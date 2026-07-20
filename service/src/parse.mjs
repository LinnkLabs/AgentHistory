// Tolerant parsing of Claude Code project JSONL.
//
// Two hard rules from the verified data model:
//   1. Type-discriminate BEFORE touching any envelope field (10.9% of lines lack uuid/ts/cwd).
//   2. cwd MUST come from a line's `cwd` field — never decode the folder name (lossy).
//
// We index message TEXT tagged with (role, kind) so O2 "search input vs output" works:
//   role=user  kind=text          -> your input
//   role=assistant kind=text      -> Claude's output
//   kind=tool_use                 -> commands the agent ran (name + input)
//   kind=tool_result              -> tool outputs
//   kind=thinking                 -> reasoning (indexed, filterable)
import fs from 'node:fs';

// Skip base64/image/huge-blob bloat when indexing tool output text.
const MAX_BLOCK_TEXT = 8 * 1024; // cap per block (verified: 92MB file -> 2.9MB real text)
const BASE64_RE = /^[A-Za-z0-9+/=\s]{2048,}$/;

function clampText(s) {
  if (typeof s !== 'string') return '';
  s = s.trim();
  if (!s) return '';
  if (s.length > MAX_BLOCK_TEXT) s = s.slice(0, MAX_BLOCK_TEXT);
  if (BASE64_RE.test(s)) return ''; // drop base64 blobs entirely
  return s;
}

/** Normalize a tool_result content payload (string | blocks | object) to searchable text. */
function toolResultText(content) {
  if (typeof content === 'string') return clampText(content);
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return clampText(content.text);
    try { return clampText(JSON.stringify(content)); } catch { return ''; }
  }
  return '';
}

// Claude Code writes many NON-human things as type:"user" (task notifications, hook output, slash-command
// echoes, interrupts). The authoritative signal is `origin.kind`; we also match known injected-content tags
// as a fallback. These must NOT be labeled as the human's input.
// Content blocks Claude Code auto-injects (IDE context, hook output, slash-command echoes, scheduled/loop
// triggers, interrupts). NOTE: excludes <uploaded_files> — its real user text sits in the same block.
const INJECTED_TAG_RE = /^\s*(?:<task-notification|<system-reminder|<ide_opened_file|<ide_selection|<local-command-caveat|<local-command-stdout|<local-command-stderr|<command-name|<command-message|<command-args|<user-prompt-submit-hook|<scheduled-task|<<autonomous-loop|\[Request interrupted)/;
const isInjectedText = (s) => INJECTED_TAG_RE.test(String(s || ''));
// The whole event is injected when Claude Code tags it: origin.kind (task-notification, peer) or isMeta.
const eventLevelInjected = (o) => !!(o && ((o.origin && typeof o.origin === 'object' && o.origin.kind) || o.isMeta === true));

/**
 * Extract indexable messages from one parsed JSONL event.
 * Returns an array of { role, kind, ts, text } (may be empty).
 * role ∈ user (human) | assistant (model) | tool (tool_result) | system (injected: notifications/hooks/commands).
 */
export function messagesFromEvent(o) {
  const out = [];
  const type = o && o.type;
  if (type !== 'user' && type !== 'assistant') return out;
  const msg = o.message;
  if (!msg || typeof msg !== 'object') return out;
  const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
  const content = msg.content;
  const model = type === 'assistant' && typeof msg.model === 'string' ? msg.model : '';

  if (type === 'user') {
    // Classify per TEXT BLOCK: an event can mix injected context (IDE/hook) with the human's real prompt.
    const evInjected = eventLevelInjected(o);
    const textRole = (s) => (evInjected || isInjectedText(s)) ? 'system' : 'user';
    if (typeof content === 'string') {
      const t = clampText(content);
      if (t) out.push({ role: textRole(content), kind: 'text', ts, text: t, model: '' });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          const t = clampText(b.text);
          if (t) out.push({ role: textRole(b.text), kind: 'text', ts, text: t, model: '' });
        } else if (b.type === 'tool_result') {
          const t = toolResultText(b.content);
          if (t) out.push({ role: 'tool', kind: 'tool_result', ts, text: t, model: '' }); // tool output, not the human or Claude
        }
      }
    }
    return out;
  }

  // assistant
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        const t = clampText(b.text);
        if (t) out.push({ role: 'assistant', kind: 'text', ts, text: t, model });
      } else if (b.type === 'thinking') {
        const t = clampText(b.thinking);
        if (t) out.push({ role: 'assistant', kind: 'thinking', ts, text: t, model });
      } else if (b.type === 'tool_use') {
        let input = '';
        try { input = JSON.stringify(b.input); } catch { input = ''; }
        const t = clampText(`${b.name || 'tool'} ${input}`);
        if (t) out.push({ role: 'assistant', kind: 'tool_use', ts, text: t, model });
      }
    }
  }
  return out;
}

