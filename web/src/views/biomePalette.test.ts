import { describe, expect, it } from 'vitest';
import { BIOME_COUNT, BIOME_RGB, biomeColor } from './biomePalette';

describe('BIOME_RGB', () => {
  it('has exactly BIOME_COUNT rows', () => {
    expect(BIOME_RGB.length).toBe(BIOME_COUNT);
    expect(BIOME_COUNT).toBe(13);
  });

  it('every row is a valid RGB triple', () => {
    for (const row of BIOME_RGB) {
      expect(row.length).toBe(3);
      for (const c of row) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('biomeColor', () => {
  it('returns the exact palette row at shade 1.0', () => {
    expect(biomeColor(0, 1)).toEqual([12, 42, 82]); // DeepOcean
    expect(biomeColor(9, 1)).toEqual([47, 107, 60]); // TropicalRainforest
  });

  it('clamps out-of-range indices to 12 (AlpineRock grey)', () => {
    expect(biomeColor(12, 1)).toEqual([141, 133, 120]);
    expect(biomeColor(13, 1)).toEqual([141, 133, 120]);
    expect(biomeColor(255, 1)).toEqual([141, 133, 120]);
    expect(biomeColor(-1, 1)).toEqual([141, 133, 120]);
  });

  it('scales brightness like hypsometricColor shade', () => {
    const flat = biomeColor(6, 1.0);
    const lit = biomeColor(6, 1.15);
    const shadow = biomeColor(6, 0.8);
    expect(lit[0]).toBeGreaterThan(flat[0]);
    expect(shadow[0]).toBeLessThan(flat[0]);
  });

  it('never exceeds 255 even when shaded up', () => {
    const [r, g, b] = biomeColor(3, 1.15); // IceCap is near-white
    expect(r).toBeLessThanOrEqual(255);
    expect(g).toBeLessThanOrEqual(255);
    expect(b).toBeLessThanOrEqual(255);
  });
});
