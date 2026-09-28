# Changelog

## 0.1.9

- **Dependencies are locked.** The package now ships an `npm-shrinkwrap.json`, so every install —
  including the plugin's `npx` launch — gets the exact dependency tree that was reviewed.
- **No credential files are touched.** Whether you are signed in to Codex is now asked of the Codex
  CLI (`codex login status`) instead of checking for its credential file.
- **Codex is found again after the September ChatGPT update**, which moved the bundled CLI and
  silently removed Codex as a "Refine with AI" engine.
- Added [PRIVACY.md](https://github.com/LinnkLabs/AgentHistory/blob/main/PRIVACY.md) and a plugin icon.

## 0.1.8

- **Search is never squeezed again.** In a VS Code sidebar it was sharing a row with the ☰ button
  and the Sessions/Now switcher, ending up so narrow its own placeholder truncated. Below 900px it
  now takes a full row of its own, above everything else — 96% of the bar instead of a sliver.
- **⌘K actually works.** The bar advertised the shortcut but nothing implemented it. ⌘K / Ctrl+K now
  focuses search from anywhere, with `/` as a fallback (VS Code can swallow ⌘K inside a webview),
  and Escape clears it.
- **Sort search results** by *Best match*, *Newest*, or *Most mentions*. Sorting happens in the
  index, before results are cut to a page, so *Newest* really is the newest match — not just the
  newest of the most relevant 200. The choice is remembered.
- **Every message hit shows when it was said** ("Today 2:14 PM", "Sep 11, 9:54 PM"; hover for the
  full timestamp and age), a **relevance meter** relative to the best hit, and **×N** when its
  session mentions the term repeatedly.
- **Reopen without scrolling back up.** Once the header's button scrolls out of view in a long
  transcript, a bar docks to the bottom with the session title, copy-resume, and the reopen action.
- Common-word searches are about 5× faster: snippets are now built only for results that are shown.
- **Claude Code plugin.** `/plugin marketplace add LinnkLabs/AgentHistory`, then
  `/plugin install agent-history@linnklabs`: the MCP server plus *recall* and *catch-up* skills.
- **MCP output is secret-redacted.** Tokens, keys, and credential assignments in past transcripts come
  back as `[redacted:<kind>]` instead of landing in a live agent's context.
- MCP `read_session` now returns the session's own resume command — Codex sessions previously got
  `claude --resume`, the same bug 0.1.7 fixed in the dashboard.
- The MCP server builds and refreshes the index itself, so installing only the plugin works.

## 0.1.7

- **Codex sessions are no longer labelled "Claude".** Every speaker name, filter tab, badge, and
  button now comes from the session's own client, and the primary action runs that client's real
  resume command — Codex sessions previously offered `claude --resume`, which could never work.
- Sessions are identified down to the surface that wrote them: `codex · desktop`, `codex · vs code`,
  `claude · vs code`, `claude · sdk` (headless runs are now distinguishable from interactive ones).
- Codex sessions use Codex's own thread names instead of adopting an injected
  `# Context from my IDE setup:` block as their title.
- `CODEX_HOME` is honoured, matching the Codex CLI's own convention.

## 0.1.6

- Publisher is now `LinnkLabs` (matches the GitHub org). The extension ID changed, so uninstall any
  previously sideloaded `buildonagents.agent-history` to avoid two copies in the activity bar.
- Marketplace listing assets: icon, screenshots, and a proper description.
- Service 0.1.6: unsupported Node versions now fail with one clear message instead of a wall of
  native-build errors, and the empty state explains which directory it scanned.

## 0.1.5

- Pane dividers resize freely; a width chosen in a wide browser no longer crushes the transcript
  inside a narrow editor panel.
- `Sessions | Now` is a real segmented control; the message-type filter uses compact counts
  (`1217 → 1.2k`) and sheds chrome as the panel narrows.

## 0.1.3

- Visual hierarchy pass: the transcript header now reads as three ranked zones (identity → actions →
  view), with one primary action instead of a flat row of equal buttons.

## 0.1.2

- Fixed the service fallback spawning the wrong npm package.
- Copy works inside the VS Code webview.

## 0.1.0

- First release: sessions list, full-text search, transcript viewer, Open in Claude Code.
