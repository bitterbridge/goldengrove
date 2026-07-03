import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDescriptor } from '../sim/parse';
import type { Sim } from '../sim/wasm';
import { bodyLayout, parentIndex } from '../sim/layout';
import { buildSpaceScene } from './space';
import { compressPosition } from './compression';

const goldenPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json');
const golden = parseDescriptor(readFileSync(goldenPath, 'utf8'));

/** A Sim backed by canned data — scene construction needs no real WASM. */
function fakeSim(): Sim {
  const layoutLen =
    golden.stars.length + golden.planets.length + golden.planets.reduce((n, p) => n + p.moons.length, 0);
  return {
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
    orbitPath: (i, segments) => {
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
  };
}

/**
 * Like fakeSim(), but the close stellar pair (stars 0 and 1) sits tens of
 * AU from the world origin — mirrors a trinary system where the wide
 * companion's recoil displaces the planet host (the barycenter of the
 * close pair) away from the origin. Planets keep the same spread as
 * fakeSim() so orbit-line assertions stay comparable.
 */
function fakeSimWithDisplacedStars(): Sim {
  const layoutLen =
    golden.stars.length + golden.planets.length + golden.planets.reduce((n, p) => n + p.moons.length, 0);
  const STAR_OFFSET: [number, number, number] = [5e11, 0, 0];
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: layoutLen,
    statesAt: (tS) => {
      const out = new Float64Array(layoutLen * 7);
      for (let i = 0; i < layoutLen; i++) {
        out[i * 7] = (i + 1) * 1e10 + tS * 0; // spread bodies on +X (planets/moons)
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
    orbitPath: (i, segments) => {
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
  };
}

describe('buildSpaceScene', () => {
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
    view.update(sim.statesAt(0), false);
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
    view.update(states, false);

    const lines = view.scene.getObjectByName('orbit-lines')!;
    const firstLine = lines.children[0] as THREE.LineLoop;
    const attr = (firstLine.geometry as THREE.BufferGeometry).getAttribute('position');
    const compressedX = attr.getX(1);
    expect(Number.isFinite(compressedX)).toBe(true);
    expect(compressedX).not.toBe(0); // first frame wrote vertices

    view.update(states, true); // flip to true scale
    const trueX = attr.getX(1);
    expect(trueX).not.toBeCloseTo(compressedX, 6); // vertices rewritten

    view.update(states, false); // flip back
    expect(attr.getX(1)).toBeCloseTo(compressedX, 6);

    // star point-light follows its star mesh
    let lightChecked = false;
    view.scene.traverse((o) => {
      const follows = (o as THREE.PointLight & { __followsBody?: number }).__followsBody;
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
  });

  it('planet orbit lines and camera origin follow the displaced stellar host (trinary framing)', () => {
    const sim = fakeSimWithDisplacedStars();
    const view = buildSpaceScene(sim);
    const states = sim.statesAt(0);
    view.update(states, false);

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

    const expectedOriginView = compressPosition(originM[0], originM[1], originM[2], false);
    const actualOriginView = view.hostOriginView();
    expect(actualOriginView[0]).toBeCloseTo(expectedOriginView[0], 4);
    expect(actualOriginView[1]).toBeCloseTo(expectedOriginView[1], 4);
    expect(actualOriginView[2]).toBeCloseTo(expectedOriginView[2], 4);

    // first planet's orbit line renders at raw path + host origin, not raw alone
    const lines = view.scene.getObjectByName('orbit-lines')!;
    const firstLine = lines.children[0] as THREE.LineLoop;
    const raw = (firstLine as THREE.LineLoop & { __rawPath?: Float64Array }).__rawPath!;
    const attr = (firstLine.geometry as THREE.BufferGeometry).getAttribute('position');

    let expected = compressPosition(raw[0]! + originM[0], raw[1]! + originM[1], raw[2]! + originM[2], false);
    expect(attr.getX(0)).toBeCloseTo(expected[0], 4);
    expect(attr.getY(0)).toBeCloseTo(expected[1], 4);
    expect(attr.getZ(0)).toBeCloseTo(expected[2], 4);

    // flip trueScale: vertex updates using the same origin, true-scale compression
    view.update(states, true);
    expected = compressPosition(raw[0]! + originM[0], raw[1]! + originM[1], raw[2]! + originM[2], true);
    expect(attr.getX(0)).toBeCloseTo(expected[0], 4);
    expect(attr.getY(0)).toBeCloseTo(expected[1], 4);
    expect(attr.getZ(0)).toBeCloseTo(expected[2], 4);
  });
});
