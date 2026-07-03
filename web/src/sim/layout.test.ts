import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { atmosphereDensityFor, bodyLayout, bodyName, bodyRadiusM, parentIndex, standableBody } from './layout';
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

describe('body metadata helpers', () => {
  it('radius lookup covers all three kinds', () => {
    expect(bodyRadiusM(golden, { kind: 'star', star: 0 })).toBe(golden.stars[0]!.radius_m);
    expect(bodyRadiusM(golden, { kind: 'planet', planet: 0 })).toBe(golden.planets[0]!.radius_m);
    const pi = golden.planets.findIndex((p) => p.moons.length > 0);
    expect(bodyRadiusM(golden, { kind: 'moon', planet: pi, moon: 0 })).toBe(golden.planets[pi]!.moons[0]!.radius_m);
  });
  it('standable: rocky planets and moons only', () => {
    const rocky = golden.planets.findIndex((p) => p.class === 'Rocky');
    const giant = golden.planets.findIndex((p) => p.class !== 'Rocky');
    expect(standableBody(golden, { kind: 'planet', planet: rocky })).toBe(true);
    if (giant >= 0) expect(standableBody(golden, { kind: 'planet', planet: giant })).toBe(false);
    expect(standableBody(golden, { kind: 'star', star: 0 })).toBe(false);
    const pi = golden.planets.findIndex((p) => p.moons.length > 0);
    expect(standableBody(golden, { kind: 'moon', planet: pi, moon: 0 })).toBe(true);
  });
  it('atmosphere density per class/state', () => {
    const rocky = golden.planets.findIndex((p) => p.class === 'Rocky');
    const d = atmosphereDensityFor(golden, { kind: 'planet', planet: rocky });
    expect(d).toBe(golden.planets[rocky]!.state.kind === 'Dead' ? 0.05 : 1.0);
    const pi = golden.planets.findIndex((p) => p.moons.length > 0);
    expect(atmosphereDensityFor(golden, { kind: 'moon', planet: pi, moon: 0 })).toBe(0.05);
  });
});
