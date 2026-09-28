# Privacy

Agent History reads the session transcripts that Claude Code, the Claude desktop app, and Codex
already keep on your computer, and builds a search index of them **on your computer**. There is no
Agent History server, account, analytics, or telemetry. This page lists exactly what it reads, what
it stores, and every case where data leaves your machine.

*Applies to the `agent-history-cli` npm package, the Claude Code plugin, and the VS Code / Open VSX
extension, all of which run the same local program.*

## What it reads

All read-only — Agent History never modifies, moves, or deletes these files.

| Source | Location | What is used |
|---|---|---|
| Claude Code sessions | `~/.claude/projects/**/*.jsonl` | Messages, timestamps, working folder, model, git branch |
| Claude Code live sessions | `~/.claude/sessions/*.json`, `~/.claude/ide/*.lock` | Which sessions are running now, and in which editor window |
| Claude desktop (Cowork) | `~/Library/Application Support/Claude/local-agent-mode-sessions/` | Session id, title, folder, model, timestamps, and the transcript. The account name, email address, and system prompt stored alongside are **never** read into the index |
| Codex sessions | `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/session_index.jsonl` | Messages, timestamps, working folder, model, and thread names |

It does not read credential files. To offer Codex as an optional engine (below), it asks the Codex
CLI itself whether you are signed in (`codex login status`).

## What it stores

One SQLite database, by default at `~/.claude/.agent-manager/index.db` (the folder is created with
owner-only permissions; override with `AGENT_MANAGER_HOME`). It holds message text — up to 8 KB per
message — plus session metadata and any task statuses you set on the board.

The index deliberately **outlives** the transcripts: Claude Code deletes old sessions after about
30 days, and anything already indexed stays searchable.

## When data leaves your machine

1. **Installing or updating.** `npx` downloads the `agent-history-cli` package and its dependencies
   from the public npm registry (`registry.npmjs.org`); the SQLite dependency downloads a prebuilt
   native binary from its GitHub releases. Versions are pinned by a lockfile.
2. **When your agent uses the plugin's tools.** Search results and transcript excerpts that the MCP
   server returns become part of your agent's conversation, and are therefore sent to that agent's
   model provider (for Claude Code, Anthropic) under **your** account and terms — exactly like any
   other file or context the agent reads. Before anything is returned, secrets are redacted: API
   keys and tokens from common providers, JWTs, private keys, bearer headers, and values assigned to
   names like `*_TOKEN`, `*_SECRET`, or `password` come back as `[redacted:<kind>]`.
3. **Optional AI features in the dashboard** — "Refine with AI" and the context book — run only when
   you start them, through **your own** signed-in `claude` or `codex` command-line tool, so short
   excerpts of conversation text go to Anthropic or OpenAI under your account. Before running they
   show how many calls they will make; they are capped per day; tool outputs are never included.

Nothing else is sent anywhere. The dashboard listens on `127.0.0.1` only, and rejects requests from
other websites.

## Deleting your data

Delete `~/.claude/.agent-manager/` to remove the index and everything Agent History stored. Your
original transcripts are untouched. Uninstall the plugin with `/plugin uninstall agent-history`, or
the extension from your editor.

## Contact

Questions or concerns: [open an issue](https://github.com/LinnkLabs/AgentHistory/issues).
