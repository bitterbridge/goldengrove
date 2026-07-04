import { describe, expect, it } from 'vitest';
import { stepLatLon } from './walk';

describe('stepLatLon', () => {
  it('forward at az=0 increases lat', () => {
    const r = stepLatLon(0, 0, 0, 1, 0, 1);
    expect(r.latDeg).toBeCloseTo(1, 9);
    expect(r.lonDeg).toBeCloseTo(0, 9);
  });

  it('forward at az=pi/2 increases lon, scaled by 1/cos(lat)', () => {
    const r0 = stepLatLon(0, 0, Math.PI / 2, 1, 0, 1);
    expect(r0.latDeg).toBeCloseTo(0, 9);
    expect(r0.lonDeg).toBeCloseTo(1, 9);

    const r60 = stepLatLon(60, 0, Math.PI / 2, 1, 0, 1);
    expect(r60.lonDeg).toBeCloseTo(2, 6); // 1 / cos(60deg) == 2
  });

  it('strafe right at az=0 increases lon', () => {
    const r = stepLatLon(0, 0, 0, 0, 1, 1);
    expect(r.lonDeg).toBeGreaterThan(0);
    expect(r.latDeg).toBeCloseTo(0, 9);
  });

  it('clamps latitude at 89', () => {
    const r = stepLatLon(88, 0, 0, 1, 0, 5);
    expect(r.latDeg).toBe(89);
  });

  it('wraps longitude into (-180, 180]', () => {
    const r = stepLatLon(0, 179, 0, 0, 1, 2);
    expect(r.lonDeg).toBeCloseTo(-179, 9);
  });
});
