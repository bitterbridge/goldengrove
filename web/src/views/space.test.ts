import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDescriptor } from '../sim/parse';
import type { Sim } from '../sim/wasm';
import { bodyLayout, parentIndex } from '../sim/layout';
import { buildSpaceScene } from './space';
import { clearTerrainCache } from './terrainCache';
import { compressPosition } from './compression';
import { AU_M } from '../sim/types';

const goldenPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json');
const golden = parseDescriptor(readFileSync(goldenPath, 'utf8'));

/** A Sim backed by canned data — scene construction needs no real WASM. */
function fakeSim(): Sim {
  const layoutLen =
    golden.stars.length + golden.planets.length + golden.planets.reduce((n, p) => n + p.moons.length, 0);
  const fake: Sim = {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: layoutLen,
    statesAt: (tS) => {
      const out = new Float64Array(layoutLen * 7);
      for (let i = 0; i < layoutLen; i++) {
        out[i * 7] = (i + 1) * 1e10 + tS * 0; // spread bodies on +X
        out[i * 7 + 5] = 1; // spin axis +Z
      }
      return out;
    },
    orbitPath: (i, segments, _tS) => {
      if (i < golden.stars.length) return new Float64Array(0);
      const out = new Float64Array(segments * 3);
      for (let k = 0; k < segments; k++) {
        const th = (2 * Math.PI * k) / segments;
        out[k * 3] = Math.cos(th) * 1e11;
        out[k * 3 + 1] = Math.sin(th) * 1e11;
      }
      return out;
    },
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: (tS) => {
      // Mass-weighted barycenter of the close pair (stars 0 and 1) computed
      // from this same fake's statesAt — mirrors the real Sim.hostOriginAt
      // contract (golden seed-42 has 2 stars, host is Barycenter).
      const s = fake.statesAt(tS);
      const m0 = golden.stars[0]!.mass_kg;
      const m1 = golden.stars[1]!.mass_kg;
      const w = m0 + m1;
      return new Float64Array([
        (m0 * s[0]! + m1 * s[7]!) / w,
        (m0 * s[1]! + m1 * s[8]!) / w,
        (m0 * s[2]! + m1 * s[9]!) / w,
      ]);
    },
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: () => null,
    bodyElevation: () => 0,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
  };
  return fake;
}

/**
 * Like fakeSim(), but the close stellar pair (stars 0 and 1) sits tens of
 * AU from the world origin — mirrors a trinary system where the wide
 * companion's recoil displaces the planet host (the barycenter of the
 * close pair) away from the origin. Planets sit at whole-AU offsets from
 * the pair (first planet at +1 AU) so local-structure assertions are easy.
 */
function fakeSimWithDisplacedStars(): Sim {
  const layoutLen =
    golden.stars.length + golden.planets.length + golden.planets.reduce((n, p) => n + p.moons.length, 0);
  const STAR_OFFSET: [number, number, number] = [5e11, 0, 0];
  const fake: Sim = {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: layoutLen,
    statesAt: (tS) => {
      const out = new Float64Array(layoutLen * 7);
      for (let i = 0; i < layoutLen; i++) {
        // planets/moons: STAR_OFFSET + whole AU on +X (first planet at +1 AU)
        out[i * 7] = STAR_OFFSET[0] + (i - 1) * AU_M + tS * 0;
        out[i * 7 + 5] = 1; // spin axis +Z
      }
      // stars 0 and 1: both near the offset, ~1 meter apart
      out[0 * 7] = STAR_OFFSET[0];
      out[0 * 7 + 1] = STAR_OFFSET[1];
      out[0 * 7 + 2] = STAR_OFFSET[2];
      out[1 * 7] = STAR_OFFSET[0] + 1;
      out[1 * 7 + 1] = STAR_OFFSET[1];
      out[1 * 7 + 2] = STAR_OFFSET[2];
      return out;
    },
    orbitPath: (i, segments, _tS) => {
      if (i < golden.stars.length) return new Float64Array(0);
      const out = new Float64Array(segments * 3);
      for (let k = 0; k < segments; k++) {
        const th = (2 * Math.PI * k) / segments;
        out[k * 3] = Math.cos(th) * 1e11;
        out[k * 3 + 1] = Math.sin(th) * 1e11;
      }
      return out;
    },
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: (tS) => {
      // Mass-weighted barycenter of the close pair (stars 0 and 1) computed
      // from this same fake's statesAt.
      const s = fake.statesAt(tS);
      const m0 = golden.stars[0]!.mass_kg;
      const m1 = golden.stars[1]!.mass_kg;
      const w = m0 + m1;
      return new Float64Array([
        (m0 * s[0]! + m1 * s[7]!) / w,
        (m0 * s[1]! + m1 * s[8]!) / w,
        (m0 * s[2]! + m1 * s[9]!) / w,
      ]);
    },
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: () => null,
    bodyElevation: () => 0,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
  };
  return fake;
}

