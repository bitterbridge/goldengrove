# Goldengrove v2 Plan 2b — Relief Tuning, Water, Fog, Flight, HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terrain that reads as terrain (real slopes), a sea surface, altitude-aware atmosphere, free-flight from footsteps to limb view, and HUD elevation/altitude readouts — completing the approved ground-terrain spec.

**Architecture:** Rust retunes the micro-detail spectrum (bigger amplitudes, elevation-masked) — the ONE deliberate fine-golden regeneration. TS adds water tiles inside terrainGlobe, exponential fog + sky-density altitude falloff, a flight mode in main.ts backed by pure tested helpers in walk.ts, and compass readout extensions.

**Tech Stack:** Rust (gg-terrain), TypeScript + three.js + vitest.

## Global Constraints

- Determinism: zero new RNG draws, zero draw-order changes. Descriptor goldens AND coarse terrain goldens (terrain-seed-*.json) stay byte-identical.
- **Fine goldens (terrain-fine-seed-*.json) are DELIBERATELY regenerated ONCE in Task 1** — the retune changes `elevation_fine` values by design. This is the only golden churn permitted; regenerate via the existing `fine_hashes` example, commit the new files in the same commit as the constants.
- micro() stays libm-free. New masks/constants must be continuous functions (abs/min of continuous inputs — no branches on position).
- Retune constants (pinned by analytic slope targets, see Task 1): micro `A0 = 0.07`, gain `0.64`, 12 octaves, joint frequency unchanged (`2.6 · 1.9^6`); elevation mask `0.25 + 0.75·min(1, |base|/0.8)` applied in `elevation_fine`, NOT inside micro.
- Flight/water/fog are render-path: std math fine, no goldens involved.
- Never `--no-verify`; `cargo fmt --all --check`, `clippy -D warnings`, `npx tsc --noEmit` clean before every commit. Rust suite `cargo test --locked`; web suite `cd web && npx vitest run`; wasm parity `wasm-pack test --node crates/gg-wasm` (Node ≥ 20 via `source ~/.nvm/nvm.sh && nvm use 22`).

## File Structure

```
crates/gg-terrain/src/noise.rs         (modify: micro constants)
crates/gg-terrain/src/lib.rs           (modify: elevation_fine mask)
crates/gg-terrain/tests/terrain.rs     (modify: budgets + slope test)
crates/gg-terrain/tests/golden/terrain-fine-seed-*.json (regenerate)
web/src/views/terrainGlobe.ts          (modify: water tiles, fog, dispose)
web/src/views/terrainGlobe.test.ts     (modify)
web/src/views/ground.ts                (modify: sky density altitude falloff)
web/src/views/ground.test.ts           (modify)
web/src/views/walk.ts                  (modify: flight helpers)
web/src/views/walk.test.ts             (modify)
web/src/ui/compass.ts                  (modify: ⛰/✈ readouts)
web/src/ui/compass.test.ts             (modify)
web/src/main.ts                        (modify: flight mode wiring)
```

---

### Task 1: Relief-spectrum retune (Rust)

**Files:**
- Modify: `crates/gg-terrain/src/noise.rs` (micro constants)
- Modify: `crates/gg-terrain/src/lib.rs` (`elevation_fine` mask)
- Modify: `crates/gg-terrain/tests/terrain.rs`
- Regenerate: `crates/gg-terrain/tests/golden/terrain-fine-seed-{1,42,123456789}.json`

**Interfaces:**
- Consumes: existing `micro`, `elevation_fine`, `fine_hash`, `fine_hashes` example.
- Produces: same signatures, new field values. Slope character (analytic targets): ~5% at 52 km wavelength, ~17% at 1 km, ~34% at 100 m on the roughest ground; plains masked to 25% of that. Old spectrum was 0.2–0.5% everywhere (visually flat — the Plan 2a QA finding).

- [ ] **Step 1: Update the tests (they must go RED against current constants)** — in `crates/gg-terrain/tests/terrain.rs`:

Replace the bounds in `micro_detail_is_small_and_continuous`:

