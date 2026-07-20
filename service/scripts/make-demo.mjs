#!/usr/bin/env node
// Build a small SANITIZED demo corpus (fake ~/.claude tree) for screenshots and first-run demos.
// Usage: node scripts/make-demo.mjs <outDir>   → sets up <outDir>/projects/... ; then run with
//   CLAUDE_TRANSCRIPT_PATH=<outDir>/projects AGENT_MANAGER_HOME=<outDir>/store node bin/agent-manager.mjs index && … serve
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: make-demo.mjs <outDir>'); process.exit(1); }
const projectsDir = path.join(out, 'projects');
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
    t -= 2;
  }
  lines.push({ type: 'ai-title', aiTitle: title, sessionId: sid });
  const file = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = new Date(now - minAgo * 60000);
  fs.utimesSync(file, when, when);
  return sid;
}

// three demo projects, friendly content only
session('/Users/demo/code/orbit-app', 'Add OAuth login flow', [
  ['user', 'Add Google OAuth to the login page, keep the email flow as fallback.'],
  ['assistant', 'Plan: add /auth/google routes, token exchange, and a session cookie. Starting with the route.'],
  ['tool', ['Edit', { file_path: 'src/auth/routes.ts' }]],
  ['assistant', 'Routes added and wired. Want me to add the refresh-token cron too?'],
], { minAgo: 42 });

session('/Users/demo/code/orbit-app', 'Fix flaky checkout test', [
  ['user', 'The checkout e2e test fails on CI about 1 in 5 runs. Find and fix the flake.'],
  ['assistant', 'The flake is a race: the cart badge updates async. Adding an explicit wait on the badge selector.'],
  ['tool', ['Bash', { command: 'npx playwright test checkout --repeat-each=20' }]],
  ['assistant', '20/20 green. The fix was replacing the sleep with a locator wait.'],
], { minAgo: 60 * 26, model: 'claude-sonnet-5' });

session('/Users/demo/code/docs-site', 'Write quickstart guide', [
  ['user', 'Draft a quickstart for the CLI: install, first run, common flags.'],
  ['assistant', 'Drafted docs/quickstart.md with install, a 60-second tour, and a troubleshooting table.'],
], { minAgo: 60 * 5, model: 'claude-opus-4-8' });

session('/Users/demo/code/data-pipeline', 'Nightly metrics rollup', [
  ['user', 'Set up the nightly job to roll daily metrics into the weekly table.'],
  ['assistant', 'Job scheduled for 03:00 with a retry. Backfilled the last 30 days — numbers match the spot checks.'],
  ['tool', ['Bash', { command: 'python rollup.py --backfill 30' }]],
], { minAgo: 60 * 49, branch: 'metrics' });

session('/Users/demo/code/data-pipeline', 'Debug memory spike in worker', [
  ['user', 'The ingest worker spikes to 4GB around 2am. Figure out why.'],
  ['assistant', 'Found it: the parser keeps the whole batch in memory. Streaming it drops peak usage to 300MB. Should I ship the fix behind a flag?'],
], { minAgo: 55, model: 'claude-sonnet-5' });

console.log('demo corpus written to', projectsDir);
