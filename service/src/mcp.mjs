// MCP server (stdio) — turns Agent History into an always-on memory every agent can query.
//
// Dependency-free: MCP's stdio transport is newline-delimited JSON-RPC 2.0, so a line reader and
// five read-only tools are all we need. Register with any MCP client, e.g.:
//   claude mcp add -s user agent-history -- node /abs/path/to/bin/agent-manager.mjs mcp
//
// Design rules:
// - stdout carries ONLY protocol frames; all logging goes to stderr.
// - Read-only: no tool mutates the store (the daemon/CLI own writes).
// - Same trust domain as the transcripts themselves: this serves the user's own local agents.
import { readBook } from './persona.mjs';

const PROTOCOL_DEFAULT = '2025-06-18';
const SERVER_INFO = { name: 'agent-history', version: '0.2.0' };

const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

// target shorthand -> (role, kind), mirroring the dashboard's search chips
const TARGETS = {
  input: { role: 'user' }, output: { role: 'assistant', kind: 'text' },
  commands: { kind: 'tool_use' }, toolout: { kind: 'tool_result' },
};

function tools(store) {
  return [
    {
      name: 'get_context_book',
      description: 'The evidence-linked model of this user (their "context book"): durable preferences, working style, profile, and interests distilled from their agent-session history. Read this FIRST when you want to adapt to how this user works. Facts marked forming have only a single observation.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => ({ markdown: readBook(store) }),
    },
    {
      name: 'search_history',
      description: "Full-text search (BM25) across ALL of the user's past agent sessions — Claude Code AND Codex, every project, months of history, including sessions whose local files were cleaned up. Use to find prior work, decisions, fixes, or discussions ('did we already solve X?'). Scope with project or sessionId; target narrows to input (user prompts) | output (agent text) | commands (tool calls) | toolout (tool results).",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords (AND, prefix-matched)' },
          project: { type: 'string', description: 'Limit to a project (folder basename)' },
          sessionId: { type: 'string', description: 'Limit to one session' },
          target: { type: 'string', enum: ['input', 'output', 'commands', 'toolout'], description: 'What kind of message to search' },
          limit: { type: 'number', description: 'Max hits (default 20, max 50)' },
        },
        required: ['query'], additionalProperties: false,
      },
      run: (a) => {
        const t = TARGETS[a.target] || {};
        const hits = store.search({
          q: a.query,
          scope: a.sessionId ? 'session' : a.project ? 'project' : 'global',
          scopeId: a.sessionId || a.project || undefined,
          role: t.role, kind: t.kind,
          limit: Math.min(Number(a.limit) || 20, 50),
        });
        return {
          hits: hits.map((h) => ({
            sessionId: h.sessionId, msgIndex: h.msgIndex, role: h.role, kind: h.kind, ts: h.ts,
            project: h.project, folder: h.cwd, sessionTitle: clip(h.title, 80), snippet: clip(h.snippet, 300),
          })),
          note: 'Use read_session with a sessionId+msgIndex to see full surrounding context.',
        };
      },
    },
    {
      name: 'get_persona_facts',
      description: "Structured persona facts about the user with evidence receipts (each fact quotes the user's own transcripts; receipts are sessionId+msgIndex, resolvable via read_session). status=active facts were confirmed across >=2 independent sessions; forming facts have one observation.",
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['active', 'forming'], description: 'Filter by status (default: both)' } },
        additionalProperties: false,
      },
      run: (a) => ({
        facts: store.listFacts({ status: a.status }).map((f) => ({
          key: f.key, kind: f.kind, statement: f.statement, status: f.status,
          observations: f.observations, sessions: JSON.parse(f.sessionsJson || '[]').length,
          evidence: JSON.parse(f.evidenceJson || '[]').slice(0, 4)
            .map((e) => ({ sessionId: e.sessionId, msgIndex: e.msgIndex, quote: clip(e.quote, 160) })),
        })),
      }),
    },
    {
      name: 'get_recent_activity',
      description: "What the user worked on recently across ALL projects and sessions: per-day per-project activity, most active sessions, and recent corrections they made to agents (strong signals of what they care about). Use to answer 'what was I doing?', to continue unfinished work, or to write a standup/retro.",
      inputSchema: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Window in days (default 7, max 90)' } },
        additionalProperties: false,
      },
      run: (a) => {
        // store.retro directly (not persona.retroReport): that helper mines signals first, a WRITE —
        // this server must stay read-only. Signals here are whatever the daemon/CLI last mined.
        const days = Math.min(Math.max(Number(a.days) || 7, 1), 90);
        const to = new Date(), from = new Date(Date.now() - days * 86_400_000);
        const r = store.retro({ fromIso: from.toISOString(), toIso: to.toISOString() });
        return {
          from: r.from, to: r.to, totals: r.totals, days: r.days,
          topSessions: r.topSessions.map((s) => ({
            sessionId: s.sessionId, title: clip(s.title, 80), project: s.project, promptsByUser: s.userMsgs,
          })),
          corrections: r.topSignals.filter((s) => s.kind === 'redirect').slice(0, 10)
            .map((s) => ({ said: clip(s.excerpt, 160), project: s.project, sessionTitle: clip(s.title, 60) })),
        };
      },
    },
    {
      name: 'read_session',
      description: 'Read a transcript excerpt from any past session — resolves search hits and persona-fact receipts to their full surrounding conversation. Give msgIndex to center on a message (e.g. from search_history or a fact receipt), omit it for the end of the session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          msgIndex: { type: 'number', description: 'Center the excerpt on this message' },
          radius: { type: 'number', description: 'Messages either side (default 6, max 25)' },
        },
        required: ['sessionId'], additionalProperties: false,
      },
      run: (a) => {
        const data = store.getSession(a.sessionId);
        if (!data) return { error: 'session not found' };
        const radius = Math.min(Math.max(Number(a.radius) || 6, 1), 25);
        const msgs = data.messages;
        let lo, hi;
        if (a.msgIndex != null) {
          const i = msgs.findIndex((m) => m.msgIndex === Number(a.msgIndex));
          const c = i >= 0 ? i : msgs.length - 1;
          lo = Math.max(0, c - radius); hi = Math.min(msgs.length, c + radius + 1);
        } else { lo = Math.max(0, msgs.length - radius * 2); hi = msgs.length; }
        const s = data.session;
        return {
          session: { sessionId: s.sessionId, title: s.title, project: s.project, folder: s.cwd, model: s.model, lastTs: s.lastTs, msgCount: s.msgCount },
          resumeCommand: s.source === 'desktop-cowork' ? null : `cd ${JSON.stringify(s.cwd || '.')} && claude --resume ${s.sessionId}`,
          messages: msgs.slice(lo, hi).map((m) => ({ msgIndex: m.msgIndex, role: m.role, kind: m.kind, ts: m.ts, text: clip(m.text, 1500) })),
        };
      },
    },
  ];
}

export function runMcp(store) {
  const TOOLS = tools(store);
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { handle(msg); } catch (e) {
        if (msg && msg.id !== undefined) fail(msg.id, -32603, String(e && e.message || e));
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));

  function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_DEFAULT,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Agent History: read-only memory over ALL of this user\'s past agent sessions (Claude Code and Codex). get_context_book tells you how they work; search_history/read_session recover any past context; get_recent_activity shows what they were just doing.',
      });
    }
    if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) return; // no response to notifications
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (method === 'tools/call') {
      const t = byName.get(params && params.name);
      if (!t) return fail(id, -32602, `unknown tool: ${params && params.name}`);
      let out;
      try { out = t.run((params && params.arguments) || {}); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true }); }
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
    }
    if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  }

  process.stderr.write(`agent-history MCP server ready (${TOOLS.length} tools)\n`);
}