```rust
    assert!(worst_val < 0.20, "micro amplitude {worst_val} exceeds spectral budget");
    assert!(worst_jump < 0.03, "micro jump {worst_jump} over ~60 m step — discontinuous");
    assert!(worst_val > 0.01, "micro is degenerate — retune lost its amplitude");
```

Replace the seam bound in `elevation_fine_agrees_with_elevation_at_scale` (`0.007` → `0.20`) and update its comment: micro's masked octave sum is ≤ 0.194 relative units.

Add the slope test (this is the RED driver — it fails on the old glassy spectrum):

```rust
#[test]
fn fine_terrain_has_walking_scale_relief() {
    // RMS slope sampled at ~1 km spacing must be mountain-legible. The
    // pre-retune spectrum measured ~0.005 here; the retune targets ~0.05+
    // globally (land masked higher, plains lower).
    let desc = generate(42);
    let anchor = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor).unwrap();
    let radius = 6.371e6; // sampling geometry only; slope is dimensionless
    let step_deg = (1000.0 / radius).to_degrees();
    let mut sq_sum = 0.0;
    let n = 4000;
    for i in 0..n {
        let lat = -60.0 + 120.0 * (i as f64) / (n as f64);
        let lon = -170.0 + 340.0 * (i as f64 * 0.618_033_988_75).fract();
        let e0 = spec.elevation_fine(lat, lon);
        let e1 = spec.elevation_fine(lat + step_deg, lon);
        let slope = (e1 - e0) / 1000.0;
        sq_sum += slope * slope;
    }
    let rms = (sq_sum / n as f64).sqrt();
    assert!(rms > 0.02, "terrain is glassy: RMS 1km slope {rms}");
    assert!(rms < 0.60, "terrain is spiky noise: RMS 1km slope {rms}");
}
```

(`f64::fract` — if unavailable as written, use `x - x.floor()`. Std math is fine here: this is a test, not a generation path.)

- [ ] **Step 2: RED run** — `cargo test -p gg-terrain --locked fine 2>&1 | tail -6`. Expected: `fine_terrain_has_walking_scale_relief` FAILS (rms ≈ 0.005), and `micro_detail_is_small_and_continuous` FAILS on the new `> 0.01` floor.

- [ ] **Step 3: Retune** — in `crates/gg-terrain/src/noise.rs`, replace micro's constants and comment:

```rust
/// Micro-detail: walking-scale relief below heightmap resolution
/// (wavelengths ~50 km down to ~45 m). Retuned 2026-07-04 after live QA
/// showed the spectrum-continuation amplitudes (A0≈0.0028) render as
/// glass: slopes were 0.2-0.5% at every scale. Targets now: ~5% slope at
/// 52 km, ~17% at 1 km, ~34% at 100 m before masking (elevation_fine
/// masks plains down to 25% of this). Libm-free.
pub fn micro(seed: u64, p: V3) -> f64 {
    const A0: f64 = 0.07;
    const F0: f64 = 2.6 * 47.045_880_999_999_99; // 2.6 * 1.9^6 (unchanged)
    let mut sum = 0.0;
    let mut amp = A0;
    let mut freq = F0;
    for k in 0..12u64 {
        sum += amp * value_noise(seed ^ (0x4D49_4352 + k), [p[0] * freq, p[1] * freq, p[2] * freq]);
        amp *= 0.64;
        freq *= 1.9;
    }
    sum
}
```

And in `crates/gg-terrain/src/lib.rs`, `elevation_fine` gains the mask:

```rust
    pub fn elevation_fine(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        let p = latlon_to_unit(lat_deg, lon_deg);
        let base = self.raw.raw_elevation(p) - self.sea_level;
        // Rough where the coarse field is dramatic (mountain belts, deep
        // trenches), calm on plains and shelves. Continuous by construction:
        // abs/min of continuous inputs, no positional branches.
        let mask = 0.25 + 0.75 * (base.abs() / 0.8).min(1.0);
        (base + mask * noise::micro(self.raw.noise_seed, p)) * self.relief_m
    }
```

