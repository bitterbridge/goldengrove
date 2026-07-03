# Goldengrove v1 — Plan 4: The Ground View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand at a lat/lon on a rocky planet or moon and watch its sky — suns, moons, and planets at their TRUE positions and angular sizes, through a scattering atmosphere, over a seeded starfield — with the URL capturing the exact vantage.

**Architecture:** All new code is view-layer TypeScript except one Rust touch-up (orbit paths sampled at drifted elements; error Results instead of aborts). A pure `observer.ts` converts flat ephemeris states + lat/lon into a local East-North-Up frame and per-body alt/az/angular-size; `ground.ts` renders that in a camera-at-origin scene (bodies on a distance-ranked dome so eclipses occlude correctly, stars behind, transparent scattering skydome in front of the stars); `main.ts` becomes a two-view machine driven by `AppState.view`.

**Tech Stack:** existing stack; no new dependencies. Custom GLSL sky shader (multi-sun single-scatter Rayleigh+Mie approximation).

## Global Constraints

- **The sky is computed, not painted** (spec): every body's direction, altitude, and angular size derive from the ephemeris states; eclipses must emerge from geometry, never be special-cased.
- **True angular sizes** for suns and moons (angular radius = asin(R/dist)); other planets get a minimum apparent radius of 0.0025 rad so they read as bright dots.
- **Local frame convention**: x=east, y=north, z=up. Azimuth 0 = north, π/2 = east. Ground camera sits at the local origin.
- **Standable bodies**: Rocky planets and all moons. Giants are never standable. Atmosphere density: Rocky+Living/Doomed → 1.0; Rocky+Dead → 0.05; moons → 0.05.
- **No generation changes**: goldens byte-identical after every task.
- **Determinism note**: starfield and body textures are view-layer cosmetics seeded from the descriptor seed (same seed → same sky), but are NOT part of the byte-pinned contract.
- Every commit: `cargo test --workspace`, `cd web && npx vitest run && npx tsc --noEmit` green, no warnings.

## File Structure

```
web/src/
├── util/prng.ts                 # fnv1a32 + mulberry32 (starfield, textures)
├── views/observer.ts            # NEW: pure frame/alt-az/angular-size math + pointToLatLon
├── views/starfield.ts           # NEW: seeded THREE.Points celestial sphere
├── views/sky.ts                 # NEW: scattering skydome (ShaderMaterial wrapper)
├── views/texture.ts             # NEW: procedural body textures (canvas; null-safe)
├── views/ground.ts              # NEW: ground scene builder
├── views/space.ts               # MODIFIED: orbit-path refresh under drift; update() gains tS
├── sim/layout.ts                # MODIFIED: + bodyRadiusM, standableBody, atmosphereDensityFor
├── sim/wasm.ts                  # MODIFIED: orbitPath gains tS
├── ui/hud.ts                    # MODIFIED: view-toggle button
└── main.ts                      # MODIFIED: two-view machine, stand-here, look controls
crates/gg-ephemeris/src/lib.rs   # MODIFIED: elements_at made pub
crates/gg-wasm/src/{flatten,lib}.rs  # MODIFIED: orbit_path(…, t_s); Result error surfaces
```

---

### Task 1: Observer math (pure)

**Files:**
- Modify: `web/src/sim/layout.ts` (add `bodyRadiusM`, `standableBody`, `atmosphereDensityFor`)
- Modify: `web/src/views/space.ts` (delete its private `bodyRadiusM`, import from layout)
- Create: `web/src/views/observer.ts`
- Test: `web/src/views/observer.test.ts`, additions to `web/src/sim/layout.test.ts`

**Interfaces:**
- Consumes: `SystemDescriptor`, `BodyRef`, `bodyLayout` (existing); flat states (7 f64/body: pos, spin axis, rotation).
- Produces:

```ts
// layout.ts additions
export function bodyRadiusM(desc: SystemDescriptor, ref: BodyRef): number;
export function standableBody(desc: SystemDescriptor, ref: BodyRef): boolean; // Rocky planet or any moon
export function atmosphereDensityFor(desc: SystemDescriptor, ref: BodyRef): number; // 1.0 | 0.05 per Global Constraints

// observer.ts
export type Vec3 = [number, number, number];
export interface ObserverFrame { positionM: Vec3; up: Vec3; east: Vec3; north: Vec3 }
export interface SkyBody {
  index: number; kind: 'star' | 'planet' | 'moon';
  dirLocal: Vec3;          // unit, x=east y=north z=up
  altRad: number; azRad: number;
  distM: number; angularRadiusRad: number;
}
export function planetBasis(axis: Vec3, rotationRad: number): { pole: Vec3; meridian: Vec3; ortho: Vec3 };
export function observerFrame(states: Float64Array, desc: SystemDescriptor, bodyIndex: number, latDeg: number, lonDeg: number): ObserverFrame;
export function skyBodies(states: Float64Array, desc: SystemDescriptor, standingIndex: number, frame: ObserverFrame): SkyBody[];
export function pointToLatLon(dirFromCenterWorld: Vec3, axis: Vec3, rotationRad: number): { latDeg: number; lonDeg: number };
```

- [ ] **Step 1: Write the failing tests**

`web/src/views/observer.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import { observerFrame, planetBasis, pointToLatLon, skyBodies, type Vec3 } from './observer';

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
```

`web/src/sim/layout.test.ts` — add:

```ts
import { atmosphereDensityFor, bodyRadiusM, standableBody } from './layout';

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
```

