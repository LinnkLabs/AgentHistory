// Persona layer: distill session histories into an evidence-linked model of the user
// (the "context book") — Persome-inspired discipline, adapted to transcripts:
//
//   1. Deterministic SIGNAL MINING (no LLM): user redirects after assistant output, interrupts.
//      Corrections are the highest-value preference data transcripts uniquely contain.
//   2. Gated LLM EXTRACTION, agent-funded: spawns the user's own authenticated `claude -p`
//      (headless print mode) under a durable daily call cap — no API key ever stored.
//      Every proposed fact must QUOTE evidence that verifiably appears at the cited message,
//      or it is dropped and counted. Prompts see only human input + Claude text output —
//      NEVER tool_result blocks (that's where secrets live).
//   3. Recurrence promotion: facts start `forming`; only >= 2 independent sessions make them
//      `active`. Changed statements keep a supersession trail instead of being overwritten.
//   4. Deterministic PROJECTION: active facts -> context-book.md (injectable into any
//      project's CLAUDE.md / memory), receipts resolvable back to session + message.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.mjs';

export const DAILY_CALL_LIMIT = Number(process.env.AGENT_MANAGER_PERSONA_DAILY_LIMIT || 50);
const CLAUDE_BIN = process.env.AGENT_MANAGER_CLAUDE_BIN || 'claude';
const CALL_TIMEOUT_MS = 180_000;

// ---------------- signal mining (deterministic) ----------------