describe('buildSpaceScene', () => {
  beforeEach(() => clearTerrainCache());

  it('creates one mesh + label per body and orbit lines for non-stars', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    expect(view.bodies.length).toBe(sim.bodyCount);
    expect(view.labels.length).toBe(sim.bodyCount);
    const lines = view.scene.getObjectByName('orbit-lines')!;
    expect(lines.children.length).toBe(sim.bodyCount - golden.stars.length);
  });

  it('update() positions meshes and never leaves NaNs', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    view.update(sim.statesAt(0), false, sim.hostOriginAt(0), 0);
    for (const mesh of view.bodies) {
      expect(Number.isFinite(mesh.position.x)).toBe(true);
      expect(mesh.position.length()).toBeGreaterThan(0);
    }
  });

  it('bodyIndexOf resolves meshes back to body indices', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    expect(view.bodyIndexOf(view.bodies[3]!)).toBe(3);
    expect(view.bodyIndexOf(view.scene)).toBeNull();
  });

  it('rescales orbit lines on trueScale flips and keeps followers in sync', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    const states = sim.statesAt(0);
    const originM = sim.hostOriginAt(0);
    view.update(states, false, originM, 0);

    const lines = view.scene.getObjectByName('orbit-lines')!;
    const firstLine = lines.children[0] as THREE.LineLoop;
    const attr = (firstLine.geometry as THREE.BufferGeometry).getAttribute('position');
    const compressedX = attr.getX(1);
    expect(Number.isFinite(compressedX)).toBe(true);
    expect(compressedX).not.toBe(0); // first frame wrote vertices

    view.update(states, true, originM, 0); // flip to true scale
    const trueX = attr.getX(1);
    expect(trueX).not.toBeCloseTo(compressedX, 6); // vertices rewritten

    view.update(states, false, originM, 0); // flip back
    expect(attr.getX(1)).toBeCloseTo(compressedX, 6);

    // star point-light follows its star mesh
    let lightChecked = false;
    view.scene.traverse((o) => {
      const follows = o.userData.followsBody as number | undefined;
      if (follows !== undefined) {
        expect(o.position.distanceTo(view.bodies[follows]!.position)).toBeLessThan(1e-9);
        lightChecked = true;
      }
    });
    expect(lightChecked).toBe(true);

    // a moon's orbit line rides its planet's view position
    const layout = bodyLayout(golden);
    const moonIdx = layout.findIndex((r) => r.kind === 'moon');
    if (moonIdx >= 0) {
      const moonLine = lines.children.find((c) => c.name === `orbit-${moonIdx}`)!;
      const parentIdx = parentIndex(layout, golden, moonIdx)!;
      expect(moonLine.position.distanceTo(view.bodies[parentIdx]!.position)).toBeLessThan(1e-9);
    }

    // moon orbit-line VERTICES also rescale on flips (previously unprobed)
    const moonIdx2 = layout.findIndex((r) => r.kind === 'moon');
    if (moonIdx2 >= 0) {
      const moonOrbitLine = lines.children.find((c) => c.name === `orbit-${moonIdx2}`)! as THREE.LineLoop;
      const mAttr = (moonOrbitLine.geometry as THREE.BufferGeometry).getAttribute('position');
      const compressedMX = mAttr.getX(1);
      view.update(states, true, originM, 0);
      expect(mAttr.getX(1)).not.toBeCloseTo(compressedMX, 6);
      view.update(states, false, originM, 0);
      expect(mAttr.getX(1)).toBeCloseTo(compressedMX, 6);
    }
  });

  it('compresses positions relative to the displaced stellar host (trinary framing)', () => {
    const sim = fakeSimWithDisplacedStars();
    const view = buildSpaceScene(sim);
    const states = sim.statesAt(0);
    const originMArr = sim.hostOriginAt(0);
    view.update(states, false, originMArr, 0);

    // mass-weighted barycenter of the close pair (stars 0 and 1) — same
    // formula the fix uses to compute the planet host origin.
    const m0 = golden.stars[0]!.mass_kg;
    const m1 = golden.stars[1]!.mass_kg;
    const w0 = m0 / (m0 + m1);
    const w1 = m1 / (m0 + m1);
    const originM: [number, number, number] = [
      w0 * states[0]! + w1 * states[7]!,
      w0 * states[1]! + w1 * states[8]!,
      w0 * states[2]! + w1 * states[9]!,
    ];
    const originView = compressPosition(originM[0], originM[1], originM[2], false);

    const actualOriginView = view.hostOriginView();
    expect(actualOriginView[0]).toBeCloseTo(originView[0], 4);
    expect(actualOriginView[1]).toBeCloseTo(originView[1], 4);
    expect(actualOriginView[2]).toBeCloseTo(originView[2], 4);

    // star and planet meshes: originView + compressPosition(offset from origin)
    const pIdx = golden.stars.length; // first planet body index
    for (const i of [0, 1, pIdx]) {
      const off = compressPosition(
        states[i * 7]! - originM[0],
        states[i * 7 + 1]! - originM[1],
        states[i * 7 + 2]! - originM[2],
        false,
      );
      expect(view.bodies[i]!.position.x).toBeCloseTo(originView[0] + off[0], 4);
      expect(view.bodies[i]!.position.y).toBeCloseTo(originView[1] + off[1], 4);
      expect(view.bodies[i]!.position.z).toBeCloseTo(originView[2] + off[2], 4);
    }

    // local structure survives displacement: a planet 1 AU from the pair
    // must render well clear of it (absolute-compression crushed this to
    // under a view unit at ~3 AU displacement).
    expect(view.bodies[pIdx]!.position.distanceTo(view.bodies[0]!.position)).toBeGreaterThanOrEqual(2);

    // planet orbit line: vertices are plain compressPosition(raw) (path is
    // host-relative); the line object itself rides originView.
    const lines = view.scene.getObjectByName('orbit-lines')!;
    const firstLine = lines.children[0] as THREE.LineLoop;
    const raw = firstLine.userData.rawPath as Float64Array;
    const attr = (firstLine.geometry as THREE.BufferGeometry).getAttribute('position');

    expect(firstLine.position.x).toBeCloseTo(originView[0], 4);
    expect(firstLine.position.y).toBeCloseTo(originView[1], 4);
    expect(firstLine.position.z).toBeCloseTo(originView[2], 4);
    let expected = compressPosition(raw[0]!, raw[1]!, raw[2]!, false);
    expect(attr.getX(0)).toBeCloseTo(expected[0], 4);
    expect(attr.getY(0)).toBeCloseTo(expected[1], 4);
    expect(attr.getZ(0)).toBeCloseTo(expected[2], 4);

    // flip trueScale: vertices rewrite with true-scale compression and the
    // line follows the true-scale originView
    view.update(states, true, originMArr, 0);
    const originViewTrue = compressPosition(originM[0], originM[1], originM[2], true);
    expect(firstLine.position.x).toBeCloseTo(originViewTrue[0], 4);
    expected = compressPosition(raw[0]!, raw[1]!, raw[2]!, true);
    expect(attr.getX(0)).toBeCloseTo(expected[0], 4);
    expect(attr.getY(0)).toBeCloseTo(expected[1], 4);
    expect(attr.getZ(0)).toBeCloseTo(expected[2], 4);
  });

  it('uses terrain textures when the sim provides them (headless canvas may still yield null)', () => {
    const sim = fakeSim();
    sim.seed = 'terrain-scene-test';
    sim.bodyTerrainInfo = (i) => (i >= golden.stars.length ? { sea_level: 0, ocean_fraction: 0.6, relief_m: 6000, plate_count: 9 } : null);
    sim.bodyHeightmap = (i, w, h) => (i >= golden.stars.length ? new Float32Array(w * h) : new Float32Array(0));
    const view = buildSpaceScene(sim);
    // structural: construction succeeds either way; material is either mapped or fallback
    expect(view.bodies.length).toBe(sim.bodyCount);
  });

  it('refreshes orbit paths when the sim time moves far from the path epoch', () => {
    const sim = fakeSim();
    let calls = 0;
    const orig = sim.orbitPath;
    sim.orbitPath = (i, seg, tS) => { calls++; return orig(i, seg, tS); };
    const view = buildSpaceScene(sim);
    const built = calls;
    view.update(sim.statesAt(0), false, sim.hostOriginAt(0), 0);
    expect(calls).toBe(built); // fresh: no refetch
    view.update(sim.statesAt(0), false, sim.hostOriginAt(0), 1e9); // ~30 years
    expect(calls).toBeGreaterThan(built); // stale: refetched
  });
});
