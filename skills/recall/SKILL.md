---
name: recall
description: Search the user's past Claude Code and Codex sessions before re-deriving something they may already have worked out. Use when the user refers to earlier work ("like last time", "did we already…", "what was that command", "the fix from the other project", "where did we land on X"), when a task looks like something they have likely done before, or when a decision, error, or config value may have been settled in an earlier session.
---

# Recall past sessions

The `agent-history` MCP server indexes every Claude Code and Codex session on this machine —
every project, including sessions whose transcripts were cleaned up. Check it before rebuilding
from scratch: the user has often already solved this, somewhere else.

## How to search

1. **`search_history`** with 2–4 distinctive keywords. Terms are ANDed and prefix-matched, so prefer
   specific nouns (`stripe webhook retry`) over phrasing (`how did we handle webhooks`).
   - `target: "commands"` finds the exact command that was run — the best way to recover an
     incantation. `target: "input"` searches only what the user typed; `"output"` only agent replies.
   - `project` narrows to one folder. `sort: "recent"` when the user means the latest attempt;
     `sort: "mentions"` to find the session that dealt with a topic most.
2. **`read_session`** with a hit's `sessionId` and `msgIndex` to read the surrounding conversation
   before relying on a snippet. Snippets are fragments; the reasoning around them matters.
3. If nothing matches, try synonyms or fewer terms once, then say plainly that you found nothing.

## Using what you find

- **Say where it came from**: the session title and date, e.g. "In *Migrate CI to ARM runners*
  (Sep 11) you pinned the one x86 job instead of dropping it." Let the user judge whether it still
  holds.
- **Treat it as history, not truth.** Code, versions, and decisions change. Verify a recalled fix
  against the current repository before applying it.
- **Values shown as `[redacted:<kind>]` were secrets** and are withheld deliberately. Don't try to
  reconstruct them or ask the user to paste them into the chat — tell them where the value was used
  so they can retrieve it from their own secret store.
- A hit's `resumeCommand` (from `read_session`) reopens that session in its own tool —
  `claude --resume` or `codex resume`. Offer it when the user wants to continue that work directly.

If a result carries a note that the index is still being built, the plugin was just installed:
say so, and suggest trying again in a minute.