/** Pretty-print a dash slug: "find-out-x" -> "Find out x". */
export function prettySlug(slug) {
  if (!slug || typeof slug !== 'string') return '';
  const s = slug.replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** First plain-text of a user message content (string or blocks). */
function firstUserText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text.trim();
    }
  }
  return '';
}

/**
 * Read the HEAD of a session file (~first user line): first-user-text, cwd, gitBranch,
 * version, entrypoint, firstTimestamp, slug. One buffered read, no full scan.
 */
export function readHead(filePath, bytes = 64 * 1024) {
  const info = { firstUserText: '', cwd: '', gitBranch: '', version: '', entrypoint: '', firstTs: '', slug: '' };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const chunk = buf.toString('utf8', 0, n);
    const lines = chunk.split('\n');
    // last line may be partial; drop it unless the chunk covered the whole file
    if (n === bytes) lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let o;
      try { o = JSON.parse(s); } catch { continue; }
      if (o.cwd && !info.cwd) info.cwd = o.cwd;
      if (o.gitBranch && !info.gitBranch) info.gitBranch = o.gitBranch;
      if (o.version && !info.version) info.version = o.version;
      if (o.entrypoint && !info.entrypoint) info.entrypoint = o.entrypoint;
      if (o.slug && !info.slug) info.slug = o.slug;
      if (o.timestamp && !info.firstTs) info.firstTs = o.timestamp;
      if (o.type === 'user' && o.message && !info.firstUserText) {
        info.firstUserText = firstUserText(o.message.content).slice(0, 240);
      }
      if (info.cwd && info.firstUserText && info.firstTs) break;
    }
  } catch { /* ignore */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
  return info;
}

/**
 * Read the TAIL of a session file (~last N KB): latest custom-title/ai-title/last-prompt,
 * last timestamped line (true end-ts), last assistant model + stop_reason.
 */
export function readTail(filePath, size, bytes = 64 * 1024) {
  const info = { customTitle: '', aiTitle: '', lastPrompt: '', slug: '', lastTs: '', model: '', stopReason: '' };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n');
    if (start > 0) lines.shift(); // first line likely partial when we didn't read from 0
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let o;
      try { o = JSON.parse(s); } catch { continue; }
      switch (o.type) {
        case 'custom-title': if (o.customTitle) info.customTitle = o.customTitle; break;
        case 'ai-title': if (o.aiTitle) info.aiTitle = o.aiTitle; break;   // keep LAST
        case 'last-prompt': if (o.lastPrompt) info.lastPrompt = o.lastPrompt; break;
      }
      if (o.slug) info.slug = o.slug;
      if (o.timestamp) info.lastTs = o.timestamp;
      if (o.type === 'assistant' && o.message) {
        if (o.message.model) info.model = o.message.model;
        if (o.message.stop_reason) info.stopReason = o.message.stop_reason;
      }
    }
  } catch { /* ignore */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
  return info;
}

/**
 * Single-pass scan of a whole session file: extracts indexable messages AND all card metadata
 * reliably (cwd/version/etc. can sit on a first line larger than any HEAD buffer, so we gather
 * them from any line during the full read we already do for FTS). Tolerant: skips malformed lines.
 */
