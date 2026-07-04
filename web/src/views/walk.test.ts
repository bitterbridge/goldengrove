import { describe, expect, it } from 'vitest';
import { flightStep, groundSpeedMps, stepLatLon } from './walk';

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

describe('flightStep', () => {
  const R = 6.371e6;
  it('ascends from the ground at the 2 m/s floor', () => {
    expect(flightStep(0, +1, 1, R)).toBeCloseTo(2, 6);
  });
  it('rate scales with altitude', () => {
    expect(flightStep(10_000, +1, 1, R)).toBeCloseTo(15_000, 0); // 10km + 10km/2*1s
  });
  it('descends and clamps at the ground', () => {
    expect(flightStep(3, -1, 10, R)).toBe(0);
  });
  it('clamps at 10 radii', () => {
    expect(flightStep(10 * R, +1, 100, R)).toBe(10 * R);
  });
  it('holds altitude with no input', () => {
    expect(flightStep(5000, 0, 1, R)).toBe(5000);
  });
});

describe('groundSpeedMps', () => {
  it('walks at 1.4, skims at 100', () => {
    expect(groundSpeedMps(0, false)).toBeCloseTo(1.4, 6);
    expect(groundSpeedMps(0, true)).toBe(100);
  });
  it('flying speed grows with altitude past the skim floor', () => {
    // max(100, altM / 2): at 1000 m the /2 term (500) already exceeds the
    // 100 m/s skim floor, so flying speed has grown past it.
    expect(groundSpeedMps(1000, false)).toBe(500);
    expect(groundSpeedMps(50_000, false)).toBe(25_000);
  });
});
