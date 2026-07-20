// P1-lite live-state + task-status inference + /api/board assembly (DESIGN-HANDOFF §2, §5).
//
// Status contract:
//   - ACTIVE is detected (live pid registry / fresh file growth), never declared.
//   - A user-set status (statusSource='user') beats auto-inference everywhere EXCEPT that a
//     genuinely running session still shows in Active (reality wins; the 🔒 status resumes on exit).
//   - ✅ done is never auto-set — only suggested (doneSuggested flag on the card).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isCustomTree } from './paths.mjs';

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** Live Claude sessions from ~/.claude/sessions/<pid>.json (pid-validated). Map sessionId -> {pid, startedAt}. */
export function liveClaudeSessions() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d && d.sessionId && d.pid && pidAlive(d.pid)) {
        const cur = out.get(d.sessionId);
        if (!cur || (d.startedAt || 0) > (cur.startedAt || 0)) out.set(d.sessionId, { pid: d.pid, startedAt: d.startedAt || 0 });
      }
    } catch { /* stale/unreadable */ }
  }
  return out;
}

const H = 3600 * 1000, D = 24 * H;
const RECENT_GROWTH_MS = 2 * 60 * 1000;   // codex "active" heuristic: file grew in the last 2 min
const INPROGRESS_MS = 48 * H;             // handoff: activity < 48h
const DONE_WINDOW_MS = 14 * D;            // Recently-done strip window
const IDLE_SUGGEST_DONE_MS = 3 * D;

const endsWithQuestion = (s) => /\?\s*["'`)\]]*\s*$/.test(String(s || '').trim().slice(-300));

/** Why is this waiting? '' if it isn't. */
export function waitingReason(row) {
  if (row.endKind === 'tool_use' && /^AskUserQuestion\b/.test(row.endHint || '')) return 'Claude asked you a question';
  if (row.endRole === 'assistant' && row.endKind === 'text' && endsWithQuestion(row.endHint)) {
    const q = String(row.endHint || '').trim();
    return `Claude asked: “${q.length > 90 ? '…' + q.slice(-88) : q}”`;
  }
  if ((row.queueDepth || 0) > 0) return `${row.queueDepth} queued prompt${row.queueDepth > 1 ? 's' : ''} pending`;
  return '';
}

/** Compute the display status for one board row. */
export function inferStatus(row, live, now = Date.now()) {
  const isLive = row.source !== 'desktop-cowork' && (
    live.has(row.sessionId) ||
    (row.source === 'codex' && now - (row.lastActivityMs || 0) < RECENT_GROWTH_MS)
  );
  if (isLive) return { status: 'active', reason: '', locked: false };

  const locked = row.statusSource === 'user' && !!row.userStatus;
  if (locked) return { status: row.userStatus, reason: row.reason || '', locked: true };

  // waiting signals decay: an unanswered question older than 7d (or a stale queue older than 48h)
  // is abandonment, not waiting
  const age = now - (row.lastActivityMs || 0);
  const wait = waitingReason(row);
  const waitFresh = wait && (wait.startsWith('Claude asked') ? age < 7 * D : age < INPROGRESS_MS);
  if (waitFresh) return { status: 'waiting', reason: row.reason || wait, locked: false };
  if (row.scheduled) return { status: 'recurring', reason: row.reason || '', locked: false };
  if (now - (row.lastActivityMs || 0) < INPROGRESS_MS) return { status: 'inprogress', reason: row.reason || '', locked: false };
  return { status: 'idle', reason: '', locked: false }; // off-board; lives in Sessions
}

const PRIORITY = { active: 0, waiting: 1, inprogress: 2, recurring: 3, paused: 4, done: 5, idle: 6, archived: 7 };

/** Assemble the Now board. Sessions sharing a taskId (manual merge) collapse into one card. */
export function buildBoard(store, { project } = {}) {
  // custom transcript trees (demo/tests) must not see this machine's real process registry
  const live = isCustomTree() ? new Map() : liveClaudeSessions();
  const now = Date.now();

  // 1) per-session inference, grouped by taskId
  const groups = new Map();
  for (const row of store.boardRows()) {
    if (project && row.project !== project) continue;
    const { status, reason, locked } = inferStatus(row, live, now);
    const card = {
      sessionId: row.sessionId,
      taskId: row.taskId || row.sessionId,
      title: row.taskTitle || row.title || row.sessionId.slice(0, 8),
      project: row.project, cwd: row.cwd, source: row.source,
      gitBranch: row.gitBranch, model: row.model,
      lastActivityMs: row.lastActivityMs, msgCount: row.msgCount, subagentCount: row.subagentCount,
      status, reason, locked, category: row.category || '',
      doneSuggested: status === 'inprogress' && !locked && !!row.prUrl && (now - (row.lastActivityMs || 0)) > IDLE_SUGGEST_DONE_MS,
    };
    const g = groups.get(card.taskId);
    if (g) g.push(card); else groups.set(card.taskId, [card]);
  }

  // 2) collapse each task group to one card: primary = most recent; status = most urgent member
  const columns = { active: [], waiting: [], inprogress: [], recurring: [], paused: [] };
  const done = [];
  let idleCount = 0;

  for (const members of groups.values()) {
    members.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0));
    const primary = members[0];
    const best = members.reduce((s, m) => (PRIORITY[m.status] < PRIORITY[s] ? m.status : s), members[0].status);
    const card = {
      ...primary,
      status: best,
      reason: members.find((m) => m.status === best && m.reason)?.reason || primary.reason,
      sessions: members.length > 1 ? members.map((m) => ({ sessionId: m.sessionId, title: m.title, lastActivityMs: m.lastActivityMs })) : undefined,
    };
    if (best === 'done') {
      if (now - (primary.lastActivityMs || 0) < DONE_WINDOW_MS) done.push(card);
    } else if (best === 'idle') {
      idleCount += members.length;
    } else if (best === 'archived') {
      // hidden; reachable via Sessions
    } else if (columns[best]) {
      columns[best].push(card);
    } else {
      columns.inprogress.push(card); // unknown user status → safest visible bucket
    }
  }
  return { columns, done, idleCount, liveCount: live.size, generatedAt: now };
}