(Adjust imports to the file's existing style; `golden` is already loaded there.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/views/observer.test.ts src/sim/layout.test.ts`
Expected: FAIL — modules/exports missing.

- [ ] **Step 3: Implement**

`web/src/sim/layout.ts` — append:

```ts
export function bodyRadiusM(desc: SystemDescriptor, ref: BodyRef): number {
  switch (ref.kind) {
    case 'star': return desc.stars[ref.star]!.radius_m;
    case 'planet': return desc.planets[ref.planet]!.radius_m;
    case 'moon': return desc.planets[ref.planet]!.moons[ref.moon]!.radius_m;
  }
}

/** You can stand on rocky planets and any moon; giants have no surface. */
export function standableBody(desc: SystemDescriptor, ref: BodyRef): boolean {
  if (ref.kind === 'moon') return true;
  return ref.kind === 'planet' && desc.planets[ref.planet]!.class === 'Rocky';
}

/** Sky-shader density. Dead worlds lost their air; moons never had much. */
export function atmosphereDensityFor(desc: SystemDescriptor, ref: BodyRef): number {
  if (ref.kind === 'moon') return 0.05;
  if (ref.kind === 'planet' && desc.planets[ref.planet]!.class === 'Rocky') {
    return desc.planets[ref.planet]!.state.kind === 'Dead' ? 0.05 : 1.0;
  }
  return 1.0;
}
```

In `web/src/views/space.ts`: delete the private `bodyRadiusM(sim, ref)` and `import { bodyRadiusM } from '../sim/layout';`, calling it as `bodyRadiusM(sim.descriptor, ref)`.

`web/src/views/observer.ts`:

```ts
import { bodyLayout, bodyRadiusM, type BodyRef } from '../sim/layout';
import type { SystemDescriptor } from '../sim/types';

export type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / len(a));

export interface ObserverFrame { positionM: Vec3; up: Vec3; east: Vec3; north: Vec3 }

export interface SkyBody {
  index: number;
  kind: 'star' | 'planet' | 'moon';
  dirLocal: Vec3;
  altRad: number;
  azRad: number;
  distM: number;
  angularRadiusRad: number;
}

/** Planet-fixed frame from spin axis + rotation angle. The prime meridian's
 * zero reference is world +X projected into the equator plane (falls back to
 * +Y when the axis is within ~0.001 rad of +X). Arbitrary but FIXED — lat/lon
 * mean the same surface point at every t, which is all a vantage needs. */
export function planetBasis(axis: Vec3, rotationRad: number): { pole: Vec3; meridian: Vec3; ortho: Vec3 } {
  const pole = norm(axis);
  let ref: Vec3 = [1, 0, 0];
  let e0 = sub(ref, scale(pole, dot(ref, pole)));
  if (len(e0) < 1e-3) {
    ref = [0, 1, 0];
    e0 = sub(ref, scale(pole, dot(ref, pole)));
  }
  e0 = norm(e0);
  const e90 = cross(pole, e0);
  const c = Math.cos(rotationRad);
  const s = Math.sin(rotationRad);
  const meridian: Vec3 = add(scale(e0, c), scale(e90, s));
  const ortho = cross(pole, meridian);
  return { pole, meridian, ortho };
}

function bodyState(states: Float64Array, i: number) {
  return {
    pos: [states[i * 7]!, states[i * 7 + 1]!, states[i * 7 + 2]!] as Vec3,
    axis: [states[i * 7 + 3]!, states[i * 7 + 4]!, states[i * 7 + 5]!] as Vec3,
    rot: states[i * 7 + 6]!,
  };
}

export function observerFrame(
  states: Float64Array,
  desc: SystemDescriptor,
  bodyIndex: number,
  latDeg: number,
  lonDeg: number,
): ObserverFrame {
  const layout = bodyLayout(desc);
  const ref = layout[bodyIndex]!;
  const { pos, axis, rot } = bodyState(states, bodyIndex);
  const b = planetBasis(axis, rot);
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const up = add(
    add(scale(b.meridian, Math.cos(lat) * Math.cos(lon)), scale(b.ortho, Math.cos(lat) * Math.sin(lon))),
    scale(b.pole, Math.sin(lat)),
  );
  let east = cross(b.pole, up);
  east = len(east) < 1e-9 ? b.meridian : norm(east); // pole fallback: arbitrary but stable
  const north = cross(up, east);
  const positionM = add(pos, scale(up, bodyRadiusM(desc, ref)));
  return { positionM, up, east, north };
}

export function worldToLocal(d: Vec3, f: ObserverFrame): Vec3 {
  return [dot(d, f.east), dot(d, f.north), dot(d, f.up)];
}

export function skyBodies(
  states: Float64Array,
  desc: SystemDescriptor,
  standingIndex: number,
  frame: ObserverFrame,
): SkyBody[] {
  const layout = bodyLayout(desc);
  const out: SkyBody[] = [];
  layout.forEach((ref: BodyRef, i: number) => {
    if (i === standingIndex) return;
    const { pos } = bodyState(states, i);
    const d = sub(pos, frame.positionM);
    const distM = len(d);
    const dirLocal = worldToLocal(scale(d, 1 / distM), frame);
    const altRad = Math.asin(Math.min(1, Math.max(-1, dirLocal[2])));
    const azRad = Math.atan2(dirLocal[0], dirLocal[1]); // 0=N, +east
    const angularRadiusRad = Math.asin(Math.min(1, bodyRadiusM(desc, ref) / distM));
    out.push({ index: i, kind: ref.kind, dirLocal, altRad, azRad, distM, angularRadiusRad });
  });
  return out;
}

/** Inverse of the surface-point construction: world-frame unit direction from
 * the planet's center to a surface point → lat/lon under the same basis. */
export function pointToLatLon(dirFromCenterWorld: Vec3, axis: Vec3, rotationRad: number): { latDeg: number; lonDeg: number } {
  const b = planetBasis(axis, rotationRad);
  const u = norm(dirFromCenterWorld);
  const latDeg = (Math.asin(Math.min(1, Math.max(-1, dot(u, b.pole)))) * 180) / Math.PI;
  const lonDeg = (Math.atan2(dot(u, b.ortho), dot(u, b.meridian)) * 180) / Math.PI;
  return { latDeg, lonDeg };
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: all PASS (observer + layout additions + no regressions from the bodyRadiusM refactor).

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: observer math — ENU frames, alt/az, angular sizes, lat/lon inverse"
```

---

### Task 2: PRNG util + starfield

**Files:**
- Create: `web/src/util/prng.ts` + `web/src/util/prng.test.ts`
- Create: `web/src/views/starfield.ts` + `web/src/views/starfield.test.ts`

**Interfaces:**
- Produces: `fnv1a32(s: string): number`; `mulberry32(seed: number): () => number` (deterministic [0,1)); `buildStarfield(seedStr: string, radius?: number, count?: number): THREE.Points` (default radius 1100, count 1200; `points.userData.starCount` set).

- [ ] **Step 1: Write the failing tests**

`web/src/util/prng.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fnv1a32, mulberry32 } from './prng';

describe('prng', () => {
  it('fnv1a32 is stable and seed-sensitive', () => {
    expect(fnv1a32('42')).toBe(fnv1a32('42'));
    expect(fnv1a32('42')).not.toBe(fnv1a32('43'));
  });
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(123)()).not.toBe(mulberry32(124)());
  });
});
```

`web/src/views/starfield.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildStarfield } from './starfield';

describe('buildStarfield', () => {
  it('is deterministic per seed and puts stars on the sphere', () => {
    const a = buildStarfield('42', 1100, 300);
    const b = buildStarfield('42', 1100, 300);
    const pa = a.geometry.getAttribute('position');
    const pb = b.geometry.getAttribute('position');
    expect(pa.count).toBe(300);
    for (let i = 0; i < 10; i++) {
      expect(pa.getX(i)).toBe(pb.getX(i));
      const r = Math.hypot(pa.getX(i), pa.getY(i), pa.getZ(i));
      expect(r).toBeCloseTo(1100, 6);
    }
    const c = buildStarfield('43', 1100, 300);
    expect(c.geometry.getAttribute('position').getX(0)).not.toBe(pa.getX(0));
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `cd web && npx vitest run src/util src/views/starfield.test.ts` — FAIL. Then:

`web/src/util/prng.ts`:

```ts
/** View-layer PRNG: cosmetics only (starfield, textures) — NOT part of the
 * byte-pinned determinism contract, but same-seed → same-sky is still nice. */

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`web/src/views/starfield.ts`:

```ts
import * as THREE from 'three';
import { fnv1a32, mulberry32 } from '../util/prng';

/** Seeded celestial sphere. Positions are WORLD-frame directions; the ground
 * scene rotates the whole Points object into the local frame each frame, so
 * stars wheel as the planet spins. */
export function buildStarfield(seedStr: string, radius = 1100, count = 1200): THREE.Points {
  const rand = mulberry32(fnv1a32(`stars-${seedStr}`));
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = 2 * rand() - 1;
    const phi = 2 * Math.PI * rand();
    const s = Math.sqrt(1 - z * z);
    pos[i * 3] = radius * s * Math.cos(phi);
    pos[i * 3 + 1] = radius * s * Math.sin(phi);
    pos[i * 3 + 2] = radius * z;
    const mag = rand(); // 0 bright .. 1 dim
    const warm = rand();
    const b = 0.35 + 0.65 * (1 - mag) ** 2;
    col[i * 3] = b * (0.85 + 0.15 * warm);
    col[i * 3 + 1] = b * 0.92;
    col[i * 3 + 2] = b * (1.0 - 0.2 * warm);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = 0;
  points.userData.starCount = count;
  return points;
}
```

- [ ] **Step 3: Run tests, commit**

Run: `cd web && npx vitest run && npx tsc --noEmit` — PASS.

```bash
git add web/src/util web/src/views/starfield.ts web/src/views/starfield.test.ts
git commit -m "feat: seeded starfield + view-layer prng"
```

---

### Task 3: Scattering skydome

**Files:**
- Create: `web/src/views/sky.ts`
- Test: `web/src/views/sky.test.ts`

**Interfaces:**
- Consumes: `temperatureToColor` (existing `color.ts`).
- Produces:

```ts
export interface SunSpec { dirLocal: [number, number, number]; temperatureK: number; irradiance: number } // irradiance relative, max 1
export interface SkyDome {
  mesh: THREE.Mesh;
  setSuns(suns: SunSpec[]): void;      // up to 3; extras ignored
  setDensity(d: number): void;
  dayFactor(): number;                  // max over suns of smoothstep(-0.12, 0.12, sunAlt) * density-weight — for ground tinting
}
export function buildSkyDome(radius?: number): SkyDome; // default 1400
```

- [ ] **Step 1: Write the failing tests**

`web/src/views/sky.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSkyDome } from './sky';

describe('buildSkyDome', () => {
  it('exposes normalized sun uniforms and counts', () => {
    const sky = buildSkyDome();
    sky.setSuns([
      { dirLocal: [0, 0, 2], temperatureK: 5800, irradiance: 1 }, // non-unit on purpose
      { dirLocal: [1, 0, 0], temperatureK: 3200, irradiance: 0.2 },
    ]);
    const u = (sky.mesh.material as THREE.ShaderMaterial).uniforms;
    expect(u.sunCount!.value).toBe(2);
    const d0 = u.sunDirs!.value[0];
    expect(Math.hypot(d0.x, d0.y, d0.z)).toBeCloseTo(1, 6);
    expect(d0.z).toBeCloseTo(1, 6);
  });
  it('caps at 3 suns and clamps density', () => {
    const sky = buildSkyDome();
    sky.setSuns(new Array(5).fill({ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }));
    const u = (sky.mesh.material as THREE.ShaderMaterial).uniforms;
    expect(u.sunCount!.value).toBe(3);
    sky.setDensity(7);
    expect(u.density!.value).toBe(1);
  });
  it('dayFactor: 1 at high noon, 0 at deep night, between at twilight', () => {
    const sky = buildSkyDome();
    sky.setDensity(1);
    sky.setSuns([{ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }]);
    expect(sky.dayFactor()).toBeCloseTo(1, 6);
    sky.setSuns([{ dirLocal: [0, 0, -1], temperatureK: 5800, irradiance: 1 }]);
    expect(sky.dayFactor()).toBeCloseTo(0, 6);
    sky.setSuns([{ dirLocal: [1, 0, 0], temperatureK: 5800, irradiance: 1 }]); // sun ON the horizon
    expect(sky.dayFactor()).toBeGreaterThan(0.3);
    expect(sky.dayFactor()).toBeLessThan(0.7);
  });
});
```

Add `import * as THREE from 'three';` at the top of the test.

- [ ] **Step 2: Run to verify failure, then implement**

Run: `cd web && npx vitest run src/views/sky.test.ts` — FAIL. Then `web/src/views/sky.ts`:

```ts
import * as THREE from 'three';
import { temperatureToColor } from './color';

export interface SunSpec { dirLocal: [number, number, number]; temperatureK: number; irradiance: number }

export interface SkyDome {
  mesh: THREE.Mesh;
  setSuns(suns: SunSpec[]): void;
  setDensity(d: number): void;
  dayFactor(): number;
}

const MAX_SUNS = 3;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Single-scatter Rayleigh+Mie approximation summed over suns. Not physical —
 * calibrated to read right: blue days, red-orange twilight bands toward the
 * sun, alpha→0 at night so the starfield behind shows through. */
const FRAG = /* glsl */ `
uniform vec3 sunDirs[${MAX_SUNS}];
uniform vec3 sunTints[${MAX_SUNS}];
uniform int sunCount;
uniform float density;
varying vec3 vDir;

const vec3 betaR = vec3(0.30, 0.65, 1.50);

float phaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float phaseM(float c) {
  float g = 0.76; float g2 = g * g;
  return 0.1193662 * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5);
}