- [ ] **Step 4: GREEN + goldens** — `cargo test -p gg-terrain --locked 2>&1 | tail -6`: the three micro/fine tests and the slope test pass; `golden_fine_hashes_are_pinned` now FAILS (expected — values changed by design). Regenerate:

```bash
for s in 1 42 123456789; do
  cargo run -p gg-terrain --example fine_hashes -- $s > crates/gg-terrain/tests/golden/terrain-fine-seed-$s.json
done
cargo test -p gg-terrain --locked 2>&1 | tail -4   # ALL green now
git diff --stat crates/gg-terrain/tests/golden/terrain-seed-*.json  # MUST be empty (coarse untouched)
```

- [ ] **Step 5: wasm parity** — `wasm-pack test --node crates/gg-wasm 2>&1 | tail -5`. Expected: all pass (the wasm test reads the same regenerated JSONs).

- [ ] **Step 6: fmt, clippy, commit**

```bash
cargo fmt --all && cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings
git add crates/gg-terrain && git commit -m "feat: relief-spectrum retune — mountain-legible slopes, elevation-masked micro (fine goldens regenerated once, by design)"
```

---

### Task 2: Water tiles in terrainGlobe

**Files:**
- Modify: `web/src/views/terrainGlobe.ts`
- Test: `web/src/views/terrainGlobe.test.ts`

**Interfaces:**
- Consumes: existing `buildTile` flow, `tileGrid`, `info.ocean_fraction`.
- Produces: no API change. Behavior: on ocean worlds (`ocean_fraction > 0`), any tile whose elevations dip below 0 also gets a WATER mesh — same grid geometry at radius exactly `R` (sea level; grid edge coordinates are bit-identical across neighbors, so no cracks and no skirts needed), shared translucent material, same per-frame position/quaternion/visibility as its terrain tile, disposed together with it.

