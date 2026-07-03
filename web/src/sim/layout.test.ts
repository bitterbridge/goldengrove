import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyLayout, bodyName, parentIndex } from './layout';
import { parseDescriptor } from './parse';

const goldenPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json');
const golden = parseDescriptor(readFileSync(goldenPath, 'utf8'));

describe('bodyLayout', () => {
  it('matches the gg-ephemeris body order: stars, planets, moons grouped', () => {
    const layout = bodyLayout(golden);
    const nStars = golden.stars.length;
    const nPlanets = golden.planets.length;
    const nMoons = golden.planets.reduce((n, p) => n + p.moons.length, 0);
    expect(layout.length).toBe(nStars + nPlanets + nMoons);
    for (let i = 0; i < nStars; i++) expect(layout[i]).toEqual({ kind: 'star', star: i });
    for (let i = 0; i < nPlanets; i++) expect(layout[nStars + i]).toEqual({ kind: 'planet', planet: i });
    let m = nStars + nPlanets;
    for (let p = 0; p < nPlanets; p++) {
      for (let j = 0; j < golden.planets[p]!.moons.length; j++) {
        expect(layout[m]).toEqual({ kind: 'moon', planet: p, moon: j });
        expect(parentIndex(layout, golden, m)).toBe(nStars + p);
        m++;
      }
    }
    expect(parentIndex(layout, golden, 0)).toBeNull();
  });

  it('names bodies stably', () => {
    expect(bodyName(golden, 0)).toBe('★A');
    expect(bodyName(golden, golden.stars.length)).toBe('I');
  });
});
