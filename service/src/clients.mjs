// Client registry — the single authority on WHICH agent product wrote a session, what its
// assistant is called, how it is badged, and how a session is handed back to it.
//
// Why this exists: label and action sites used to re-derive client identity ad hoc, each with its
// own ternary and each defaulting to Claude — so every Codex transcript said "Claude" and offered a
// `claude --resume` command that cannot work. All of that now flows from one table.
//
// Recognition inputs (both already stored; no schema change):
//   source     — which reader ingested it: cli | ide | desktop-cowork | codex
//   entrypoint — the surface, as the tool itself reported it:
//                  Claude: claude-vscode · sdk-cli · sdk-ts · claude-desktop · cli
//                  Codex:  session_meta.payload.originator — "Codex Desktop" · codex_vscode ·
//                          codex_sdk_ts · codex_work_desktop · codex_exec ·
//                          codex-chrome-extension-sidepanel
//
// THE INVARIANT: an unrecognised entrypoint falls back INSIDE its source's family. Only a genuinely
// unknown source yields `unknown`. No path leads from Codex data to a Claude label — that is what
// makes this a fix for the class of bug rather than for one screenshot.
//
// Adding a client = one reader + one entry here + one line in ENTRYPOINTS. Nothing else.

/**
 * handoff:  how a session can be reopened. ide = deep-link into a live editor window; terminal =
 *           spawn the CLI's own resume command; none = it cannot be reopened (say so, don't guess).
 * liveness: what evidence proves it's RUNNING. pid = Claude's validated ~/.claude/sessions registry;
 *           growth = recent transcript growth (Codex publishes no registry, so this is the honest
 *           proxy); none = runs where we can't observe it (Cowork's sandbox VM). Never "assume idle".
 */
export const CLIENTS = {
  'claude-code-cli': {
    family: 'claude', product: 'Claude Code', surface: 'CLI', assistant: 'Claude',
    glyph: '✱', badge: 'claude', handoff: 'ide', liveness: 'pid', resume: 'claude',
  },
  'claude-code-ide': {
    family: 'claude', product: 'Claude Code', surface: 'VS Code', assistant: 'Claude',
    glyph: '✱', badge: 'ide', handoff: 'ide', liveness: 'pid', resume: 'claude',
  },
  'claude-code-sdk': {
    // headless/print-mode runs (`claude -p`, Agent SDK). Resumable, but never has a live IDE window.
    family: 'claude', product: 'Claude Code', surface: 'SDK', assistant: 'Claude',
    glyph: '✱', badge: 'claude', handoff: 'terminal', liveness: 'pid', resume: 'claude',
  },
  'claude-desktop': {
    // Cowork / local-agent sessions run in a sandbox VM — the CLI cannot resume them.
    family: 'claude', product: 'Claude', surface: 'Desktop', assistant: 'Claude',
    glyph: '✱', badge: 'cowork', handoff: 'none', liveness: 'none', resume: '',
  },
  'codex-desktop': {
    family: 'codex', product: 'Codex', surface: 'Desktop', assistant: 'Codex',
    glyph: '◎', badge: 'codex', handoff: 'terminal', liveness: 'growth', resume: 'codex',
  },
  'codex-ide': {
    family: 'codex', product: 'Codex', surface: 'VS Code', assistant: 'Codex',
    glyph: '◎', badge: 'codex', handoff: 'terminal', liveness: 'growth', resume: 'codex',
  },
  'codex-cli': {
    family: 'codex', product: 'Codex', surface: 'CLI', assistant: 'Codex',
    glyph: '◎', badge: 'codex', handoff: 'terminal', liveness: 'growth', resume: 'codex',
  },
  'codex-sdk': {
    family: 'codex', product: 'Codex', surface: 'SDK', assistant: 'Codex',
    glyph: '◎', badge: 'codex', handoff: 'terminal', liveness: 'growth', resume: 'codex',
  },
  'codex-exec': {
    family: 'codex', product: 'Codex', surface: 'headless', assistant: 'Codex',
    glyph: '◎', badge: 'codex', handoff: 'terminal', liveness: 'growth', resume: 'codex',
  },
  'codex-chrome': {
    family: 'codex', product: 'Codex', surface: 'Chrome', assistant: 'Codex',
    glyph: '◎', badge: 'codex', handoff: 'none', liveness: 'growth', resume: '',
  },
  unknown: {
    family: 'unknown', product: 'Agent', surface: '', assistant: 'Agent',
    glyph: '◆', badge: '', handoff: 'none', liveness: 'none', resume: '',
  },
};