- [ ] **Step 1: Failing tests** — add to `terrainGlobe.test.ts` (the existing fakeSim's `bodyElevations` returns `100·sin(lat·0.5)` — negative for negative lats, so ocean tiles exist near the south):

```ts
  it('ocean worlds get translucent water meshes on tiles that dip below sea level', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(-30, 30, 252, suns, 8); // southern hemisphere: elevations < 0
    const water: THREE.Mesh[] = [];
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).transparent) water.push(m);
    });
    expect(water.length).toBeGreaterThan(0);
    // water sits at sea level: vertex radius ≈ R (position + origin round-trip)
  });

  it('dry worlds get no water meshes', () => {
    const sim = fakeSim();
    const dry = { ...sim, bodyTerrainInfo: (i: number) => (i === 0 ? null : { sea_level: 0, ocean_fraction: 0, relief_m: 6000, plate_count: 8 }) };
    const g = buildTerrainGlobe(dry as Sim, anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(-30, 30, 252, suns, 8);
    let transparent = 0;
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).transparent) transparent++;
    });
    expect(transparent).toBe(0);
  });

  it('dispose also removes water meshes', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(-30, 30, 252, suns, 8);
    g.dispose();
    let meshes = 0;
    g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    expect(meshes).toBe(0);
  });
```

Add `import * as THREE from 'three';` to the test file if absent.

- [ ] **Step 2: RED run** — `npx vitest run src/views/terrainGlobe.test.ts 2>&1 | tail -4`.

- [ ] **Step 3: Implement** in `terrainGlobe.ts`:

```ts
// module scope, near the terrain material:
  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x1c4a78, transparent: true, opacity: 0.82, roughness: 0.35, metalness: 0,
  });
  const waterMeshes = new Map<string, THREE.Mesh>();
  const hasOcean = info.ocean_fraction > 0;

// in buildTile, after the terrain mesh is registered — reuse `data` & `grid`:
    if (hasOcean) {
      let dipsBelow = false;
      for (let i = 0; i < elevs.length; i++) if (elevs[i]! < 0) { dipsBelow = true; break; }
      if (dipsBelow) {
        const flat = new Float32Array(elevs.length); // all zeros = sea level
        const w = buildTileMesh(t, flat, { radiusM, reliefM: info.relief_m, classTint, dead });
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.BufferAttribute(w.positions, 3));
        wg.setIndex(new THREE.BufferAttribute(w.indices, 1));
        wg.computeVertexNormals();
        const wm = new THREE.Mesh(wg, waterMaterial);
        wm.userData.originBf = w.originBf;
        wm.visible = false;
        scene.add(wm);
        waterMeshes.set(tileKey(t), wm);
      }
    }
```

In the per-frame placement loop, mirror terrain: after positioning a visible tile mesh, do the same for `waterMeshes.get(key)` if present (same origin math — its originBf equals the tile's); hide when the tile hides. In the evict loop and in `dispose()`, dispose + remove the water mesh alongside its tile (and dispose `waterMaterial` in `dispose()`).

Note: water reuses `buildTileMesh` with a zero elevation array — vertex colors computed for e=0 are ignored (material has no vertexColors flag) and the skirt is harmless (it hangs below the surface, hidden by terrain or water opacity). This is deliberate reuse over a bespoke builder.

- [ ] **Step 4: GREEN + full suite** — `npx vitest run 2>&1 | tail -4`, `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `git add src/views && git commit -m "feat: translucent sea surface on ocean worlds"`

---

### Task 3: Fog + sky-density altitude falloff

**Files:**
- Modify: `web/src/views/terrainGlobe.ts` (fog)
- Modify: `web/src/views/ground.ts` (sky density falloff)
- Test: both test files

**Interfaces:**
- `TerrainGlobe.update` gains two trailing params: `update(latDeg, lonDeg, eyeAltM, suns, buildBudget?, atmDensity?, dayFactor?)` (defaults 0/0 keep old calls valid).
- `GroundView.update` gains one: `update(states, standing, altitudeM?)` (default 0).
- Scale height pinned: `H = 8500` meters (both falloffs).

- [ ] **Step 1: Failing tests.**

`terrainGlobe.test.ts`:

```ts
  it('fog density scales with atmosphere and fades with altitude; airless = no fog', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    g.update(15, 30, 252, suns, 2, 1.0, 1.0);
    const fogLow = (g.scene.fog as THREE.FogExp2).density;
    expect(fogLow).toBeGreaterThan(0);
    g.update(15, 30, 100_000, suns, 2, 1.0, 1.0);
    const fogHigh = (g.scene.fog as THREE.FogExp2).density;
    expect(fogHigh).toBeLessThan(fogLow / 100);
    g.update(15, 30, 252, suns, 2, 0.0, 1.0);
    expect((g.scene.fog as THREE.FogExp2).density).toBe(0);
  });
```

`ground.test.ts` — the sky dome's density uniform must fade with altitude. `buildSkyDome` exposes `setDensity`; ground calls it internally. Assert observable behavior via `dayFactor` stability + a direct probe of the dome material uniform:

```ts
  it('sky density falls off exponentially with altitude', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const dome = g.scene.getObjectByName('skydome') as THREE.Mesh;
    const uniforms = (dome.material as THREE.ShaderMaterial).uniforms;
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 }, 0);
    const d0 = uniforms.density!.value as number;
    g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 }, 8500);
    const d1 = uniforms.density!.value as number;
    expect(d1).toBeCloseTo(d0 * Math.exp(-1), 5);
  });
