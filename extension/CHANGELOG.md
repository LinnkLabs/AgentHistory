# Changelog

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
