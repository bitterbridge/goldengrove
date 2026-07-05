import type * as THREE from 'three';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { biomeTexture, terrainTexture } from './terrainTexture';

const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
const RESOLUTION: [number, number] = [512, 256];
const cache = new Map<string, THREE.CanvasTexture | null>();

/** Lazy terrain texture per body; null for non-terrain bodies or headless canvas. */
export function getTerrainTexture(sim: Sim, bodyIndex: number): THREE.CanvasTexture | null {
  const key = `${sim.seed}:${bodyIndex}`;
  if (cache.has(key)) return cache.get(key)!;
  const info = sim.bodyTerrainInfo(bodyIndex);
  let tex: THREE.CanvasTexture | null = null;
  if (info) {
    const map = sim.bodyHeightmap(bodyIndex, RESOLUTION[0], RESOLUTION[1]);
    if (map.length > 0) {
      const biomes = sim.bodyBiomeGrid(bodyIndex, RESOLUTION[0], RESOLUTION[1]);
      if (biomes.length > 0) {
        tex = biomeTexture(biomes, map, RESOLUTION[0], RESOLUTION[1]);
      } else {
        const layout = bodyLayout(sim.descriptor);
        const ref = layout[bodyIndex]!;
        const classHex = ref.kind === 'planet' ? PALETTE[sim.descriptor.planets[ref.planet]!.class] : 0x8a8f98;
        const dead = ref.kind === 'planet' && sim.descriptor.planets[ref.planet]!.state.kind === 'Dead';
        tex = terrainTexture(map, RESOLUTION[0], RESOLUTION[1], classHex, dead);
      }
    }
  }
  cache.set(key, tex);
  return tex;
}

/** Test hook + future-proofing for in-place seed switches (today reroll is a
 * full page reload, so production never needs this). */
export function clearTerrainCache(): void {
  cache.clear();
}
