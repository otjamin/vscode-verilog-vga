import * as vscode from 'vscode';
import { HDLModuleDef } from './sim/hdltypes';
import { HDLModuleWASM } from './sim/hdlwasm';
import {
  renderVGAFrame,
  resetModule,
  detectSyncPolarity,
  skipToFrameBoundary,
  VGA_WIDTH,
  VGA_HEIGHT,
  SyncPolarity,
} from './sim/vga';
import { compileVerilator } from './verilator/compile';
import { detectTopModule } from './verilog';

export class VGASimulatorPanel {
  public static currentPanel: VGASimulatorPanel | undefined;
  private static readonly viewType = 'verilogvga.simulatorView';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private mod: HDLModuleWASM | null = null;
  private running = false;
  private syncPolarity: SyncPolarity = { hsyncActiveLow: false, vsyncActiveLow: false };

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.ViewColumn.Beside;

    if (VGASimulatorPanel.currentPanel) {
      VGASimulatorPanel.currentPanel.panel.reveal(column);
      return VGASimulatorPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      VGASimulatorPanel.viewType,
      'VGA Simulator',
      column,
      {
        enableScripts: true,
      },
    );

    VGASimulatorPanel.currentPanel = new VGASimulatorPanel(panel, extensionUri);
    return VGASimulatorPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtmlForWebview();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'stop':
            this.stopSimulation();
            break;
          case 'reset':
            if (this.mod) {
              resetModule(this.mod);
              this.syncPolarity = detectSyncPolarity(this.mod);
              resetModule(this.mod);
              skipToFrameBoundary(this.mod, this.syncPolarity);
            }
            break;
        }
      },
      null,
      this.disposables,
    );
  }

  public async compileSources(sources: Record<string, string>) {
    this.stopSimulation();

    this.panel.webview.postMessage({ command: 'status', text: 'Compiling...' });

    const topModule = detectTopModule(sources);

    // Intercept process.exit from verilator_bin.js
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`Verilator process.exit(${code})`);
    }) as never;

    try {
      const res = await compileVerilator({ topModule, sources });

      if (!res.output) {
        const errorMessages = res.errors
          .filter((e) => e.type === 'error')
          .map((e) => {
            const loc = e.file ? `${e.file}:${e.line}:${e.column}: ` : '';
            return loc + e.message;
          })
          .join('\n');
        this.panel.webview.postMessage({
          command: 'error',
          text: 'Compilation Error:\n' + errorMessages,
        });
        return;
      }

      // Show warnings if any
      const warnings = res.errors.filter((e) => e.type === 'warning');
      if (warnings.length > 0) {
        vscode.window.showWarningMessage(
          `Verilator: ${warnings.length} warning(s)`,
        );
      }

      await this.initModule(res.output.modules);
      this.panel.webview.postMessage({ command: 'status', text: 'Running' });
      this.startSimulation();
    } catch (e) {
      this.panel.webview.postMessage({
        command: 'error',
        text: 'Error: ' + (e instanceof Error ? e.message : String(e)),
      });
    } finally {
      process.exit = originalExit;
    }
  }

  private async initModule(modules: Record<string, HDLModuleDef>) {
    if (this.mod) {
      this.mod.dispose();
      this.mod = null;
    }

    const constpool = modules['@CONST-POOL@'] || modules['__Vconst'];
    this.mod = new HDLModuleWASM(modules['TOP'], constpool);
    await this.mod.init();

    // Reset and detect sync polarity
    resetModule(this.mod);
    this.syncPolarity = detectSyncPolarity(this.mod);
    resetModule(this.mod);
    skipToFrameBoundary(this.mod, this.syncPolarity);
  }

  private startSimulation() {
    if (!this.mod || this.running) {
      return;
    }
    this.running = true;
    this.renderLoop();
  }

  private stopSimulation() {
    this.running = false;
  }

  private renderLoop() {
    if (!this.running || !this.mod) {
      return;
    }

    const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);

    try {
      renderVGAFrame(this.mod, pixels, {
        polarity: this.syncPolarity,
      });
    } catch (e) {
      this.panel.webview.postMessage({
        command: 'error',
        text: 'Simulation error: ' + (e instanceof Error ? e.message : String(e)),
      });
      this.running = false;
      return;
    }

    // Send pixel data as base64 to avoid transfer overhead issues
    const base64 = Buffer.from(pixels.buffer).toString('base64');
    this.panel.webview.postMessage({
      command: 'frame',
      width: VGA_WIDTH,
      height: VGA_HEIGHT,
      pixels: base64,
    });

    // Schedule next frame with setImmediate to avoid blocking the extension host
    if (this.running) {
      setImmediate(() => this.renderLoop());
    }
  }

  private dispose() {
    VGASimulatorPanel.currentPanel = undefined;
    this.running = false;

    if (this.mod) {
      this.mod.dispose();
      this.mod = null;
    }

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private getHtmlForWebview(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VGA Simulator</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      background: #1e1e1e;
      color: #ccc;
      font-family: system-ui, sans-serif;
      overflow: hidden;
      height: 100vh;
    }
    #status-bar {
      width: 100%;
      padding: 6px 12px;
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      font-size: 12px;
      box-sizing: border-box;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #status-text {
      color: #9cdcfe;
    }
    .controls button {
      background: #0e639c;
      color: white;
      border: none;
      padding: 3px 10px;
      margin-left: 6px;
      cursor: pointer;
      font-size: 12px;
      border-radius: 2px;
    }
    .controls button:hover {
      background: #1177bb;
    }
    #canvas-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }
    canvas {
      image-rendering: pixelated;
      background: #000;
    }
    #error-overlay {
      position: absolute;
      inset: 0;
      top: 30px;
      background: rgba(0, 0, 0, 0.9);
      color: #f66;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      padding: 20px;
      white-space: pre-wrap;
      overflow-y: auto;
      display: none;
    }
    #fps-counter {
      color: #888;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div id="status-bar">
    <span><span id="status-text">Waiting...</span> <span id="fps-counter"></span></span>
    <div class="controls">
      <button id="btn-stop">Stop</button>
      <button id="btn-reset">Reset</button>
    </div>
  </div>
  <div id="canvas-container">
    <canvas id="vga-canvas"></canvas>
  </div>
  <div id="error-overlay"></div>
  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const canvas = document.getElementById('vga-canvas');
      const ctx = canvas.getContext('2d');
      const statusText = document.getElementById('status-text');
      const errorOverlay = document.getElementById('error-overlay');
      const fpsCounter = document.getElementById('fps-counter');

      let imageData = null;
      let frameCount = 0;
      let lastFpsTime = performance.now();

      function resizeCanvas(width, height) {
        canvas.width = width;
        canvas.height = height;
        // Scale canvas to fit viewport
        const container = document.getElementById('canvas-container');
        const maxW = container.clientWidth - 20;
        const maxH = container.clientHeight - 20;
        const scale = Math.min(maxW / width, maxH / height, 2);
        canvas.style.width = Math.floor(width * scale) + 'px';
        canvas.style.height = Math.floor(height * scale) + 'px';
        imageData = ctx.createImageData(width, height);
      }

      resizeCanvas(736, 520);

      document.getElementById('btn-stop').addEventListener('click', () => {
        vscode.postMessage({ command: 'stop' });
        statusText.textContent = 'Stopped';
      });

      document.getElementById('btn-reset').addEventListener('click', () => {
        vscode.postMessage({ command: 'reset' });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
          case 'frame': {
            if (!imageData || imageData.width !== msg.width || imageData.height !== msg.height) {
              resizeCanvas(msg.width, msg.height);
            }
            // Decode base64 pixel data
            const binary = atob(msg.pixels);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            imageData.data.set(bytes);
            ctx.putImageData(imageData, 0, 0);

            // FPS counter
            frameCount++;
            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
              fpsCounter.textContent = frameCount + ' fps';
              frameCount = 0;
              lastFpsTime = now;
            }
            break;
          }
          case 'status':
            statusText.textContent = msg.text;
            errorOverlay.style.display = 'none';
            break;
          case 'error':
            errorOverlay.textContent = msg.text;
            errorOverlay.style.display = 'block';
            statusText.textContent = 'Error';
            break;
        }
      });

      window.addEventListener('resize', () => {
        if (imageData) {
          resizeCanvas(imageData.width, imageData.height);
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
