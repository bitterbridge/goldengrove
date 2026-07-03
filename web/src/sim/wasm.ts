import init, { World } from '../wasm/pkg/gg_wasm.js';
import { parseDescriptor } from './parse';
import type { DateTime, SystemDescriptor } from './types';

export interface Sim {
  seed: string;
  descriptor: SystemDescriptor;
  bodyCount: number;
  statesAt(tS: number): Float64Array;
  orbitPath(bodyIndex: number, segments: number): Float64Array;
  anchorDate(tS: number): DateTime;
}

let wasmReady: Promise<unknown> | null = null;

/** Boot the WASM module (once) and build a world from a seed string. */
export async function loadSim(seed: string): Promise<Sim> {
  wasmReady ??= init(new URL('../wasm/pkg/gg_wasm_bg.wasm', import.meta.url));
  await wasmReady;
  const world = new World(seed);
  const descriptor = parseDescriptor(world.descriptor_json());
  return {
    seed,
    descriptor,
    bodyCount: world.body_count(),
    statesAt: (tS) => world.states_at(tS),
    orbitPath: (i, segments) => world.orbit_path(i, segments),
    anchorDate: (tS) => JSON.parse(world.anchor_date_json(tS)) as DateTime,
  };
}
