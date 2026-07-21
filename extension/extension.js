// Agent History — VS Code / Cursor extension (thin client over the local agent-manager service).
const vscode = require('vscode');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ensureService, resolveServiceEntry, healthCheck } = require('./service-control');

function cfg() { return vscode.workspace.getConfiguration('agentHistory'); }
function port() { return cfg().get('port', 4600); }
function nodePath() { return cfg().get('nodePath', 'node') || 'node'; }
function workspaceFolder() { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; }

class SessionsViewProvider {
  constructor(context) { this.context = context; this.view = null; this.scoped = cfg().get('scopeToWorkspace', true); }

  async resolveWebviewView(view) {
    this.view = view;
    // portMapping is the supported way for webview content to reach a localhost server
    // (resolves inside Remote/Codespaces too); we address the service as localhost:<port>.
    view.webview.options = { enableScripts: true, portMapping: [{ webviewPort: port(), extensionHostPort: port() }] };
    view.webview.html = this.loadingHtml('Starting Agent History service…');
    await this.render();
  }

  async render() {
    if (!this.view) return;
    try {
      await ensureService({
        port: port(),
        extensionDir: this.context.extensionPath,
        configuredEntry: cfg().get('serviceEntry', '') || undefined,
        nodePath: nodePath(),
      });
      const ws = this.scoped ? workspaceFolder() : '';
      const target = `http://localhost:${port()}/` + (ws ? '?ws=' + encodeURIComponent(ws) : '');
      this.view.webview.html = this.iframeHtml(target, port());
    } catch (e) {
      this.view.webview.html = this.errorHtml(String(e && e.message || e));
    }
  }

  async toggleScope() { this.scoped = !this.scoped; await this.render(); }

  loadingHtml(msg) {
    return `<!doctype html><meta charset="utf-8"><style>body{font:13px -apple-system,sans-serif;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style><div>${esc(msg)}</div>`;
  }
  iframeHtml(src, p) {
    const csp = `default-src 'none'; frame-src http://127.0.0.1:${p} http://localhost:${p}; style-src 'unsafe-inline';`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100vh;overflow:hidden}</style></head>
<body><iframe src="${esc(src)}" allow="clipboard-read; clipboard-write"></iframe></body></html>`;
  }
  errorHtml(msg) {
    return `<!doctype html><meta charset="utf-8"><style>body{font:13px -apple-system,sans-serif;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px}code{background:var(--vscode-textCodeBlock-background);padding:1px 5px;border-radius:4px}a{color:var(--vscode-textLink-foreground)}</style>
<h3>Agent History service unavailable</h3>
<p>${esc(msg)}</p>
<p>Build the index once (needs Node 20+), then reload:</p>
<pre><code>npx agent-history-cli index</code></pre>
<p><a href="command:agentHistory.restart">↻ Retry</a></p>`;
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function runCli(context, subcommand) {
  const entry = resolveServiceEntry(context.extensionPath, cfg().get('serviceEntry', '') || undefined);
  // system node (see service-control startService) — never process.execPath (Electron ABI).
  const cmd = entry ? nodePath() : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  const args = entry ? [entry, subcommand] : ['--yes', 'agent-history-cli', subcommand];
  return spawn(cmd, args, { stdio: 'ignore' });
}

function activate(context) {
  const provider = new SessionsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentHistory.view', provider, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('agentHistory.openInBrowser', async () => {
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port()}/`));
    }),

    // The Portrait is a full-bleed cinematic page — the sidebar can show it, but the wow belongs
    // in a real browser window.
    vscode.commands.registerCommand('agentHistory.openPortrait', async () => {
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port()}/portrait.html`));
    }),

    vscode.commands.registerCommand('agentHistory.toggleScope', () => provider.toggleScope()),

    vscode.commands.registerCommand('agentHistory.restart', () => provider.render()),

    vscode.commands.registerCommand('agentHistory.reindex', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Agent History: reindexing sessions…' },
        () => new Promise((resolve) => {
          const child = runCli(context, 'index');
          child.on('exit', () => resolve());
          child.on('error', () => resolve());
        })
      );
      vscode.window.showInformationMessage('Agent History: reindex complete.');
      provider.render();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
