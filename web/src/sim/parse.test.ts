import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from './parse';

const goldenPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json');
const goldenJson = readFileSync(goldenPath, 'utf8');

describe('parseDescriptor', () => {
  it('accepts the real golden descriptor (cross-boundary contract)', () => {
    const d = parseDescriptor(goldenJson);
    expect(d.schema_version).toBe(2);
    expect(d.seed).toBe('42');
    expect(d.stars.length).toBeGreaterThan(0);
    expect(d.planets.length).toBeGreaterThan(0);
    const anchor = d.planets[d.anchor_planet]!;
    expect(anchor.class).toBe('Rocky');
    expect(anchor.calendar).not.toBeNull();
    expect(anchor.calendar!.months.length).toBe(anchor.moons.length);
    for (const p of d.planets) {
      expect(p.state.kind === 'Living' || p.state.kind === 'Dead' || p.state.kind === 'Doomed').toBe(true);
      if (p.state.kind === 'Doomed') expect(p.state.doom_time_s).toBeGreaterThan(0);
    }
  });

  it('rejects wrong schema version', () => {
    const d = JSON.parse(goldenJson);
    d.schema_version = 99;
    expect(() => parseDescriptor(JSON.stringify(d))).toThrow(/schema_version/);
  });

  it('rejects structurally broken input naming the path', () => {
    const d = JSON.parse(goldenJson);
    delete d.planets[0].orbit;
    expect(() => parseDescriptor(JSON.stringify(d))).toThrow(/planets\[0\]\.orbit/);
  });

  it('rejects Barycenter host with fewer than 2 stars', () => {
    const d = JSON.parse(goldenJson);
    d.planet_host = 'Barycenter';
    d.stars = [d.stars[0]];
    expect(() => parseDescriptor(JSON.stringify(d))).toThrow(/planet_host/);
  });
});
