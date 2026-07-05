import { describe, expect, it } from 'vitest';
import { decoupleWeight, eyeTerrainM, flightStep, groundSpeedMps, lonSlipDeg, spinRateRadPerS, stepLatLon } from './walk';

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
    expect(flightStep(0, +1, 1, R, 1e9)).toBeCloseTo(2, 6);
  });
  it('rate scales with altitude', () => {
    expect(flightStep(10_000, +1, 1, R, 1e9)).toBeCloseTo(15_000, 0); // 10km + 10km/2*1s
  });
  it('descends and clamps at the ground', () => {
    expect(flightStep(3, -1, 10, R, 1e9)).toBe(0);
  });
  it('clamps at 10 radii', () => {
    expect(flightStep(10 * R, +1, 100, R, 1e9)).toBe(10 * R);
  });
  it('holds altitude with no input', () => {
    expect(flightStep(5000, 0, 1, R, 1e9)).toBe(5000);
  });
});

describe('decoupleWeight', () => {
  const R = 6.371e6;
  it('is 1 on the ground and up to 0.05R', () => {
    expect(decoupleWeight(0, R)).toBe(1);
    expect(decoupleWeight(0.05 * R, R)).toBe(1);
  });
  it('is 0 at and above 0.5R', () => {
    expect(decoupleWeight(0.5 * R, R)).toBe(0);
    expect(decoupleWeight(5 * R, R)).toBe(0);
  });
  it('decreases monotonically in between', () => {
    const a = decoupleWeight(0.1 * R, R);
    const b = decoupleWeight(0.3 * R, R);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });
});

describe('lonSlipDeg', () => {
  const R = 6.371e6;
  it('is zero on the ground', () => {
    expect(lonSlipDeg(0, R, 7.3e-5, 1)).toBe(0);
  });
  it('slips fully at inertial altitude: planet spins east under you, you drift west', () => {
    const slip = lonSlipDeg(R, R, 7.3e-5, 10);
    expect(slip).toBeCloseTo((-7.3e-5 * 10 * 180) / Math.PI, 9);
  });
});

describe('spinRateRadPerS', () => {
  it('differences adjacent rotation samples', () => {
    expect(spinRateRadPerS(1.0, 1.006, 60)).toBeCloseTo(1e-4, 9);
  });
  it('unwraps across the 2π seam', () => {
    expect(spinRateRadPerS(2 * Math.PI - 0.003, 0.003, 60)).toBeCloseTo(1e-4, 9);
  });
});

describe('flightStep descent brake', () => {
  const R = 6.371e6;
  it('descending from high altitude over low terrain uses alt/3', () => {
    expect(flightStep(90_000, -1, 1, R, 89_000)).toBeCloseTo(90_000 - 30_000, 0);
  });
  it('flares against height above terrain', () => {
    // 5 km up but only 100 m above a mountain top: rate = max(2, min(1667, 50)) = 50
    expect(flightStep(5_000, -1, 1, R, 100)).toBeCloseTo(4_950, 6);
  });
  it('ascent is unchanged by aboveTerrain', () => {
    expect(flightStep(10_000, +1, 1, R, 5)).toBeCloseTo(15_000, 0);
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

describe('eyeTerrainM', () => {
  it('floors the eye at wading depth on ocean worlds', () => {
    expect(eyeTerrainM(-95, true)).toBeCloseTo(-0.7, 9); // -0.7 + 1.7 eye = +1.0 m above the sea
    expect(eyeTerrainM(5, true)).toBe(5);
  });
  it('follows terrain everywhere on dry worlds', () => {
    expect(eyeTerrainM(-95, false)).toBe(-95);
  });
  it('floors AFTER relief scaling, since water renders unscaled: scale before floor', () => {
    // Caller composition must be eyeTerrainM(terrainM * reliefScale, ocean),
    // never eyeTerrainM(terrainM, ocean) * reliefScale. The floor is a
    // render-space constant (water always renders at true scale), so it has
    // to apply to the already-scaled terrain value, not be scaled itself.
    expect(eyeTerrainM(-95 * 3, true)).toBeCloseTo(-0.7, 9); // eye = -0.7 + 1.7 = +1.0 m above sea
  });
});
