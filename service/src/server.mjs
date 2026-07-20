// Minimal HTTP server (Node built-ins only) exposing the REST API + serving the web dashboard.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { openStore } from './store.mjs';
import { reconcile } from './indexer.mjs';
import { indexCoworkAll } from './cowork.mjs';
import { indexCodexAll } from './codex.mjs';
import { retroReport, readBook, buildBook, extractSessions, callsUsedToday, DAILY_CALL_LIMIT } from './persona.mjs';
import { buildBoard, pidAlive } from './taskboard.mjs';
import { runClassify, classifyPreview } from './classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { execFile(cmd, [url], () => {}); } catch { /* ignore */ }
}

// ---------- Open in Claude Code (deep-link handoff) ----------
// Research findings (2026-07): the VS Code extension resumes by id via
// vscode://anthropic.claude-code/open?session=<id> — but ONLY if the session's workspace is the
// focused window. So we (1) focus the right folder window first (open -a <IDE> <cwd>), then (2) fire
// the URI. No live IDE window with that folder → open a Terminal running `claude --resume`. Anything
// else (non-mac, Cowork sandbox sessions, failures) → tell the client to copy the resume command.
const IDE_SCHEMES = {
  'Visual Studio Code': { app: 'Visual Studio Code', scheme: 'vscode' },
  'Visual Studio Code - Insiders': { app: 'Visual Studio Code - Insiders', scheme: 'vscode-insiders' },
  'Cursor': { app: 'Cursor', scheme: 'cursor' },
  'Windsurf': { app: 'Windsurf', scheme: 'windsurf' },
};

/** Live IDE windows from ~/.claude/ide/*.lock (pid-validated): [{ideName, folders[]}]. */
function liveIdeWindows() {
  const dir = path.join(os.homedir(), '.claude', 'ide');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.lock')); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d && d.pid && pidAlive(d.pid) && Array.isArray(d.workspaceFolders)) {
        out.push({ ideName: d.ideName || 'Visual Studio Code', folders: d.workspaceFolders });
      }
    } catch { /* stale/unreadable lock */ }
  }
  return out;
}