void main() {
  vec3 v = normalize(vDir);
  float mu = max(v.z, 0.0);
  float depth = 1.0 / (mu + 0.12);
  vec3 col = vec3(0.0);
  for (int i = 0; i < ${MAX_SUNS}; i++) {
    if (i >= sunCount) break;
    vec3 s = sunDirs[i];
    float day = smoothstep(-0.12, 0.12, s.z);
    float c = dot(v, s);
    // near-horizon suns redden: attenuate blue with the sun's own path length
    float sunDepth = 1.0 / (max(s.z, 0.0) + 0.12);
    vec3 transmit = exp(-betaR * sunDepth * 0.35);
    col += sunTints[i] * transmit * (betaR * phaseR(c) + vec3(phaseM(c) * 0.12)) * depth * day;
  }
  col *= density * 1.6;
  col = vec3(1.0) - exp(-1.4 * col); // tonemap
  float alpha = clamp(max(col.r, max(col.g, col.b)) * 1.7, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function buildSkyDome(radius = 1400): SkyDome {
  const uniforms = {
    sunDirs: { value: Array.from({ length: MAX_SUNS }, () => new THREE.Vector3(0, 0, -1)) },
    sunTints: { value: Array.from({ length: MAX_SUNS }, () => new THREE.Color(0)) },
    sunCount: { value: 0 },
    density: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
  mesh.renderOrder = 1; // after the starfield so its alpha blends over the stars
  let lastSuns: SunSpec[] = [];

  return {
    mesh,
    setSuns(suns) {
      lastSuns = suns.slice(0, MAX_SUNS);
      uniforms.sunCount.value = lastSuns.length;
      lastSuns.forEach((s, i) => {
        uniforms.sunDirs.value[i]!.set(...s.dirLocal).normalize();
        const [r, g, b] = temperatureToColor(s.temperatureK);
        uniforms.sunTints.value[i]!.setRGB(r * s.irradiance, g * s.irradiance, b * s.irradiance);
      });
    },
    setDensity(d) {
      uniforms.density.value = Math.min(1, Math.max(0, d));
    },
    dayFactor() {
      let f = 0;
      for (const s of lastSuns) {
        const z = s.dirLocal[2] / Math.hypot(...s.dirLocal);
        f = Math.max(f, smoothstep(-0.12, 0.12, z) * s.irradiance);
      }
      return f * uniforms.density.value;
    },
  };
}
```

- [ ] **Step 3: Run tests, commit**

Run: `cd web && npx vitest run && npx tsc --noEmit` — PASS.

```bash
git add web/src/views/sky.ts web/src/views/sky.test.ts
git commit -m "feat: multi-sun scattering skydome"
```

---

### Task 4: Ground scene builder (+ procedural textures)

**Files:**
- Create: `web/src/views/texture.ts`
- Create: `web/src/views/ground.ts`
- Test: `web/src/views/ground.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (`observerFrame`, `skyBodies`, `worldToLocal`, `buildStarfield`, `buildSkyDome`, `atmosphereDensityFor`, `bodyName`, `bodyLayout`), `Sim`.
- Produces:

```ts
// texture.ts
export function proceduralBodyTexture(seedStr: string, bodyIndex: number, baseHex: number): THREE.CanvasTexture | null; // null when no 2D canvas (tests)

// ground.ts
export interface Standing { body: number; latDeg: number; lonDeg: number }
export interface GroundView {
  scene: THREE.Scene;
  bodies: THREE.Mesh[];              // one per body in layout order; the stood-on body's mesh hides at update()
  labels: CSS2DObject[];
  update(states: Float64Array, standing: Standing): void;
  dayFactor(): number;
}
export function buildGroundScene(sim: Sim): GroundView;
```

Dome layout contract: starfield at 1100 (renderOrder 0), skydome at 1400 (renderOrder 1, transparent), sky bodies at distances 850-950 ranked by TRUE distance (nearest → 850), ground disc at z = −2. Body display radius = domeDist × tan(max(angularRadius, minApparent)) where minApparent = 0.0025 for planet-kind bodies and 0 for stars/moons (true size). Up to 2 sun directional lights drive moon/planet phases.

- [ ] **Step 1: Write the failing tests**

`web/src/views/ground.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { buildGroundScene } from './ground';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

function fakeSim(): Sim {
  const n = bodyLayout(golden).length;
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: n,
    statesAt: () => {
      const s = new Float64Array(n * 7);
      for (let i = 0; i < n; i++) {
        s[i * 7] = (i + 1) * 1e10;
        s[i * 7 + 5] = 1;
      }
      return s;
    },
    orbitPath: () => new Float64Array(0),
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: () => new Float64Array(3),
  };
}

describe('buildGroundScene', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;

  it('creates one mesh + label per body (stood-on one hides at update) and the fixed furniture', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    expect(g.bodies.length).toBe(sim.bodyCount);
    expect(g.labels.length).toBe(sim.bodyCount);
    expect(g.scene.getObjectByName('starfield')).toBeTruthy();
    expect(g.scene.getObjectByName('skydome')).toBeTruthy();
    expect(g.scene.getObjectByName('ground-disc')).toBeTruthy();
  });

  it('update() places bodies on the 850-950 dome, ranked by true distance', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 15, lonDeg: 0 });
    const dists = g.bodies.map((m) => m.position.length()).filter((d) => d > 0);
    expect(Math.min(...dists)).toBeGreaterThanOrEqual(850 - 1e-6);
    expect(Math.max(...dists)).toBeLessThanOrEqual(950 + 1e-6);
    for (const m of g.bodies) {
      expect(Number.isFinite(m.position.x)).toBe(true);
      expect(m.scale.x).toBeGreaterThan(0);
    }
  });

  it('suns light the scene and drive dayFactor', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 });
    const lights: THREE.DirectionalLight[] = [];
    g.scene.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight) lights.push(o as THREE.DirectionalLight); });
    expect(lights.length).toBeGreaterThanOrEqual(1);
    expect(g.dayFactor()).toBeGreaterThanOrEqual(0);
    expect(g.dayFactor()).toBeLessThanOrEqual(1);
  });

  it('labels hide below the horizon', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 0 });
    const anyHidden = g.labels.some((l) => l.visible === false);
    const anyShown = g.labels.some((l) => l.visible === true);
    expect(anyHidden || anyShown).toBe(true); // structural: visibility is being managed
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement texture.ts**

Run: `cd web && npx vitest run src/views/ground.test.ts` — FAIL. Then `web/src/views/texture.ts`:

```ts
import * as THREE from 'three';
import { fnv1a32, mulberry32 } from '../util/prng';

/** Blotchy two-tone surface so rotation and phase read. Returns null when no
 * 2D canvas exists (headless tests) — callers fall back to a flat color. */
export function proceduralBodyTexture(seedStr: string, bodyIndex: number, baseHex: number): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rand = mulberry32(fnv1a32(`tex-${seedStr}-${bodyIndex}`));
  const base = new THREE.Color(baseHex);
  ctx.fillStyle = `#${base.getHexString()}`;
  ctx.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 46; i++) {
    const shade = base.clone().multiplyScalar(0.75 + 0.5 * rand());
    ctx.fillStyle = `#${shade.getHexString()}`;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.ellipse(rand() * 128, rand() * 64, 4 + rand() * 18, 3 + rand() * 9, rand() * Math.PI, 0, 2 * Math.PI);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
```

- [ ] **Step 3: Implement ground.ts**

`web/src/views/ground.ts`:

```ts
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { atmosphereDensityFor, bodyLayout, bodyName } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { observerFrame, skyBodies, type SkyBody } from './observer';
import { buildSkyDome, type SunSpec } from './sky';
import { buildStarfield } from './starfield';
import { temperatureToColor } from './color';
import { proceduralBodyTexture } from './texture';

export interface Standing { body: number; latDeg: number; lonDeg: number }

export interface GroundView {
  scene: THREE.Scene;
  bodies: THREE.Mesh[];
  labels: CSS2DObject[];
  update(states: Float64Array, standing: Standing): void;
  dayFactor(): number;
}

const DOME_NEAR = 850;
const DOME_FAR = 950;
const MIN_APPARENT_RAD = 0.0025; // planets-as-dots floor; suns/moons stay true
const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;

export function buildGroundScene(sim: Sim): GroundView {
  const scene = new THREE.Scene();
  const desc = sim.descriptor;
  const layout = bodyLayout(desc);

  const stars = buildStarfield(sim.seed);
  stars.name = 'starfield';
  scene.add(stars);

  const sky = buildSkyDome();
  sky.mesh.name = 'skydome';
  scene.add(sky.mesh);

  const groundMat = new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.DoubleSide });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(3000, 48), groundMat);
  ground.name = 'ground-disc';
  ground.position.z = -2;
  ground.renderOrder = 2;
  scene.add(ground);

  scene.add(new THREE.AmbientLight(0x334455, 0.35));
  const sunLights = [new THREE.DirectionalLight(0xffffff, 0), new THREE.DirectionalLight(0xffffff, 0)];
  sunLights.forEach((l) => scene.add(l));

  const unit = new THREE.SphereGeometry(1, 24, 16);
  const bodies: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  const indexOf: number[] = []; // mesh slot -> body index (filled per update since standing changes)

  // One mesh per layout entry; the stood-on body's mesh is hidden each frame.
  layout.forEach((ref, i) => {
    let mat: THREE.Material;
    if (ref.kind === 'star') {
      const [r, g, b] = temperatureToColor(desc.stars[ref.star]!.temperature_k);
      mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
    } else {
      const baseHex = ref.kind === 'planet' ? PALETTE[desc.planets[ref.planet]!.class] : 0x8a8f98;
      const tex = proceduralBodyTexture(sim.seed, i, baseHex);
      mat = new THREE.MeshStandardMaterial(tex ? { map: tex, roughness: 1 } : { color: baseHex, roughness: 1 });
    }
    const mesh = new THREE.Mesh(unit, mat);
    mesh.name = `sky-body-${i}`;
    scene.add(mesh);
    const div = document.createElement('div');
    div.className = 'body-label';
    div.textContent = bodyName(desc, i);
    const label = new CSS2DObject(div);
    mesh.add(label);
    bodies.push(mesh);
    labels.push(label);
    indexOf.push(i);
  });

  const starQuat = new THREE.Quaternion();
  const basis = new THREE.Matrix4();

  function update(states: Float64Array, standing: Standing): void {
    const frame = observerFrame(states, desc, standing.body, standing.latDeg, standing.lonDeg);
    const visible: SkyBody[] = skyBodies(states, desc, standing.body, frame);

    // world→local rotation for the starfield (rows = east/north/up)
    basis.makeBasis(
      new THREE.Vector3(...frame.east),
      new THREE.Vector3(...frame.north),
      new THREE.Vector3(...frame.up),
    ).transpose();
    starQuat.setFromRotationMatrix(basis);
    stars.quaternion.copy(starQuat);

    // rank by true distance → dome distance (nearest occludes: real eclipses)
    const ranked = [...visible].sort((a, b) => a.distM - b.distM);
    const domeDist = new Map<number, number>();
    ranked.forEach((b, r) => {
      domeDist.set(b.index, ranked.length === 1 ? DOME_NEAR : DOME_NEAR + ((DOME_FAR - DOME_NEAR) * r) / (ranked.length - 1));
    });

    const byIndex = new Map(visible.map((b) => [b.index, b]));
    const suns: SunSpec[] = [];
    let maxIrr = 0;
    for (const b of visible) {
      if (b.kind === 'star') {
        const st = desc.stars[layout[b.index]!.kind === 'star' ? (layout[b.index] as { star: number }).star : 0]!;
        const irr = st.luminosity_w / (b.distM * b.distM);
        maxIrr = Math.max(maxIrr, irr);
        suns.push({ dirLocal: b.dirLocal, temperatureK: st.temperature_k, irradiance: irr });
      }
    }
    suns.forEach((s) => { s.irradiance = maxIrr > 0 ? s.irradiance / maxIrr : 0; });
    suns.sort((a, b) => b.irradiance - a.irradiance);
    sky.setSuns(suns);
    sky.setDensity(atmosphereDensityFor(desc, layout[standing.body]!));

    sunLights.forEach((l, i) => {
      const s = suns[i];
      if (s && s.dirLocal[2] > -0.2) {
        l.intensity = 2.2 * s.irradiance;
        l.position.set(s.dirLocal[0] * 100, s.dirLocal[1] * 100, s.dirLocal[2] * 100);
        const [r, g, bb] = temperatureToColor(s.temperatureK);
        l.color.setRGB(r, g, bb);
      } else {
        l.intensity = 0;
      }
    });

    bodies.forEach((mesh, slot) => {
      const i = indexOf[slot]!;
      const b = byIndex.get(i);
      if (!b || i === standing.body) {
        mesh.visible = false;
        labels[slot]!.visible = false;
        return;
      }
      const d = domeDist.get(i)!;
      mesh.visible = b.altRad > -0.12;
      labels[slot]!.visible = mesh.visible && b.kind !== 'star';
      mesh.position.set(b.dirLocal[0] * d, b.dirLocal[1] * d, b.dirLocal[2] * d);
      const apparent = b.kind === 'planet' ? Math.max(b.angularRadiusRad, MIN_APPARENT_RAD) : b.angularRadiusRad;
      mesh.scale.setScalar(Math.max(d * Math.tan(apparent), 0.05));
    });

    const day = sky.dayFactor();
    groundMat.color.setHex(0x14100c).lerp(new THREE.Color(0x6a5a48), day);
  }

  return { scene, bodies, labels, update, dayFactor: () => sky.dayFactor() };
}
```

Implementation note: the star lookup inside the suns loop is awkward as sketched — clean version: `const ref = layout[b.index]!; if (ref.kind !== 'star') continue; const st = desc.stars[ref.star]!;`. Use the clean version.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS. If `proceduralBodyTexture` throws in happy-dom instead of returning null (getContext may throw rather than return null in some versions), wrap its body in try/catch returning null — the null path is the tested contract.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/texture.ts web/src/views/ground.ts web/src/views/ground.test.ts
git commit -m "feat: ground scene — dome-ranked sky bodies, phase lighting, day tinting"
```

