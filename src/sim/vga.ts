// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2026, Tiny Tapeout LTD
// Author: Uri Shaked
//
// Modified in 2026 by Benjamin Otto to enable Tiny Tapeout-independent inputs and outputs.

import { HDLModuleWASM } from './hdlwasm';

export const VGA_WIDTH = 736;
export const VGA_HEIGHT = 520;

export interface VGASignals {
  hsync: boolean;
  vsync: boolean;
  r: number;
  g: number;
  b: number;
}

/** Byte-offsets of the standalone VGA output signals inside the WASM memory. */
export interface VGASignalOffsets {
  hsync: number;
  vsync: number;
  r: number;
  g: number;
  b: number;
}

export function getVGASignalOffsets(mod: HDLModuleWASM): VGASignalOffsets {
  const required = ['hsync', 'vsync', 'r', 'g', 'b'] as const;
  const missing = required.filter((name) => !mod.globals.lookup(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing top-level VGA output port(s): ${missing.join(', ')}. ` +
      `Your top module must declare: output wire hsync, vsync; output wire [1:0] r, g, b;`
    );
  }
  return {
    hsync: mod.globals.lookup('hsync').offset,
    vsync: mod.globals.lookup('vsync').offset,
    r: mod.globals.lookup('r').offset,
    g: mod.globals.lookup('g').offset,
    b: mod.globals.lookup('b').offset,
  };
}

export interface SyncPolarity {
  hsyncActiveLow: boolean;
  vsyncActiveLow: boolean;
}

export function readVGASignals(mod: HDLModuleWASM, offsets: VGASignalOffsets, polarity?: SyncPolarity): VGASignals {
  const hraw = !!mod.data8[offsets.hsync];
  const vraw = !!mod.data8[offsets.vsync];
  return {
    hsync: polarity?.hsyncActiveLow ? !hraw : hraw,
    vsync: polarity?.vsyncActiveLow ? !vraw : vraw,
    r: mod.data8[offsets.r] & 0x3,
    g: mod.data8[offsets.g] & 0x3,
    b: mod.data8[offsets.b] & 0x3,
  };
}

export function detectSyncPolarity(mod: HDLModuleWASM): SyncPolarity {
  const offsets = getVGASignalOffsets(mod);
  const MAX_TICKS = 500_000;

  function detectSignal(readBit: () => boolean): boolean {
    // Skip the initial (potentially partial) phase to reach a clean transition
    const initialState = readBit();
    let skipTicks = 0;
    while (readBit() === initialState && skipTicks < MAX_TICKS) {
      mod.tick2(1);
      skipTicks++;
    }
    if (skipTicks >= MAX_TICKS) {
      return true; // fallback: active-low (VGA standard)
    }

    // Measure two complete consecutive phases; the shorter one is the sync pulse
    const phase1State = readBit();
    let phase1Ticks = 0;
    while (readBit() === phase1State && phase1Ticks < MAX_TICKS) {
      mod.tick2(1);
      phase1Ticks++;
    }
    if (phase1Ticks >= MAX_TICKS) {
      return true;
    }
    let phase2Ticks = 0;
    while (readBit() !== phase1State && phase2Ticks < MAX_TICKS) {
      mod.tick2(1);
      phase2Ticks++;
    }
    if (phase2Ticks >= MAX_TICKS) {
      return true;
    }
    const pulseIsHigh = phase1Ticks < phase2Ticks ? phase1State : !phase1State;
    return !pulseIsHigh;
  }

  const vsyncActiveLow = detectSignal(() => !!mod.data8[offsets.vsync]);
  const hsyncActiveLow = detectSignal(() => !!mod.data8[offsets.hsync]);
  return { hsyncActiveLow, vsyncActiveLow };
}

export interface RenderOptions {
  polarity?: SyncPolarity;
  onTick?: () => void;
  onLine?: () => void;
}

export function renderVGAFrame(mod: HDLModuleWASM, pixels: Uint8Array, options?: RenderOptions) {
  const offsets = getVGASignalOffsets(mod);
  const { onTick, onLine, polarity } = options ?? {};

  function readSignals() {
    return readVGASignals(mod, offsets, polarity);
  }

  function waitFor(condition: () => boolean, timeout = 10000) {
    let counter = 0;
    while (!condition() && counter < timeout) {
      mod.tick2(1);
      onTick?.();
      counter++;
    }
  }

  frameLoop: for (let y = 0; y < VGA_HEIGHT; y++) {
    waitFor(() => !readSignals().hsync);
    onLine?.();
    for (let x = 0; x < VGA_WIDTH; x++) {
      const offset = (y * VGA_WIDTH + x) * 4;
      mod.tick2(1);
      onTick?.();
      const { hsync, vsync, r, g, b } = readSignals();
      if (hsync) break;
      if (vsync) break frameLoop;
      pixels[offset] = r * 85;
      pixels[offset + 1] = g * 85;
      pixels[offset + 2] = b * 85;
      pixels[offset + 3] = 0xff;
    }
    waitFor(() => readSignals().hsync);
  }
}

export function resetModule(mod: HDLModuleWASM) {
  mod.powercycle();
  mod.state.rst_n = 0;
  mod.tick2(10);
  mod.state.rst_n = 1;
}

/** Advance the simulation to the next vsync frame boundary. */
export function skipToFrameBoundary(mod: HDLModuleWASM, polarity?: SyncPolarity) {
  const offsets = getVGASignalOffsets(mod);
  const vsync = () => {
    const raw = !!mod.data8[offsets.vsync];
    return polarity?.vsyncActiveLow ? !raw : raw;
  };
  while (!vsync()) mod.tick2(1);
  while (vsync()) mod.tick2(1);
}

/** Names of keyboard input signals that can be driven by the simulator. */
export const KEYBOARD_SIGNALS = [
  'key_0', 'key_1', 'key_2', 'key_3', 'key_4',
  'key_5', 'key_6', 'key_7', 'key_8', 'key_9',
  'key_up', 'key_down', 'key_left', 'key_right',
  'key_space',
] as const;

/** Maps KeyboardEvent.key values to Verilog input signal names. */
export const KEY_MAP: Record<string, string> = {
  '0': 'key_0',
  '1': 'key_1',
  '2': 'key_2',
  '3': 'key_3',
  '4': 'key_4',
  '5': 'key_5',
  '6': 'key_6',
  '7': 'key_7',
  '8': 'key_8',
  '9': 'key_9',
  'ArrowUp': 'key_up',
  'ArrowDown': 'key_down',
  'ArrowLeft': 'key_left',
  'ArrowRight': 'key_right',
  ' ': 'key_space',
};
