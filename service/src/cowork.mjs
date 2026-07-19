// M4 — Desktop Cowork ingestion (optional, best-effort, versioned adapter).
//
// Each Cowork/local-agent session is a metadata json + a sibling transcript dir under:
//   local-agent-mode-sessions/<clientId>/<accountId>/local_<uuid>.json          <- metadata (REAL cwd/title)
//   local-agent-mode-sessions/<clientId>/<accountId>/local_<uuid>/.claude/projects/<enc>/<cliSessionId>.jsonl
//                                                                               <- transcript (Reader-A schema)
// The embedded transcript's own `cwd` is a synthetic sandbox path (/sessions/<name>), so the REAL project
// comes from the metadata's `cwd` / `userSelectedFolders`. We extract ONLY cwd/title/model/timestamps —
// never the PII the metadata also holds (accountName, emailAddress, systemPrompt). Newer desktop builds
// encrypt transcripts into a VM image; when unreadable we still surface a metadata-only card.
import fs from 'node:fs';
import path from 'node:path';
import { desktopCoworkDir } from './paths.mjs';
import { scanSession, deriveTitle } from './parse.mjs';
import { SCHEMA_VERSION } from './store.mjs';

// Collect local_<uuid>.json metadata files, without descending into transcript dirs / plugin junk.
function walkMetaFiles(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^local_/.test(e.name) || /plugins?$/.test(e.name) || e.name === 'debug') continue;
      walkMetaFiles(p, out, depth + 1);
    } else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Find the transcript jsonl for a metadata file (sibling local_<uuid>/.claude/projects/<enc>/<cli>.jsonl). */
function findTranscript(metaPath, cliSessionId) {
  const localId = path.basename(metaPath, '.json');
  const projectsDir = path.join(path.dirname(metaPath), localId, '.claude', 'projects');
  let best = null, bestSize = -1, subdirs;
  try { subdirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const sd of subdirs) {
    if (!sd.isDirectory()) continue;
    let files; try { files = fs.readdirSync(path.join(projectsDir, sd.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(projectsDir, sd.name, f);
      if (cliSessionId && f === cliSessionId + '.jsonl') return full;
      let sz = 0; try { sz = fs.statSync(full).size; } catch { /* */ }
      if (sz > bestSize) { bestSize = sz; best = full; }
    }
  }
  return best;
}

export function enumerateCowork() {
  const root = desktopCoworkDir();
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const metaPath of walkMetaFiles(root)) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
    if (!meta || !meta.sessionId) continue;
    // userSelectedFolders[0] is the REAL host folder; meta.cwd is the synthetic /sessions/<name> sandbox path.
    const realCwd = (Array.isArray(meta.userSelectedFolders) && meta.userSelectedFolders[0]) || meta.originCwd || '';
    const cwd = realCwd || meta.cwd || '';
    // keep ONLY non-PII fields
    const safe = { sessionId: meta.sessionId, cliSessionId: meta.cliSessionId, cwd, title: meta.title,
      model: meta.model, createdAt: meta.createdAt, lastActivityAt: meta.lastActivityAt };
    out.push({ metaPath, meta: safe, transcriptPath: findTranscript(metaPath, meta.cliSessionId) });
  }
  return out;
}

function toIso(ms) { try { return ms ? new Date(ms).toISOString() : ''; } catch { return ''; } }

export function indexCoworkOne(store, item) {
  const { meta, transcriptPath } = item;
  const sessionId = meta.sessionId;
  let size = 0, mtimeMs = meta.lastActivityAt || 0;
  if (transcriptPath) { try { const st = fs.statSync(transcriptPath); size = st.size; mtimeMs = Math.max(mtimeMs, Math.floor(st.mtimeMs)); } catch { /* */ } }

  let messages = [], m = {};
  if (transcriptPath) { try { const sc = scanSession(transcriptPath); messages = sc.messages; m = sc.meta; } catch { /* encrypted */ } }
  const cwd = meta.cwd || '';
  const title = meta.title || deriveTitle({ aiTitle: m.aiTitle, slug: m.slug, lastPrompt: m.lastPrompt, firstUserText: m.firstUserText }) || sessionId.slice(0, 14);

  store.writeSession({
    sessionId, source: 'desktop-cowork', cwd,
    project: cwd ? path.basename(cwd) : '(cowork)',
    gitBranch: m.gitBranch || '', version: m.version || '', entrypoint: 'desktop',
    title, model: meta.model || m.model || '',
    firstTs: toIso(meta.createdAt) || m.firstTs || '',
    lastTs: toIso(meta.lastActivityAt) || m.lastTs || '',
    lastActivityMs: mtimeMs || Date.now(),
    msgCount: messages.length, subagentCount: 0, fileSize: size,
    filePath: transcriptPath || item.metaPath,
    parserSchemaVer: SCHEMA_VERSION, indexedAtMs: Date.now(),
  }, messages);
  return transcriptPath ? 'indexed' : 'metadata-only';
}

/** Full rebuild of the desktop-cowork source (prunes stale, small secondary surface). */
export function indexCoworkAll(store, { onProgress } = {}) {
  const items = enumerateCowork();
  if (!items.length) return { total: 0, indexed: 0, metadataOnly: 0 };
  store.deleteBySource('desktop-cowork');
  let indexed = 0, metadataOnly = 0;
  for (let i = 0; i < items.length; i++) {
    let res;
    try { res = indexCoworkOne(store, items[i]); } catch { res = 'skipped'; }
    if (res === 'indexed') indexed++; else if (res === 'metadata-only') metadataOnly++;
    if (onProgress) onProgress(i + 1, items.length);
  }
  return { total: items.length, indexed, metadataOnly };
}