export function scanSession(filePath) {
  const meta = {
    cwd: '', gitBranch: '', version: '', entrypoint: '', firstTs: '', lastTs: '',
    slug: '', firstUserText: '', customTitle: '', aiTitle: '', lastPrompt: '', model: '', stopReason: '',
    // task-status signals (P1-lite): what the session ENDED on + recurring/PR markers
    endRole: '', endKind: '', endHint: '', queueDepth: 0, scheduled: 0, prUrl: '',
  };
  const messages = [];
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { messages, meta }; }
  let msgIndex = 0, byteOffset = 0;
  for (const line of raw.split('\n')) {
    const start = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf8') + 1;
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    // metadata (type-tolerant, .get-style access)
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.gitBranch && !meta.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.version && !meta.version) meta.version = o.version;
    if (o.entrypoint && !meta.entrypoint) meta.entrypoint = o.entrypoint;
    if (o.slug) meta.slug = o.slug;
    if (typeof o.timestamp === 'string') { if (!meta.firstTs) meta.firstTs = o.timestamp; meta.lastTs = o.timestamp; }
    if (o.type === 'custom-title' && o.customTitle) meta.customTitle = o.customTitle;
    if (o.type === 'ai-title' && o.aiTitle) meta.aiTitle = o.aiTitle;          // keep LAST
    if (o.type === 'last-prompt' && o.lastPrompt) meta.lastPrompt = o.lastPrompt;
    if (o.type === 'user' && o.message && !meta.firstUserText) meta.firstUserText = firstUserText(o.message.content).slice(0, 240);
    if (o.type === 'assistant' && o.message) { if (o.message.model) meta.model = o.message.model; if (o.message.stop_reason) meta.stopReason = o.message.stop_reason; }
    // task-status signals
    if (o.type === 'queue-operation') {
      if (o.operation === 'enqueue') meta.queueDepth++;
      else if (o.operation === 'dequeue' || o.operation === 'remove') meta.queueDepth = Math.max(0, meta.queueDepth - 1);
    }
    if (o.type === 'pr-link' && o.prUrl) meta.prUrl = o.prUrl;
    // messages for FTS
    for (const mm of messagesFromEvent(o)) {
      messages.push({ msgIndex: msgIndex++, role: mm.role, kind: mm.kind, ts: mm.ts, byteOffset: start, text: mm.text, model: mm.model || '' });
      trackEndSignals(meta, mm);
    }
  }
  return { messages, meta };
}

/** Update meta's end-of-session signals with each surfaced message (also used by the tail scanner). */
export function trackEndSignals(meta, mm) {
  if (mm.role === 'system') {
    if (/^\s*<scheduled-task|^\s*<<autonomous-loop/.test(mm.text || '')) meta.scheduled = 1;
    return; // injected content never counts as the "end" of the conversation
  }
  meta.endRole = mm.role; meta.endKind = mm.kind;
  meta.endHint = mm.kind === 'text' || mm.kind === 'tool_use' ? String(mm.text || '').slice(0, 240) : '';
}

/**
 * Byte-offset tail scan (M5): parse only COMPLETE lines from `startByte` to EOF.
 * Returns { messages (role/kind/ts/text/byteOffset), consumed (bytes up to last newline), meta }.
 * A partial trailing line (no terminating newline) is left unconsumed for the next pass.
 */
export function scanRange(filePath, startByte) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = size - startByte;
    if (len <= 0) return { messages: [], consumed: 0, meta: {} };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, startByte);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { messages: [], consumed: 0, meta: {} }; // no complete line yet
    const text = buf.subarray(0, lastNl + 1).toString('utf8');
    const messages = [], meta = {};
    let offset = startByte;
    for (const line of text.split('\n')) {
      const start = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
      const s = line.trim();
      if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (typeof o.timestamp === 'string') meta.lastTs = o.timestamp;
      if (o.type === 'ai-title' && o.aiTitle) meta.aiTitle = o.aiTitle;
      if (o.type === 'custom-title' && o.customTitle) meta.customTitle = o.customTitle;
      if (o.type === 'last-prompt' && o.lastPrompt) meta.lastPrompt = o.lastPrompt;
      if (o.slug) meta.slug = o.slug;
      if (o.type === 'assistant' && o.message && o.message.model) meta.model = o.message.model;
      if (o.type === 'queue-operation') {
        if (o.operation === 'enqueue') meta.queueDelta = (meta.queueDelta || 0) + 1;
        else if (o.operation === 'dequeue' || o.operation === 'remove') meta.queueDelta = (meta.queueDelta || 0) - 1;
      }
      if (o.type === 'pr-link' && o.prUrl) meta.prUrl = o.prUrl;
      for (const mm of messagesFromEvent(o)) {
        messages.push({ role: mm.role, kind: mm.kind, ts: mm.ts, text: mm.text, byteOffset: start, model: mm.model || '' });
        trackEndSignals(meta, mm);
      }
    }
    return { messages, consumed: lastNl + 1, meta };
  } catch {
    return { messages: [], consumed: 0, meta: {} };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* */ }
  }
}

/** Title priority chain (first hit wins). */
export function deriveTitle({ customTitle, aiTitle, slug, lastPrompt, firstUserText: fut }) {
  if (customTitle) return customTitle;
  if (aiTitle) return aiTitle;
  const ps = prettySlug(slug);
  if (ps) return ps;
  if (lastPrompt) return lastPrompt.slice(0, 80);
  if (fut) return fut.slice(0, 80);
  return '';
}