```

(Check the dome shader's actual uniform name first — read `sky.ts`; if it isn't `density`, use the real name in the test.)

- [ ] **Step 2: RED run** — both files.

- [ ] **Step 3: Implement.**

`terrainGlobe.ts` — at build: `scene.fog = new THREE.FogExp2(0x0a0e14, 0);` and in `update(...)`:

```ts
  function update(latDeg: number, lonDeg: number, eyeAltM: number, suns: SunSpec[], buildBudget = 2, atmDensity = 0, dayFactor = 0): void {
    ...
    const fog = scene.fog as THREE.FogExp2;
    fog.density = 2.5e-5 * atmDensity * Math.exp(-eyeAltM / 8500);
    fog.color.setHex(0x0a0e14).lerp(new THREE.Color(0x9db4c8), dayFactor);
```

`ground.ts` — `update(states, standing, altitudeM = 0)`; the `sky.setDensity(...)` line becomes:

```ts
    sky.setDensity(atmosphereDensityFor(desc, layout[standing.body]!) * Math.exp(-altitudeM / 8500));
```

`main.ts` — pass through: `ground.update(states, {...}, flightAltM)` and `terrainGlobe.update(lat, lon, eyeAlt, suns, 2, atmosphereDensityFor(sim.descriptor, layout[current.body]!), ground.dayFactor())`. (Import `atmosphereDensityFor` if not present; `flightAltM` arrives in Task 4 — until then pass 0.)

- [ ] **Step 4: GREEN + full suite + tsc.**
- [ ] **Step 5: Commit** — `git commit -m "feat: distance fog and Karman-line sky falloff"`

---

### Task 4: Free-flight

**Files:**
- Modify: `web/src/views/walk.ts` (pure helpers)
- Test: `web/src/views/walk.test.ts`
- Modify: `web/src/main.ts` (wiring)

**Interfaces (new, in walk.ts):**

```ts
/** Vertical flight integration: hold-to-ascend/descend, rate scales with
 * altitude (min 2 m/s, alt/2 per second) so leaving the ground and reaching
 * limb view both feel responsive. Altitude clamps to [0, 10 * radiusM]. */
export function flightStep(altM: number, dUp: number, dtS: number, radiusM: number): number;

/** Horizontal ground-speed ladder: walking 1.4, Shift-skim 100, flying
 * max(100, altM / 2) m/s. */
export function groundSpeedMps(altM: number, shiftHeld: boolean): number;
```

Flight mode contract (wired in main.ts): `flightAltM` state, 0 = walking. Keys `r` (up) / `f` (down), same input-focus guard and blur-clear as WASD. Landing = altitude integrates to 0 → walk mode. Eye altitude passed to the globe: `terrain + 1.7 + flightAltM` (wade clamp from Plan 2a stays). Altitude is session-local; URL schema unchanged.

- [ ] **Step 1: Failing tests** — `walk.test.ts`:

```ts
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
    expect(groundSpeedMps(1000, false)).toBe(100);
    expect(groundSpeedMps(50_000, false)).toBe(25_000);
  });
});
```

- [ ] **Step 2: RED run** — `npx vitest run src/views/walk.test.ts 2>&1 | tail -4`.

- [ ] **Step 3: Implement** in `walk.ts`:

```ts
export function flightStep(altM: number, dUp: number, dtS: number, radiusM: number): number {
  if (dUp === 0) return altM;
  const rate = Math.max(2, altM / 2);
  const next = altM + dUp * rate * dtS;
  return Math.min(10 * radiusM, Math.max(0, next));
}

export function groundSpeedMps(altM: number, shiftHeld: boolean): number {
  if (altM > 0) return Math.max(100, altM / 2);
  return shiftHeld ? 100 : 1.4;
}
```

- [ ] **Step 4: Wire in main.ts.**

1. State + keys (next to heldKeys/shiftHeld; same guards):

```ts
  let flightAltM = 0;
  const flightKeys = new Set<'r' | 'f'>();
  // in the existing keydown handler: if (e.key === 'r' || e.key === 'f') flightKeys.add(e.key as 'r' | 'f');
  // in keyup: flightKeys.delete(...); in the blur handler: flightKeys.clear();
```

2. In the ground branch of the render loop, before the walk block:

```ts
      const dUp = (flightKeys.has('r') ? 1 : 0) - (flightKeys.has('f') ? 1 : 0);
      if (dUp !== 0) {
        const rM = bodyRadiusM(sim.descriptor, layout[current.body]!);
        flightAltM = flightStep(flightAltM, dUp, dt, rM);
      }
