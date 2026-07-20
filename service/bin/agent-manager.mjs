#!/usr/bin/env node
// agenthistory — every agent session, one board (organize / search / locate / act).
import { openStore } from '../src/store.mjs';
import { indexAll } from '../src/indexer.mjs';
import { indexCoworkAll } from '../src/cowork.mjs';
import { indexCodexAll } from '../src/codex.mjs';
import { isCustomTree } from '../src/paths.mjs';

const argv = process.argv.slice(2);
// No command (or only flags) = "up": refresh the index, then open the dashboard. `npx agenthistory` just works.
const hasCmd = argv[0] && !argv[0].startsWith('--');
const cmd = hasCmd ? argv[0] : 'up';

// Flags that consume the following token as a value; everything else after --x is boolean true.
const VALUE_FLAGS = new Set(['project', 'session', 'role', 'kind', 'port', 'limit', 'model', 'days']);
const opts = {};
const rest = []; // positionals (e.g. the search query words)
for (let i = hasCmd ? 1 : 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) { opts[name] = argv[++i]; }
    else { opts[name] = true; }
  } else {
    rest.push(a);
  }
}
function flag(name, def) { return name in opts ? opts[name] : def; }
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function rel(ms) {
  if (!ms) return '';
  const d = Date.now() - ms, s = d / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`agenthistory — every agent session, one board (Claude Code + Codex, 100% local)

Usage:
  agenthistory                               Index (incremental) + open the dashboard  ← default
  agenthistory index [--force]               Build/refresh the index from ~/.claude/projects
  agenthistory status                       Show corpus stats + recent sessions
  agenthistory search <query> [options]     Full-text search across all sessions
      --project <name>   --session <id>       scope
      --role user|assistant  --kind text|tool_use|tool_result|thinking   target
  agenthistory serve [--port 4600] [--no-open]   Start the web dashboard

  agenthistory persona extract [--limit 10] [--model x] [--dry-run]
      Distill un-seen sessions into evidence-linked facts via YOUR authenticated \`claude\` CLI
      (agent-funded: no API key stored; durable daily call cap).
  agenthistory persona facts [--all]        List persona facts (+receipts with --all)
  agenthistory persona book                 Rebuild + print the context book (context-book.md)
  agenthistory persona status               Extraction coverage, facts, signals, daily cap
  agenthistory retro [--days 7] [--digest] [--model x]
      What you worked on in the window; --digest adds one LLM-written narrative

  agenthistory mcp                          Run the MCP server (stdio) — agents query your
                                             history + context book live. Register with:
      claude mcp add -s user agent-history -- npx agenthistory mcp
`);
    return;
  }

  const store = openStore();

  if (cmd === 'up') {
    // first-run friendly default: incremental index (fast when nothing changed), then serve
    process.stdout.write('Refreshing index… ');
    const r = indexAll(store, {});
    const cw = isCustomTree() ? { total: 0 } : indexCoworkAll(store);
    const cx = isCustomTree() ? { total: 0 } : indexCodexAll(store, {});
    const s = store.stats();
    process.stdout.write(`${r.indexed + (cw.indexed || 0) + (cx.indexed || 0)} new/changed · ${s.sessions} sessions · ${s.projects} projects\n`);
    store.close();
    const { serve } = await import('../src/server.mjs');
    const port = Number(flag('port', 4600)) || 4600;
    await serve({ port, open: flag('no-open', false) !== true, watch: flag('no-watch', false) !== true });
    return;
  }

  if (cmd === 'index') {
    const force = !!flag('force', false);
    process.stdout.write('Indexing ~/.claude/projects …\n');
    let lastPct = -1;
    const r = indexAll(store, {
      force,
      onProgress: (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r  ${done}/${total} (${pct}%)   `);
        }
      },
    });
    process.stdout.write(`\r✓ Indexed ${r.indexed} new/changed, skipped ${r.skipped} (${(r.elapsedMs / 1000).toFixed(1)}s)          \n`);
    // M4: desktop Cowork (optional, best-effort)
    const cw = isCustomTree() ? { total: 0 } : indexCoworkAll(store);
    if (cw.total) process.stdout.write(`  desktop Cowork: ${cw.indexed} with transcripts, ${cw.metadataOnly} metadata-only (encrypted/migrated)\n`);
    const cx = isCustomTree() ? { total: 0 } : indexCodexAll(store, { force });
    if (cx.total) process.stdout.write(`  Codex: ${cx.indexed} indexed, ${cx.skipped} unchanged\n`);
    const s = store.stats();
    process.stdout.write(`  ${s.sessions} sessions · ${s.projects} projects · ${s.messages} messages · ${fmtBytes(s.bytes)} of transcripts\n`);
    store.close();
    return;
  }

  if (cmd === 'status') {
    const s = store.stats();
    console.log(`Corpus: ${s.sessions} sessions · ${s.projects} projects · ${s.messages} messages · ${fmtBytes(s.bytes)}`);
    const li = store.meta('lastIndexMs');
    if (li) console.log(`Last indexed: ${rel(Number(li))}`);
    console.log('\nTop projects:');
    for (const p of store.projectSummary().slice(0, 12)) {
      console.log(`  ${String(p.sessions).padStart(3)}  ${(p.project || '(unknown)').padEnd(40)} ${rel(p.lastActivityMs)}`);
    }
    console.log('\nMost recent sessions:');
    for (const r of store.listSessions().slice(0, 12)) {
      const title = (r.title || r.sessionId.slice(0, 8)).slice(0, 50);
      console.log(`  ${rel(r.lastActivityMs).padStart(9)}  ${String(r.msgCount).padStart(4)} msg  ${(r.project || '').padEnd(24).slice(0, 24)}  ${title}`);
    }
    store.close();
    return;
  }

  if (cmd === 'search') {
    const q = rest.join(' ');
    if (!q) { console.log('Usage: agenthistory search <query> [--project x] [--session id] [--role user|assistant] [--kind text|tool_use|tool_result]'); store.close(); return; }
    const scope = flag('session', null) ? 'session' : flag('project', null) ? 'project' : 'global';
    const scopeId = flag('session', null) || flag('project', null) || null;
    const hits = store.search({ q, scope, scopeId, role: flag('role', null), kind: flag('kind', null), limit: 40 });
    console.log(`${hits.length} hit(s) for "${q}"${scope !== 'global' ? ` in ${scope} ${scopeId}` : ''}\n`);
    for (const h of hits) {
      console.log(`• [${h.role}/${h.kind}] ${h.project}  ›  ${(h.title || h.sessionId.slice(0, 8)).slice(0, 46)}`);
      console.log(`    ${h.snippet.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
      console.log(`    ${h.cwd}   (session ${h.sessionId})`);
    }
    store.close();
    return;
  }

  if (cmd === 'mcp') {
    const { runMcp } = await import('../src/mcp.mjs');
    runMcp(store);       // stdio server; store stays open for the process lifetime
    return;
  }

  if (cmd === 'persona') {
    const sub = rest[0] || 'status';
    const persona = await import('../src/persona.mjs');

    if (sub === 'extract') {
      const limit = Number(flag('limit', 10)) || 10;
      const dryRun = !!flag('dry-run', false);
      console.log(dryRun
        ? `Dry run: showing up to ${limit} extraction candidates (no LLM calls)…`
        : `Extracting up to ${limit} sessions via \`claude -p\` (daily cap ${persona.DAILY_CALL_LIMIT}, used ${persona.callsUsedToday(store)})…`);
      const r = await persona.extractSessions(store, {
        limit, model: flag('model', ''), dryRun,
        onProgress: (i, total, c, res) => {
          const t = (c.title || c.sessionId.slice(0, 8)).slice(0, 46);
          if (res.dryRun) console.log(`  ${i}/${total}  ${c.project} › ${t}  (${c.userMsgs} user msgs, ${res.signals} signals, ~${Math.round(res.promptChars / 1000)}k chars)`);
          else if (res.error) console.log(`  ${i}/${total}  ✗ ${t}: ${res.error}`);
          else console.log(`  ${i}/${total}  ✓ ${t}: +${res.added} new · ${res.merged} merged · ${res.dropped} dropped by evidence gate`);
        },
      });
      if (r.capped) console.log(`  ⚠ daily call cap reached (${persona.DAILY_CALL_LIMIT}); resumes tomorrow.`);
      if (!dryRun) console.log(`Done: ${r.added} new facts, ${r.merged} merged, ${r.dropped} gate-dropped. Book: ${persona.bookPath()}`);
      store.close();
      return;
    }

    if (sub === 'facts') {
      const facts = store.listFacts();
      if (!facts.length) { console.log('No facts yet. Run: agenthistory persona extract'); store.close(); return; }
      for (const f of facts) {
        const sessions = JSON.parse(f.sessionsJson || '[]');
        console.log(`${f.status === 'active' ? '●' : '○'} [${f.kind}] ${f.statement}   (${f.observations}× · ${sessions.length} sessions · ${f.key})`);
        if (flag('all', false)) {
          for (const e of JSON.parse(f.evidenceJson || '[]').slice(0, 4)) {
            const title = store.getSessionMeta(e.sessionId)?.title || e.sessionId.slice(0, 8);
            console.log(`     ↳ “${e.quote.slice(0, 90)}” — ${title.slice(0, 40)} #${e.msgIndex}`);
          }
        }
      }
      store.close();
      return;
    }

    if (sub === 'book') {
      console.log(persona.buildBook(store));
      console.error(`\n(written to ${persona.bookPath()})`);
      store.close();
      return;
    }

    if (sub === 'status') {
      const st = store.personaStatus();
      const total = store.stats().sessions;
      console.log(`Persona: ${st.extracted}/${total} sessions distilled · facts: ${st.facts.active || 0} active, ${st.facts.forming || 0} forming · ${st.signals} mined signals`);
      console.log(`LLM calls today: ${persona.callsUsedToday(store)}/${persona.DAILY_CALL_LIMIT} (agent-funded via \`claude -p\`, no API key stored)`);
      console.log(`Book: ${persona.bookPath()}`);
      store.close();
      return;
    }

    console.log(`Unknown persona subcommand: ${sub}. Try: extract | facts | book | status`);
    store.close();
    return;
  }

  if (cmd === 'retro') {
    const persona = await import('../src/persona.mjs');
    const days = Number(flag('days', 7)) || 7;
    const report = persona.retroReport(store, { days });
    const t = report.totals;
    console.log(`Retro — last ${days} days  (${report.from.slice(0, 10)} → ${report.to.slice(0, 10)})`);
    console.log(`  ${t.sessions || 0} sessions · ${t.projects || 0} projects · ${t.userMsgs || 0} prompts by you · ${t.msgs || 0} messages`);
    console.log(`  corrections you made: ${report.signals.redirect || 0} · interrupts: ${report.signals.interrupt || 0}\n`);
    const byDay = new Map();
    for (const d of report.days) { if (!byDay.has(d.day)) byDay.set(d.day, []); byDay.get(d.day).push(d); }
    for (const [day, rows] of byDay) {
      console.log(`  ${day}  ${rows.map((r) => `${r.project}(${r.userMsgs})`).slice(0, 6).join('  ')}`);
    }
    console.log('\n  Most active sessions:');
    for (const s of report.topSessions.slice(0, 8)) {
      console.log(`   ${String(s.userMsgs).padStart(4)} prompts  ${(s.project || '').padEnd(24).slice(0, 24)}  ${(s.title || '').slice(0, 50)}`);
    }
    if (flag('digest', false)) {
      console.log('\nWriting digest via claude -p …');
      const d = await persona.retroDigest(store, report, { model: flag('model', '') });
      if (d.ok) { console.log('\n' + d.text + `\n\n(saved to ${d.file})`); }
      else console.log(`  ✗ ${d.error}`);
    }
    store.close();
    return;
  }

  if (cmd === 'serve') {
    store.close();
    const { serve } = await import('../src/server.mjs');
    const port = Number(flag('port', 4600)) || 4600;
    await serve({ port, open: flag('no-open', false) !== true, watch: flag('no-watch', false) !== true });
    return; // server keeps process alive
  }

  console.log(`Unknown command: ${cmd}. Try: agenthistory help`);
  store.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
