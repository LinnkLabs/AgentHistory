// Service lifecycle for the Agent Manager extension — no `vscode` dependency (unit-testable).
// The extension is a THIN CLIENT: it reuses a running agent-manager service if present,
// otherwise auto-spawns one, and (as a last resort) the caller can fall back to a message.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

/** GET http://127.0.0.1:<port>/api/stats — resolves stats object or null (not running). */
function healthCheck(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stats', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Locate the service entry: explicit config → sibling ../service/bin → null (=> use npx). */
function resolveServiceEntry(extensionDir, configuredEntry) {
  if (configuredEntry && fs.existsSync(configuredEntry)) return configuredEntry;
  const sibling = path.resolve(extensionDir, '..', 'service', 'bin', 'agent-manager.mjs');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

/**
 * Spawn the service detached so it outlives this window and is shared with other clients.
 * IMPORTANT: use SYSTEM node (default 'node'), never the extension host's process.execpath —
 * that is the Electron binary, whose native ABI would not match the service's better-sqlite3 build.
 */
function startService({ port, entry, nodePath = 'node' }) {
  const cmd = entry ? nodePath : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const args = entry
    ? [entry, 'serve', '--port', String(port), '--no-open']
    : ['--yes', 'agent-manager', 'serve', '--port', String(port), '--no-open'];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** Poll health until the service answers or we time out. */
async function waitForHealth(port, { timeoutMs = 15000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await healthCheck(port);
    if (stats) return stats;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Ensure a service is reachable on `port`. Returns { url, stats, spawned }.
 * Throws if it cannot be started.
 */
async function ensureService({ port, extensionDir, configuredEntry, nodePath = 'node' }) {
  let stats = await healthCheck(port);
  if (stats) return { url: `http://127.0.0.1:${port}`, stats, spawned: false };
  const entry = resolveServiceEntry(extensionDir, configuredEntry);
  startService({ port, entry, nodePath });
  stats = await waitForHealth(port);
  if (!stats) throw new Error(`agent-manager service did not start on port ${port}` + (entry ? '' : ' (no local entry found; is `agent-manager` installed for npx?)'));
  return { url: `http://127.0.0.1:${port}`, stats, spawned: true };
}

module.exports = { healthCheck, resolveServiceEntry, startService, waitForHealth, ensureService };
