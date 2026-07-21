#!/usr/bin/env node
// Build a SANITIZED demo corpus (fake ~/.claude tree) for screenshots, GIFs, and first-run demos.
// Usage: node scripts/make-demo.mjs <outDir>   → sets up <outDir>/projects/... ; then run with
//   CLAUDE_TRANSCRIPT_PATH=<outDir>/projects AGENT_MANAGER_HOME=<outDir>/store node bin/agent-manager.mjs index && … serve
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: make-demo.mjs <outDir>'); process.exit(1); }
const projectsDir = path.join(out, 'projects');
fs.rmSync(projectsDir, { recursive: true, force: true });
fs.mkdirSync(projectsDir, { recursive: true });

const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

function session(projectPath, title, turns, { minAgo = 30, model = 'claude-opus-4-8', branch = 'main' } = {}) {
  const enc = projectPath.replace(/[/ ]/g, '-');
  const dir = path.join(projectsDir, enc);
  fs.mkdirSync(dir, { recursive: true });
  const sid = uuid();
  const lines = [];
  let t = minAgo + turns.length * 2;
  for (const [role, text] of turns) {
    const base = { sessionId: sid, timestamp: iso(t), cwd: projectPath, gitBranch: branch, version: '2.1.195', uuid: uuid(), isSidechain: false };
    if (role === 'user') lines.push({ ...base, type: 'user', message: { role: 'user', content: text } });
    else if (role === 'assistant') lines.push({ ...base, type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text }] } });
    else if (role === 'tool') lines.push({ ...base, type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id: 'toolu_' + uuidN, name: text[0], input: text[1] }] } });
    else if (role === 'sched') lines.push({ ...base, type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<scheduled-task>\n' + text + '\n</scheduled-task>' } });
    t -= 2;
  }
  lines.push({ type: 'ai-title', aiTitle: title, sessionId: sid });
  const file = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = new Date(now - minAgo * 60000);
  fs.utimesSync(file, when, when);
  return sid;
}

const P = { orbit: '/Users/demo/code/orbit-app', docs: '/Users/demo/code/docs-site', data: '/Users/demo/code/data-pipeline', mobile: '/Users/demo/code/mobile-app', infra: '/Users/demo/code/infra' };

// --- WAITING (agent ended on a question) ---
session(P.orbit, 'Add OAuth login flow', [
  ['user', 'Add Google OAuth to the login page; keep the email/password flow as a fallback.'],
  ['assistant', 'Plan: add /auth/google routes, the token exchange, and a signed session cookie. Starting on the routes.'],
  ['tool', ['Edit', { file_path: 'src/auth/google.ts' }]],
  ['assistant', 'OAuth routes are wired and the happy path works. Want me to add refresh-token rotation now, or ship login first and do rotation in a follow-up?'],
], { minAgo: 48 });

session(P.mobile, 'Add biometric auth to unlock', [
  ['user', 'Add Face ID / fingerprint unlock. Fall back to the 6-digit PIN.'],
  ['assistant', 'Integrated the platform auth API behind a small AuthGate. One question: should a failed biometric attempt fall straight to PIN, or lock for 30s after 3 fails?'],
], { minAgo: 90, model: 'claude-sonnet-5', branch: 'feature/biometric' });

session(P.data, 'Debug 2am memory spike in worker', [
  ['user', 'The ingest worker spikes to 4GB around 2am. Find out why.'],
  ['assistant', 'Found it — the parser holds the whole batch in memory. Streaming it drops the peak to ~300MB. Ship the fix behind a flag, or just replace the parser?'],
], { minAgo: 55, model: 'claude-sonnet-5' });

// --- ACTIVE-looking recent work (no live pid in demo, so these read as in-progress) ---
session(P.orbit, 'Fix flaky checkout test', [
  ['user', 'The checkout e2e test fails on CI about 1 in 5 runs. Find and fix the flake.'],
  ['assistant', 'The flake is a race: the cart badge updates async, so the assertion sometimes runs first.'],
  ['tool', ['Bash', { command: 'npx playwright test checkout --repeat-each=20' }]],
  ['assistant', '20/20 green. The fix was replacing a fixed sleep with an explicit wait on the cart-badge locator.'],
], { minAgo: 60 * 20, branch: 'ci-flake' });

