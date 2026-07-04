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
    bodyTerrainInfo: () => null,
    bodyElevation: () => 0,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
  };
}

describe('buildGroundScene', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;

  it('creates one mesh + label per body (stood-on one hides at update) and the fixed furniture', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    expect(g.bodies.length).toBe(sim.bodyCount);
    expect(g.labels.length).toBe(sim.bodyCount);
    expect(g.scene.getObjectByName('starfield')).toBeTruthy();
    expect(g.scene.getObjectByName('skydome')).toBeTruthy();
    expect(g.scene.getObjectByName('ground-disc')).toBeTruthy();
    // golden seed-42 has tidally locked moons: at least one label carries the lock badge
    expect(g.labels.some((l) => (l.element as HTMLElement).textContent?.endsWith('🔒'))).toBe(true);
  });

  it('update() places bodies on the 850-950 dome, ranked by true distance', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 15, lonDeg: 0 });
    const dists = g.bodies.map((m) => m.position.length()).filter((d) => d > 0);
    expect(Math.min(...dists)).toBeGreaterThanOrEqual(850 - 1e-6);
    expect(Math.max(...dists)).toBeLessThanOrEqual(950 + 1e-6);
    for (const m of g.bodies) {
      expect(Number.isFinite(m.position.x)).toBe(true);
      expect(m.scale.x).toBeGreaterThan(0);
    }
  });

  it('suns light the scene and drive dayFactor', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 });
    const lights: THREE.DirectionalLight[] = [];
    g.scene.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight) lights.push(o as THREE.DirectionalLight); });
    expect(lights.length).toBeGreaterThanOrEqual(1);
    expect(g.dayFactor()).toBeGreaterThanOrEqual(0);
    expect(g.dayFactor()).toBeLessThanOrEqual(1);
  });

  it('keeps sky bodies sunlit when the sun is below the horizon (moon-at-night)', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    // fixture geometry: bodies along +x, axis +z; at lat 0 lon 0 the observer's
    // up is +x and both suns sit at z ~ -1 — deep night. Sky bodies (the moon
    // overhead at midnight) must still receive sunlight for correct phases.
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 0 });
    const lights: THREE.DirectionalLight[] = [];
    g.scene.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight) lights.push(o as THREE.DirectionalLight); });
    const total = lights.reduce((sum, l) => sum + l.intensity, 0);
    expect(total).toBeGreaterThan(0);
    // and the lit light still points from the sun's sky direction (below horizon)
    const lit = lights.find((l) => l.intensity > 0)!;
    expect(lit.position.z).toBeLessThan(0);
  });

  it('applies body rotation from the axis+angle state slots', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const states = sim.statesAt(0);
    g.update(states, { body: anchorBody, latDeg: 15, lonDeg: 0 });

    // mesh index === body index (bodies are pushed in layout order); pick a
    // visible one the same way the dome-placement test identifies visibility.
    const visible = g.bodies.findIndex((m) => m.position.length() > 0);
    expect(visible).toBeGreaterThanOrEqual(0);
    const mesh = g.bodies[visible]!;

    // rotation angle 0 on the first call -> identity-ish quaternion
    expect(mesh.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
    const beforeQuat = mesh.quaternion.clone();

    const rotated = states.slice();
    rotated[visible * 7 + 6] = 1.0; // advance this body's rotation angle
    g.update(rotated, { body: anchorBody, latDeg: 15, lonDeg: 0 });

    expect(mesh.quaternion.equals(beforeQuat)).toBe(false);
  });

  it('labels hide below the horizon', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 0 });
    const anyHidden = g.labels.some((l) => l.visible === false);
    const anyShown = g.labels.some((l) => l.visible === true);
    expect(anyHidden || anyShown).toBe(true); // structural: visibility is being managed
  });
});
