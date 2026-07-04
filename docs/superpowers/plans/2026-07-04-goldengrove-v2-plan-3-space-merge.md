# Goldengrove v2 Plan 3 — Space-View Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One continuous true-scale scene from footsteps to high orbit: sky bodies at real positions/sizes (dome projection deleted), rotation decoupling at altitude, shareable `alt=`, look-straight-down pitch, and a descent that flares.

**Architecture:** Pure helpers in `walk.ts` (decoupling weight, lon slip, descent brake); `localBodies.ts` renders every non-standing body true-scale camera-relative in the local-space (terrain) pass with a sprite floor for sub-pixel bodies and one directional light per star; `ground.ts` loses its dome block and keeps starfield + atmosphere + sun-spec math (extracted to `observer.ts` for sharing); `main.ts` wires observer world position, lon slip, alt URL, pitch, and the wider far plane.

**Tech Stack:** TypeScript + three.js + vitest only. **No Rust, no goldens, no schema change.**

## Global Constraints

- Determinism surfaces untouched: no gg-* crate edits; `cargo test --locked` must pass unchanged at the end (it will — nothing Rust is touched; run it once before the final commit as a regression gate).
- URL: `view=ground` gains `alt=` (meters, integer-rounded, omitted when 0); existing links keep their meaning; `view=space` untouched. lat/lon serialization precision rises from 2 to 4 decimals (~11 m) — shared standing spots stop landing 500 m off.
- Decoupling: `w = 1 − smoothstep(alt, 0.05·R, 0.5·R)`; `lonDeg -= (1−w)·spinRate·dt·180/π`. Spin rate derived TS-side from two ephemeris samples 60 s apart, unwrapped mod 2π.
- Movement: ascent rate `max(2, alt/2)` (unchanged); descent rate `max(2, min(alt/3, aboveTerrainM/2))`; pitch clamp ±89°.
- Dot floor: bodies under 2 px apparent radius render as sprites (suns get a glow sprite always).
- The moon-at-night physical guarantee survives: star directional lights are NEVER gated by the observer's horizon.
- Every commit: `npx tsc --noEmit` clean + `npx vitest run` green (from `web/`). Never `--no-verify`.

## File Structure

```
web/src/views/walk.ts            (modify: decoupleWeight, lonSlipDeg, spinRateRadPerS, flightStep descent brake)
web/src/views/walk.test.ts       (modify)
web/src/state/url.ts             (modify: alt param, 4-decimal lat/lon)
web/src/state/url.test.ts        (modify — find the existing test file; if named differently, follow the existing name)
web/src/views/observer.ts        (modify: export sunSpecs — moved from ground.ts)
web/src/views/localBodies.ts     (create) + localBodies.test.ts
web/src/views/ground.ts          (modify: dome block deleted)
web/src/views/ground.test.ts     (modify)
web/src/main.ts                  (modify: integration)
```

---

### Task 1: Movement & decoupling helpers (walk.ts)

**Files:**
- Modify: `web/src/views/walk.ts`, Test: `web/src/views/walk.test.ts`

**Interfaces (produced — Tasks 5 relies on exact names):**

```ts
export function decoupleWeight(altM: number, radiusM: number): number; // 1 grounded → 0 inertial
export function lonSlipDeg(altM: number, radiusM: number, spinRateRadPerS: number, dtS: number): number; // SIGNED delta to ADD to lonDeg
export function spinRateRadPerS(rot0: number, rot1: number, dtS: number): number; // unwrapped (rot1-rot0)/dt
// flightStep gains a 5th arg: aboveTerrainM (descent brake); ascent unchanged.
export function flightStep(altM: number, dUp: number, dtS: number, radiusM: number, aboveTerrainM: number): number;
```

- [ ] **Step 1: Failing tests** — append to `walk.test.ts` (and update the two existing descent-related `flightStep` tests to pass a large `aboveTerrainM` like `1e9` so their behavior is unchanged):

```ts
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
```

- [ ] **Step 2: RED** — `cd web && npx vitest run src/views/walk.test.ts 2>&1 | tail -4`.

- [ ] **Step 3: Implement** in `walk.ts`:

```ts
/** Rotational coupling to the ground: 1 = carried with the planet's spin
 * (walking, low flight), fading to 0 (inertial hover — the planet turns
 * beneath you) between 5% and 50% of the body radius. */
export function decoupleWeight(altM: number, radiusM: number): number {
  const lo = 0.05 * radiusM;
  const hi = 0.5 * radiusM;
  const t = Math.min(1, Math.max(0, (altM - lo) / (hi - lo)));
  return 1 - t * t * (3 - 2 * t);
}

/** Signed longitude drift for one frame at altitude: while decoupled, the
 * planet spins east under a hovering observer, so their body-frame
 * longitude drifts WEST (negative for positive spin). Add to lonDeg. */
export function lonSlipDeg(altM: number, radiusM: number, spinRateRadPerS: number, dtS: number): number {
  const w = decoupleWeight(altM, radiusM);
  return (-(1 - w) * spinRateRadPerS * dtS * 180) / Math.PI;
}

/** Spin rate from two ephemeris rotation samples, unwrapped mod 2π. */
export function spinRateRadPerS(rot0: number, rot1: number, dtS: number): number {
  let d = (rot1 - rot0) % (2 * Math.PI);
  if (d < -Math.PI) d += 2 * Math.PI;
  if (d > Math.PI) d -= 2 * Math.PI;
  return d / dtS;
}
```

And modify `flightStep`: signature gains `aboveTerrainM: number`; the rate becomes direction-dependent:

```ts
export function flightStep(altM: number, dUp: number, dtS: number, radiusM: number, aboveTerrainM: number): number {
  if (dUp === 0) return altM;
  // Ascent: responsive exponential. Descent: same shape but braked against
  // height above terrain so landings flare instead of slam.
  const rate = dUp > 0 ? Math.max(2, altM / 2) : Math.max(2, Math.min(altM / 3, aboveTerrainM / 2));
  const next = altM + dUp * rate * dtS;
  return Math.min(10 * radiusM, Math.max(0, next));
}
```

