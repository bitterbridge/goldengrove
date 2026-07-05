import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { buildGroundScene } from './ground';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

function fakeSim(): Sim {
  const n = bodyLayout(golden).length;
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: n,
    statesAt: () => {
      const s = new Float64Array(n * 7);
      for (let i = 0; i < n; i++) {
        s[i * 7] = (i + 1) * 1e10;
        s[i * 7 + 5] = 1;
      }
      return s;
    },
    orbitPath: () => new Float64Array(0),
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: () => new Float64Array(3),
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: (i) => (i === 0 ? null : { sea_level: 0, ocean_fraction: 0.4, relief_m: 6000, plate_count: 8 }),
    bodyElevation: () => 0,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
    bodyBiomeGrid: () => new Uint8Array(0),
    bodyBiomes: (_: number, coords: Float64Array) => new Uint8Array(coords.length / 2),
    bodyClimateInfo: () => null,
  };
}

describe('buildGroundScene', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;

  it('creates the fixed furniture (no per-body meshes/labels — that moved to localBodies)', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    expect(g.scene.getObjectByName('starfield')).toBeTruthy();
    expect(g.scene.getObjectByName('skydome')).toBeTruthy();
    expect(g.scene.getObjectByName('ground-disc')).toBeTruthy();
  });

  it('keeps only starfield + sky dome + disc: no sky-body meshes remain', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    let skyBodyMeshes = 0;
    g.scene.traverse((o) => { if (o.name.startsWith('sky-body-')) skyBodyMeshes++; });
    expect(skyBodyMeshes).toBe(0);
    expect(g.scene.getObjectByName('starfield')).toBeTruthy();
    expect(g.scene.getObjectByName('skydome')).toBeTruthy();
  });

  it('suns drive dayFactor (per-star lights now live in localBodies)', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 });
    expect(g.dayFactor()).toBeGreaterThanOrEqual(0);
    expect(g.dayFactor()).toBeLessThanOrEqual(1);
  });

  it('setDiscVisible hides the fallback disc (terrain pass replaces it)', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const disc = g.scene.getObjectByName('ground-disc')!;
    expect(disc.visible).toBe(true);
    g.setDiscVisible(false);
    expect(disc.visible).toBe(false);
  });

  it('update returns the suns it computed for the terrain pass', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const suns = g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 });
    expect(Array.isArray(suns)).toBe(true);
    expect(suns.length).toBeGreaterThanOrEqual(1);
    expect(suns[0]!.irradiance).toBe(1); // normalized, brightest first
  });

  it('sky density falls off exponentially with altitude', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const dome = g.scene.getObjectByName('skydome') as THREE.Mesh;
    const uniforms = (dome.material as THREE.ShaderMaterial).uniforms;
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 }, 0);
    const d0 = uniforms.density!.value as number;
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 }, 8500);
    const d1 = uniforms.density!.value as number;
    expect(d1).toBeCloseTo(d0 * Math.exp(-1), 5);
  });
});
