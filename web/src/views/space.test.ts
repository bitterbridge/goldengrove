import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../sim/parse';
import type { Sim } from '../sim/wasm';
import { buildSpaceScene } from './space';

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
});