- [ ] **Step 4: GREEN + tsc** — full `npx vitest run 2>&1 | tail -4` (main.ts's existing flightStep call now needs the 5th arg — pass `Number.POSITIVE_INFINITY` as a stopgap in THIS task with a `// Task 5 wires the real aboveTerrainM` comment so the suite compiles; Task 5 replaces it) and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git add src/views/walk.ts src/views/walk.test.ts src/main.ts && git commit -m "feat: decoupling + descent-brake movement helpers"`

---

### Task 2: URL `alt=` + 4-decimal lat/lon

**Files:**
- Modify: `web/src/state/url.ts`; Test: the existing url test file under `web/src/state/`.

**Interfaces:** `AppState` gains `alt: number | null` (meters; null = 0/absent). `defaultAppState` sets `alt: null`. Parse range [0, 1e10]; serialize `Math.round(alt)` only when `alt !== null && alt > 0`, key order after `lon`.

- [ ] **Step 1: Failing tests** (append to the existing url test file, matching its style):

```ts
  it('round-trips alt and omits it when grounded', () => {
    const s = { ...defaultAppState('42'), view: 'ground' as const, body: 3, lat: 2.11, lon: 44.3, alt: 12345.6 };
    const parsed = parseAppState(serializeAppState(s))!;
    expect(parsed.alt).toBe(12346);
    expect(serializeAppState({ ...s, alt: 0 })).not.toContain('alt=');
    expect(serializeAppState({ ...s, alt: null })).not.toContain('alt=');
  });

  it('rejects junk alt without failing the parse', () => {
    expect(parseAppState('#seed=42&alt=-5')!.alt).toBeNull();
    expect(parseAppState('#seed=42&alt=zeppelin')!.alt).toBeNull();
  });

  it('serializes lat/lon to 4 decimals (11 m — walking-precision shares)', () => {
    const s = { ...defaultAppState('42'), lat: 2.110449, lon: -119.75012, alt: null };
    const out = serializeAppState(s);
    expect(out).toContain('lat=2.1104');
    expect(out).toContain('lon=-119.7501');
  });
```

- [ ] **Step 2: RED**, then **Step 3: Implement** — `AppState.alt: number | null`; `defaultAppState` returns `alt: null`; in `parseAppState`: `s.alt = finiteInRange(params.get('alt'), 0, 1e10);` ; in `serializeAppState`, after the lon line: `if (s.alt !== null && s.alt > 0) parts.push(`alt=${Math.round(s.alt)}`);` and change both lat/lon lines from `.toFixed(2)` to `.toFixed(4)` (keep the trailing-zero strip). Any other construction sites of AppState literals (main.ts spread-updates use `...current` — check with tsc) get `alt` via the interface default only if tsc demands it.
- [ ] **Step 4: GREEN + tsc (full suite)**, **Step 5: Commit** — `"feat: alt in shared links; lat/lon at walking precision"`

---

### Task 3: `sunSpecs` extraction (observer.ts)

**Files:**
- Modify: `web/src/views/observer.ts`, `web/src/views/ground.ts`; Test: `web/src/views/observer.test.ts`

**Interfaces:** `export function sunSpecs(states: Float64Array, desc: SystemDescriptor, standingIndex: number, frame: ObserverFrame): SunSpec[]` — exactly today's ground.ts logic (irradiance = luminosity/d², normalized to max, sorted brightest-first, dirLocal in ENU). Import `SunSpec` type from `./sky`. `ground.ts` update() calls it instead of computing inline (behavior identical — its tests stay green unmodified). `localBodies` (Task 4) and main.ts keep using it via ground's return value as today.

- [ ] **Step 1: Failing test** — in `observer.test.ts` (match its fixture style; it already builds frames):

```ts
  it('sunSpecs: brightest sun first, normalized irradiance, ENU direction', () => {
    // reuse the file's existing descriptor/states fixtures; assert:
    // result.length === desc.stars.length; result[0].irradiance === 1;
    // every dirLocal is unit-length (hypot ≈ 1).
  });
```

Write the real assertions against the file's existing fixtures — the three properties above are the contract; no new fixture machinery.

- [ ] **Step 2: RED**, **Step 3: Move the code** (cut from ground.ts update(), paste as exported function; ground.ts calls `const suns = sunSpecs(states, desc, standing.body, frame);` then `sky.setSuns(suns)` etc. as today), **Step 4: GREEN full suite + tsc**, **Step 5: Commit** — `"refactor: sunSpecs shared via observer.ts"`

---

### Task 4: `localBodies.ts` — true-scale sky

**Files:**
- Create: `web/src/views/localBodies.ts`; Test: `web/src/views/localBodies.test.ts`

**Interfaces:**

```ts
export interface LocalBodies {
  group: THREE.Group;      // caller adds to the local-space (terrain) scene
  labels: CSS2DObject[];   // for the view-switch hide lifecycle
  /** observerWorldM: observer eye in WORLD meters (f64). frame: ENU basis. */
  update(states: Float64Array, observerWorldM: [number, number, number], frame: ObserverFrame, standingBody: number, camera: THREE.PerspectiveCamera, viewportHeightPx: number): void;
  dispose(): void;
}
export function buildLocalBodies(sim: Sim): LocalBodies;
```

Behavior contract (tests encode it):
- One entry per layout body. Stars: emissive-colored `MeshBasicMaterial` sphere (temperatureToColor) + always-on glow `THREE.Sprite` + one `THREE.DirectionalLight` per star, intensity `2.0 × normalized irradiance` (max-normalized across stars per frame), direction = star's ENU direction, NEVER gated by altitude/horizon. Rocky/moons/giants: `MeshStandardMaterial` with `getTerrainTexture ?? proceduralBodyTexture` (same construction as the old dome block — lift it).
- Per frame per body i ≠ standingBody: `rel = pos_i − observerWorldM` (f64 components), `dist = |rel|`, ENU position = `worldToLocal(rel/dist, frame) · dist`, mesh scale = TRUE `bodyRadiusM`. Angular radius px = `asin(radius/dist) / (fovYrad) · viewportHeightPx`. If < 2 px: mesh hidden, a per-body dot `THREE.Sprite` (scale ∝ dist so it stays ~4 px) shown instead; else mesh shown, dot hidden. Standing body: everything hidden.
- Bodies keep their axial rotation (`setRotationFromAxisAngle` from state slots, exactly as the dome block did).
- Labels: one CSS2DObject per body (bodyName + 🔒 for locked, lifted from the dome block), attached to the mesh, hidden when its body is hidden or is a star below the dot floor (matches old label rules: stars never labeled).
- `dispose()`: geometries, materials, sprites, lights removed & disposed.

- [ ] **Step 1: Failing tests** — `localBodies.test.ts` reusing `ground.test.ts`'s fixture pattern (golden seed-42 descriptor + fakeSim; copy the fakeSim from ground.test.ts — including bodyElevation/bodyElevations stubs — into this file rather than importing across test files):

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildLocalBodies } from './localBodies';
import { observerFrame } from './observer';
// + the fixture/fakeSim preamble copied from ground.test.ts

