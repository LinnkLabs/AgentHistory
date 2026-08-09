// Reader C — Codex CLI/Desktop sessions (DESIGN-HANDOFF §4). Verified on-disk contract (2026-07-20):
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (+ ~/.codex/archived_sessions/*.jsonl)
//   line = {timestamp, type, payload}; types: session_meta | response_item | event_msg | turn_context
//   session_meta.payload: id, cwd (REAL path), git, cli_version, originator, timestamp
//   turn_context.payload: model, cwd, effort, …
//   response_item.payload: message(role user|assistant|developer, content[{input_text|output_text|input_image}])
//                          function_call{name,arguments} · function_call_output{output} · reasoning{summary[]}
// Own versioned parser per the two-reader discipline — never shares Claude's type allowlist.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from './store.mjs';
import { codexHomeDir } from './paths.mjs';

const CLAMP = 8 * 1024;
const clamp = (s) => { const t = String(s || '').trim(); return t.length > CLAMP ? t.slice(0, CLAMP) : t; };
// Codex-injected user blocks that are not the human typing
const INJECTED_RE = /^\s*(<(environment_context|permissions[ _]instructions|user_instructions|recommended_plugins|app_context|turn_aborted|AGENTS|ide_context|collaboration_mode|codex_delegation)|#+\s*AGENTS\.md)/i;

export function codexDirs() {
  const root = codexHomeDir();
  return { sessions: path.join(root, 'sessions'), archived: path.join(root, 'archived_sessions') };
}

/**
 * Codex names its own threads and records them in ~/.codex/session_index.jsonl
 * ({id, thread_name, updated_at}, most recent only). Those names beat anything we can derive: a
 * Codex turn often opens with an injected "# Context from my IDE setup:" block, which our
 * first-user-text heuristic would otherwise adopt as the title. Best-effort — missing file is fine.
 */
export function codexThreadNames() {
  const names = new Map();
  let raw;
  try { raw = fs.readFileSync(path.join(codexHomeDir(), 'session_index.jsonl'), 'utf8'); } catch { return names; }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const name = String(o && o.thread_name || '').trim();
    if (o && o.id && name) names.set(String(o.id), name);   // later lines win: the newest rename
  }
  return names;
}

function walkJsonl(dir, out = [], depth = 0) {
  if (depth > 5) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out, depth + 1);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

export function enumerateCodex() {
  const { sessions, archived } = codexDirs();
  return [...walkJsonl(sessions), ...walkJsonl(archived)];
}

function textOf(content, types) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && types.includes(b.type)).map((b) => String(b.text || '')).filter(Boolean).join('\n');
}

