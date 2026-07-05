import { describe, expect, it } from 'vitest';
import { biomeTexture, hypsometricColor, slopeShade } from './terrainTexture';

const tint: [number, number, number] = [155, 143, 122]; // Rocky palette 0x9b8f7a

describe('hypsometricColor', () => {
  it('deep ocean is dark blue, shallows lighter', () => {
    const deep = hypsometricColor(-1.5, 1, tint, false);
    const shallow = hypsometricColor(-0.05, 1, tint, false);
    expect(deep[2]).toBeGreaterThan(deep[0]); // blue dominant
    expect(shallow[2]).toBeGreaterThan(shallow[0]);
    expect(shallow[0] + shallow[1] + shallow[2]).toBeGreaterThan(deep[0] + deep[1] + deep[2]);
  });
  it('land climbs from lowland tones to pale peaks', () => {
    const low = hypsometricColor(0.05, 1, tint, false);
    const peak = hypsometricColor(1.8, 1, tint, false);
    expect(peak[0] + peak[1] + peak[2]).toBeGreaterThan(low[0] + low[1] + low[2]);
    expect(Math.abs(peak[0] - peak[2])).toBeLessThan(30); // peaks near-grey
  });
  it('dead worlds have no blue basins', () => {
    const basin = hypsometricColor(-1.0, 1, tint, true);
    expect(basin[2]).toBeLessThanOrEqual(basin[0]); // browns, not blues
  });
  it('shade scales brightness', () => {
    const flat = hypsometricColor(0.5, 1.0, tint, false);
    const lit = hypsometricColor(0.5, 1.15, tint, false);
    const shadow = hypsometricColor(0.5, 0.8, tint, false);
    expect(lit[0]).toBeGreaterThan(flat[0]);
    expect(shadow[0]).toBeLessThan(flat[0]);
  });
});

describe('slopeShade', () => {
  it('west-facing slopes catch the NW light', () => {
    // simple ramp descending eastward: west faces brighter than east faces
    const w = 8, h = 4;
    const map = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) map[r * w + c] = -c * 0.2;
    const bright = slopeShade(map, w, h, 2, 4);
    const flat = slopeShade(new Float32Array(w * h), w, h, 2, 4);
    expect(bright).toBeGreaterThan(flat);
    expect(flat).toBeCloseTo(1.0, 5);
  });
  it('clamps to a sane range', () => {
    const w = 8, h = 4;
    const cliff = new Float32Array(w * h).map((_, i) => (i % w) % 2 ? 50 : -50);
    const s = slopeShade(cliff, w, h, 2, 3);
    expect(s).toBeGreaterThanOrEqual(0.75);
    expect(s).toBeLessThanOrEqual(1.15);
  });
});

describe('biomeTexture', () => {
  it('returns null without a canvas (jsdom has no 2d context)', () => {
    const w = 8, h = 4;
    const biomes = new Uint8Array(w * h);
    const elevations = new Float32Array(w * h);
    expect(biomeTexture(biomes, elevations, w, h)).toBeNull();
  });

  it('returns null (not throws) with out-of-range class indices', () => {
    const w = 8, h = 4;
    const biomes = new Uint8Array(w * h).fill(255); // out-of-range -> clamps to AlpineRock
    const elevations = new Float32Array(w * h);
    expect(() => biomeTexture(biomes, elevations, w, h)).not.toThrow();
    expect(biomeTexture(biomes, elevations, w, h)).toBeNull();
  });
});
