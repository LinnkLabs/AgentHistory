# agent-manager

A local-first **librarian** for every Claude session. Organize, search, and locate across the
Claude Code CLI and the VS Code / Cursor extension — all from `~/.claude/projects/**/*.jsonl`,
100% local, no auth. Implements the search-first MVP (M0–M3) of the [Agent Manager PRD](../PRD.md).

## What it does (the three outputs)

- **O1 — Glance, organized.** Every session, grouped by project, sorted by recency. Nothing hidden.
- **O2 — Scoped keyword search.** Search `global / project / session` × target
  (*your input* · *Claude output* · *commands* · *tool outputs*) via SQLite FTS5/BM25.
- **O3 — Locate.** Every hit shows **project › real folder › session › message**, and click-to-jump
  scrolls to the exact message with the keyword highlighted. Copy `claude --resume`, reveal folder.

## Install & run

```bash
cd "Agent Manager/service"
npm install                 # one native dep: better-sqlite3
node bin/agent-manager.mjs index      # build the index (~20–30s for ~230 sessions)
node bin/agent-manager.mjs serve      # opens http://127.0.0.1:4600
```

(Published as `npx agent-manager` later — the bin is already wired.)

## CLI

```
agent-manager index [--force]                 build/refresh the index
agent-manager status                          corpus stats + recent sessions
agent-manager search <query> [options]        full-text search
    --project <name>   --session <id>          scope
    --role user|assistant                       target
    --kind text|tool_use|tool_result|thinking   target
agent-manager serve [--port 4600] [--no-open]  web dashboard
```

## How it works

- **Indexer** (`src/indexer.mjs`): enumerate-first. Only top-level `UUID.jsonl` files (subagents under
  `<id>/subagents/` are *counted*, not parsed). One tolerant streaming pass per session
  (`src/parse.mjs`) extracts card metadata **and** every message tagged with `role`+`kind`. Incremental
  via `(size, mtime)`. cwd is read from inside the JSONL (never decoded from the lossy folder name).
- **Store** (`src/store.mjs`): `better-sqlite3` (WAL) with a `messages` table + an **external-content
  FTS5** index. `role`/`kind` drive O2 target filters; `sessionId` joins `sessions` for O3 provenance.
- **Server** (`src/server.mjs`): Node built-in `http`, REST + a self-contained web dashboard
  (`src/web/`, no build step). Endpoints: `/api/sessions`, `/api/session/:id`, `/api/search`, `/api/stats`.

## Verified on a real tree

229 sessions · 30 projects · **73k messages · 638 MB** → cold index **~19–32 s**, search **P95 ~76 ms**.
Data model + benchmarks: [../DATA-MODEL.md](../DATA-MODEL.md).

## Also included

- **Light/dark theme** (persisted), **collapsible** result groups, transcript **name-match highlighting**.
- **M4 — desktop Cowork**: ingests `~/Library/Application Support/Claude/local-agent-mode-sessions`
  transcripts (real project from the sibling metadata's `userSelectedFolders`; only cwd/title/model kept,
  no PII), tagged `desktop-cowork`, merged into the same overview + search.
- **M5 — live**: `serve` watches the tree (5s reconcile, byte-offset tail — only appended bytes are
  parsed, partial lines buffered), exposes `/api/version`; the UI polls it and refreshes without
  disrupting the open transcript. A green dot shows it's live (watch is on by default; `serve --no-watch` disables it).

- **Open in Claude Code**: the transcript header's primary button hands the session off to the live
  tool — if a VS Code/Cursor/Windsurf window has the session's folder open, it focuses that window and
  fires `<ide>://anthropic.claude-code/open?session=<id>`; otherwise it opens Terminal running
  `claude --resume` in the right cwd; otherwise it copies the resume command. When a search match is
  active, the matched block's text is copied to the clipboard first (deep links can't scroll to a
  message — paste to locate it on the other side). Cowork sessions aren't resumable and say so.
  API: `POST /api/open-in-claude {sessionId, dryRun?}`.

## Roadmap (Phase 2)

