import { beforeEach, describe, expect, it } from 'vitest';
import { clearTerrainCache, getTerrainTexture } from './terrainCache';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseDescriptor } from '../sim/parse';
import type { Sim } from '../sim/wasm';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

function countingSim(seed: string): { sim: Sim; calls: () => number } {
  let n = 0;
  const sim: Sim = {
    seed,
    descriptor: golden,
    bodyCount: 21,
    statesAt: () => new Float64Array(21 * 7),
    orbitPath: () => new Float64Array(0),
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: () => new Float64Array(3),
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: (i) => {
      n++;
      return i >= golden.stars.length ? { sea_level: 0, ocean_fraction: 0.5, relief_m: 5000, plate_count: 8 } : null;
    },
    bodyElevation: () => 0,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
  };
  return { sim, calls: () => n };
}

describe('getTerrainTexture cache', () => {
  beforeEach(() => clearTerrainCache());

  it('memoizes per body — second lookup makes no sim calls', () => {
    const { sim, calls } = countingSim('cache-test-1');
    getTerrainTexture(sim, 3);
    const after = calls();
    expect(after).toBeGreaterThan(0);
    getTerrainTexture(sim, 3);
    expect(calls()).toBe(after);
  });

  it('caches null results too (headless canvas / no terrain)', () => {
    const { sim, calls } = countingSim('cache-test-2');
    expect(getTerrainTexture(sim, 0)).toBeNull(); // star: info null
    const after = calls();
    expect(getTerrainTexture(sim, 0)).toBeNull();
    expect(calls()).toBe(after);
  });

  it('keys by seed — different seeds do not collide', () => {
    const a = countingSim('cache-test-3a');
    const b = countingSim('cache-test-3b');
    getTerrainTexture(a.sim, 3);
    getTerrainTexture(b.sim, 3);
    expect(a.calls()).toBeGreaterThan(0);
    expect(b.calls()).toBeGreaterThan(0); // b was NOT served from a's entry
  });
});