// A user message that starts like this right after Claude's output is a correction/redirect.
// English + Chinese, tuned for precision over recall (a false "preference" is worse than a miss).
const REDIRECT_RE = /^(no[,.!\s]|no$|don't\b|do not\b|stop\b|wait\b|actually[,\s]|instead\b|not that\b|that's (not|wrong)\b|wrong\b|undo\b|revert\b|nope\b|hold on\b|不要|不对|不是这|别|等等|等一下|停|错了|改成|换成|重来|撤销|不行)/i;
const INTERRUPT_RE = /^\[Request interrupted/;

/**
 * Mine correction signals for one session from its already-indexed messages.
 * Returns [{msgIndex, kind, excerpt, ts}].
 */
export function mineSessionSignals(messages) {
  const out = [];
  let lastRealRole = null; // last non-tool, non-system speaker
  for (const m of messages) {
    if (m.role === 'system' && INTERRUPT_RE.test(m.text || '')) {
      out.push({ msgIndex: m.msgIndex, kind: 'interrupt', excerpt: (m.text || '').slice(0, 200), ts: m.ts });
      continue;
    }
    if (m.role === 'user' && m.kind === 'text') {
      if (lastRealRole === 'assistant' && REDIRECT_RE.test((m.text || '').trim())) {
        out.push({ msgIndex: m.msgIndex, kind: 'redirect', excerpt: (m.text || '').slice(0, 240), ts: m.ts });
      }
      lastRealRole = 'user';
    } else if (m.role === 'assistant' && (m.kind === 'text' || m.kind === 'tool_use')) {
      lastRealRole = 'assistant';
    }
  }
  return out;
}

/** Rebuild signals for every session whose index changed since the last mining pass. */
export function mineAllSignals(store, { force = false } = {}) {
  const builtMs = Number(store.meta('persona.signalsBuiltMs') || 0);
  const sessions = store.listSessions();
  let mined = 0;
  for (const s of sessions) {
    if (!force && builtMs && s.indexedAtMs && s.indexedAtMs <= builtMs) continue;
    const data = store.getSession(s.sessionId);
    if (!data) continue;
    store.replaceSignals(s.sessionId, mineSessionSignals(data.messages));
    mined++;
  }
  store.meta('persona.signalsBuiltMs', Date.now());
  return { mined, total: sessions.length };
}

// ---------------- agent-funded LLM runner ----------------

function todayKey() { return 'persona.usage.' + new Date().toISOString().slice(0, 10); }

export function callsUsedToday(store) { return Number(store.meta(todayKey()) || 0); }

export function takeCall(store) {
  const used = callsUsedToday(store);
  if (used >= DAILY_CALL_LIMIT) return false;
  store.meta(todayKey(), used + 1);
  return true;
}

/**
 * Run one prompt through the user's own authenticated `claude` CLI (headless -p mode).
 * Prompt goes via stdin (no ARG_MAX risk); cwd is our data dir so no project CLAUDE.md leaks in.
 * Strips nested-session env markers so this works when invoked from inside a Claude session.
 */
export function runClaude(prompt, { model = '', timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json'];
    if (model) args.push('--model', model);
    const env = { ...process.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_CODE_SSE_PORT;
    const child = execFile(CLAUDE_BIN, args, { cwd: dataDir(), env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: String(err.message || err) });
        try {
          const o = JSON.parse(stdout);
          if (o && typeof o.result === 'string') return resolve({ ok: true, text: o.result, costUsd: o.total_cost_usd });
          return resolve({ ok: false, error: 'no result field in claude output' });
        } catch {
          return resolve({ ok: false, error: 'unparseable claude output: ' + String(stdout).slice(0, 200) });
        }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** Pull the first JSON array/object out of an LLM reply (tolerates ```json fences and prose). */
export function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  for (let end = body.length; end > start; end--) {
    const cand = body.slice(start, end).trim();
    if (!cand.endsWith(']') && !cand.endsWith('}')) continue;
    try { return JSON.parse(cand); } catch { /* keep shrinking */ }
  }
  return null;
}

// ---------------- gated extraction ----------------

const FACT_KINDS = new Set(['profile', 'preference', 'workflow', 'interest']);
const MIN_CONFIDENCE = 0.5;
const MAX_EVIDENCE_PER_FACT = 12;

/** Normalize for quote-verification: lowercase, collapse whitespace. */
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Build the extraction prompt for one session. Only human input and Claude text output are
 * included (redaction gate: tool_result / tool_use / thinking never reach the prompt).
 */
export function buildExtractionPrompt(session, messages, signals, knownFacts = []) {
  const signalSet = new Map(signals.map((s) => [s.msgIndex, s.kind]));
  const lines = [];
  let budget = 24_000;
  for (const m of messages) {
    if (!((m.role === 'user' || m.role === 'assistant') && m.kind === 'text')) continue;
    const text = String(m.text || '').slice(0, 700);
    const tag = signalSet.get(m.msgIndex) === 'redirect' ? ' [CORRECTION]' : '';
    const line = `[#${m.msgIndex}] ${m.role === 'user' ? 'USER' : 'CLAUDE'}${tag}: ${text}`;
    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.push(line);
  }
  return `You are a careful analyst building an evidence-linked model of a software developer from one of their AI-agent session transcripts. Extract durable facts about the USER (never about Claude, never about transient task state).

Session: "${session.title}" · project: ${session.project} · date: ${(session.lastTs || '').slice(0, 10)}

Transcript (USER = the human; lines marked [CORRECTION] are the user correcting the agent — the strongest preference signal):

${lines.join('\n')}

${knownFacts.length ? `Known facts from earlier sessions — if this session supports one of these (even phrased differently), REUSE ITS EXACT key so observations accumulate; only invent a new key for a genuinely new fact:
${knownFacts.map((f) => `- ${f.key}: ${f.statement}`).join('\n')}

` : ''}Extract 0-6 durable facts. Each must be:
- about the USER's lasting preferences, working style, profile, or interests — NOT this task's details
- directly supported by a verbatim quote from a numbered message above

Respond with ONLY a JSON array (no prose):
[{"kind":"profile|preference|workflow|interest","key":"short-kebab-slug-naming-the-fact","statement":"one sentence, third person with they/them pronouns, starting with 'Prefers/Uses/Works/Is...'","confidence":0.0-1.0,"evidence":[{"msgIndex":123,"quote":"exact substring copied from that message"}]}]

Return [] if the session reveals nothing durable. Never invent quotes.`;
}

/**
 * Verify + apply one session's proposed facts. The hard gate (Persome's "keeps receipts"):
 * every evidence item must cite a real user/assistant text message whose text actually contains
 * the quote. Facts with no surviving evidence are dropped and counted.
 */
export function applyFacts(store, session, messages, proposed) {
  const byIndex = new Map(messages.map((m) => [m.msgIndex, m]));
  const now = Date.now();
  let added = 0, merged = 0, dropped = 0;
  if (!Array.isArray(proposed)) return { added, merged, dropped: 1 };

  for (const f of proposed.slice(0, 12)) {
    if (!f || typeof f !== 'object') { dropped++; continue; }
    const kind = FACT_KINDS.has(f.kind) ? f.kind : null;
    const key = String(f.key || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    const statement = String(f.statement || '').trim().slice(0, 300);
    const confidence = Number(f.confidence);
    if (!kind || !key || !statement || !(confidence >= MIN_CONFIDENCE)) { dropped++; continue; }

    const evidence = (Array.isArray(f.evidence) ? f.evidence : []).filter((e) => {
      if (!e || typeof e.msgIndex !== 'number' || typeof e.quote !== 'string' || !e.quote.trim()) return false;
      const m = byIndex.get(e.msgIndex);
      if (!m || !(m.role === 'user' || m.role === 'assistant') || m.kind !== 'text') return false; // never a tool block
      return norm(m.text).includes(norm(e.quote));   // the quote must really be there
    }).map((e) => ({ sessionId: session.sessionId, msgIndex: e.msgIndex, quote: String(e.quote).slice(0, 200) }));
    if (!evidence.length) { dropped++; continue; }

    const prior = store.getFact(key);
    if (!prior) {
      store.insertFact({
        key, kind, statement, status: 'forming', confidence,
        observations: 1,
        sessionsJson: JSON.stringify([session.sessionId]),
        evidenceJson: JSON.stringify(evidence),
        historyJson: JSON.stringify([]),
        firstSeenMs: now, lastSeenMs: now,
      });
      added++;
    } else {
      const sessions = new Set(JSON.parse(prior.sessionsJson || '[]'));
      sessions.add(session.sessionId);
      const allEvidence = JSON.parse(prior.evidenceJson || '[]').concat(evidence).slice(-MAX_EVIDENCE_PER_FACT);
      const history = JSON.parse(prior.historyJson || '[]');
      if (norm(prior.statement) !== norm(statement)) history.push({ statement: prior.statement, untilMs: now });
      store.updateFact(key, {
        statement,
        kind,
        confidence: Math.max(prior.confidence || 0, confidence),
        observations: (prior.observations || 0) + 1,
        sessionsJson: JSON.stringify([...sessions]),
        evidenceJson: JSON.stringify(allEvidence),
        historyJson: JSON.stringify(history.slice(-10)),
        status: sessions.size >= 2 ? 'active' : prior.status,   // recurrence promotion
        lastSeenMs: now,
      });
      merged++;
    }
  }
  return { added, merged, dropped };
}

/**
 * Lazy extraction pass: distill up to `limit` not-yet-seen sessions through `claude -p`,
 * bounded by the durable daily call cap. onProgress(i, total, session, result) optional.
 */
export async function extractSessions(store, { limit = 10, model = '', dryRun = false, onProgress } = {}) {
  mineAllSignals(store);
  const candidates = store.extractionCandidates({ limit });
  const summary = { attempted: 0, added: 0, merged: 0, dropped: 0, errors: [], capped: false, dryRun };
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const data = store.getSession(c.sessionId);
    if (!data) continue;
    const signals = store.signalsForSession(c.sessionId);
    const known = store.listFacts().slice(0, 60).map((f) => ({ key: f.key, statement: f.statement }));
    const prompt = buildExtractionPrompt(data.session, data.messages, signals, known);
    if (dryRun) {
      if (onProgress) onProgress(i + 1, candidates.length, c, { dryRun: true, promptChars: prompt.length, signals: signals.length });
      continue;
    }
    if (!takeCall(store)) { summary.capped = true; break; }
    summary.attempted++;
    const r = await runClaude(prompt, { model });
    if (!r.ok) { summary.errors.push(`${c.sessionId.slice(0, 8)}: ${r.error}`); if (onProgress) onProgress(i + 1, candidates.length, c, r); continue; }
    const proposed = extractJson(r.text);
    const applied = applyFacts(store, data.session, data.messages, proposed || []);
    summary.added += applied.added; summary.merged += applied.merged; summary.dropped += applied.dropped;
    store.setPersonaState({
      sessionId: c.sessionId, extractedAtMs: Date.now(), msgCountAtExtract: data.session.msgCount,
      factsAdded: applied.added, factsMerged: applied.merged, dropped: applied.dropped,
    });
    if (onProgress) onProgress(i + 1, candidates.length, c, { ...r, ...applied });
  }
  if (!dryRun && (summary.attempted || summary.capped)) buildBook(store);
  return summary;
}

// ---------------- context book projection ----------------

const KIND_HEADINGS = { profile: 'Profile', preference: 'Preferences', workflow: 'Working style', interest: 'Interests & focus areas' };

export function bookPath() { return path.join(dataDir(), 'context-book.md'); }

/** Deterministic projection of active (+ forming) facts into a human/agent-readable markdown book. */
export function buildBook(store) {
  const facts = store.listFacts();
  const active = facts.filter((f) => f.status === 'active');
  const forming = facts.filter((f) => f.status === 'forming');
  const st = store.personaStatus();
  const titleOf = (sid) => (store.getSessionMeta(sid)?.title || sid.slice(0, 8));

  const lines = [];
  lines.push('# Context Book');
  lines.push('');
  lines.push(`> An evidence-linked model of this user, distilled from ${st.extracted} agent-session transcripts.`);
  lines.push(`> Every fact carries receipts (session + message) and required independent recurrence before activation.`);
  lines.push(`> Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by Agent History. Review before sharing externally.`);
  lines.push('');
  for (const kind of Object.keys(KIND_HEADINGS)) {
    const rows = active.filter((f) => f.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${KIND_HEADINGS[kind]}`);
    lines.push('');
    for (const f of rows) {
      const sessions = JSON.parse(f.sessionsJson || '[]');
      lines.push(`- ${f.statement}  _(seen in ${sessions.length} sessions, e.g. “${titleOf(sessions[0]).slice(0, 48)}”)_`);
    }
    lines.push('');
  }
  if (forming.length) {
    lines.push('## Forming (single observation — not yet trusted)');
    lines.push('');
    for (const f of forming.slice(0, 20)) lines.push(`- ${f.statement}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('_Inspect receipts: `agent-manager persona facts` · refresh: `agent-manager persona extract`_');
  const md = lines.join('\n');
  fs.writeFileSync(bookPath(), md, { mode: 0o600 });
  return md;
}

export function readBook(store) {
  try { return fs.readFileSync(bookPath(), 'utf8'); } catch { return buildBook(store); }
}

// ---------------- retro (rollup + optional LLM digest) ----------------

export function retroReport(store, { days = 7, toMs = Date.now() } = {}) {
  mineAllSignals(store);
  const to = new Date(toMs);
  const from = new Date(toMs - days * 86_400_000);
  return store.retro({ fromIso: from.toISOString(), toIso: to.toISOString() });
}

export async function retroDigest(store, report, { model = '' } = {}) {
  if (!takeCall(store)) return { ok: false, error: `daily call limit (${DAILY_CALL_LIMIT}) reached` };
  const compact = {
    range: { from: report.from.slice(0, 10), to: report.to.slice(0, 10) },
    totals: report.totals,
    days: report.days,
    topSessions: report.topSessions.map((s) => ({ title: s.title, project: s.project, userMsgs: s.userMsgs })),
    corrections: report.topSignals.filter((s) => s.kind === 'redirect').map((s) => ({ project: s.project, said: s.excerpt.slice(0, 160) })),
  };
  const prompt = `You are writing a concise personal retrospective for a developer from their AI-agent activity data (JSON below). Cover: main themes worked on, how attention shifted across projects, threads that look unfinished, and what the correction quotes reveal about what they cared about. Be specific, use the actual project/session names, no fluff, no headers deeper than ###. 250-400 words of markdown.

${JSON.stringify(compact)}`;
  const r = await runClaude(prompt, { model });
  if (!r.ok) return r;
  const dir = path.join(dataDir(), 'retro');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `retro-${report.to.slice(0, 10)}-${Math.round((new Date(report.to) - new Date(report.from)) / 86_400_000)}d.md`);
  fs.writeFileSync(file, r.text, { mode: 0o600 });
  return { ok: true, text: r.text, file };
}