Live-state (PID registry), resume/focus-IDE, cost rollups, notifications, cloud managed-session cards.
See [../PRD.md](../PRD.md) §6.

## Persona layer & Insights (shipped 2026-07-19)

Distills your session histories into an evidence-linked model of you — the **context book** — plus
a retrospective view of what you worked on. Persome-inspired discipline, adapted to transcripts:

- **Signal mining (no LLM):** detects your corrections of the agent (redirects after Claude's
  output, `[Request interrupted]`) — the highest-value preference signal transcripts contain.
- **Agent-funded extraction:** spawns *your own* authenticated `claude -p` (headless) to propose
  facts — no API key stored, durable daily call cap (default 50, `AGENT_MANAGER_PERSONA_DAILY_LIMIT`).
- **Evidence gate:** every fact must quote a verbatim passage that really exists at the cited
  message (receipt = sessionId + msgIndex); tool outputs never reach prompts (secrets stay out).
- **Recurrence promotion:** facts start `forming`; only ≥2 independent sessions make them `active`.
  Changed statements keep a supersession history instead of being overwritten.
- **Self-exclusion:** transcripts of our own `claude -p` calls are never indexed (no feedback loop).

```
agent-manager persona extract [--limit 10] [--dry-run] [--model x]   # distill sessions
agent-manager persona facts [--all]                                  # facts (+receipts)
agent-manager persona book                                           # rebuild + print context-book.md
agent-manager persona status                                         # coverage · facts · daily cap
agent-manager retro [--days 7] [--digest]                            # what you worked on; --digest = LLM narrative
```

The book lives at `~/.claude/.agent-manager/context-book.md` — paste it into any project's
CLAUDE.md (or a new machine) to give every future session your working style. In the dashboard,
the **✦ Insights** button shows the retro (activity by day, most active sessions, your recent
corrections) and the context book with click-through to each fact's evidence.
API: `GET /api/retro?days=7`, `GET /api/persona/book|facts`, `POST /api/persona/extract`.

## Agent Portrait (shipped 2026-07-19)

`/portrait.html` — a full-bleed, self-contained visualization of you × your agents, computed
entirely locally from `/api/viz`. Five scenes: animated hero (days together / sessions / prompts /
projects / subagents, starting from your first-ever session), rhythm (contribution heatmap +
streaks + peak-hour histogram), attention river (weekly streamgraph of prompts across projects),
the persona constellation (facts orbit "YOU"; active = bright & close, forming = dim & far;
click a star → statement + verbatim receipts), and your corrections. Ends in a "Make it work for
you" panel: copy the context book for CLAUDE.md, draft standing rules from repeated corrections,
download the book for non-Claude agents, and the weekly `retro --digest` loop. Linked from the
dashboard via ✦ Insights → "✨ Your Portrait".

## MCP server — always-on memory for every agent (shipped 2026-07-19)

`agent-manager mcp` runs a dependency-free stdio MCP server (newline-delimited JSON-RPC 2.0) so
any MCP client — Claude Code, Codex, Cursor, Claude Desktop — can pull your context live instead
of via paste. Registered for Claude Code with:

```
claude mcp add -s user agent-history -- node <abs-path>/service/bin/agent-manager.mjs mcp
```

Five read-only tools (stdout carries only protocol frames; logs go to stderr; nothing mutates the store):

| Tool | What agents get |
|---|---|
| `get_context_book` | The evidence-linked model of the user — read first to adapt to how they work |
| `search_history` | BM25 search across ALL sessions/projects/months (target: input/output/commands/toolout) |
| `get_persona_facts` | Structured facts + receipts (sessionId+msgIndex), filter active/forming |
| `get_recent_activity` | Per-day per-project rollup, top sessions, recent corrections |
| `read_session` | Transcript excerpt around any receipt/search hit + the `claude --resume` command |

The loop this closes: an agent can ask "how does this user like to work?" (context book), "have we
solved this before?" (search → read_session), and "what were they just doing?" (recent activity) —
Agent History becomes the persistent memory layer under every agent you run.