```

3. Walk block: `const speedMps = flightAltM > 0 ? groundSpeedMps(flightAltM, shiftHeld) : (shiftHeld ? SKIM_M_PER_S : WALK_M_PER_S);` — or simply replace the ladder with `groundSpeedMps(flightAltM, shiftHeld)` and DELETE the now-redundant `WALK_M_PER_S`/`SKIM_M_PER_S` constants (they live in walk.ts's helper now).
4. Eye altitude: where `eyeAlt` is computed for `terrainGlobe.update`, add `+ flightAltM`; pass `flightAltM` as ground.update's `altitudeM` (replacing Task 3's 0).
5. Reset `flightAltM = 0` in `enterGround`/`exitGround`/stand-here (a shared link or new stand starts on foot).
6. Speed-clamp note: the existing "speed clamped to 1 hr/s while standing" logic is unrelated (sim time); leave it.

- [ ] **Step 5: GREEN + full suite + tsc.** Also `npx vitest run 2>&1 | tail -4`.
- [ ] **Step 6: Commit** — `git commit -m "feat: free-flight — hold R/F to ascend/descend, altitude-scaled speeds"`

---

### Task 5: HUD elevation/altitude readouts

**Files:**
- Modify: `web/src/ui/compass.ts`
- Test: `web/src/ui/compass.test.ts`
- Modify: `web/src/main.ts` (pass values)

**Interfaces:** `setHeading(yawRad, pitchRad, latLon?, elevM?: number | null, flightAltM?: number)` — appends ` · ⛰ 1,234 m` when `elevM` is a number, and ` · ✈ 12.3 km` when `flightAltM > 0` (meters with thousands separators below 10 km, `X.Y km` above).

- [ ] **Step 1: Failing tests** — `compass.test.ts`:

```ts
  it('shows elevation and flight altitude when provided', () => {
    const root = document.createElement('div');
    const c = buildCompass(root);
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, 1234.4, 0);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('⛰ 1,234 m');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, -30.2, 0);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('⛰ -30 m');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, 5, 12_300);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('✈ 12.3 km');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, 5, 900);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('✈ 900 m');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, null, 0);
    expect(root.querySelector('.compass-readout')!.textContent).not.toContain('⛰');
  });
```

- [ ] **Step 2: RED run.**
- [ ] **Step 3: Implement** in `compass.ts` (inside `setHeading`, after the latLon suffix):

```ts
      if (elevM !== null && elevM !== undefined) {
        text += ` · ⛰ ${Math.round(elevM).toLocaleString('en-US')} m`;
      }
      if (flightAltM && flightAltM > 0) {
        text += flightAltM >= 10_000 ? ` · ✈ ${(flightAltM / 1000).toFixed(1)} km` : ` · ✈ ${Math.round(flightAltM)} m`;
      }
```

- [ ] **Step 4: Wire in main.ts** — the existing `compass.setHeading(yaw, pitch, latLon)` call gains `, currentElevationM, flightAltM`.
- [ ] **Step 5: GREEN + full suite + tsc; commit** — `git commit -m "feat: HUD elevation and flight-altitude readouts"`

---

### Task 6: Ship + live QA

(Controller-level: final whole-branch review per subagent-driven-development, merge from the PRIMARY repo, push, watch deploy, then Playwright QA: (1) seed 42 peak at 2.11N 44.30E — terrain must now read as terrain; (2) coastline with visible water plane; (3) hold R to ascend to ~200 km — sky fades to black, limb curves, fog gone; (4) IVa airless check unchanged; (5) HUD readouts visible. Screenshots eyeballed. Update memory + roadmap after.)

## Self-Review Notes (applied)

- Spec coverage vs approved design: flight ✓ (Task 4), water ✓ (T2), fog + sky falloff ✓ (T3), HUD ✓ (T5); relief retune is the QA-driven addition, constants derived analytically (slope table in Task 1). CDLOD-compat unaffected (no mesh-layout change).
- Golden policy explicit: coarse byte-identical, fine regenerated ONCE in Task 1 only.
- Type consistency: `update` signatures with defaulted trailing params keep earlier tasks' calls compiling between tasks; walk.ts helper names (`flightStep`, `groundSpeedMps`) used identically in Tasks 4-5 wiring.
- Known reconciliation points: sky-dome density uniform name (T3 Step 1), compass argument order (T5 wiring must match the interface line).