describe('buildLocalBodies', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;
  const states = () => fakeSim().statesAt(0); // bodies along +x at (i+1)e10, axis +z
  const camera = new THREE.PerspectiveCamera(60, 1400 / 900, 0.3, 1e13);

  function updated(standing = anchorBody) {
    const sim = fakeSim();
    const lb = buildLocalBodies(sim);
    const st = states();
    const frame = observerFrame(st, golden, standing, 0, 0);
    const obs: [number, number, number] = [frame.positionM[0], frame.positionM[1], frame.positionM[2]];
    lb.update(st, obs, frame, standing, camera, 900);
    return lb;
  }

  it('creates one directional light per star, ungated by horizon', () => {
    const lb = updated();
    const lights: THREE.DirectionalLight[] = [];
    lb.group.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight) lights.push(o as THREE.DirectionalLight); });
    expect(lights.length).toBe(golden.stars.length);
    expect(Math.max(...lights.map((l) => l.intensity))).toBeGreaterThan(0);
    // fixture geometry puts the suns below the observer's horizon (lon 0 ⇒ up = +x,
    // suns at smaller x ⇒ dir z ≈ −1): the light must still be on — moon-at-night successor.
    const lit = lights.find((l) => l.intensity > 0)!;
    expect(lit.position.z).toBeLessThan(0);
  });

  it('places bodies at true distance and scale in ENU', () => {
    const lb = updated();
    let checked = 0;
    lb.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible || m.userData.bodyIndex === undefined) return;
      const i = m.userData.bodyIndex as number;
      if (i === anchorBody) return;
      // fixture: body i at x=(i+1)e10; observer on anchor at up=+x ⇒ distance along ±up
      const expected = Math.abs((i + 1) * 1e10 - (anchorBody + 1) * 1e10) || null;
      if (expected) { expect(m.position.length()).toBeCloseTo(expected, -4); checked++; }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it('hides the standing body entirely', () => {
    const lb = updated();
    lb.group.traverse((o) => {
      if ((o as THREE.Object3D).userData?.bodyIndex === anchorBody) expect((o as THREE.Object3D).visible).toBe(false);
    });
  });

  it('sub-2px bodies render as dots, larger as meshes', () => {
    const lb = updated();
    let dots = 0, meshes = 0;
    lb.group.traverse((o) => {
      if ((o as THREE.Sprite).isSprite && o.visible && o.userData.isDot) dots++;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.userData.bodyIndex !== undefined) meshes++;
    });
    // at 1e10-m spacings with true radii, most bodies are sub-pixel: dots dominate
    expect(dots).toBeGreaterThan(0);
    expect(dots + meshes).toBeGreaterThan(5);
  });

  it('dispose empties the group', () => {
    const lb = updated();
    lb.dispose();
    let anything = 0;
    lb.group.traverse((o) => { if (o !== lb.group) anything++; });
    expect(anything).toBe(0);
  });
});
```

- [ ] **Step 2: RED**, then **Step 3: Implement** `localBodies.ts`. Lift the dome block's per-body construction (materials, textures, labels, lock badges, rotation application) VERBATIM from `ground.ts` (read it first — it is being deleted in Task 5, so this task is the move's destination). New logic per the behavior contract above; tag every object with `userData.bodyIndex`, dots with `userData.isDot = true`. Directional light intensity normalization mirrors sunSpecs (max irradiance across stars = 1). Set `frustumCulled = false` on meshes (positions are huge; three's culler misjudges log-depth scenes — same reasoning as terrain tiles).

- [ ] **Step 4: GREEN full suite + tsc**, **Step 5: Commit** — `"feat: true-scale local bodies — meshes, dot floor, per-star lights"`

---

### Task 5: Integration — dome deletion + main.ts wiring

**Files:**
- Modify: `web/src/views/ground.ts`, `web/src/views/ground.test.ts`, `web/src/main.ts`

**Consumes:** everything above, exact names as declared.

- [ ] **Step 1: Failing tests** — update `ground.test.ts`:
  - DELETE: the dome-placement test ('update() places bodies on the 850-950 dome…'), the body-rotation test, the label-horizon test, and the moon-at-night test (its physical guarantee now lives in localBodies.test.ts — verify that test exists before deleting this one).
  - UPDATE: the furniture test drops `bodies/labels` expectations (GroundView loses both arrays) but keeps starfield/skydome/ground-disc/lock-badge... the lock-badge assertion moves to localBodies (already covered by its label lift) — remove it here.
  - ADD:

```ts
  it('keeps only starfield + sky dome + disc: no sky-body meshes remain', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    let skyBodyMeshes = 0;
    g.scene.traverse((o) => { if (o.name.startsWith('sky-body-')) skyBodyMeshes++; });
    expect(skyBodyMeshes).toBe(0);
    expect(g.scene.getObjectByName('starfield')).toBeTruthy();
    expect(g.scene.getObjectByName('skydome')).toBeTruthy();
  });
