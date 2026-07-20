// Central path resolution for all Claude local surfaces + our own store.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = os.homedir();

/** Root of Claude Code's per-project transcript store (overridable, matching the ext convention). */
export function claudeProjectsDir() {
  return process.env.CLAUDE_TRANSCRIPT_PATH || path.join(HOME, '.claude', 'projects');
}

/** True when pointing at a custom transcript tree (demo/tests) — machine-wide sources (Cowork/Codex) stay out. */
export function isCustomTree() {
  return !!process.env.CLAUDE_TRANSCRIPT_PATH;
}

/** Live process registry: ~/.claude/sessions/<pid>.json (Phase 2 live-state; enumerated read-only here). */
export function sessionsRegistryDir() {
  return path.join(HOME, '.claude', 'sessions');
}

/** IDE attach locks: ~/.claude/ide/<pid>.lock */
export function ideLocksDir() {
  return path.join(HOME, '.claude', 'ide');
}

/** Desktop app support root (macOS). */
function claudeDesktopDir() {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Claude');
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'Claude');
  return null;
}
/** Desktop Cowork / local-agent-mode store — holds embedded .claude/projects transcripts. */
export function desktopCoworkDir() {
  const d = claudeDesktopDir();
  return d ? path.join(d, 'local-agent-mode-sessions') : null;
}
/** Desktop Cowork index store — local_<uuid>.json with the REAL cwd/title/model/timestamps. */
export function coworkIndexDir() {
  const d = claudeDesktopDir();
  return d ? path.join(d, 'claude-code-sessions') : null;
}

/** Our own data dir + SQLite index. Mode 0700 — transcripts + any Cowork PII are private. */
export function dataDir() {
  const dir = process.env.AGENT_MANAGER_HOME || path.join(HOME, '.claude', '.agent-manager');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function dbPath() {
  return path.join(dataDir(), 'index.db');
}

/** A UUIDv4 filename like <sessionId>.jsonl — used to distinguish real sessions from other files. */
export const SESSION_FILE_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