/** Parse one Codex rollout file into our session shape. */
export function scanCodex(filePath) {
  const meta = { id: '', cwd: '', gitBranch: '', version: '', model: '', originator: '', firstTs: '', lastTs: '',
    firstUserText: '', endRole: '', endKind: '', endHint: '' };
  const messages = [];
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { messages, meta }; }
  let msgIndex = 0, byteOffset = 0;
  const push = (role, kind, ts, text, start) => {
    const t = clamp(text);
    if (!t) return;
    messages.push({ msgIndex: msgIndex++, role, kind, ts, byteOffset: start, text: t, model: role === 'assistant' && kind !== 'tool_result' ? meta.model : '' });
    if (role !== 'system') { meta.endRole = role; meta.endKind = kind; meta.endHint = kind === 'text' || kind === 'tool_use' ? t.slice(0, 240) : ''; }
  };
  for (const line of raw.split('\n')) {
    const start = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf8') + 1;
    const s = line.trim();
    if (!s) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
    if (ts) { if (!meta.firstTs) meta.firstTs = ts; meta.lastTs = ts; }
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      meta.id = p.id || meta.id;
      meta.cwd = p.cwd || meta.cwd;
      meta.version = p.cli_version || meta.version;
      // Which Codex surface wrote this ("Codex Desktop" | codex_vscode | codex_exec | …) — the
      // signal the client registry turns into a real product/surface label.
      meta.originator = p.originator || meta.originator;
      if (p.git && typeof p.git === 'object' && p.git.branch) meta.gitBranch = p.git.branch;
      continue;
    }
    if (o.type === 'turn_context') { if (p.model) meta.model = p.model; if (p.cwd && !meta.cwd) meta.cwd = p.cwd; continue; }
    if (o.type !== 'response_item') continue; // event_msg etc: skip-on-unknown
    const pt = p.type;
    if (pt === 'message') {
      if (p.role === 'assistant') push('assistant', 'text', ts, textOf(p.content, ['output_text', 'text']), start);
      else if (p.role === 'user') {
        const t = textOf(p.content, ['input_text', 'text']);
        if (t) push(INJECTED_RE.test(t) ? 'system' : 'user', 'text', ts, t, start);
      } else if (p.role === 'developer') push('system', 'text', ts, textOf(p.content, ['input_text', 'text']), start);
    } else if (pt === 'function_call') {
      push('assistant', 'tool_use', ts, `${p.name || 'tool'} ${clamp(p.arguments || '')}`, start);
    } else if (pt === 'function_call_output') {
      push('tool', 'tool_result', ts, typeof p.output === 'string' ? p.output : JSON.stringify(p.output || ''), start);
    } else if (pt === 'reasoning') {
      const t = Array.isArray(p.summary) ? p.summary.map((b) => b && b.text || '').filter(Boolean).join('\n') : '';
      push('assistant', 'thinking', ts, t, start);
    }
  }
  // set first REAL user text for the title
  const fu = messages.find((m) => m.role === 'user');
  meta.firstUserText = fu ? fu.text.slice(0, 240) : '';
  return { messages, meta };
}

/** Index all Codex sessions incrementally (skip by size+mtime). Returns {total, indexed, skipped}. */
export function indexCodexAll(store, { force = false } = {}) {
  const files = enumerateCodex();
  const threadNames = codexThreadNames();
  let indexed = 0, skipped = 0;
  for (const filePath of files) {
    let st;
    try { st = fs.statSync(filePath); } catch { skipped++; continue; }
    const fromName = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    const uuid = fromName ? fromName[1] : path.basename(filePath, '.jsonl');
    const fallbackId = 'codex-' + uuid;
    const prior = store.getIndexedInfo(fallbackId);
    if (!force && prior && prior.fileSize === st.size && prior.lastActivityMs === Math.floor(st.mtimeMs)
        && (prior.parserSchemaVer || 0) >= SCHEMA_VERSION) { skipped++; continue; }

    const { messages, meta } = scanCodex(filePath);
    const sessionId = fallbackId; // filename uuid == session_meta.id in practice; filename is stable
    const cwd = meta.cwd || '';
    const title = threadNames.get(meta.id || uuid)
      || (meta.firstUserText || '').split('\n')[0].slice(0, 80)
      || sessionId.slice(0, 14);
    store.writeSession({
      sessionId, source: 'codex', cwd,
      project: cwd ? path.basename(cwd) : '(codex)',
      gitBranch: meta.gitBranch || '', version: meta.version || '', entrypoint: meta.originator || 'codex',
      title, model: meta.model || '',
      firstTs: meta.firstTs || '', lastTs: meta.lastTs || '',
      lastActivityMs: Math.floor(st.mtimeMs),
      msgCount: messages.length, subagentCount: 0,
      fileSize: st.size, filePath,
      parserSchemaVer: SCHEMA_VERSION, indexedAtMs: Date.now(),
      endRole: meta.endRole, endKind: meta.endKind, endHint: meta.endHint,
      queueDepth: 0, scheduled: 0, prUrl: '',
    }, messages);
    indexed++;
  }
  return { total: files.length, indexed, skipped };
}
