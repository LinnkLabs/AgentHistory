# Agent History — VS Code / Cursor extension

Brings the Agent History dashboard (organize · search · locate your Claude sessions) into an
activity-bar panel. It is a **thin client**: it reuses a running `agent-manager` service, and if
none is running it **auto-spawns** the sibling service, then embeds the dashboard.

## Behaviour

1. On activation it health-checks `http://127.0.0.1:<port>/api/stats`.
2. If reachable → embeds it. If not → spawns the service (detached, shared with the browser) and waits.
3. **Workspace-scoped** by default: opens focused on the current workspace folder's project
   (toggle in the view title to show all projects).

## Commands (view title + palette)

- **Agent History: Toggle workspace scope**
- **Agent History: Open dashboard in browser**
- **Agent History: Reindex sessions**
- **Agent History: Restart service**

## Settings

- `agentHistory.port` (default `4600`)
- `agentHistory.serviceEntry` — path to the service's `bin/agent-manager.mjs`. Empty = auto-detect the
  sibling `../service` package, else fall back to `npx agent-manager`.
- `agentHistory.scopeToWorkspace` (default `true`)

## Test locally

**Prereqs (once):** the service must have its deps + an index built, with the same system Node the
extension will spawn:

```bash
cd "../service" && npm install && node bin/agent-manager.mjs index
```

### Option A — Run from source (F5, zero config) ✅ recommended

1. Open **this `extension/` folder** as the VS Code / Cursor workspace root.
2. Press **F5** → an Extension Development Host window opens with the extension loaded.
3. Click the Agent History icon in the activity bar. The dashboard embeds; the service auto-starts.

`../service` is auto-detected, so no settings are needed.

### Option B — Install the packaged `.vsix`

```bash
code --install-extension agent-history-0.1.0.vsix   # or Cursor: cursor --install-extension …
```

Because the installed extension no longer sits next to `../service`, set two things in Settings:

- `agentHistory.serviceEntry` → absolute path to `…/Agent Manager/service/bin/agent-manager.mjs`
- `agentHistory.nodePath` → `node` (or an absolute path to Node if it isn't on VS Code's PATH — common
  with GUI launches / nvm). Must be the **same Node that built the service's `better-sqlite3`**.

## Notes

- The service runs as a normal **system Node** process (not inside the extension host) — this avoids the
  Electron-ABI mismatch that would otherwise break the native `better-sqlite3`.
- Service lifecycle logic lives in `service-control.js` (no `vscode` dependency, unit-testable).
- MVP scope: reuse-or-auto-spawn + embed. Read-only direct-store fallback is a later step; today the
  fallback is a clear "service unavailable + retry" panel.
