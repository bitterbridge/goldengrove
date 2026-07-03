import { describe, expect, it } from 'vitest';
import { AU_M } from '../sim/types';
import { VIEW_UNITS_PER_AU, compressPosition, compressRadial, displayRadius, moonViewFactor } from './compression';

describe('compressRadial', () => {
  it('maps 1 AU to exactly VIEW_UNITS_PER_AU', () => {
    expect(compressRadial(AU_M, false)).toBeCloseTo(VIEW_UNITS_PER_AU, 6);
  });
  it('is monotonic and compresses the outer system', () => {
    const r1 = compressRadial(1 * AU_M, false);
    const r5 = compressRadial(5 * AU_M, false);
    const r30 = compressRadial(30 * AU_M, false);
    expect(r5).toBeGreaterThan(r1);
    expect(r30).toBeGreaterThan(r5);
    expect(r30).toBeLessThan(30 * VIEW_UNITS_PER_AU * 0.5); // strongly sublinear far out
  });
  it('true scale is linear', () => {
    expect(compressRadial(7 * AU_M, true)).toBeCloseTo(7 * VIEW_UNITS_PER_AU, 6);
  });
  it('preserves direction', () => {
    const [x, y, z] = compressPosition(3 * AU_M, 4 * AU_M, 0, false);
    expect(x / y).toBeCloseTo(3 / 4, 6);
    expect(z).toBe(0);
  });
  it('handles the origin', () => {
    expect(compressPosition(0, 0, 0, false)).toEqual([0, 0, 0]);
  });
});

describe('moon exaggeration', () => {
  it('keeps our Moon visibly outside an Earth-floor planet', () => {
    const f = moonViewFactor(3.844e8, false);
    const dView = 3.844e8 * f;
    expect(dView).toBeGreaterThanOrEqual(displayRadius('planet', 6.371e6, false) * 2.5 * 0.999);
  });
  it('caps huge moon systems', () => {
    const f = moonViewFactor(0.3 * AU_M, false); // outer giant moon
    expect(0.3 * AU_M * f).toBeLessThanOrEqual(1.5 * 1.001);
  });
  it('true scale disables exaggeration', () => {
    const f = moonViewFactor(3.844e8, true);
    expect(3.844e8 * f).toBeCloseTo((3.844e8 / AU_M) * VIEW_UNITS_PER_AU, 9);
  });
});

describe('displayRadius', () => {
  it('floors tiny true radii per class', () => {
    expect(displayRadius('star', 6.957e8, false)).toBeGreaterThanOrEqual(0.5);
    expect(displayRadius('planet', 6.371e6, false)).toBeGreaterThanOrEqual(0.15);
    expect(displayRadius('moon', 1.7e6, false)).toBeGreaterThanOrEqual(0.05);
  });
  it('true scale uses the real radius', () => {
    expect(displayRadius('star', 6.957e8, true)).toBeCloseTo((6.957e8 / AU_M) * VIEW_UNITS_PER_AU, 9);
  });
});