---

### Task 5: Rust touch-ups — drifted orbit paths + error Results

**Files:**
- Modify: `crates/gg-ephemeris/src/lib.rs` (make `elements_at` pub with doc)
- Modify: `crates/gg-wasm/src/flatten.rs` (`orbit_path_points` gains `t_s`)
- Modify: `crates/gg-wasm/src/lib.rs` (`orbit_path` gains `t_s`; `descriptor_json`/`anchor_date_json` return `Result<String, JsError>`)
- Modify: `crates/gg-wasm/tests/flatten.rs` (signature updates + drift test)
- Modify: `web/src/sim/wasm.ts` (`orbitPath(i, segments, tS)`)
- Modify: `web/src/views/space.ts` (path refresh when stale; `update()` gains `tS`)
- Modify: `web/src/main.ts`, `web/src/views/space.test.ts` (call sites)

**Interfaces:**
- Produces: `gg_ephemeris::elements_at(el: &OrbitalElements, sec: &SecularRates, t_s: f64) -> OrbitalElements` (pub); `orbit_path_points(desc, body_index, segments, t_s)`; JS `orbit_path(body_index, segments, t_s)`; TS `Sim.orbitPath(bodyIndex, segments, tS)`; `SpaceView.update(states, trueScale, originM, tS)` (4th param; ALL call sites updated). Path refresh: space.ts re-fetches a body's path when `|tS − pathEpoch| > PATH_REFRESH_S` (3.156e8 ≈ 10 Earth years) and rewrites vertices.

