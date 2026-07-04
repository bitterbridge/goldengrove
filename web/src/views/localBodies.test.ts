import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { buildLocalBodies } from './localBodies';
import { observerFrame } from './observer';

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
  };
}

describe('buildLocalBodies', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;
  const states = () => fakeSim().statesAt(0); // bodies along +x at (i+1)e10, axis +z
  const camera = new THREE.PerspectiveCamera(60, 1400 / 900, 0.3, 1e13);

  function updated(standing = anchorBody) {
    const sim = fakeSim();
    const lb = buildLocalBodies(sim);
    const st = states();
    const frame = observerFrame(st, golden, standing, 0, 0);
    const obs: [number, number, number] = [frame.positionM[0], frame.positionM[1], frame.positionM[2]];
    lb.update(st, obs, frame, standing, camera, 900);
    return { lb, frame };
  }

  it('creates one directional light per star, ungated by horizon', () => {
    const { lb } = updated();
    const lights: THREE.DirectionalLight[] = [];
    lb.group.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight) lights.push(o as THREE.DirectionalLight); });
    expect(lights.length).toBe(golden.stars.length);
    expect(Math.max(...lights.map((l) => l.intensity))).toBeGreaterThan(0);
    // fixture geometry puts the suns below the observer's horizon (lon 0 ⇒ up = +x,
    // suns at smaller x ⇒ dir z ≈ −1): the light must still be on — moon-at-night successor.
    const lit = lights.find((l) => l.intensity > 0)!;
    expect(lit.position.z).toBeLessThan(0);
  });

  it('places bodies at true distance and scale in ENU', () => {
    const { lb, frame } = updated();
    let checked = 0;
    lb.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible || m.userData.bodyIndex === undefined) return;
      const i = m.userData.bodyIndex as number;
      if (i === anchorBody) return;
      // fixture: body i at x=(i+1)e10; observer sits at frame.positionM (anchor's
      // surface point, which is offset from the anchor's raw position by the
      // anchor's own radius — that offset must be included for a true-distance
      // comparison, not just the raw (i+1)e10 body-index spacing).
      const expected = Math.abs((i + 1) * 1e10 - frame.positionM[0]) || null;
      if (expected) { expect(m.position.length()).toBeCloseTo(expected, -4); checked++; }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('hides the standing body entirely', () => {
    const { lb } = updated();
    lb.group.traverse((o) => {
      if ((o as THREE.Object3D).userData?.bodyIndex === anchorBody) expect((o as THREE.Object3D).visible).toBe(false);
    });
  });

  it('sub-2px bodies render as dots, larger as meshes', () => {
    const { lb } = updated();
    let dots = 0, meshes = 0;
    lb.group.traverse((o) => {
      if ((o as THREE.Sprite).isSprite && o.visible && o.userData.isDot) dots++;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.userData.bodyIndex !== undefined) meshes++;
    });
    // at 1e10-m spacings with true radii, most bodies are sub-pixel: dots dominate
    expect(dots).toBeGreaterThan(0);
    expect(dots + meshes).toBeGreaterThan(5);
  });

  it('hides non-star labels below the horizon, shows them above', () => {
    const { lb } = updated();
    // fixture geometry (lon 0 ⇒ up = +x): body index 2 (planet 0) sits at
    // smaller x than the observer (anchorBody = 3) ⇒ ENU dir z ≈ -1, well
    // below the -0.12 rad horizon gate — mirrors the old dome's below-horizon
    // hiding, which the new true-position view must preserve.
    expect(lb.labels[2]!.visible).toBe(false);
    // body index 4 (planet 2) sits at larger x ⇒ ENU dir z ≈ +1, above the
    // horizon — its (non-star) label stays visible.
    expect(lb.labels[4]!.visible).toBe(true);
  });

  it('dispose empties the group', () => {
    const { lb } = updated();
    lb.dispose();
    let anything = 0;
    lb.group.traverse((o) => { if (o !== lb.group) anything++; });
    expect(anything).toBe(0);
  });
});
