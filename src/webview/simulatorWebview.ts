import { compileVerilator } from '../verilator/compile';
import { detectTopModule } from '../verilog';
import { HDLModuleDef } from '../sim/hdltypes';
import { HDLModuleWASM } from '../sim/hdlwasm';
import {
  detectSyncPolarity,
  getVGASignalOffsets,
  KEY_MAP,
  readVGASignals,
  renderVGAFrame,
  resetModule,
  SyncPolarity,
  VGA_HEIGHT,
  VGA_WIDTH,
  VGASignalOffsets,
} from '../sim/vga';

// Acquire the VS Code API
const vscode = acquireVsCodeApi();

const canvas = document.getElementById('vga-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;
const errorBox = document.getElementById('error-box')!;

let jmod: HDLModuleWASM | null = null;
let syncPolarity: SyncPolarity = { hsyncActiveLow: false, vsyncActiveLow: false };
let vgaOffsets: VGASignalOffsets | null = null;
let stopped = true;
let imageData = ctx.createImageData(VGA_WIDTH, VGA_HEIGHT);

/** Set of signal names that actually exist in the current design. */
let availableKeySignals: Set<string> = new Set();

function showError(text: string) {
  errorBox.style.display = 'block';
  errorBox.textContent = text;
}

function hideError() {
  errorBox.style.display = 'none';
  errorBox.textContent = '';
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function reset() {
  if (!jmod) { return; }
  resetModule(jmod);
  syncPolarity = detectSyncPolarity(jmod);
  vgaOffsets = getVGASignalOffsets(jmod);
  resetModule(jmod);
}

function detectAvailableKeySignals() {
  availableKeySignals.clear();
  if (!jmod) { return; }
  for (const signal of Object.values(KEY_MAP)) {
    try {
      if (jmod.globals.lookup(signal)) {
        availableKeySignals.add(signal);
      }
    } catch { /* signal not present in design */ }
  }
}

function setKeyState(key: string, pressed: boolean) {
  if (!jmod) { return; }
  const signal = KEY_MAP[key];
  if (!signal || !availableKeySignals.has(signal)) { return; }
  jmod.state[signal] = pressed ? 1 : 0;
}

async function initModule(modules: Record<string, HDLModuleDef>) {
  if (jmod) { jmod.dispose(); }
  jmod = new HDLModuleWASM(modules['TOP'], modules['@CONST-POOL@']);
  await jmod.init();
  detectAvailableKeySignals();
  reset();
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function handleCompile(sources: Record<string, string>, wasmBase64: string) {
  stopped = true;
  hideError();
  setStatus('Compiling...');

  const wasmBinary = base64ToArrayBuffer(wasmBase64);

  try {
    const topModule = detectTopModule(sources);
    const res = await compileVerilator({
      topModule,
      sources,
      wasmBinary,
    });

    if (res.errors.filter((e) => e.type === 'error').length) {
      const errorMessages = res.errors
        .filter((e) => e.type === 'error')
        .map((e) => `${e.file}:${e.line}:${e.column}: ${e.message}`)
        .join('\n');
      showError(errorMessages);
      setStatus('Compilation failed');
      return;
    }

    if (!res.output) {
      showError('Compilation produced no output');
      setStatus('Compilation failed');
      return;
    }

    // Show warnings if any
    const warnings = res.errors.filter((e) => e.type === 'warning');
    if (warnings.length > 0) {
      const warnText = warnings
        .map((w) => `${w.file}:${w.line}: ${w.message}`)
        .join('\n');
      showError('Warnings:\n' + warnText);
    }

    await initModule(res.output.modules);
    stopped = false;
    setStatus('Running simulation');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(msg);
    setStatus('Error');
  }
}

// Animation loop
function animationFrame() {
  requestAnimationFrame(animationFrame);

  if (stopped || !jmod || !vgaOffsets) {
    return;
  }

  const data = new Uint8Array(imageData.data.buffer);
  renderVGAFrame(jmod, data, { polarity: syncPolarity });
  ctx.putImageData(imageData, 0, 0);

  // Advance to next vsync boundary
  const offsets = vgaOffsets;
  const getVSync = () => {
    const raw = !!jmod!.data8[offsets.vsync];
    return syncPolarity.vsyncActiveLow ? !raw : raw;
  };
  let counter = 0;
  while (!getVSync() && counter < 10000) {
    jmod.tick2(1);
    counter++;
  }
  while (getVSync() && counter < 20000) {
    jmod.tick2(1);
    counter++;
  }
}

requestAnimationFrame(animationFrame);

// Keyboard input handling
document.addEventListener('keydown', (e) => {
  if (KEY_MAP[e.key]) {
    e.preventDefault();
    setKeyState(e.key, true);
  }
});

document.addEventListener('keyup', (e) => {
  if (KEY_MAP[e.key]) {
    e.preventDefault();
    setKeyState(e.key, false);
  }
});

// Listen for messages from the extension
window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'compile':
      handleCompile(message.sources, message.wasmBase64);
      break;
  }
});

// Tell the extension we are ready
vscode.postMessage({ type: 'ready' });