```

- [ ] **Step 2: RED**, then **Step 3: ground.ts surgery** — delete: `DOME_NEAR/DOME_FAR/MIN_APPARENT_RAD`, the per-layout mesh/label construction loop, the dome-ranking + placement block in update(), the sky-body `sunLights` (the per-star lights now live in localBodies), and `bodies/labels` from `GroundView`. KEEP: starfield + its quaternion update, sky dome + setSuns/setDensity (via `sunSpecs` from Task 3), ambient light, ground disc + `setDiscVisible`, `update` still returns `SunSpec[]`, `dayFactor`. The file should shrink by roughly half.

- [ ] **Step 4: main.ts wiring** (read the current file first; adapt names):
  1. `const localBodies = buildLocalBodies(sim);` once at boot; `terrainGlobe`'s scene is per-standing-body, so localBodies.group attaches to a small persistent local-space scene: create `const localSpace = new THREE.Scene(); localSpace.add(localBodies.group);` and render order becomes: sky pass (ground.scene) → clearDepth → render `localSpace` → render terrainGlobe.scene (if any) — bodies first, then terrain, SAME depth buffer after the clear (terrain correctly occludes bodies below the horizon; bodies occlude each other). Labels: `labelRenderer.render(localSpace, groundCamera)` replaces the ground-scene label render in the ground branch; extend `hideAllLabels()` usage unchanged (labels still carry `.body-label` class).
  2. Observer world position each ground frame: `const frame = observerFrame(states, sim.descriptor, current.body, current.lat ?? 0, current.lon ?? 0);` then `obsWorld = frame.positionM + frame.up · (eyeTerrainM(...) + 1.7 + flightAltM)` (component-wise f64). Call `localBodies.update(states, obsWorld, frame, current.body, groundCamera, renderer.domElement.clientHeight)`.
  3. Rotation decoupling: on `enterGround(body,…)` compute once `standingSpinRate = spinRateRadPerS(states0[body*7+6], states60[body*7+6], 60)` using `sim.statesAt(clock.t)` and `sim.statesAt(clock.t + 60)`. Each ground frame with `flightAltM > 0`: `current.lon = wrapLon(current.lon + lonSlipDeg(flightAltM, rM, standingSpinRate, dt))` (wrap to (−180,180], reuse stepLatLon's wrap idiom), then `refreshElevation()` only when slip is non-zero (cheap guard: `w < 1`).
  4. `flightStep` call: replace the Task-1 stopgap with real `aboveTerrainM = flightAltM + 1.7` (height above terrain is flight altitude plus eye height — terrain elevation itself is NOT altitude).
  5. Pitch clamp: locate the pointermove pitch clamp and widen to `±89 · π/180`.
  6. Far plane: `groundCamera` far `5e7` → `1e13`.
  7. URL: boot/enterGround reads `current.alt` into `flightAltM` (clamped ≥ 0); `syncUrl()` includes `alt: flightAltM` (add to the spread); flight keyup also calls `syncUrl()`.
- [ ] **Step 5: GREEN full suite + tsc.**
- [ ] **Step 6: Commit** — `"feat: one true-scale local space — dome deleted, decoupled hover, alt shares"`

---

### Task 6: Ship + live QA

(Controller-level: final whole-branch review, `cargo test --locked` regression gate, merge from PRIMARY repo, push, deploy, then Playwright QA: moon transit from a 5,000 km hover on seed 42; drift check hovering high over a marked lon; descend-and-flare onto the seed-42 peak; eclipse/occultation pass on seed 3630539713810705175 IVa (parent planet at TRUE angular size — the libration view should get dramatically better); look straight down from 100 km; orrery map untouched; share-link round trip with alt.)

## Self-Review Notes (applied)

- Spec coverage: true-scale scene (T4+T5), decoupling (T1+T5), alt URL (T2), pitch/descent (T1+T5), sunSpecs share (T3), dome deletion + moon-at-night successor (T4 test + T5 surgery), far plane (T5), labels lifecycle (T4/T5). Deferred items match spec.
- Type consistency: `flightStep` 5-arg form appears in T1 (definition) and T5 (real wiring, stopgap noted in T1 Step 4); `sunSpecs` signature identical in T3/T5; `LocalBodies.update` signature identical in T4/T5.
- Known reconciliation points: url test filename (T2), observer.test fixture reuse (T3 — contract stated, assertions written against existing fixtures), render-order note (bodies then terrain after one clearDepth) is deliberate and load-bearing for occlusion.