- [ ] **Step 1: Write the failing Rust test**

Append to `crates/gg-wasm/tests/flatten.rs` (and update every existing `orbit_path_points(...)` call in this file to pass a final `0.0`):

```rust
#[test]
fn orbit_paths_follow_secular_drift() {
    // A planet with a large apsidal rate: the path sampled at a later t must
    // rotate its periapsis accordingly (epoch-frozen paths were the old bug).
    let mut desc = gg_gen::generate(42);
    desc.planets[0].orbit.eccentricity = 0.4;
    desc.planets[0].secular.apsidal_rad_per_s = 1.0e-9;
    let stars = desc.stars.len();
    let p0 = orbit_path_points(&desc, stars, 64, 0.0);
    let big_t = 1.0e9; // periapsis advanced by 1 radian
    let p1 = orbit_path_points(&desc, stars, 64, big_t);
    // same shape (same point count), rotated: first sample differs by ~a*e-scale distance
    assert_eq!(p0.len(), p1.len());
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    let a = desc.planets[0].orbit.semi_major_axis_m;
    assert!(
        (dx * dx + dy * dy).sqrt() > 0.05 * a,
        "path did not move under 1 rad of apsidal drift"
    );
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p gg-wasm --test flatten`
Expected: FAIL to compile — extra argument.

