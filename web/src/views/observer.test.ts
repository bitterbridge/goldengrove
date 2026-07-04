import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import { observerFrame, planetBasis, pointToLatLon, skyBodies, sunSpecs, type Vec3 } from './observer';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

const DEG = Math.PI / 180;

/** Hand-built two-body states: star at origin, one planet on +X at 1 AU,
 * planet axis +Z, rotation angle θ. 7 f64 per body. */
function twoBodyStates(thetaRad: number, planetAxis: Vec3 = [0, 0, 1]): Float64Array {
  const s = new Float64Array(14);
  s[5] = 1; // star spin axis +Z (unused)
  s[7] = 1.496e11; // planet x
  s[10] = planetAxis[0]; s[11] = planetAxis[1]; s[12] = planetAxis[2];
  s[13] = thetaRad;
  return s;
}

/** Minimal single-planet descriptor for the hand states. */
function miniDesc() {
  const d = structuredClone(golden);
  d.stars = [d.stars[0]!];
  d.planets = [structuredClone(d.planets[d.anchor_planet]!)];
  d.planets[0]!.moons = [];
  d.planets[0]!.radius_m = 6.371e6;
  d.anchor_planet = 0;
  return d;
}

describe('planetBasis', () => {
  it('is orthonormal and pole-aligned', () => {
    const b = planetBasis([0, 0, 1], 0.7);
    const dot = (a: Vec3, c: Vec3) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    expect(dot(b.pole, b.meridian)).toBeCloseTo(0, 12);
    expect(dot(b.meridian, b.ortho)).toBeCloseTo(0, 12);
    expect(dot(b.meridian, b.meridian)).toBeCloseTo(1, 12);
  });
  it('rotation carries the meridian: θ=π/2 moves meridian from +X to pole×X', () => {
    const b0 = planetBasis([0, 0, 1], 0);
    const b1 = planetBasis([0, 0, 1], Math.PI / 2);
    expect(b0.meridian[0]).toBeCloseTo(1, 12);
    expect(b1.meridian[1]).toBeCloseTo(1, 12);
  });
});

describe('observerFrame', () => {
  it('equatorial observer at θ=0, lon 0 stands on the +X side', () => {
    const f = observerFrame(twoBodyStates(0), miniDesc(), 1, 0, 0);
    expect(f.up[0]).toBeCloseTo(1, 9);
    expect(f.positionM[0]).toBeCloseTo(1.496e11 + 6.371e6, 0);
    // ENU orthonormal, north at equator points along the pole
    expect(f.north[2]).toBeCloseTo(1, 9);
  });
  it('θ=π rotates the observer to the −X side', () => {
    const f = observerFrame(twoBodyStates(Math.PI), miniDesc(), 1, 0, 0);
    expect(f.up[0]).toBeCloseTo(-1, 9);
  });
  it('north-pole observer has up along the spin axis', () => {
    const f = observerFrame(twoBodyStates(0.3), miniDesc(), 1, 90, 0);
    expect(f.up[2]).toBeCloseTo(1, 9);
  });
});

describe('skyBodies', () => {
  it('the sun is at the zenith for the subsolar observer and at nadir for the antisolar one', () => {
    const desc = miniDesc();
    // observer at lon 180 (θ=0) faces −X: away from the star at origin → sun at zenith? No:
    // planet is at +X of the star, so the star is in the −X direction from the planet.
    // lon 180 observer's up is −X → sun at zenith.
    const fSub = observerFrame(twoBodyStates(0), desc, 1, 0, 180);
    const sun = skyBodies(twoBodyStates(0), desc, 1, fSub).find((b) => b.kind === 'star')!;
    expect(sun.altRad).toBeCloseTo(Math.PI / 2, 4);
    const fAnti = observerFrame(twoBodyStates(0), desc, 1, 0, 0);
    const sun2 = skyBodies(twoBodyStates(0), desc, 1, fAnti).find((b) => b.kind === 'star')!;
    expect(sun2.altRad).toBeCloseTo(-Math.PI / 2, 4);
  });
  it('angular radius matches asin(R/d) — lunar-like case', () => {
    // star radius from the golden primary; check the formula directly instead:
    const desc = miniDesc();
    const f = observerFrame(twoBodyStates(0), desc, 1, 0, 180);
    const sun = skyBodies(twoBodyStates(0), desc, 1, f).find((b) => b.kind === 'star')!;
    const expected = Math.asin(desc.stars[0]!.radius_m / sun.distM);
    expect(sun.angularRadiusRad).toBeCloseTo(expected, 12);
  });
  it('excludes the body being stood on and returns unit local dirs', () => {
    const desc = miniDesc();
    const f = observerFrame(twoBodyStates(0.4), desc, 1, 30, 45);
    const bodies = skyBodies(twoBodyStates(0.4), desc, 1, f);
    expect(bodies.some((b) => b.index === 1)).toBe(false);
    for (const b of bodies) {
      expect(Math.hypot(...b.dirLocal)).toBeCloseTo(1, 9);
      expect(b.altRad).toBeCloseTo(Math.asin(b.dirLocal[2]), 9);
    }
  });
  it('works against the real golden descriptor without NaNs', () => {
    const layout = bodyLayout(golden);
    const n = layout.length;
    const states = new Float64Array(n * 7);
    for (let i = 0; i < n; i++) { states[i * 7] = (i + 1) * 1e10; states[i * 7 + 5] = 1; }
    const anchorBody = golden.stars.length + golden.anchor_planet;
    const f = observerFrame(states, golden, anchorBody, 15, 0);
    for (const b of skyBodies(states, golden, anchorBody, f)) {
      expect(Number.isFinite(b.altRad) && Number.isFinite(b.azRad) && Number.isFinite(b.angularRadiusRad)).toBe(true);
    }
  });
});

describe('sunSpecs', () => {
  it('brightest sun first, normalized irradiance, ENU direction', () => {
    const layout = bodyLayout(golden);
    const n = layout.length;
    const states = new Float64Array(n * 7);
    for (let i = 0; i < n; i++) { states[i * 7] = (i + 1) * 1e10; states[i * 7 + 5] = 1; }
    const anchorBody = golden.stars.length + golden.anchor_planet;
    const f = observerFrame(states, golden, anchorBody, 15, 0);
    const suns = sunSpecs(states, golden, anchorBody, f);
    expect(suns.length).toBe(golden.stars.length);
    expect(suns[0]!.irradiance).toBe(1);
    for (const s of suns) {
      expect(Math.hypot(...s.dirLocal)).toBeCloseTo(1, 9);
    }
  });
});

describe('pointToLatLon', () => {
  it('round-trips with observerFrame across rotations and tilted axes', () => {
    const axis: Vec3 = [Math.sin(0.4), 0, Math.cos(0.4)];
    for (const theta of [0, 1.1, Math.PI, 5.9]) {
      for (const [lat, lon] of [[0, 0], [30, 45], [-60, 170], [89, -90]] as const) {
        const states = twoBodyStates(theta, axis);
        const f = observerFrame(states, miniDesc(), 1, lat, lon);
        const dir: Vec3 = [f.up[0], f.up[1], f.up[2]];
        const r = pointToLatLon(dir, axis, theta);
        expect(r.latDeg).toBeCloseTo(lat, 6);
        // lon wraps: compare on the circle
        const dLon = ((r.lonDeg - lon + 540) % 360) - 180;
        expect(dLon).toBeCloseTo(0, 6);
      }
    }
  });
});