function openInClaude(store, sessionId, { dryRun = false } = {}) {
  const s = store.getSessionMeta(sessionId);
  if (!s) return { method: 'none', reason: 'session not found' };
  const cwd = s.cwd || '';
  const resumeCmd = `cd ${JSON.stringify(cwd || os.homedir())} && claude --resume ${sessionId}`;

  // Cowork sandbox sessions aren't resumable by the CLI/IDE at all — be honest, don't hand out a bogus command.
  if (s.source === 'desktop-cowork') return { method: 'none', reason: 'desktop Cowork session — view it here or in the Claude app' };
  if (process.platform !== 'darwin') return { method: 'copy', resumeCmd, reason: 'IDE/terminal handoff is macOS-only for now' };

  // 1) workspace-aware IDE deep link: a LIVE window already has this session's folder open
  const win = cwd && liveIdeWindows().find((w) => w.folders.some((fo) => cwd === fo || cwd.startsWith(fo + '/')));
  if (win) {
    const ide = IDE_SCHEMES[win.ideName] || IDE_SCHEMES['Visual Studio Code'];
    const folder = win.folders.find((fo) => cwd === fo || cwd.startsWith(fo + '/'));
    const uri = `${ide.scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
    try {
      if (!dryRun) {
        execFile('open', ['-a', ide.app, folder], () => {
          // focus the right window first, then route the URI to it
          setTimeout(() => { try { execFile('open', [uri], () => {}); } catch { /* */ } }, 600);
        });
      }
      return { method: 'ide', ide: win.ideName, folder, uri, dryRun };
    } catch { /* fall through */ }
  }

  // 2) terminal fallback: open Terminal.app running the resume command in the right cwd
  if (cwd && fs.existsSync(cwd)) {
    const script = resumeCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      if (!dryRun) {
        execFile('osascript',
          ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'],
          () => {});
      }
      return { method: 'terminal', resumeCmd, dryRun };
    } catch { /* fall through */ }
  }

  return { method: 'copy', resumeCmd, reason: cwd ? 'no live IDE window with this folder' : 'session cwd unknown' };
}

export async function serve({ port = 4600, open = true, watch = true } = {}) {
  const store = openStore();
  let version = 0, lastChangeMs = 0;
  // one background persona extraction at a time; UI polls its progress
  const extract = { running: false, done: 0, total: 0, lastResult: null };
  // one background classify run at a time (Refine with AI)
  const classify = { running: false, done: 0, total: 0, lastResult: null };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const qp = url.searchParams;
    try {
      // ---- API ----
      if (p === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (p === '/api/version') return sendJSON(res, 200, { version, lastChangeMs });
      if (p === '/api/stats') return sendJSON(res, 200, store.stats());

      if (p === '/api/sessions') {
        // O1: organized overview — projects + sessions, filtered.
        const sessions = store.listSessions({
          project: qp.get('project') || undefined,
          model: qp.get('model') || undefined,
          from: qp.get('from') ? Number(qp.get('from')) : undefined,
          to: qp.get('to') ? Number(qp.get('to')) : undefined,
          sort: qp.get('sort') || 'recent',
        });
        return sendJSON(res, 200, { projects: store.projectSummary(), sessions });
      }

      const mSession = p.match(/^\/api\/session\/([^/]+)$/);
      if (mSession) {
        // O3: full transcript for the locate/jump view.
        const data = store.getSession(decodeURIComponent(mSession[1]));
        if (!data) return sendJSON(res, 404, { error: 'not found' });
        return sendJSON(res, 200, data);
      }

      if (p === '/api/search') {
        // O2: scope x target.
        const hits = store.search({
          q: qp.get('q') || '',
          scope: qp.get('scope') || 'global',
          scopeId: qp.get('scopeId') || undefined,
          role: qp.get('role') || undefined,
          kind: qp.get('kind') || undefined,
          limit: qp.get('limit') ? Number(qp.get('limit')) : 200,
        });
        return sendJSON(res, 200, { hits });
      }

      // ---- portrait (visualization layer): one payload with everything the page needs ----
      if (p === '/api/viz') {
        const days = Math.max(30, Math.min(Number(qp.get('days')) || 182, 366));
        const viz = store.vizData({ days });
        // rotate UTC hour buckets into this machine's local time
        const offsetH = Math.round(-new Date().getTimezoneOffset() / 60);
        viz.hours = viz.hoursUtc.map((_, i) => viz.hoursUtc[((i - offsetH) % 24 + 24) % 24]);
        delete viz.hoursUtc;
        // streaks over the daily series
        const daySet = new Set(viz.daily.filter((d) => d.prompts > 0).map((d) => d.day));
        let best = 0, cur = 0;
        for (let i = days; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
          cur = daySet.has(d) ? cur + 1 : 0;
          if (cur > best) best = cur;
        }
        let current = 0;
        for (let i = 0; ; i++) {
          const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
          if (daySet.has(d)) current++;
          else if (i === 0) continue;   // today may simply not have activity yet
          else break;
        }
        viz.streak = { current, best };
        viz.facts = store.listFacts().map((f) => ({
          key: f.key, kind: f.kind, statement: f.statement, status: f.status,
          observations: f.observations, sessions: JSON.parse(f.sessionsJson || '[]'),
          evidence: JSON.parse(f.evidenceJson || '[]'),
        }));
        viz.corrections = store.db.prepare(`
          SELECT p.excerpt, p.ts, s.project, s.title FROM persona_signals p
          JOIN sessions s ON s.sessionId = p.sessionId
          WHERE p.kind = 'redirect' ORDER BY p.ts DESC LIMIT 24
        `).all();
        viz.persona = store.personaStatus();
        return sendJSON(res, 200, viz);
      }

      // ---- persona / insights ----
      if (p === '/api/retro') {
        const days = Math.max(1, Math.min(Number(qp.get('days')) || 7, 365));
        return sendJSON(res, 200, retroReport(store, { days }));
      }
      if (p === '/api/persona/book') {
        const md = qp.get('rebuild') ? buildBook(store) : readBook(store);
        return sendJSON(res, 200, { markdown: md });
      }
      if (p === '/api/persona/facts') {
        const facts = store.listFacts().map((f) => ({
          key: f.key, kind: f.kind, statement: f.statement, status: f.status,
          observations: f.observations, sessions: JSON.parse(f.sessionsJson || '[]'),
          evidence: JSON.parse(f.evidenceJson || '[]'),
        }));
        return sendJSON(res, 200, { facts, status: store.personaStatus(), calls: { used: callsUsedToday(store), limit: DAILY_CALL_LIMIT } });
      }
      if (p === '/api/persona/extract' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (extract.running) return sendJSON(res, 200, { started: false, reason: 'already running', ...extract });
          let limit = 5;
          try { limit = Math.max(1, Math.min(Number(JSON.parse(body).limit) || 5, 25)); } catch { /* */ }
          extract.running = true; extract.done = 0; extract.total = 0; extract.lastResult = null;
          extractSessions(store, {
            limit,
            onProgress: (i, total) => { extract.done = i; extract.total = total; },
          }).then((r) => { extract.lastResult = r; })
            .catch((e) => { extract.lastResult = { error: String(e && e.message || e) }; })
            .finally(() => { extract.running = false; version++; lastChangeMs = Date.now(); });
          sendJSON(res, 200, { started: true, limit });
        });
        return;
      }
      if (p === '/api/persona/extract-status') return sendJSON(res, 200, { ...extract, calls: { used: callsUsedToday(store), limit: DAILY_CALL_LIMIT } });

      // ---- Now board (task view) ----
      if (p === '/api/board') {
        return sendJSON(res, 200, buildBoard(store, { project: qp.get('project') || undefined }));
      }
      // merge sessions into one task (drag card onto card)
      if (p === '/api/task/merge' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let b = {};
          try { b = JSON.parse(body) || {}; } catch { /* */ }
          const into = String(b.into || ''); const ids = Array.isArray(b.sessionIds) ? b.sessionIds : [];
          if (!into || !ids.length) return sendJSON(res, 400, { error: 'need into + sessionIds' });
          const target = store.setTaskMeta(into, {}); // ensures a taskId exists for the target
          for (const sid of ids) if (sid !== into) store.setTaskMeta(String(sid), { taskId: target.taskId });
          sendJSON(res, 200, { ok: true, taskId: target.taskId, merged: ids.length });
        });
        return;
      }
      // unmerge: make a session standalone again
      if (p === '/api/task/unmerge' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let b = {};
          try { b = JSON.parse(body) || {}; } catch { /* */ }
          if (!b.sessionId) return sendJSON(res, 400, { error: 'need sessionId' });
          store.setTaskMeta(String(b.sessionId), { taskId: String(b.sessionId) });
          sendJSON(res, 200, { ok: true });
        });
        return;
      }

      // Refine with AI: preview (dryRun) → confirm → background run with polled progress
      if (p === '/api/classify' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let b = {};
          try { b = JSON.parse(body) || {}; } catch { /* */ }
          if (b.dryRun) return sendJSON(res, 200, { ...classifyPreview(store), running: classify.running });
          if (classify.running) return sendJSON(res, 409, { error: 'classify already running' });
          classify.running = true; classify.done = 0; classify.total = 0; classify.lastResult = null;
          runClassify(store, {
            limit: Number(b.limit) || 25, model: b.model || '',
            onProgress: (done, total) => { classify.done = done; classify.total = total; },
          }).then((r) => { classify.lastResult = r; classify.running = false; version++; lastChangeMs = Date.now(); })
            .catch((e) => { classify.lastResult = { error: String(e && e.message || e) }; classify.running = false; });
          sendJSON(res, 200, { started: true });
        });
        return;
      }
      if (p === '/api/classify/status') return sendJSON(res, 200, classify);

      const mTask = p.match(/^\/api\/task\/([^/]+)$/);
      if (mTask && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let patch = {};
          try { patch = JSON.parse(body) || {}; } catch { /* */ }
          const allowed = {};
          for (const k of ['status', 'taskTitle', 'reason', 'category']) if (patch[k] !== undefined) allowed[k] = patch[k];
          if (allowed.status && !['auto', 'waiting', 'inprogress', 'recurring', 'paused', 'done', 'archived'].includes(allowed.status)) {
            return sendJSON(res, 400, { error: 'invalid status (active is detected, not declared)' });
          }
          const row = store.setTaskMeta(decodeURIComponent(mTask[1]), allowed);
          sendJSON(res, 200, { ok: true, taskMeta: row });
        });
        return;
      }

      // Open a session in Claude Code: workspace-aware IDE deep link, else terminal resume, else copy.
      if (p === '/api/open-in-claude' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let sessionId = '', dryRun = false;
          try { const b = JSON.parse(body); sessionId = b.sessionId || ''; dryRun = !!b.dryRun; } catch { /* */ }
          const result = openInClaude(store, sessionId, { dryRun });
          sendJSON(res, 200, result);
        });
        return;
      }

      // Reveal a folder in the OS file manager (O3 "see which folder").
      if (p === '/api/reveal' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let target = '';
          try { target = JSON.parse(body).path || ''; } catch { /* */ }
          if (target && fs.existsSync(target)) {
            const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
            try { execFile(cmd, [target], () => {}); } catch { /* */ }
          }
          sendJSON(res, 200, { ok: true });
        });
        return;
      }

      // ---- static web UI ----
      if (p === '/' ) return sendFile(res, path.join(WEB_DIR, 'index.html'));
      const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(WEB_DIR, safe);
      if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);

      res.writeHead(404); res.end('not found');
    } catch (e) {
      sendJSON(res, 500, { error: String(e && e.message || e) });
    }
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  // M5: keep the desktop-Cowork surface fresh at startup, then live-watch the CLI/IDE sessions.
  try { indexCoworkAll(store); } catch { /* best-effort */ }
  let timer = null;
  if (watch) {
    timer = setInterval(() => {
      try {
        const r = reconcile(store);            // byte-offset tail of grown files + pick up new sessions
        const cx = indexCodexAll(store);       // codex: cheap stat-skip pass (also feeds the board's recency-based Active)
        if (r.changed || cx.indexed) { version++; lastChangeMs = Date.now(); }
      } catch { /* ignore a bad tick */ }
    }, 5000);
    server.on('close', () => clearInterval(timer));
  }

  const url = `http://127.0.0.1:${port}`;
  const s = store.stats();
  console.log(`\n  agent-manager  ·  ${s.sessions} sessions · ${s.projects} projects · ${s.messages} messages`);
  console.log(`  ▶ ${url}  ${watch ? '(live)' : ''}\n  (Ctrl+C to stop)\n`);
  if (open) openBrowser(url);
  return { server, url };
}