/** Per-family fallback when the entrypoint is unrecognised — never leaves the family. */
const FAMILY_DEFAULT = { cli: 'claude-code-cli', ide: 'claude-code-ide', 'desktop-cowork': 'claude-desktop', codex: 'codex-cli' };

// entrypoint (normalised) -> clientId. Values are what the tools actually write; new surfaces can be
// added here without touching any render site.
const ENTRYPOINTS = {
  // --- Claude ---
  claude_vscode: 'claude-code-ide',
  claude_desktop: 'claude-desktop',
  desktop: 'claude-desktop',
  sdk_cli: 'claude-code-sdk',
  sdk_ts: 'claude-code-sdk',
  sdk_py: 'claude-code-sdk',
  cli: 'claude-code-cli',
  // --- Codex (session_meta.payload.originator) ---
  codex_desktop: 'codex-desktop',
  codex_work_desktop: 'codex-desktop',
  codex_vscode: 'codex-ide',
  codex_cli_rs: 'codex-cli',
  codex: 'codex-cli',
  codex_sdk_ts: 'codex-sdk',
  codex_sdk: 'codex-sdk',
  codex_exec: 'codex-exec',
  codex_chrome_extension_sidepanel: 'codex-chrome',
};

/** "Codex Desktop" and a future "codex-desktop" must resolve identically. */
const normEntry = (e) => String(e || '').trim().toLowerCase().replace(/[-\s]+/g, '_');

/**
 * (source, entrypoint) -> clientId. Pure; always returns a key present in CLIENTS.
 * An unknown entrypoint degrades to its family's default, NOT to Claude.
 */
export function resolveClientId({ source, entrypoint } = {}) {
  const src = String(source || '').trim().toLowerCase();
  const mapped = ENTRYPOINTS[normEntry(entrypoint)];
  // The entrypoint only wins when it agrees with the source's family — a stray value must never
  // drag a Codex session into the Claude branch.
  if (mapped && (!FAMILY_DEFAULT[src] || CLIENTS[mapped].family === CLIENTS[FAMILY_DEFAULT[src]].family)) {
    return mapped;
  }
  return FAMILY_DEFAULT[src] || 'unknown';
}

/** Descriptor for a session row (accepts a stored `clientId`, else resolves). Never undefined. */
export function clientOf(session = {}) {
  const id = session.clientId && CLIENTS[session.clientId] ? session.clientId : resolveClientId(session);
  return { id, ...CLIENTS[id] };
}

/** Codex session ids are stored prefixed (`codex-<uuid>`); `codex resume` wants the bare UUID. */
export function nativeSessionId(session = {}) {
  const id = String(session.sessionId || '');
  return clientOf(session).family === 'codex' ? id.replace(/^codex-/, '') : id;
}

/**
 * The shell line that reopens this session in its own tool. '' when the client cannot resume —
 * callers must treat empty as "no command exists" rather than falling back to another tool's CLI.
 */
export function resumeCommand(session = {}) {
  const c = clientOf(session);
  if (!c.resume) return '';
  const cd = `cd ${JSON.stringify(session.cwd || '.')}`;
  if (c.resume === 'codex') return `${cd} && codex resume ${nativeSessionId(session)}`;
  return `${cd} && claude --resume ${session.sessionId}`;
}

/** Badge text: family + surface, e.g. "codex · desktop". */
export function clientBadge(session = {}) {
  const c = clientOf(session);
  const name = c.family === 'unknown' ? 'agent' : c.family === 'claude' ? 'claude' : c.family;
  return { text: c.surface ? `${name} · ${c.surface.toLowerCase()}` : name, cls: c.badge };
}

/** Label for the primary "reopen" action, e.g. "◎ Open in Codex". */
export function openLabel(session = {}) {
  const c = clientOf(session);
  return `${c.glyph} Open in ${c.product}`;
}
