import init, { World } from '../wasm/pkg/gg_wasm.js';
import { parseDescriptor } from './parse';
import type { DateTime, SystemDescriptor, TerrainInfo } from './types';

export interface Sim {
  seed: string;
  descriptor: SystemDescriptor;
  bodyCount: number;
  statesAt(tS: number): Float64Array;
  orbitPath(bodyIndex: number, segments: number, tS: number): Float64Array;
  anchorDate(tS: number): DateTime;
  hostOriginAt(tS: number): Float64Array;
  bodyHeightmap(bodyIndex: number, width: number, height: number): Float32Array; // length 0 => no terrain
  bodyTerrainInfo(bodyIndex: number): TerrainInfo | null; // null => no terrain
}

let wasmReady: Promise<unknown> | null = null;

export class WasmLoadError extends Error {}

/** Boot the WASM module (once) and build a world from a seed string. */
export async function loadSim(seed: string): Promise<Sim> {
  wasmReady ??= init(new URL('../wasm/pkg/gg_wasm_bg.wasm', import.meta.url));
  try {
    await wasmReady;
  } catch (err) {
    wasmReady = null; // allow retry on next call rather than caching the failure
    throw new WasmLoadError(`WASM module failed to load: ${String(err)}`);
  }
  const world = new World(seed);
  const descriptor = parseDescriptor(world.descriptor_json());
  return {
    seed,
    descriptor,
    bodyCount: world.body_count(),
    statesAt: (tS) => world.states_at(tS),
    orbitPath: (i, segments, tS) => world.orbit_path(i, segments, tS),
    anchorDate: (tS) => JSON.parse(world.anchor_date_json(tS)) as DateTime,
    hostOriginAt: (tS) => world.host_origin_at(tS),
    bodyHeightmap: (i, w, h) => world.body_heightmap(i, w, h),
    bodyTerrainInfo: (i) => {
      try {
        return JSON.parse(world.body_terrain_info(i)) as TerrainInfo;
      } catch {
        return null;
      }
    },
  };
}
