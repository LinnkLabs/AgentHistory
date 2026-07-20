// "✨ Refine with AI" — manual, metered task classification (DESIGN-HANDOFF §3).
// Reuses the persona harness: the user's own authenticated `claude -p`, shared daily call cap,
// head+tail user/assistant text only (tool outputs never leave the machine), cache by
// (sessionId, lastActivityMs) so unchanged sessions are never re-sent.
import { runClaude, extractJson, callsUsedToday, takeCall, DAILY_CALL_LIMIT } from './persona.mjs';

const CATEGORIES = ['feature', 'ops', 'research', 'content', 'analysis', 'infra', 'other'];
const cacheKey = (sid) => 'classify:' + sid;

/** Board-relevant sessions that need (re)classification: recent, and new-or-changed since last run. */
export function classifyCandidates(store, { limit = 25 } = {}) {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const out = [];
  for (const row of store.boardRows()) {
    if ((row.lastActivityMs || 0) < cutoff) continue;
    if (row.userStatus === 'archived') continue;
    if (store.meta(cacheKey(row.sessionId)) === String(row.lastActivityMs)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function excerpt(store, sessionId) {
  const data = store.getSession(sessionId);
  if (!data) return '';
  const conv = data.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.kind === 'text');
  const clip = (m) => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`;
  const head = conv.slice(0, 6), tail = conv.length > 12 ? conv.slice(-6) : conv.slice(head.length);
  return [...head.map(clip), conv.length > 12 ? `… (${conv.length - 12} messages omitted) …` : '', ...tail.map(clip)].filter(Boolean).join('\n');
}

function prompt(row, body) {
  return `You label ONE coding-agent work session for a personal task board. Reply with ONLY a JSON object:
{"taskTitle": "<imperative, <=60 chars, what the task IS (not the chat title)>",
 "category": "<one of: ${CATEGORIES.join('|')}>",
 "reason": "<current state in <=80 chars, e.g. 'blocked on X since …' / 'shipped, PR merged' / ''>"}

Project: ${row.project} · last activity: ${new Date(row.lastActivityMs).toISOString().slice(0, 10)} · existing title: ${row.title}

Conversation excerpt (head+tail):
${body}`;
}

/**
 * Run classification for up to `limit` changed sessions. Applies conservatively:
 * taskTitle only when none is set (user renames + prior titles stick), reason only
 * where the user hasn't set a status (🔒 always wins), category always refreshed.
 */
export async function runClassify(store, { limit = 25, model = '', onProgress } = {}) {
  const cands = classifyCandidates(store, { limit });
  let done = 0, applied = 0, failed = 0, capped = false, costUsd = 0;
  for (const row of cands) {
    if (!takeCall(store)) { capped = true; break; }
    const body = excerpt(store, row.sessionId);
    const res = body ? await runClaude(prompt(row, body), { model }) : { ok: false, error: 'empty excerpt' };
    done++;
    if (res.ok) {
      const j = extractJson(res.text) || {};
      const patch = {};
      if (j.taskTitle && !row.taskTitle) patch.taskTitle = String(j.taskTitle).slice(0, 60);
      if (j.category && CATEGORIES.includes(j.category)) patch.category = j.category;
      if (j.reason !== undefined && row.statusSource !== 'user') patch.reason = String(j.reason || '').slice(0, 80);
      if (Object.keys(patch).length) { store.setTaskMeta(row.sessionId, patch); applied++; }
      store.meta(cacheKey(row.sessionId), String(row.lastActivityMs));
      costUsd += res.costUsd || 0;
    } else { failed++; }
    if (onProgress) onProgress(done, cands.length, row, res);
  }
  return { total: cands.length, done, applied, failed, capped, costUsd };
}

export function classifyPreview(store) {
  return {
    toClassify: classifyCandidates(store, { limit: 100 }).length,
    callsUsed: callsUsedToday(store),
    cap: DAILY_CALL_LIMIT,
  };
}