session(P.infra, 'Set up auth proxy for internal tools', [
  ['user', 'Put an SSO auth proxy in front of the internal dashboards.'],
  ['assistant', 'Deployed oauth2-proxy in front of the ingress; internal apps now require SSO. Added a bypass for health checks.'],
  ['tool', ['Bash', { command: 'kubectl apply -f k8s/auth-proxy.yaml' }]],
], { minAgo: 60 * 8, branch: 'sso' });

session(P.docs, 'Write CLI quickstart guide', [
  ['user', 'Draft a quickstart for the CLI: install, first run, common flags.'],
  ['assistant', 'Drafted docs/quickstart.md — install, a 60-second tour, and a troubleshooting table for the usual install snags.'],
], { minAgo: 60 * 5 });

session(P.data, 'Add retry to the metrics rollup', [
  ['user', 'The nightly rollup sometimes fails on a transient DB error. Add a bounded retry.'],
  ['assistant', 'Wrapped the write in an exponential backoff (3 tries). Backfilled last night’s missing run — numbers match the spot checks now.'],
  ['tool', ['Bash', { command: 'python rollup.py --backfill 1' }]],
], { minAgo: 60 * 30, branch: 'metrics' });

session(P.mobile, 'Reduce cold-start time', [
  ['user', 'App cold start is 3.2s. Get it under 1.5s.'],
  ['assistant', 'Deferred the analytics SDK and lazy-loaded the settings module. Cold start is now 1.3s on a mid-tier device.'],
], { minAgo: 60 * 44, model: 'claude-sonnet-5' });

session(P.orbit, 'Rate-limit the public API', [
  ['user', 'Add per-IP rate limiting to the public API endpoints.'],
  ['assistant', 'Added a sliding-window limiter (100 req/min/IP) with a Retry-After header. Excluded the auth callback so OAuth round-trips don’t get throttled.'],
], { minAgo: 60 * 52 });

session(P.infra, 'Migrate CI to the new runners', [
  ['user', 'Move the pipeline to the new ARM runners and see if it’s cheaper.'],
  ['assistant', 'Migrated; build time dropped 40% and cost ~25%. One job still needs x86 for a native dep — pinned that one.'],
], { minAgo: 60 * 70, branch: 'ci-arm' });

// --- RECURRING (scheduled) ---
session(P.data, 'Nightly metrics rollup /loop', [
  ['sched', 'Roll daily metrics into the weekly table and post a summary to #metrics.'],
  ['assistant', 'Rollup complete. 7-day active users +4.2% WoW; no anomalies flagged.'],
], { minAgo: 60 * 9, branch: 'metrics' });

session(P.infra, 'Weekly dependency audit /schedule', [
  ['sched', 'Run the dependency and CVE audit; open issues for anything high severity.'],
  ['assistant', 'Audit done — 1 high-severity advisory in a transitive dep; opened an issue with the upgrade path.'],
], { minAgo: 60 * 33 });

// --- older / done-ish (mostly land off-board → keeps columns realistic) ---
session(P.docs, 'Polish the README hero', [
  ['user', 'Tighten the README intro and add a features table.'],
  ['assistant', 'Rewrote the intro to one line + a features table; trimmed ~40% of the words.'],
], { minAgo: 60 * 60 * 5 });

session(P.orbit, 'Upgrade to the new router', [
  ['user', 'Upgrade to router v7 and fix the breaking changes.'],
  ['assistant', 'Upgraded; migrated the 3 breaking APIs and updated the tests. All green, PR opened.'],
], { minAgo: 60 * 60 * 8, branch: 'router-v7' });

console.log('demo corpus written to', projectsDir, '(15 sessions across 5 projects)');