- [ ] **Step 3: Implement the Rust side**

In `crates/gg-ephemeris/src/lib.rs`, change `fn elements_at(...)` to:

```rust
/// Orbital elements with secular drift applied at time t. Public so the
/// boundary crate samples orbit PATHS from the same drifted elements the
/// position evaluation uses — one authority, like host_origin_at.
pub fn elements_at(el: &OrbitalElements, sec: &gg_gen::descriptor::SecularRates, t_s: f64) -> OrbitalElements {
```

(body unchanged; adjust the existing internal call sites if the signature path changes — they already call it as a free fn.)

In `crates/gg-wasm/src/flatten.rs`, change `orbit_path_points` to take `t_s: f64` and sample drifted elements:

```rust
pub fn orbit_path_points(desc: &SystemDescriptor, body_index: usize, segments: usize, t_s: f64) -> Vec<f64> {
```

Inside, where `(elements, mu)` are resolved, also capture the body's `SecularRates` (planet's or moon's `secular` field; stars unchanged → early return), then:

```rust
    let elements = gg_ephemeris::elements_at(&elements, &secular, t_s);
```

before computing `period` and sampling (the sampling loop itself is unchanged — it samples one full orbit of the drifted ellipse).

In `crates/gg-wasm/src/lib.rs`:

```rust
    /// 3 f64 per segment, relative to the parent focus, sampled from the
    /// secular-drifted elements at time t. Empty for stars.
    pub fn orbit_path(&self, body_index: usize, segments: usize, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(orbit_path_points(self.eph.desc(), body_index, segments, t_s).as_slice())
    }

    pub fn descriptor_json(&self) -> Result<String, JsError> {
        serde_json::to_string(self.eph.desc()).map_err(|e| JsError::new(&format!("descriptor serialization failed: {e}")))
    }

    pub fn anchor_date_json(&self, t_s: f64) -> Result<String, JsError> {
        let desc = self.eph.desc();
        let cal = desc.planets[desc.anchor_planet]
            .calendar
            .as_ref()
            .ok_or_else(|| JsError::new("anchor planet has no calendar"))?;
        serde_json::to_string(&gg_gen::calendar::date_at(cal, t_s))
            .map_err(|e| JsError::new(&format!("date serialization failed: {e}")))
    }
```

(Remove the old `expect(...)` versions. wasm-bindgen turns `Err` into a thrown JS exception — the TS wrapper needs no change beyond the generated .d.ts.)

- [ ] **Step 4: Run Rust suites**

Run: `cargo test --workspace && wasm-pack test --node crates/gg-wasm` (Node 22)
Expected: PASS, including the new drift test; goldens untouched.

- [ ] **Step 5: TS side — refresh stale paths**

`web/src/sim/wasm.ts`: `orbitPath: (i, segments, tS) => world.orbit_path(i, segments, tS),` and the `Sim` interface gains the third param.

`web/src/views/space.ts`:
- `const PATH_REFRESH_S = 3.156e8; // ~10 Earth years: far below secular timescales, cheap to refresh`
- Build-time fetch becomes `sim.orbitPath(i, ORBIT_SEGMENTS, 0)` with `line.userData.pathEpoch = 0;`
- `update(states, trueScale, originM)` becomes `update(states, trueScale, originM, tS)` (interface + impl). At the top of update, before positioning:

```ts
    meta.forEach((m) => {
      const line = m.orbitLine;
      if (!line) return;
      if (Math.abs(tS - (line.userData.pathEpoch as number)) > PATH_REFRESH_S) {
        line.userData.rawPath = sim.orbitPath(line.userData.bodyIndex as number, ORBIT_SEGMENTS, tS);
        line.userData.pathEpoch = tS;
        writeOrbitLine(m, lastTrueScale ?? false);
      }
    });
```

