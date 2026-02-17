import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class VGASimulatorPanel {
  public static readonly viewType = 'verilogvga.simulator';
  private static currentPanel: VGASimulatorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private sourceDir: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.ViewColumn.Beside;

    // Capture the source directory before the webview panel steals focus
    const sourceDir = VGASimulatorPanel.resolveSourceDir();
    if (!sourceDir) {
      vscode.window.showWarningMessage('No active Verilog file. Open a .v or .sv file first.');
      return;
    }

    if (VGASimulatorPanel.currentPanel) {
      VGASimulatorPanel.currentPanel.sourceDir = sourceDir;
      VGASimulatorPanel.currentPanel.panel.reveal(column);
      VGASimulatorPanel.currentPanel.compileAndSend();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VGASimulatorPanel.viewType,
      'VGA Simulator',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'dist'),
          vscode.Uri.joinPath(extensionUri, 'src', 'verilator'),
        ],
      },
    );

    VGASimulatorPanel.currentPanel = new VGASimulatorPanel(panel, extensionUri, sourceDir);
  }

  private static resolveSourceDir(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const fsPath = editor.document.uri.fsPath;
      if (fsPath.endsWith('.v') || fsPath.endsWith('.sv')) {
        return path.dirname(fsPath);
      }
    }
    // No fallback - must have an active .v or .sv file
    return undefined;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, sourceDir: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.sourceDir = sourceDir;

    this.panel.webview.html = this.getHtmlForWebview();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'ready':
            this.compileAndSend();
            break;
          case 'error':
            vscode.window.showErrorMessage(message.text);
            break;
        }
      },
      null,
      this.disposables,
    );

    // Re-compile when a Verilog file is saved in the current source directory
    const watcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith('.v') || doc.fileName.endsWith('.sv')) {
        const fileDir = path.dirname(doc.fileName);
        // Only recompile if the file is in the current source directory or a subdirectory
        if (fileDir.startsWith(this.sourceDir)) {
          this.compileAndSend();
        }
      }
    });
    this.disposables.push(watcher);
  }

  private async compileAndSend() {
    const sources = this.collectVerilogSources(this.sourceDir);

    if (Object.keys(sources).length === 0) {
      vscode.window.showWarningMessage('No Verilog source files found.');
      return;
    }

    // Read the wasm binary and send it along with sources
    const wasmPath = path.join(this.extensionUri.fsPath, 'src', 'verilator', 'verilator_bin.wasm');
    let wasmBase64: string;
    try {
      const wasmBuf = fs.readFileSync(wasmPath);
      wasmBase64 = wasmBuf.toString('base64');
    } catch {
      vscode.window.showErrorMessage('Could not read verilator_bin.wasm');
      return;
    }

    this.panel.webview.postMessage({
      type: 'compile',
      sources,
      wasmBase64,
    });
  }

  private collectVerilogSources(dir: string): Record<string, string> {
    const sources: Record<string, string> = {};
    this.walkDir(dir, dir, sources);
    return sources;
  }

  private walkDir(baseDir: string, currentDir: string, sources: Record<string, string>) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(baseDir, fullPath, sources);
      } else if (entry.isFile() && (entry.name.endsWith('.v') || entry.name.endsWith('.sv'))) {
        sources[entry.name] = fs.readFileSync(fullPath, 'utf-8');
      }
    }
  }

  private getHtmlForWebview(): string {
    const webview = this.panel.webview;

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
    );

    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VGA Simulator</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: #1e1e1e;
      color: #ccc;
      font-family: var(--vscode-font-family, sans-serif);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    h2 {
      margin: 0 0 8px 0;
      font-size: 14px;
      font-weight: 600;
    }
    #vga-canvas {
      image-rendering: pixelated;
      border: 1px solid #444;
      width: 640px;
      height: auto;
      outline: none;
    }
    #vga-canvas:focus {
      border-color: #0af;
    }
    #status {
      margin-top: 8px;
      font-size: 12px;
      color: #888;
    }
    #controls-hint {
      margin-top: 6px;
      font-size: 11px;
      color: #666;
    }
    #error-box {
      margin-top: 8px;
      padding: 8px 12px;
      background: #3a1d1d;
      border: 1px solid #d44;
      border-radius: 4px;
      color: #f88;
      font-size: 12px;
      white-space: pre-wrap;
      display: none;
      max-width: 640px;
      width: 100%;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  <h2>VGA Simulator</h2>
  <canvas id="vga-canvas" width="736" height="520" tabindex="0"></canvas>
  <div id="status">Waiting for compilation...</div>
  <div id="controls-hint">Click the display to enable keyboard input &mdash; Arrow keys, Space, 0&ndash;9</div>
  <div id="error-box"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose() {
    VGASimulatorPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
