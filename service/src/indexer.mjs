// Enumerate-first indexer. Reads only top-level session files (UUID.jsonl NOT under /subagents/),
// counts subagents from disk, streams messages into FTS. Incremental via (size, mtime).
import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir, dataDir, SESSION_FILE_RE } from './paths.mjs';
import { scanSession, scanRange, deriveTitle } from './parse.mjs';
import { SCHEMA_VERSION } from './store.mjs';

/** Encoded ~/.claude/projects folder name for a cwd (every non-alphanumeric char -> '-'). */
const encodeCwd = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-');

/** List { projectDir, sessionId, filePath } for every top-level session across all projects. */
export function enumerateSessions(root = claudeProjectsDir()) {
  const out = [];
  // Persona extraction runs `claude -p` with cwd = our own data dir; those transcripts are OUR
  // machinery, not the user's work — indexing them would pollute the corpus and let the persona
  // extract facts from its own prompts (feedback loop). Always excluded.
  const selfFolder = encodeCwd(dataDir());
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory() || p.name === selfFolder) continue;
    const projectDir = path.join(root, p.name);
    let entries;
    try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue; // subagents live under <sessionId>/subagents/ (dirs) -> naturally excluded
      const m = e.name.match(SESSION_FILE_RE);
      if (!m) continue;
      out.push({ projectDir, folderName: p.name, sessionId: m[1], filePath: path.join(projectDir, e.name) });
    }
  }
  return out;
}

function countSubagents(projectDir, sessionId) {
  const dir = path.join(projectDir, sessionId, 'subagents');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
  } catch { return 0; }
}

/**
 * Index one session file into the store. Returns 'indexed' | 'skipped'.
 * `force` re-indexes even if unchanged.
 */
export function indexOne(store, item, { force = false } = {}) {
  let st;
  try { st = fs.statSync(item.filePath); } catch { return 'skipped'; }
  const prior = store.getIndexedInfo(item.sessionId);
  if (!force && prior && prior.fileSize === st.size && prior.lastActivityMs === Math.floor(st.mtimeMs)) {
    return 'skipped';
  }

  const { messages, meta } = scanSession(item.filePath);

  const cwd = meta.cwd || '';
  const project = cwd ? path.basename(cwd) : item.folderName;
  const title =
    deriveTitle({
      customTitle: meta.customTitle,
      aiTitle: meta.aiTitle,
      slug: meta.slug,
      lastPrompt: meta.lastPrompt,
      firstUserText: meta.firstUserText,
    }) || item.sessionId.slice(0, 8);

  const session = {
    sessionId: item.sessionId,
    source: meta.entrypoint === 'claude-vscode' ? 'ide' : 'cli',
    cwd,
    project,
    gitBranch: meta.gitBranch || '',
    version: meta.version || '',
    entrypoint: meta.entrypoint || '',
    title,
    model: meta.model || '',
    firstTs: meta.firstTs || (messages[0]?.ts ?? ''),
    lastTs: meta.lastTs || '',
    lastActivityMs: Math.floor(st.mtimeMs),
    msgCount: messages.length,
    subagentCount: countSubagents(item.projectDir, item.sessionId),
    fileSize: st.size,
    filePath: item.filePath,
    parserSchemaVer: SCHEMA_VERSION,
    indexedAtMs: Date.now(),
  };

  store.writeSession(session, messages);
  return 'indexed';
}

/**
 * M5 incremental tail: if a known session's file only grew, parse only the appended bytes and
 * append messages — no full re-read. Full-scan on first sight or on shrink/rewrite.
 * Returns 'indexed' | 'tailed' | 'skipped' | 'gone'.
 */
export function tailIndexOne(store, item) {
  let st;
  try { st = fs.statSync(item.filePath); } catch { return 'gone'; }
  const size = st.size, mtimeMs = Math.floor(st.mtimeMs);
  const prior = store.getIndexedFull(item.sessionId);
  if (!prior) return indexOne(store, item, { force: true });
  if (size === prior.fileSize && mtimeMs === prior.lastActivityMs) return 'skipped';
  if (size < prior.fileSize) return indexOne(store, item, { force: true }); // shrank / rewritten → resync

  const { messages, consumed, meta } = scanRange(item.filePath, prior.fileSize);
  if (!messages.length && consumed === 0) return 'skipped'; // only a partial line so far
  const startIndex = prior.msgCount || 0;
  messages.forEach((m, i) => { m.msgIndex = startIndex + i; });
  if (messages.length) store.appendMessages(item.sessionId, messages);

  const patch = { fileSize: prior.fileSize + consumed, lastActivityMs: mtimeMs, msgCount: startIndex + messages.length };
  if (meta.lastTs) patch.lastTs = meta.lastTs;
  if (meta.model) patch.model = meta.model;
  const newTitle = deriveTitle({ customTitle: meta.customTitle, aiTitle: meta.aiTitle, slug: meta.slug, lastPrompt: meta.lastPrompt });
  if (newTitle) patch.title = newTitle;
  store.patchSession(item.sessionId, patch);
  return 'tailed';
}

/** One reconcile pass over all top-level sessions (picks up new files, appends, rewrites). */
export function reconcile(store) {
  store.deleteByCwd(dataDir());   // scrub any self-transcripts indexed before the exclusion existed
  const items = enumerateSessions();
  let changed = 0;
  for (const it of items) {
    let r; try { r = tailIndexOne(store, it); } catch { r = 'err'; }
    if (r === 'tailed' || r === 'indexed') changed++;
  }
  return { changed, total: items.length };
}

/** Full index pass. onProgress(done, total, status) is optional. */
export function indexAll(store, { force = false, onProgress } = {}) {
  store.deleteByCwd(dataDir());   // scrub any self-transcripts indexed before the exclusion existed
  const items = enumerateSessions();
  let indexed = 0, skipped = 0;
  const t0 = Date.now();
  for (let i = 0; i < items.length; i++) {
    let res = 'skipped';
    try { res = indexOne(store, items[i], { force }); } catch { res = 'skipped'; }
    if (res === 'indexed') indexed++; else skipped++;
    if (onProgress) onProgress(i + 1, items.length, res);
  }
  store.meta('lastIndexMs', Date.now());
  store.meta('schemaVersion', SCHEMA_VERSION);
  return { total: items.length, indexed, skipped, elapsedMs: Date.now() - t0 };
}
