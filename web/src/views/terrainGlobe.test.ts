import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { buildTerrainGlobe } from './terrainGlobe';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

function fakeSim(): Sim {
  const n = bodyLayout(golden).length;
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: n,
    statesAt: () => new Float64Array(n * 7),
    orbitPath: () => new Float64Array(0),
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: () => new Float64Array(3),
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: (i) => (i === 0 ? null : { sea_level: 0, ocean_fraction: 0.5, relief_m: 6000, plate_count: 8 }),
    bodyElevation: () => 250,
    bodyElevations: (_: number, coords: Float64Array) => {
      const out = new Float32Array(coords.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = 100 * Math.sin(coords[2 * i]! * 0.5); // smooth, lat-dependent
      return out;
    },
  };
}

describe('buildTerrainGlobe', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;
  const suns = [{ dirLocal: [0, 0, 1] as [number, number, number], temperatureK: 5800, irradiance: 1 }];

  it('returns null for non-terrain bodies (stars)', () => {
    expect(buildTerrainGlobe(fakeSim(), 0)).toBeNull();
  });

  it('builds tiles over successive updates and renders them', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    expect(g).not.toBeNull();
    for (let f = 0; f < 40; f++) g.update(15, 30, 252, suns, 8);
    const s = g.stats();
    expect(s.built).toBeGreaterThan(20);
    let visibleMeshes = 0;
    g.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh && o.visible) visibleMeshes++; });
    expect(visibleMeshes).toBeGreaterThan(5);
  });

  it('keeps rendered tile positions camera-relative (no planet-scale magnitudes)', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 252, suns, 8);
    // the nearest visible tile must sit within ~2 tile-lengths of the origin
    let nearest = Infinity;
    g.scene.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh && o.visible) nearest = Math.min(nearest, o.position.length());
    });
    expect(nearest).toBeLessThan(50_000);
    expect(nearest).toBeGreaterThan(0);
  });

  it('has sun lights that fade below the horizon (ground darkens at night)', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    const intensityTotal = () => {
      let total = 0;
      g.scene.traverse((o) => {
        const l = o as { isDirectionalLight?: boolean; intensity?: number };
        if (l.isDirectionalLight) total += l.intensity ?? 0;
      });
      return total;
    };
    g.update(15, 30, 252, [{ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }]);
    const day = intensityTotal();
    g.update(15, 30, 252, [{ dirLocal: [0, 0, -0.5], temperatureK: 5800, irradiance: 1 }]);
    const night = intensityTotal();
    expect(day).toBeGreaterThan(0.5);
    expect(night).toBe(0);
  });
});