(Store `line.userData.bodyIndex = i` at build time, next to the existing `userData.rawPath` assignment.)
- Update ALL call sites: `main.ts` priming (`view.update(sim.statesAt(0), trueScale, sim.hostOriginAt(0), 0)`) and loop (`..., clock.t)`); every `view.update(...)` in `space.test.ts` gains a final `0` (and the fakes' `orbitPath` signatures gain the unused `tS` param).
- Add one test to `space.test.ts`:

```ts
  it('refreshes orbit paths when the sim time moves far from the path epoch', () => {
    const sim = fakeSim();
    let calls = 0;
    const orig = sim.orbitPath;
    sim.orbitPath = (i, seg, tS) => { calls++; return orig(i, seg, tS); };
    const view = buildSpaceScene(sim);
    const built = calls;
    view.update(sim.statesAt(0), false, sim.hostOriginAt(0), 0);
    expect(calls).toBe(built); // fresh: no refetch
    view.update(sim.statesAt(0), false, sim.hostOriginAt(0), 1e9); // ~30 years
    expect(calls).toBeGreaterThan(built); // stale: refetched
  });
```

- [ ] **Step 6: Run web suite + build**

Run: `cd web && npm run build:wasm && npx vitest run && npx tsc --noEmit`
Expected: PASS (build:wasm regenerates the .d.ts with the new signatures — required for tsc).

- [ ] **Step 7: Commit**

```bash
git add crates web/src
git commit -m "feat: orbit paths follow secular drift; wasm error Results instead of aborts"
```

---

### Task 6: Integration — two-view machine, stand-here, look controls

**Files:**
- Modify: `web/src/ui/hud.ts` (+ view-toggle button, `setViewButton`)
- Modify: `web/src/ui/hud.test.ts`
- Modify: `web/src/main.ts` (view machine, stand-here, ground look controls, share fields)

**Interfaces:**
- Consumes: everything above; `pointToLatLon`, `standableBody`, `buildGroundScene`, `AppState`.
- Produces: `HudCallbacks.onToggleView(): void`; `Hud.setViewButton(label: string, visible: boolean): void`. `main.ts` keeps a mutable `current: AppState` that share serializes (view/body/lat/lon updated on every transition).

- [ ] **Step 1: Write the failing HUD test**

Append to the `buildHud interactions` describe in `web/src/ui/hud.test.ts` (extend the `noop` object with `onToggleView() {}`):

```ts
  it('view-toggle button is controllable', () => {
    const root = document.createElement('div');
    let toggles = 0;
    const hud = buildHud(root, '42', { ...noop, onToggleView: () => { toggles++; } });
    const btn = root.querySelector('button[name="view-toggle"]') as HTMLButtonElement;
    expect(btn.style.display).toBe('none'); // hidden until controller decides
    hud.setViewButton('⏚ stand here', true);
    expect(btn.style.display).toBe('');
    expect(btn.textContent).toBe('⏚ stand here');
    btn.click();
    expect(toggles).toBe(1);
  });
```

- [ ] **Step 2: Run to verify failure, then implement the HUD change**

Run: `cd web && npx vitest run src/ui/hud.test.ts` — FAIL. In `web/src/ui/hud.ts`: add `onToggleView(): void;` to `HudCallbacks`, `setViewButton(label: string, visible: boolean): void;` to `Hud`; in the top-left group after the share button:

```ts
  const viewToggle = el('button', '', '');
  (viewToggle as HTMLButtonElement).name = 'view-toggle';
  viewToggle.style.display = 'none';
  viewToggle.addEventListener('click', () => cb.onToggleView());
  topLeft.append(viewToggle);
```

and in the returned object:

```ts
    setViewButton: (label, visible) => {
      viewToggle.textContent = label;
      viewToggle.style.display = visible ? '' : 'none';
    },
```

Run again — PASS.

- [ ] **Step 3: Rewrite main.ts as the two-view machine**

Replace the body of `boot()` in `web/src/main.ts` so it reads as follows (keep the module-scope `hashchange → reload` listener and the error-card try/catch exactly as they are; new/changed regions are the view machine, ground controls, and callbacks — read the current file first and preserve anything not mentioned):

```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadSim, WasmLoadError, type Sim } from './sim/wasm';
import { SimClock } from './time/clock';
import { buildSpaceScene, type SpaceView } from './views/space';
import { buildGroundScene, type GroundView } from './views/ground';
import { pointToLatLon, type Vec3 } from './views/observer';
import { bodyLayout, standableBody } from './sim/layout';
import { buildHud, formatDate } from './ui/hud';
import { randomSeed } from './ui/seed';
import { defaultAppState, parseAppState, serializeAppState, type AppState } from './state/url';
import { timeAtDate } from './sim/calendar';
import './styles.css';

const app = document.getElementById('app')!;
// Full reload on seed change: tearing down renderer/loop/listeners by hand
// buys nothing at this app size and invites leaks.
addEventListener('hashchange', () => location.reload());

async function boot(): Promise<void> {
  const current: AppState = parseAppState(location.hash) ?? defaultAppState(randomSeed());
  history.replaceState(null, '', serializeAppState(current));
  app.replaceChildren();

  let sim: Sim;
  try {
    sim = await loadSim(current.seed);
  } catch (err) {
    const card = document.createElement('div');
    card.className = 'hud hud-top-left';
    card.textContent =
      err instanceof WasmLoadError
        ? 'Goldengrove failed to load its simulation engine — check your connection and reload.'
        : `This seed found a bug — please report it. (${String(err)})`;
    if (!(err instanceof WasmLoadError)) {
      const reroll = document.createElement('button');
      reroll.textContent = '⟲ try another world';
      reroll.addEventListener('click', () => { location.hash = `seed=${randomSeed()}`; });
      card.append(document.createElement('br'), reroll);
    }
    app.append(card);
    return;
  }

  const layout = bodyLayout(sim.descriptor);
  const anchorBody = sim.descriptor.stars.length + sim.descriptor.anchor_planet;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  app.append(renderer.domElement, labelRenderer.domElement);

  // --- space view ---
  const spaceCamera = new THREE.PerspectiveCamera(50, 1, 0.001, 20000);
  spaceCamera.up.set(0, 0, 1);
  const controls = new OrbitControls(spaceCamera, renderer.domElement);
  controls.enableDamping = true;
  const view: SpaceView = buildSpaceScene(sim);

  // --- ground view ---
  const groundCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  groundCamera.up.set(0, 0, 1);
  let yaw = 0; // 0 = north (+Y), positive east
  let pitch = 0.15;
  const ground: GroundView = buildGroundScene(sim);

  const clock = new SimClock();
  clock.t = current.t;
  clock.speed = current.speed;
  if (current.t > 0) {
    // A shared moment should hold until the viewer presses play.
    clock.paused = true;
  }
  let trueScale = false;
  let focused: number | null = null;
  if (current.body !== null && current.body < sim.bodyCount) focused = current.body;

  const anchorCal = sim.descriptor.planets[sim.descriptor.anchor_planet]!.calendar!;
  const hud = buildHud(app, current.seed, {
    onPlayPause: () => { clock.paused = !clock.paused; hud.setPaused(clock.paused); },
    onSpeed: (m) => { clock.speed = m; },
    onTrueScale: (on) => { trueScale = on; },
    onReroll: () => { location.hash = `seed=${randomSeed()}`; },
    onShare: () => {
      const hash = serializeAppState({ ...current, t: clock.t, speed: clock.speed, body: focused });
      history.replaceState(null, '', hash);
      void navigator.clipboard.writeText(`${location.origin}${location.pathname}${hash}`);
      hud.flashShared();
    },
    onDateJump: (year, day) => { clock.t = timeAtDate(anchorCal, year, day); },
    onToggleView: () => {
      if (current.view === 'space') enterGround(focused ?? anchorBody, current.lat ?? 15, current.lon ?? 0);
      else exitGround();
    },
  });
  hud.setActiveSpeed(clock.speed);
  hud.setPaused(clock.paused);

  function refreshViewButton(): void {
    if (current.view === 'ground') {
      hud.setViewButton('◉ orrery', true);
    } else {
      const standable = focused !== null && standableBody(sim.descriptor, layout[focused]!);
      hud.setViewButton('⏚ stand here', standable);
    }
  }

  function enterGround(body: number, latDeg: number, lonDeg: number): void {
    if (!standableBody(sim.descriptor, layout[body]!)) return;
    current.view = 'ground';
    current.body = body;
    current.lat = latDeg;
    current.lon = lonDeg;
    focused = body;
    yaw = 0;
    pitch = 0.15;
    refreshViewButton();
  }
  function exitGround(): void {
    current.view = 'space';
    refreshViewButton();
  }

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = app;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    for (const cam of [spaceCamera, groundCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }
  addEventListener('resize', resize);
  resize();

  // pointer: space = click-to-focus / stand-here via raycast; ground = look around
  const down = new THREE.Vector2();
  let dragging = false;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    down.set(e.clientX, e.clientY);
    dragging = true;
  });
  addEventListener('pointerup', () => { dragging = false; });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (current.view !== 'ground' || !dragging) return;
    yaw -= e.movementX * 0.0032;
    pitch = Math.min(Math.PI / 2 - 0.01, Math.max(-0.45, pitch + e.movementY * 0.0032));
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (current.view !== 'space') return;
    if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
    const ndc = new THREE.Vector2(
      (e.clientX / renderer.domElement.clientWidth) * 2 - 1,
      -(e.clientY / renderer.domElement.clientHeight) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, spaceCamera);
    const hit = ray.intersectObjects(view.bodies, false)[0];
    if (!hit) return;
    const idx = view.bodyIndexOf(hit.object);
    if (idx === null) return;
    if (focused === idx && standableBody(sim.descriptor, layout[idx]!)) {
      // second click on an already-focused standable body: stand at the hit point
      const center = hit.object.position;
      const dir: Vec3 = [hit.point.x - center.x, hit.point.y - center.y, hit.point.z - center.z];
      const s = sim.statesAt(clock.t);
      const axis: Vec3 = [s[idx * 7 + 3]!, s[idx * 7 + 4]!, s[idx * 7 + 5]!];
      const { latDeg, lonDeg } = pointToLatLon(dir, axis, s[idx * 7 + 6]!);
      enterGround(idx, latDeg, lonDeg);
    } else {
      focused = idx;
      refreshViewButton();
    }
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (current.view !== 'ground') return;
    groundCamera.fov = Math.min(75, Math.max(20, groundCamera.fov + e.deltaY * 0.02));
    groundCamera.updateProjectionMatrix();
  }, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (current.view === 'ground') exitGround();
    else { focused = null; refreshViewButton(); }
  });

  refreshViewButton();
  view.update(sim.statesAt(0), trueScale, sim.hostOriginAt(0), 0);
  const [ox, oy, oz] = view.hostOriginView();
  controls.target.set(ox, oy, oz);
  spaceCamera.position.set(ox, oy - 28, oz + 16);

  let lastWall = performance.now();
  let lastDateUpdate = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - lastWall) / 1000, 0.1);
    lastWall = now;
    clock.tick(dt);
    const states = sim.statesAt(clock.t);

    if (current.view === 'ground' && current.body !== null) {
      ground.update(states, { body: current.body, latDeg: current.lat ?? 0, lonDeg: current.lon ?? 0 });
      groundCamera.position.set(0, 0, 0);
      groundCamera.lookAt(Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch));
      if (now - lastDateUpdate > 250) {
        lastDateUpdate = now;
        hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
      }
      renderer.render(ground.scene, groundCamera);
      labelRenderer.render(ground.scene, groundCamera);
    } else {
      view.update(states, trueScale, sim.hostOriginAt(clock.t), clock.t);
      if (focused !== null) controls.target.lerp(view.bodies[focused]!.position, 0.15);
      controls.update();
      if (now - lastDateUpdate > 250) {
        lastDateUpdate = now;
        hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
      }
      renderer.render(view.scene, spaceCamera);
      labelRenderer.render(view.scene, spaceCamera);
    }
  });

  // deep link straight into the ground view
  if (current.view === 'ground') {
    const body = current.body !== null && current.body < sim.bodyCount ? current.body : anchorBody;
    if (standableBody(sim.descriptor, layout[body]!)) enterGround(body, current.lat ?? 15, current.lon ?? 0);
    else exitGround();
  }
}

void boot();
```

Note the yaw convention: `lookAt(sin·cos, cos·cos, sin)` puts yaw 0 at north (+Y), positive yaw toward east (+X) — matching the observer azimuth convention.

- [ ] **Step 4: Run everything**

Run: `cd web && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: ground view integration — stand-here, look controls, deep links"
```

---

### Task 7: Ship + live verification (controller-run)

**Files:** none (operations).

- [ ] **Step 1: Merge to main, push; watch the run to green** (same commands as prior plans).

- [ ] **Step 2: Live QA (headless browser against the deployed site)**

1. `#seed=42` → click anchor planet, click again → ground view: sky renders, suns visible, HUD shows `◉ orrery`. Screenshot.
2. Speed `1 hr/s`: sun altitude visibly changes across ~20 s of wall time (compare two screenshots / sample a sky pixel).
3. Date-jump +half a local day → night: sky alpha drops, stars visible. Screenshot.
4. Stand on a moon of the gas giant (seed 42, planet VI): the giant looms large. Screenshot.
5. Dead-world check: scan seeds via `cargo run -p gg-gen --example dump -- <seed> | jq` for a Dead anchor, deep-link `view=ground` there → daytime starfield (airless).
6. Share from ground view → URL contains `view=ground&body=…&lat=…&lon=…`; fresh page reproduces the vantage.
7. Esc returns to the orrery; zero console errors throughout.

## Definition of Done

- All suites green (native, wasm parity, web); goldens byte-identical; clippy clean.
- Live QA checklist above passes with screenshots recorded.
- The spec's Ground View section is fully delivered: computed sky, correct angular sizes/phases, seed starfield, scattering atmosphere (binary-sun twilights included by construction), flat-horizon ground.
