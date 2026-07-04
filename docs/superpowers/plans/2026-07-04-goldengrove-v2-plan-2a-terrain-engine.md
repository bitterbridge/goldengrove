# Goldengrove v2 Plan 2a — Quadtree Terrain Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ground view's flat disc becomes a quadtree cube-sphere planet: real terrain with ~1.5 m detail underfoot, correct curvature and horizons, and walking that rides the surface.

**Architecture:** Rust adds micro-detail octaves (`elevation_fine`, meters) and a batched WASM elevation API. TypeScript adds four modules — `cubeSphere` (tile addressing), `tileTree` (LOD selection + LRU), `tileMesh` (geometry with skirts + vertex colors), `terrainGlobe` (three.js orchestrator with async tile builds) — integrated into the ground view as a second render pass (sky first, depth cleared, terrain second). Flight, water, fog, and HUD readouts are Plan 2b.

**Tech Stack:** Rust (gg-terrain, gg-wasm, wasm-bindgen), TypeScript + three.js + vitest.

## Global Constraints

- Determinism: same seed → identical output everywhere, forever. Micro-detail derives from the existing `noise_seed` with new XOR channels — **zero new RNG draws, zero changes to draw order**.
- Descriptor goldens AND existing terrain goldens stay **byte-identical** — never regenerate them; if they fail, your change is wrong.
- `elevation()`, `heightmap()`, `SCHEMA_VERSION` (2) untouched.
- All generation-path transcendentals via `gg_core::math` (libm). The new noise/micro code must stay libm-free (integer hash + mul/add only, like `noise.rs`). `f64::floor`, `f64::round`, `f64::sqrt` are IEEE-exact and allowed.
- wasm32 is the canonical target; new determinism surfaces get wasm parity coverage.
- Lat/lon convention: `lat = asin(z)`, `lon = atan2(y, x)` in the body-fixed frame (matches `gg-terrain::sphere::latlon_to_unit` and `web/src/views/observer.ts`).
- Tile mesh layout must not preclude CDLOD geomorphing (committed follow-up): uniform (N+1)×(N+1) grids per tile, no T-junction stitching; skirts only.
- Never use `--no-verify`; run `cargo fmt`/`clippy -D warnings`/`npx tsc --noEmit` before committing.
- Commands below run from the repo root unless a `cd` is shown. Rust suite: `cargo test --locked`. Web suite: `cd web && npx vitest run`.

## File Structure

```
crates/gg-terrain/src/noise.rs        (modify: add micro())
crates/gg-terrain/src/lib.rs          (modify: elevation_fine, elevation_fine_batch, fine_hash)
crates/gg-terrain/tests/terrain.rs    (modify: micro tests + fine golden test)
crates/gg-terrain/examples/fine_hashes.rs  (create: golden bootstrap)
crates/gg-terrain/tests/golden/terrain-fine-seed-{1,42,123456789}.json (create)
crates/gg-wasm/src/lib.rs             (modify: body_elevation, body_elevations)
crates/gg-wasm/tests/wasm_golden.rs   (modify: fine parity + boundary tests)
web/src/sim/wasm.ts                   (modify: Sim.bodyElevation/bodyElevations)
web/src/views/cubeSphere.ts           (create) + cubeSphere.test.ts
web/src/views/tileTree.ts             (create) + tileTree.test.ts
web/src/views/tileMesh.ts             (create) + tileMesh.test.ts
web/src/views/terrainGlobe.ts         (create) + terrainGlobe.test.ts
web/src/views/ground.ts               (modify: terrain scene, disc removal)
web/src/main.ts                       (modify: two-pass render, meters walking, eye height)
web/src/views/ground.test.ts          (modify: fakeSim + two-pass assertions)
```

---

### Task 1: Rust micro-detail octaves + `elevation_fine`

**Files:**
- Modify: `crates/gg-terrain/src/noise.rs`
- Modify: `crates/gg-terrain/src/lib.rs`
- Test: `crates/gg-terrain/tests/terrain.rs`

**Interfaces:**
- Consumes: existing `value_noise` (private in noise.rs), `RawTerrain.noise_seed`, `TerrainSpec { raw, sea_level, relief_m }`, `latlon_to_unit`.
- Produces: `pub fn micro(seed: u64, p: V3) -> f64` (noise.rs); `TerrainSpec::elevation_fine(lat_deg, lon_deg) -> f64` (METERS above sea level); `TerrainSpec::elevation_fine_batch(coords: &[f64]) -> Vec<f32>` (`[lat0, lon0, lat1, lon1, …]`); `pub fn fine_hash(vals: &[f32]) -> u64` (lib.rs). Task 2 pins goldens on `fine_hash`; Task 3 wraps the batch in WASM.

- [ ] **Step 1: Write the failing tests** — append to `crates/gg-terrain/tests/terrain.rs`:

```rust
#[test]
fn micro_detail_is_small_and_continuous() {
    // Amplitude budget: micro is a spectral tail; |micro| must stay under
    // ~0.007 relative units (sum of its octave amplitudes), and adjacent
    // samples 1e-5 rad apart (~60 m) must not jump more than the finest
    // octaves can move.
    let mut worst_val = 0.0f64;
    let mut worst_jump = 0.0f64;
    let mut prev = None;
    for i in 0..20_000 {
        let t = i as f64 * 1e-5;
        let p = gg_terrain::sphere::latlon_to_unit(12.0 + t * 57.2957795, 40.0);
        let m = gg_terrain::noise::micro(0xDEADBEEF, p);
        worst_val = worst_val.max(m.abs());
        if let Some(pv) = prev {
            worst_jump = worst_jump.max((m - pv).abs());
        }
        prev = Some(m);
    }
    assert!(worst_val < 0.007, "micro amplitude {worst_val} exceeds spectral budget");
    assert!(worst_jump < 0.002, "micro jump {worst_jump} over ~60 m step — discontinuous");
    assert!(worst_val > 1e-5, "micro is degenerate/zero");
}

#[test]
fn elevation_fine_agrees_with_elevation_at_scale() {
    // fine = relief_m * (elevation + micro): the base field is untouched, so
    // fine/relief must stay within the micro budget of elevation() everywhere.
    let desc = generate(42);
    let anchor = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor).unwrap();
    let relief = spec.info().relief_m;
    for row in 0..32 {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / 32.0;
        for col in 0..64 {
            let lon = -180.0 + (col as f64 + 0.5) * 360.0 / 64.0;
            let coarse = spec.elevation(lat, lon);
            let fine = spec.elevation_fine(lat, lon);
            let diff = (fine / relief - coarse).abs();
            assert!(diff < 0.007, "spectral seam at ({lat},{lon}): {diff}");
        }
    }
}

#[test]
fn elevation_fine_batch_matches_scalar() {
    let desc = generate(42);
    let anchor = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor).unwrap();
    let coords = [10.0, 20.0, -35.5, 170.25, 89.0, -179.0];
    let batch = spec.elevation_fine_batch(&coords);
    assert_eq!(batch.len(), 3);
    for (i, pair) in coords.chunks_exact(2).enumerate() {
        assert_eq!(batch[i], spec.elevation_fine(pair[0], pair[1]) as f32);
    }
}
```

Also add `pub mod` visibility if needed: tests access `gg_terrain::noise::micro` and `gg_terrain::sphere::latlon_to_unit` — make `pub mod noise;` and confirm `pub mod sphere;` in lib.rs (sphere is already used by tests; check and match existing visibility).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-terrain --locked micro 2>&1 | tail -5` and `cargo test -p gg-terrain --locked elevation_fine 2>&1 | tail -5`
Expected: compile FAILURE — `micro` / `elevation_fine` not found.

- [ ] **Step 3: Implement `micro` in `crates/gg-terrain/src/noise.rs`** (append):

```rust
/// Micro-detail: continues the terrain detail cascade below heightmap
/// resolution (wavelengths ~50 km down to ~45 m on an Earth-radius body).
/// The joint amplitude equals what the detail fbm would give its next
/// octave, so the spectrum has no seam; gain 0.6 (vs 0.5 above) keeps
/// walking-scale ground from being glassy. 12 octaves for every body —
/// small bodies just get sub-perceptual extra terms. Libm-free.
pub fn micro(seed: u64, p: V3) -> f64 {
    // 0.35 * 0.5^7 / 0.984375: detail's octave-6 amplitude one step past
    // its last (its 6-octave amp sum is 0.984375; see raw_elevation).
    const A0: f64 = 0.35 * 0.007_812_5 / 0.984_375;
    const F0: f64 = 2.6 * 47.045_881_899_999_99; // 2.6 * 1.9^6
    let mut sum = 0.0;
    let mut amp = A0;
    let mut freq = F0;
    for k in 0..12u64 {
        sum += amp * value_noise(seed ^ (0x4D49_4352 + k), [p[0] * freq, p[1] * freq, p[2] * freq]);
        amp *= 0.6;
        freq *= 1.9;
    }
    sum
}
```

Note: `1.9^6` written as a literal so the constant is fixed forever; do NOT compute it with `powf` (libm value could differ from the literal and this constant is now part of the determinism surface). Verify the literal: 1.9² = 3.61; ³ = 6.859; ⁴ = 13.0321; ⁵ = 24.76099; ⁶ = 47.0458810 — the literal above carries f64 precision of that product chain; compute it once in a scratch `rustc` snippet with `let x = 1.9f64*1.9*1.9*1.9*1.9*1.9; println!("{x:.17}")` and paste EXACTLY what it prints.

- [ ] **Step 4: Implement `elevation_fine`, `elevation_fine_batch`, `fine_hash` in `crates/gg-terrain/src/lib.rs`** — inside `impl TerrainSpec`, after `elevation`:

```rust
    /// Elevation in METERS above sea level with micro-detail octaves that
    /// continue the noise spectrum below heightmap resolution. The base
    /// field is exactly elevation() (same draws, same values); micro adds
    /// <0.7% of relief, so orrery textures and ground truth agree at
    /// texture scale. The ground view and walking consume this.
    pub fn elevation_fine(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        let p = latlon_to_unit(lat_deg, lon_deg);
        let rel = self.raw.raw_elevation(p) - self.sea_level + noise::micro(self.raw.noise_seed, p);
        rel * self.relief_m
    }

    /// Batched elevation_fine: coords is [lat0, lon0, lat1, lon1, ...] in
    /// degrees. One FFI crossing per terrain tile build.
    pub fn elevation_fine_batch(&self, coords: &[f64]) -> Vec<f32> {
        debug_assert!(coords.len() % 2 == 0, "coords must be lat/lon pairs");
        coords
            .chunks_exact(2)
            .map(|c| self.elevation_fine(c[0], c[1]) as f32)
            .collect()
    }
```

And at file scope (near `heightmap_hash`):

```rust
/// FNV-1a-64 over centimeter-quantized i32 little-endian bytes — the
/// fine-elevation determinism fingerprint (meter-scale values exceed the
/// coarse hash's ±4 relative-unit clamp, so it gets its own quantization).
pub fn fine_hash(vals: &[f32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for e in vals {
        let q = (f64::from(*e) * 100.0).round() as i32;
        for b in q.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}
```

`raw.noise_seed` and `raw.raw_elevation` are private-to-crate fields/methods already used inside lib.rs — no visibility change needed. `noise::micro` needs `pub` (Step 3) and `pub mod noise;` if the module isn't public (adjust the existing `mod noise;` line; keep other items in noise.rs private).

- [ ] **Step 5: Run the three tests**

Run: `cargo test -p gg-terrain --locked 2>&1 | tail -8`
Expected: all tests pass, INCLUDING the pre-existing golden + property tests (byte-identical goldens prove `elevation()` is untouched).

- [ ] **Step 6: fmt, clippy, commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --locked -- -D warnings
git add crates/gg-terrain && git commit -m "feat: micro-detail octaves + elevation_fine (meters) in gg-terrain"
```

---

### Task 2: Fine-elevation goldens (native + wasm parity)

**Files:**
- Create: `crates/gg-terrain/examples/fine_hashes.rs`
- Create: `crates/gg-terrain/tests/golden/terrain-fine-seed-{1,42,123456789}.json` (generated)
- Modify: `crates/gg-terrain/tests/terrain.rs`
- Modify: `crates/gg-wasm/tests/wasm_golden.rs`

**Interfaces:**
- Consumes: `TerrainSpec::{for_body, elevation_fine}`, `fine_hash` (Task 1), `gg_gen::generate`.
- Produces: pinned fine goldens; a shared helper pattern (64×32 fine grid) that the wasm test reproduces exactly.

- [ ] **Step 1: Write the golden test** — append to `crates/gg-terrain/tests/terrain.rs`:

```rust
/// 64x32 fine-elevation grid, same pixel-center sampling as heightmap().
fn fine_grid(spec: &TerrainSpec) -> Vec<f32> {
    let (w, h) = (64usize, 32usize);
    let mut out = Vec::with_capacity(w * h);
    for row in 0..h {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / h as f64;
        for col in 0..w {
            let lon = -180.0 + (col as f64 + 0.5) * 360.0 / w as f64;
            out.push(spec.elevation_fine(lat, lon) as f32);
        }
    }
    out
}

#[test]
fn golden_fine_hashes_are_pinned() {
    for seed in [1u64, 42, 123_456_789] {
        let path = format!("tests/golden/terrain-fine-seed-{seed}.json");
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!("missing {path}; bootstrap: cargo run -p gg-terrain --example fine_hashes -- {seed} > crates/gg-terrain/{path}")
        });
        let expected: std::collections::BTreeMap<String, String> = serde_json::from_str(&expected).unwrap();
        let desc = generate(seed);
        let total = desc.stars.len() + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(format!("body_{body}"), format!("{:#018x}", gg_terrain::fine_hash(&fine_grid(&spec))));
            }
        }
        assert_eq!(actual, expected, "seed {seed}: fine elevation diverged — ground terrain would change under walkers' feet");
    }
}
```

- [ ] **Step 2: Write the bootstrap example** — `crates/gg-terrain/examples/fine_hashes.rs`, mirroring the existing `examples/hashes.rs` (read it first and copy its argument handling verbatim), but hashing the 64×32 `elevation_fine` grid with `fine_hash` and the same `body_N` JSON shape as above.

- [ ] **Step 3: Generate the three golden files**

```bash
for s in 1 42 123456789; do
  cargo run -p gg-terrain --example fine_hashes -- $s > crates/gg-terrain/tests/golden/terrain-fine-seed-$s.json
done
```

Then `cargo test -p gg-terrain --locked golden 2>&1 | tail -4` — expected: BOTH golden tests pass (coarse goldens untouched: `git diff --stat crates/gg-terrain/tests/golden/terrain-seed-*.json` must be empty).

- [ ] **Step 4: Extend wasm parity** — in `crates/gg-wasm/tests/wasm_golden.rs`, add a test that reproduces `fine_grid` (copy the 64×32 loop — wasm tests can't import test helpers from gg-terrain's tests) for each golden seed and asserts the same hashes read from the same JSON files (the existing wasm golden tests already read golden JSONs via `include_str!` — read the file and copy that mechanism exactly; anchor the paths the same way).

- [ ] **Step 5: Run wasm parity**

Run: `wasm-pack test --node crates/gg-wasm 2>&1 | tail -6` (Node ≥ 20 required — Node 18 crashes the test runner)
Expected: all wasm tests pass including the new fine-golden parity.

- [ ] **Step 6: fmt, clippy, commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets --locked -- -D warnings
git add crates/gg-terrain crates/gg-wasm && git commit -m "test: fine-elevation goldens pinned natively and under wasm32"
```

---

### Task 3: WASM + TS boundary — `body_elevation`, `body_elevations`

**Files:**
- Modify: `crates/gg-wasm/src/lib.rs`
- Modify: `crates/gg-wasm/tests/wasm_golden.rs`
- Modify: `web/src/sim/wasm.ts`
- Modify: `web/src/views/ground.test.ts` (fakeSim gains the two methods)

**Interfaces:**
- Consumes: `with_terrain` cache helper (existing), `TerrainSpec::{elevation_fine, elevation_fine_batch}`.
- Produces (Rust): `pub fn body_elevation(&self, body_index: usize, lat_deg: f64, lon_deg: f64) -> Result<f64, JsError>`; `pub fn body_elevations(&self, body_index: usize, coords: &[f64]) -> js_sys::Float32Array` (empty array for non-terrain bodies, matching `body_heightmap`).
- Produces (TS, `Sim` interface): `bodyElevation(bodyIndex: number, latDeg: number, lonDeg: number): number | null` (null for non-terrain); `bodyElevations(bodyIndex: number, coords: Float64Array): Float32Array` (length 0 for non-terrain). Tasks 6–7 consume these.

- [ ] **Step 1: Write the failing wasm boundary test** — append to the World boundary test section of `crates/gg-wasm/tests/wasm_golden.rs`:

```rust
#[wasm_bindgen_test]
fn body_elevation_scalar_and_batch_agree() {
    let world = World::new("42").unwrap();
    // anchor planet body index: stars.len() + anchor_planet, read from the descriptor JSON
    let desc: serde_json::Value = serde_json::from_str(&world.descriptor_json().unwrap()).unwrap();
    let body = desc["stars"].as_array().unwrap().len() + desc["anchor_planet"].as_u64().unwrap() as usize;
    let e = world.body_elevation(body, 10.0, 20.0).unwrap();
    assert!(e.is_finite() && e.abs() < 50_000.0, "implausible elevation {e}");
    let batch = world.body_elevations(body, &[10.0, 20.0]);
    assert_eq!(batch.length(), 1);
    assert_eq!(batch.get_index(0), e as f32);
    // star (body 0) has no terrain
    assert!(world.body_elevation(0, 0.0, 0.0).is_err());
    assert_eq!(world.body_elevations(0, &[0.0, 0.0]).length(), 0);
}
```

(Adapt `World::new("42")`'s exact constructor signature to whatever the existing boundary tests in this file use — read them first and copy their construction line verbatim.)

- [ ] **Step 2: Run to verify failure** — `wasm-pack test --node crates/gg-wasm 2>&1 | tail -5`. Expected: compile FAILURE (`body_elevation` not found).

- [ ] **Step 3: Implement** — in `crates/gg-wasm/src/lib.rs` after `body_terrain_info`:

```rust
    /// Fine elevation (METERS above sea level) at a surface point.
    /// Error for bodies with no terrain (stars, giants).
    pub fn body_elevation(&self, body_index: usize, lat_deg: f64, lon_deg: f64) -> Result<f64, JsError> {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => Ok(s.elevation_fine(lat_deg, lon_deg)),
            None => Err(JsError::new("no terrain for this body")),
        })
    }

    /// Batched fine elevations: coords = [lat0, lon0, lat1, lon1, ...] deg.
    /// Empty array = no terrain body (renderer skips), matching body_heightmap.
    pub fn body_elevations(&self, body_index: usize, coords: &[f64]) -> js_sys::Float32Array {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => js_sys::Float32Array::from(s.elevation_fine_batch(coords).as_slice()),
            None => js_sys::Float32Array::new_with_length(0),
        })
    }
```

- [ ] **Step 4: Run wasm tests** — `wasm-pack test --node crates/gg-wasm 2>&1 | tail -5`. Expected: PASS.

- [ ] **Step 5: TS wrapper** — in `web/src/sim/wasm.ts`, add to the `Sim` interface and to the object the loader returns (read the file; every existing method follows the same delegation pattern — copy it):

```ts
  /** Fine elevation in meters above sea level; null for non-terrain bodies. */
  bodyElevation(bodyIndex: number, latDeg: number, lonDeg: number): number | null;
  /** Batched fine elevations for [lat0, lon0, ...] pairs; length 0 for non-terrain bodies. */
  bodyElevations(bodyIndex: number, coords: Float64Array): Float32Array;
```

Implementation in the returned object: `bodyElevation` wraps the WASM call in try/catch and returns `null` on error (the Rust side throws for non-terrain bodies); `bodyElevations` passes through.

- [ ] **Step 6: Update `fakeSim` in `web/src/views/ground.test.ts`** so it satisfies `Sim`:

```ts
    bodyElevation: () => 0,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
```

- [ ] **Step 7: Full check + commit**

```bash
cd web && npm run build:wasm && npx tsc --noEmit && npx vitest run 2>&1 | tail -4
cd .. && cargo fmt --all && cargo clippy --workspace --all-targets --locked -- -D warnings
git add crates/gg-wasm web/src && git commit -m "feat: body_elevation + batched body_elevations across the WASM boundary"
```

---

### Task 4: `cubeSphere.ts` — tile addressing

**Files:**
- Create: `web/src/views/cubeSphere.ts`
- Test: `web/src/views/cubeSphere.test.ts`

**Interfaces:**
- Consumes: nothing (pure math module).
- Produces (exact signatures Tasks 5–7 rely on):

```ts
export type V3 = [number, number, number];
export interface TileId { face: number; level: number; ix: number; iy: number }
export const TILE_QUADS = 64;
export function tileKey(t: TileId): string;                    // "f:l:ix:iy"
export function children(t: TileId): [TileId, TileId, TileId, TileId];
export function parent(t: TileId): TileId | null;              // null at level 0
export function faceUnit(face: number, a: number, b: number): V3;  // a,b ∈ [-1,1]
export function unitLatLon(u: V3): { latDeg: number; lonDeg: number };
export function tileCenterUnit(t: TileId): V3;
export function tileEdgeLenM(level: number, radiusM: number): number; // (π/2)·R / 2^level
export function maxLevel(radiusM: number): number;             // clamp(ceil(log2(edge0/ (TILE_QUADS*1.5))), 3, 18)
export interface TileGrid { lats: Float64Array; lons: Float64Array; units: Float64Array } // (N+1)² entries; units is xyz-interleaved
export function tileGrid(t: TileId): TileGrid;                 // row-major, iy-major then ix, b before a
export function containingTile(u: V3, level: number): TileId;  // tile whose face-square contains unit vector u
```

- [ ] **Step 1: Write the failing tests** — `web/src/views/cubeSphere.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  TILE_QUADS, children, containingTile, faceUnit, maxLevel, parent,
  tileCenterUnit, tileEdgeLenM, tileGrid, tileKey, unitLatLon, type TileId,
} from './cubeSphere';

describe('cubeSphere addressing', () => {
  it('faceUnit covers the sphere: 6 faces × corners are unit-length and distinct-ish', () => {
    const seen = new Set<string>();
    for (let f = 0; f < 6; f++) {
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as const) {
        const u = faceUnit(f, a, b);
        expect(Math.hypot(...u)).toBeCloseTo(1, 12);
        seen.add(u.map((x) => x.toFixed(6)).join(','));
      }
    }
    expect(seen.size).toBe(6 + 8); // 6 distinct centers + 8 shared corners
  });

  it('adjacent faces produce bit-identical points along shared edges', () => {
    // +X face at a=1 runs along the cube edge x=1,y=1; find the neighbor
    // face/param that generates the same edge, and compare EXACTLY (===).
    for (let i = 0; i <= 8; i++) {
      const b = -1 + (2 * i) / 8;
      const fromX = faceUnit(0, 1, b);
      const fromY = faceUnit(2, -1, b);
      expect(fromX[0]).toBe(fromY[0]);
      expect(fromX[1]).toBe(fromY[1]);
      expect(fromX[2]).toBe(fromY[2]);
    }
  });

  it('unitLatLon inverts the terrain lat/lon convention', () => {
    const u = faceUnit(4, 0, 0); // +Z face center = north pole
    expect(unitLatLon(u).latDeg).toBeCloseTo(90, 10);
    const eq = faceUnit(0, 0, 0); // +X face center = lat 0, lon 0
    const { latDeg, lonDeg } = unitLatLon(eq);
    expect(latDeg).toBeCloseTo(0, 10);
    expect(lonDeg).toBeCloseTo(0, 10);
  });

  it('children/parent round-trip and refine the same square', () => {
    const t: TileId = { face: 3, level: 4, ix: 5, iy: 9 };
    const kids = children(t);
    expect(kids.length).toBe(4);
    for (const k of kids) {
      expect(k.level).toBe(5);
      expect(parent(k)).toEqual(t);
    }
    expect(new Set(kids.map(tileKey)).size).toBe(4);
    expect(parent({ face: 0, level: 0, ix: 0, iy: 0 })).toBeNull();
  });

  it('tileGrid yields (N+1)² aligned lat/lon/unit samples with exact shared edges', () => {
    const t: TileId = { face: 1, level: 2, ix: 1, iy: 2 };
    const g = tileGrid(t);
    const n = TILE_QUADS + 1;
    expect(g.lats.length).toBe(n * n);
    expect(g.units.length).toBe(3 * n * n);
    // right edge of this tile === left edge of its east neighbor (same level)
    const nb: TileId = { face: 1, level: 2, ix: 2, iy: 2 };
    const gn = tileGrid(nb);
    for (let row = 0; row < n; row++) {
      const a = row * n + (n - 1); // last column of t
      const bIdx = row * n + 0;    // first column of neighbor
      expect(g.units[3 * a]).toBe(gn.units[3 * bIdx]);
      expect(g.units[3 * a + 1]).toBe(gn.units[3 * bIdx + 1]);
      expect(g.units[3 * a + 2]).toBe(gn.units[3 * bIdx + 2]);
    }
  });

  it('edge length halves per level; maxLevel lands near 1.5 m spacing', () => {
    const R = 6.371e6;
    expect(tileEdgeLenM(3, R)).toBeCloseTo(tileEdgeLenM(2, R) / 2, 6);
    const L = maxLevel(R);
    const spacing = tileEdgeLenM(L, R) / TILE_QUADS;
    expect(spacing).toBeGreaterThan(0.7);
    expect(spacing).toBeLessThan(3.0);
    expect(maxLevel(1e4)).toBeGreaterThanOrEqual(3); // tiny body clamps low but valid
  });

  it('containingTile finds the tile whose square holds the point', () => {
    const t: TileId = { face: 2, level: 6, ix: 17, iy: 40 };
    const c = tileCenterUnit(t);
    expect(containingTile(c, 6)).toEqual(t);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd web && npx vitest run src/views/cubeSphere.test.ts 2>&1 | tail -4`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `web/src/views/cubeSphere.ts`:**

```ts
/** Quadtree cube-sphere tile addressing. Six faces, each an axis-aligned
 * square in (a, b) ∈ [-1,1]²; a tile at `level` is one of 2^level × 2^level
 * squares per face. All grid parameters are dyadic rationals, and adjacent
 * faces share pre-normalization edge points exactly, so shared edges/corners
 * produce bit-identical unit vectors — tile seams cannot crack. */
export type V3 = [number, number, number];
export interface TileId { face: number; level: number; ix: number; iy: number }

/** Quads per tile side (65 vertices). One uniform grid per tile — the layout
 * CDLOD geomorphing needs later; seams are handled by skirts, not stitching. */
export const TILE_QUADS = 64;

const FACES: { n: V3; u: V3; v: V3 }[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

export function tileKey(t: TileId): string {
  return `${t.face}:${t.level}:${t.ix}:${t.iy}`;
}

export function children(t: TileId): [TileId, TileId, TileId, TileId] {
  const l = t.level + 1;
  const x = t.ix * 2;
  const y = t.iy * 2;
  return [
    { face: t.face, level: l, ix: x, iy: y },
    { face: t.face, level: l, ix: x + 1, iy: y },
    { face: t.face, level: l, ix: x, iy: y + 1 },
    { face: t.face, level: l, ix: x + 1, iy: y + 1 },
  ];
}

export function parent(t: TileId): TileId | null {
  if (t.level === 0) return null;
  return { face: t.face, level: t.level - 1, ix: t.ix >> 1, iy: t.iy >> 1 };
}

export function faceUnit(face: number, a: number, b: number): V3 {
  const f = FACES[face]!;
  const x = f.n[0] + a * f.u[0] + b * f.v[0];
  const y = f.n[1] + a * f.u[1] + b * f.v[1];
  const z = f.n[2] + a * f.u[2] + b * f.v[2];
  const len = Math.sqrt(x * x + y * y + z * z);
  return [x / len, y / len, z / len];
}

/** Matches gg-terrain's latlon_to_unit: lat = asin(z), lon = atan2(y, x). */
export function unitLatLon(u: V3): { latDeg: number; lonDeg: number } {
  const latDeg = (Math.asin(Math.min(1, Math.max(-1, u[2]))) * 180) / Math.PI;
  const lonDeg = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  return { latDeg, lonDeg };
}

/** Face parameter of a tile-grid node: dyadic, exact in f64. */
function param(index: number, offset: number, level: number): number {
  return -1 + (2 * (index + offset)) / (1 << level);
}

export function tileCenterUnit(t: TileId): V3 {
  return faceUnit(t.face, param(t.ix, 0.5, t.level), param(t.iy, 0.5, t.level));
}

export function tileEdgeLenM(level: number, radiusM: number): number {
  return ((Math.PI / 2) * radiusM) / (1 << level);
}

/** Deepest level: ~1.5 m vertex spacing, clamped to [3, 18]. */
export function maxLevel(radiusM: number): number {
  const l = Math.ceil(Math.log2(((Math.PI / 2) * radiusM) / (TILE_QUADS * 1.5)));
  return Math.min(18, Math.max(3, l));
}

export interface TileGrid { lats: Float64Array; lons: Float64Array; units: Float64Array }

/** (N+1)×(N+1) grid, row-major over iy (b) then ix (a). Grid nodes at tile
 * borders are shared dyadic parameters, so neighbors at the same level get
 * bit-identical unit vectors along shared edges. */
export function tileGrid(t: TileId): TileGrid {
  const n = TILE_QUADS + 1;
  const lats = new Float64Array(n * n);
  const lons = new Float64Array(n * n);
  const units = new Float64Array(3 * n * n);
  for (let row = 0; row < n; row++) {
    const b = param(t.iy, row / TILE_QUADS, t.level);
    for (let col = 0; col < n; col++) {
      const a = param(t.ix, col / TILE_QUADS, t.level);
      const u = faceUnit(t.face, a, b);
      const i = row * n + col;
      const { latDeg, lonDeg } = unitLatLon(u);
      lats[i] = latDeg;
      lons[i] = lonDeg;
      units[3 * i] = u[0];
      units[3 * i + 1] = u[1];
      units[3 * i + 2] = u[2];
    }
  }
  return { lats, lons, units };
}

/** Tile at `level` whose face-square contains unit vector u: pick the face
 * by dominant axis, then locate (a, b) by central projection onto it. */
export function containingTile(u: V3, level: number): TileId {
  const ax = Math.abs(u[0]);
  const ay = Math.abs(u[1]);
  const az = Math.abs(u[2]);
  let face: number;
  if (ax >= ay && ax >= az) face = u[0] >= 0 ? 0 : 1;
  else if (ay >= ax && ay >= az) face = u[1] >= 0 ? 2 : 3;
  else face = u[2] >= 0 ? 4 : 5;
  const f = FACES[face]!;
  const denom = u[0] * f.n[0] + u[1] * f.n[1] + u[2] * f.n[2];
  const a = (u[0] * f.u[0] + u[1] * f.u[1] + u[2] * f.u[2]) / denom;
  const b = (u[0] * f.v[0] + u[1] * f.v[1] + u[2] * f.v[2]) / denom;
  const scale = 1 << level;
  const clampIdx = (p: number) => Math.min(scale - 1, Math.max(0, Math.floor(((p + 1) / 2) * scale)));
  return { face, level, ix: clampIdx(a), iy: clampIdx(b) };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/views/cubeSphere.test.ts 2>&1 | tail -4`. Expected: PASS. If the bit-exact seam test fails, the neighbor-face pairing in the test may not match the FACES table — verify by printing both triples; fix the TEST's face/param choice (the table is the source of truth), never loosen `toBe` to `toBeCloseTo`.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && git add src/views/cubeSphere.ts src/views/cubeSphere.test.ts && git commit -m "feat: cube-sphere quadtree tile addressing"
```

---

### Task 5: `tileTree.ts` — LOD selection, build queue, LRU

**Files:**
- Create: `web/src/views/tileTree.ts`
- Test: `web/src/views/tileTree.test.ts`

**Interfaces:**
- Consumes: `TileId, tileKey, children, parent, tileCenterUnit, tileEdgeLenM, maxLevel` (Task 4).
- Produces:

```ts
export interface TreeConfig { radiusM: number; splitK: number; maxLevelOverride?: number; cacheCap: number }
export interface TreeUpdate { render: TileId[]; build: TileId[]; evict: string[] }
export class TileTree {
  constructor(cfg: TreeConfig);
  /** cameraBf: observer position in body-fixed METERS. */
  update(cameraBf: [number, number, number]): TreeUpdate;
  markBuilt(key: string): void;
  isBuilt(key: string): boolean;
}
```

Semantics (the test encodes these):
- **Desired set**: descend from the 6 roots; split while `level < maxLevel` AND `chordDist(cameraBf, center·R) < splitK · tileEdgeLenM(level)`.
- **Render set**: for each desired tile, itself if built, else its nearest built ancestor; deduped.
- **Build list**: every unbuilt tile on each desired tile's ancestor chain (root → leaf), deduped, ordered coarse-to-fine then near-to-far — coverage improves top-down and the world sharpens progressively.
- **Evict list**: when built count exceeds `cacheCap`, the least-recently-rendered built keys not in the current render set. Rendered keys refresh their recency every update.

- [ ] **Step 1: Write the failing tests** — `web/src/views/tileTree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TileTree, type TreeConfig } from './tileTree';
import { TILE_QUADS, tileEdgeLenM, tileKey } from './cubeSphere';

const R = 6.371e6;
const cfg: TreeConfig = { radiusM: R, splitK: 3, cacheCap: 320 };
const surface = (): [number, number, number] => [R, 0, 0]; // on +X face center

describe('TileTree', () => {
  it('desires deep tiles near the camera and coarse ones far away', () => {
    const tree = new TileTree(cfg);
    const { build } = tree.update(surface());
    const levels = build.map((t) => t.level);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(15); // near-foot leaf
    expect(Math.min(...levels)).toBe(0);                    // far-side root
    // build order is coarse-first
    expect(levels[0]).toBe(0);
    const sorted = [...levels].every((l, i, a) => i === 0 || a[i - 1]! <= l);
    expect(sorted).toBe(true);
  });

  it('renders the nearest built ancestor until children are ready', () => {
    const tree = new TileTree(cfg);
    const first = tree.update(surface());
    expect(first.render.length).toBe(0); // nothing built yet
    // build only the six roots
    for (const t of first.build.filter((t) => t.level === 0)) tree.markBuilt(tileKey(t));
    const second = tree.update(surface());
    expect(second.render.length).toBe(6);
    expect(second.render.every((t) => t.level === 0)).toBe(true);
    // finer builds are still wanted
    expect(second.build.some((t) => t.level > 0)).toBe(true);
  });

  it('renders built leaves directly and drops them from the build list', () => {
    const tree = new TileTree(cfg);
    const { build } = tree.update(surface());
    for (const t of build) tree.markBuilt(tileKey(t));
    const next = tree.update(surface());
    expect(next.build.length).toBe(0);
    const keys = next.render.map(tileKey);
    expect(new Set(keys).size).toBe(keys.length); // deduped
    expect(next.render.length).toBeGreaterThan(6);
  });

  it('evicts least-recently-rendered tiles beyond cacheCap, never active ones', () => {
    const small: TreeConfig = { radiusM: R, splitK: 3, cacheCap: 10 };
    const tree = new TileTree(small);
    const a = tree.update(surface());
    for (const t of a.build) tree.markBuilt(tileKey(t));
    tree.update(surface());
    // walk to the antipode: an entirely different desired set
    const b = tree.update([-R, 0, 0]);
    for (const t of b.build) tree.markBuilt(tileKey(t));
    const c = tree.update([-R, 0, 0]);
    expect(c.evict.length).toBeGreaterThan(0);
    const active = new Set(c.render.map(tileKey));
    for (const k of c.evict) {
      expect(active.has(k)).toBe(false);
      expect(tree.isBuilt(k)).toBe(false); // evict unregisters
    }
  });

  it('respects maxLevelOverride', () => {
    const capped = new TileTree({ radiusM: R, splitK: 3, cacheCap: 320, maxLevelOverride: 4 });
    const { build } = capped.update(surface());
    expect(Math.max(...build.map((t) => t.level))).toBeLessThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/views/tileTree.test.ts 2>&1 | tail -4`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `web/src/views/tileTree.ts`:**

```ts
/** LOD selection + build scheduling + LRU eviction for the terrain quadtree.
 * Pure logic — no three.js, no WASM — so it's unit-testable and the render
 * layer (terrainGlobe) stays a thin shell. */
import {
  TILE_QUADS, children, maxLevel, parent, tileCenterUnit, tileEdgeLenM, tileKey, type TileId,
} from './cubeSphere';

export interface TreeConfig { radiusM: number; splitK: number; maxLevelOverride?: number; cacheCap: number }
export interface TreeUpdate { render: TileId[]; build: TileId[]; evict: string[] }

export class TileTree {
  private readonly cfg: TreeConfig;
  private readonly deepest: number;
  private built = new Map<string, number>(); // key -> last-rendered stamp
  private stamp = 0;

  constructor(cfg: TreeConfig) {
    this.cfg = cfg;
    this.deepest = cfg.maxLevelOverride ?? maxLevel(cfg.radiusM);
  }

  isBuilt(key: string): boolean {
    return this.built.has(key);
  }

  markBuilt(key: string): void {
    if (!this.built.has(key)) this.built.set(key, this.stamp);
  }

  private dist(cameraBf: [number, number, number], t: TileId): number {
    const c = tileCenterUnit(t);
    const R = this.cfg.radiusM;
    const dx = cameraBf[0] - c[0] * R;
    const dy = cameraBf[1] - c[1] * R;
    const dz = cameraBf[2] - c[2] * R;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  update(cameraBf: [number, number, number]): TreeUpdate {
    this.stamp++;
    // 1. desired set: split toward the camera
    const desired: { t: TileId; d: number }[] = [];
    const stack: TileId[] = [];
    for (let f = 0; f < 6; f++) stack.push({ face: f, level: 0, ix: 0, iy: 0 });
    while (stack.length > 0) {
      const t = stack.pop()!;
      const d = this.dist(cameraBf, t);
      if (t.level < this.deepest && d < this.cfg.splitK * tileEdgeLenM(t.level, this.cfg.radiusM)) {
        stack.push(...children(t));
      } else {
        desired.push({ t, d });
      }
    }

    // 2. render set: nearest built ancestor per desired tile (deduped);
    //    3. build list: every unbuilt ancestor-chain tile, coarse-first.
    const render = new Map<string, TileId>();
    const wanted = new Map<string, { t: TileId; d: number }>();
    for (const { t, d } of desired) {
      let cur: TileId | null = t;
      const chain: TileId[] = [];
      let shown: TileId | null = null;
      while (cur) {
        const k = tileKey(cur);
        if (this.built.has(k)) { shown = cur; break; }
        chain.push(cur);
        cur = parent(cur);
      }
      if (shown) {
        const k = tileKey(shown);
        render.set(k, shown);
        this.built.set(k, this.stamp);
      }
      for (const c of chain) {
        const k = tileKey(c);
        const prev = wanted.get(k);
        if (!prev || d < prev.d) wanted.set(k, { t: c, d });
      }
    }
    const build = [...wanted.values()]
      .sort((a, b) => a.t.level - b.t.level || a.d - b.d)
      .map((w) => w.t);

    // 4. eviction: oldest built keys beyond cap, never currently rendered
    const evict: string[] = [];
    if (this.built.size > this.cfg.cacheCap) {
      const candidates = [...this.built.entries()]
        .filter(([k]) => !render.has(k))
        .sort((a, b) => a[1] - b[1]);
      const excess = this.built.size - this.cfg.cacheCap;
      for (const [k] of candidates.slice(0, excess)) {
        this.built.delete(k);
        evict.push(k);
      }
    }

    return { render: [...render.values()], build, evict };
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/views/tileTree.test.ts 2>&1 | tail -4`. Expected: PASS. Also sanity-check selection size: temporarily `console.log(desired.length)` for the surface camera — expect roughly 40–200 tiles; if it's thousands, the split predicate is wrong (check units: `dist` in meters vs `tileEdgeLenM` in meters). Remove the log before committing.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && git add src/views/tileTree.ts src/views/tileTree.test.ts && git commit -m "feat: quadtree LOD selection with async build queue and LRU eviction"
```

---

### Task 6: `tileMesh.ts` — displaced grid + skirts + vertex colors

**Files:**
- Create: `web/src/views/tileMesh.ts`
- Test: `web/src/views/tileMesh.test.ts`

**Interfaces:**
- Consumes: `TileId, TILE_QUADS, tileGrid, tileCenterUnit, tileEdgeLenM` (Task 4); `hypsometricColor` from `./terrainTexture` (existing: `(e: number, shade: number, classTint: [number,number,number], dead: boolean) => [number,number,number]`, `e` in RELATIVE units).
- Produces:

```ts
export interface TileMeshInputs {
  radiusM: number;
  reliefM: number;               // meters-per-relative-unit (TerrainInfo.relief_m)
  classTint: [number, number, number];
  dead: boolean;
}
export interface TileMeshData {
  positions: Float32Array;  // xyz per vertex, relative to originBf
  colors: Float32Array;     // rgb 0..1 per vertex
  indices: Uint32Array;
  originBf: [number, number, number]; // f64 meters, body-fixed
}
export function buildTileMesh(t: TileId, elevationsM: Float32Array, inputs: TileMeshInputs): TileMeshData;
```

Layout contract (Task 7 and future CDLOD rely on it): vertices 0..(N+1)²−1 are the uniform grid in `tileGrid` order; skirt vertices ((N+1)² .. (N+1)²+4N+3) copy the border ring, pulled toward the planet center by `0.08 × tileEdgeLenM(level)`; `elevationsM` has exactly (N+1)² entries in `tileGrid` order.

- [ ] **Step 1: Write the failing tests** — `web/src/views/tileMesh.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TILE_QUADS, tileCenterUnit, tileEdgeLenM, type TileId } from './cubeSphere';
import { buildTileMesh, type TileMeshInputs } from './tileMesh';

const R = 6.371e6;
const inputs: TileMeshInputs = { radiusM: R, reliefM: 6000, classTint: [155, 143, 122], dead: false };
const t: TileId = { face: 0, level: 6, ix: 30, iy: 31 };
const n = TILE_QUADS + 1;
const gridCount = n * n;
const skirtCount = 4 * TILE_QUADS + 4;

function flat(elev = 0): Float32Array {
  return new Float32Array(gridCount).fill(elev);
}

describe('buildTileMesh', () => {
  it('emits grid + skirt vertices with matching color entries', () => {
    const m = buildTileMesh(t, flat(), inputs);
    expect(m.positions.length).toBe(3 * (gridCount + skirtCount));
    expect(m.colors.length).toBe(m.positions.length);
  });

  it('grid vertices sit at radius + elevation, relative to the tile origin', () => {
    const m = buildTileMesh(t, flat(1000), inputs);
    const c = tileCenterUnit(t);
    const origin = m.originBf;
    expect(Math.hypot(origin[0] - c[0] * R, origin[1] - c[1] * R, origin[2] - c[2] * R)).toBeLessThan(1);
    // every grid vertex: |origin + pos| ≈ R + 1000
    for (const i of [0, gridCount >> 1, gridCount - 1]) {
      const x = origin[0] + m.positions[3 * i]!;
      const y = origin[1] + m.positions[3 * i + 1]!;
      const z = origin[2] + m.positions[3 * i + 2]!;
      expect(Math.hypot(x, y, z)).toBeCloseTo(R + 1000, 3);
    }
    // relative coords stay small (precision contract): well under tile size
    let maxAbs = 0;
    for (const v of m.positions) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeLessThan(2 * tileEdgeLenM(t.level, R) + 2000);
  });

  it('skirt vertices duplicate the border ring, pulled toward the center', () => {
    const m = buildTileMesh(t, flat(500), inputs);
    const depth = 0.08 * tileEdgeLenM(t.level, R);
    const o = m.originBf;
    const radiusOf = (i: number) =>
      Math.hypot(o[0] + m.positions[3 * i]!, o[1] + m.positions[3 * i + 1]!, o[2] + m.positions[3 * i + 2]!);
    for (const s of [gridCount, gridCount + skirtCount - 1]) {
      expect(radiusOf(s)).toBeCloseTo(R + 500 - depth, 2);
    }
  });

  it('indices reference valid vertices and cover N² quads + 4N skirt quads', () => {
    const m = buildTileMesh(t, flat(), inputs);
    expect(m.indices.length).toBe(6 * (TILE_QUADS * TILE_QUADS + 4 * TILE_QUADS));
    for (const i of m.indices) expect(i).toBeLessThan(gridCount + skirtCount);
  });

  it('colors follow the hypsometric ramp: deep ocean is bluer than peaks are', () => {
    const deep = buildTileMesh(t, flat(-3000), inputs);
    const peak = buildTileMesh(t, flat(5000), inputs);
    expect(deep.colors[2]!).toBeGreaterThan(deep.colors[0]!);      // blue-dominant
    expect(peak.colors[0]!).toBeGreaterThan(deep.colors[0]!);      // brighter red channel
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/views/tileMesh.test.ts 2>&1 | tail -4`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `web/src/views/tileMesh.ts`:**

```ts
/** Tile geometry: a uniform (N+1)² displaced grid (CDLOD-compatible layout)
 * plus a skirt ring pulled toward the planet center to hide LOD cracks.
 * Positions are relative to the tile's own body-fixed origin so f32 GPU
 * buffers never carry planet-scale magnitudes (no vertex jitter). */
import { TILE_QUADS, tileCenterUnit, tileEdgeLenM, tileGrid, type TileId } from './cubeSphere';
import { hypsometricColor } from './terrainTexture';

export interface TileMeshInputs {
  radiusM: number;
  reliefM: number;
  classTint: [number, number, number];
  dead: boolean;
}

export interface TileMeshData {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  originBf: [number, number, number];
}

export function buildTileMesh(t: TileId, elevationsM: Float32Array, inputs: TileMeshInputs): TileMeshData {
  const n = TILE_QUADS + 1;
  const gridCount = n * n;
  if (elevationsM.length !== gridCount) {
    throw new Error(`tile ${t.face}:${t.level}:${t.ix}:${t.iy}: expected ${gridCount} elevations, got ${elevationsM.length}`);
  }
  const grid = tileGrid(t);
  const c = tileCenterUnit(t);
  const R = inputs.radiusM;
  const originBf: [number, number, number] = [c[0] * R, c[1] * R, c[2] * R];

  // border ring indices, walked in order: bottom row, right col, top row
  // (reversed), left col (reversed) — a closed loop of 4N vertices + 4 corners
  const ring: number[] = [];
  for (let col = 0; col < n; col++) ring.push(col);                         // bottom (row 0)
  for (let row = 1; row < n; row++) ring.push(row * n + (n - 1));           // right
  for (let col = n - 2; col >= 0; col--) ring.push((n - 1) * n + col);      // top
  for (let row = n - 2; row >= 1; row--) ring.push(row * n);                // left
  const skirtCount = ring.length; // 4N + 4 - 4 corners counted once = 4N... (see test: 4N+4 total entries)

  const positions = new Float32Array(3 * (gridCount + skirtCount));
  const colors = new Float32Array(3 * (gridCount + skirtCount));
  const skirtDepth = 0.08 * tileEdgeLenM(t.level, R);

  const writeVertex = (out: number, gi: number, radialOffset: number) => {
    const ux = grid.units[3 * gi]!;
    const uy = grid.units[3 * gi + 1]!;
    const uz = grid.units[3 * gi + 2]!;
    const r = R + elevationsM[gi]! + radialOffset;
    positions[3 * out] = ux * r - originBf[0];
    positions[3 * out + 1] = uy * r - originBf[1];
    positions[3 * out + 2] = uz * r - originBf[2];
    const [cr, cg, cb] = hypsometricColor(elevationsM[gi]! / inputs.reliefM, 1.0, inputs.classTint, inputs.dead);
    colors[3 * out] = cr / 255;
    colors[3 * out + 1] = cg / 255;
    colors[3 * out + 2] = cb / 255;
  };

  for (let i = 0; i < gridCount; i++) writeVertex(i, i, 0);
  ring.forEach((gi, s) => writeVertex(gridCount + s, gi, -skirtDepth));

  // indices: N² grid quads + one quad per skirt edge segment
  const quadCount = TILE_QUADS * TILE_QUADS + ring.length;
  const indices = new Uint32Array(6 * quadCount);
  let o = 0;
  for (let row = 0; row < TILE_QUADS; row++) {
    for (let col = 0; col < TILE_QUADS; col++) {
      const i0 = row * n + col;
      const i1 = i0 + 1;
      const i2 = i0 + n;
      const i3 = i2 + 1;
      indices.set([i0, i2, i1, i1, i2, i3], o);
      o += 6;
    }
  }
  for (let s = 0; s < ring.length; s++) {
    const gi0 = ring[s]!;
    const gi1 = ring[(s + 1) % ring.length]!;
    const s0 = gridCount + s;
    const s1 = gridCount + ((s + 1) % ring.length);
    indices.set([gi0, s0, gi1, gi1, s0, s1], o);
    o += 6;
  }

  return { positions, colors, indices, originBf };
}
```

**Ring-count check while implementing:** the loop above yields `n + (n−1) + (n−1) + (n−2) = 4n − 4 = 4·TILE_QUADS` entries. The test expects `4·TILE_QUADS + 4` — reconcile by INCLUDING all four corners twice is wrong; instead fix the TEST'S `skirtCount` to `4 * TILE_QUADS` and the index expectation to `6 * (TILE_QUADS² + 4 * TILE_QUADS)` — the closed ring has exactly 4N segments and 4N vertices. (This note exists because off-by-a-corner is THE classic skirt bug: derive the count from the loop you actually wrote and make test + code agree before moving on.)

- [ ] **Step 4: Run tests** — `npx vitest run src/views/tileMesh.test.ts 2>&1 | tail -4`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit && git add src/views/tileMesh.ts src/views/tileMesh.test.ts && git commit -m "feat: tile mesh builder — displaced grid, skirts, hypsometric vertex colors"
```

---

### Task 7: `terrainGlobe.ts` + ground-view/two-pass integration

**Files:**
- Create: `web/src/views/terrainGlobe.ts`
- Test: `web/src/views/terrainGlobe.test.ts`
- Modify: `web/src/views/ground.ts`
- Modify: `web/src/main.ts`
- Modify: `web/src/views/ground.test.ts`

**Interfaces:**
- Consumes: `Sim.bodyElevations/bodyElevation/bodyTerrainInfo` (Task 3), `TileTree` (Task 5), `buildTileMesh` (Task 6), `tileGrid/tileKey` (Task 4), `bodyLayout/bodyRadiusM` (`../sim/layout`), `PALETTE` pattern from ground.ts.
- Produces:

```ts
export interface TerrainGlobe {
  scene: THREE.Scene;
  /** latDeg/lonDeg/eyeAltM: observer geo position (eye altitude above the
   *  ellipsoid-less sphere, i.e. terrain_m + eye height). buildBudget: max
   *  tiles to build this frame. */
  update(latDeg: number, lonDeg: number, eyeAltM: number, suns: SunSpec[], buildBudget?: number): void;
  stats(): { built: number; pendingBuilds: number };
}
export function buildTerrainGlobe(sim: Sim, bodyIndex: number): TerrainGlobe | null; // null = no terrain body
```

Ownership: the ground scene is built ONCE at boot but the standing body changes at runtime (stand-here on another body), so **`main.ts` owns the globe** — it calls `buildTerrainGlobe(sim, body)` on every ground entry / standing-body change and disposes the old one. `ground.ts` only gains `setDiscVisible(v: boolean)` (the flat disc is the fallback when the globe is null) and `update` returns the `SunSpec[]` it computed so the terrain pass can reuse them. `main.ts` renders sky scene → `renderer.clearDepth()` → terrain scene, converts walking to meters, and sets the camera eye from `sim.bodyElevation`.

- [ ] **Step 1: Write the failing tests** — `web/src/views/terrainGlobe.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { buildTerrainGlobe } from './terrainGlobe';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

function fakeSim(): Sim {
  const n = bodyLayout(golden).length;
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: n,
    statesAt: () => new Float64Array(n * 7),
    orbitPath: () => new Float64Array(0),
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: () => new Float64Array(3),
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: (i) => (i === 0 ? null : { sea_level: 0, ocean_fraction: 0.5, relief_m: 6000, plate_count: 8 }),
    bodyElevation: () => 250,
    bodyElevations: (_: number, coords: Float64Array) => {
      const out = new Float32Array(coords.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = 100 * Math.sin(coords[2 * i]! * 0.5); // smooth, lat-dependent
      return out;
    },
  };
}

describe('buildTerrainGlobe', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;
  const suns = [{ dirLocal: [0, 0, 1] as [number, number, number], temperatureK: 5800, irradiance: 1 }];

  it('returns null for non-terrain bodies (stars)', () => {
    expect(buildTerrainGlobe(fakeSim(), 0)).toBeNull();
  });

  it('builds tiles over successive updates and renders them', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    expect(g).not.toBeNull();
    for (let f = 0; f < 40; f++) g.update(15, 30, 252, suns, 8);
    const s = g.stats();
    expect(s.built).toBeGreaterThan(20);
    let visibleMeshes = 0;
    g.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh && o.visible) visibleMeshes++; });
    expect(visibleMeshes).toBeGreaterThan(5);
  });

  it('keeps rendered tile positions camera-relative (no planet-scale magnitudes)', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 252, suns, 8);
    // the nearest visible tile must sit within ~2 tile-lengths of the origin
    let nearest = Infinity;
    g.scene.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh && o.visible) nearest = Math.min(nearest, o.position.length());
    });
    expect(nearest).toBeLessThan(50_000);
    expect(nearest).toBeGreaterThan(0);
  });

  it('has sun lights that fade below the horizon (ground darkens at night)', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    const intensityTotal = () => {
      let total = 0;
      g.scene.traverse((o) => {
        const l = o as { isDirectionalLight?: boolean; intensity?: number };
        if (l.isDirectionalLight) total += l.intensity ?? 0;
      });
      return total;
    };
    g.update(15, 30, 252, [{ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }]);
    const day = intensityTotal();
    g.update(15, 30, 252, [{ dirLocal: [0, 0, -0.5], temperatureK: 5800, irradiance: 1 }]);
    const night = intensityTotal();
    expect(day).toBeGreaterThan(0.5);
    expect(night).toBe(0);
  });
});
```

And modify `web/src/views/ground.test.ts`: extend `fakeSim` with `bodyTerrainInfo` returning `{ sea_level: 0, ocean_fraction: 0.4, relief_m: 6000, plate_count: 8 }` for non-star bodies (Task 3 already added `bodyElevation`/`bodyElevations`), and add:

```ts
  it('setDiscVisible hides the fallback disc (terrain pass replaces it)', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const disc = g.scene.getObjectByName('ground-disc')!;
    expect(disc.visible).toBe(true);
    g.setDiscVisible(false);
    expect(disc.visible).toBe(false);
  });

  it('update returns the suns it computed for the terrain pass', () => {
    const sim = fakeSim();
    const g = buildGroundScene(sim);
    const suns = g.update(sim.statesAt(0), { body: anchorBody, latDeg: 0, lonDeg: 180 });
    expect(Array.isArray(suns)).toBe(true);
    expect(suns.length).toBeGreaterThanOrEqual(1);
    expect(suns[0]!.irradiance).toBe(1); // normalized, brightest first
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/views/terrainGlobe.test.ts src/views/ground.test.ts 2>&1 | tail -6`. Expected: FAIL (module not found / disc assertions).

- [ ] **Step 3: Implement `web/src/views/terrainGlobe.ts`:**

```ts
/** three.js orchestrator for the quadtree terrain: owns the terrain scene,
 * drains the build queue against the WASM elevation API, and re-anchors
 * tiles camera-relative each frame (rendering-relative-to-eye).
 *
 * Frame conventions: the scene is the observer's ENU frame (x=east,
 * y=north, z=up — identical to the sky scene), so one camera drives both
 * passes. Terrain lives in BODY-FIXED coordinates (elevation is a function
 * of lat/lon only), and ENU axes expressed body-fixed depend only on
 * lat/lon — the body's rotation never enters: east = pole×up normalized,
 * north = up×east. */
import * as THREE from 'three';
import { bodyLayout, bodyRadiusM } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import type { SunSpec } from './sky';
import { tileGrid, tileKey, type TileId } from './cubeSphere';
import { TileTree } from './tileTree';
import { buildTileMesh } from './tileMesh';

export interface TerrainGlobe {
  scene: THREE.Scene;
  update(latDeg: number, lonDeg: number, eyeAltM: number, suns: SunSpec[], buildBudget?: number): void;
  stats(): { built: number; pendingBuilds: number };
}

const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
const MOON_TINT = 0x8a8f98;

export function buildTerrainGlobe(sim: Sim, bodyIndex: number): TerrainGlobe | null {
  const info = sim.bodyTerrainInfo(bodyIndex);
  if (!info) return null;
  const desc = sim.descriptor;
  const layout = bodyLayout(desc);
  const ref = layout[bodyIndex]!;
  if (ref.kind === 'star') return null;
  const radiusM = bodyRadiusM(desc, ref);
  const classHex = ref.kind === 'planet' ? PALETTE[desc.planets[ref.planet]!.class] : MOON_TINT;
  const classTint: [number, number, number] = [(classHex >> 16) & 255, (classHex >> 8) & 255, classHex & 255];
  const dead = ref.kind === 'planet' && desc.planets[ref.planet]!.world_state.kind === 'Dead';

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x334455, 0.3));
  const sunLights = [new THREE.DirectionalLight(0xffffff, 0), new THREE.DirectionalLight(0xffffff, 0)];
  sunLights.forEach((l) => scene.add(l));

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0 });
  // splitK 1.7 keeps the steady-state active set near ~100-200 tiles
  // (~1-1.6 M triangles); splitK 3 would triple that. cacheCap must
  // comfortably exceed the active set or the cache thrashes.
  const tree = new TileTree({ radiusM, splitK: 1.7, cacheCap: 480 });
  const meshes = new Map<string, THREE.Mesh>();
  let pendingBuilds = 0;

  function buildTile(t: TileId): void {
    const grid = tileGrid(t);
    const n = grid.lats.length;
    const coords = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      coords[2 * i] = grid.lats[i]!;
      coords[2 * i + 1] = grid.lons[i]!;
    }
    const elevs = sim.bodyElevations(bodyIndex, coords);
    if (elevs.length !== n) return; // non-terrain body (shouldn't happen here)
    const data = buildTileMesh(t, elevs, { radiusM, reliefM: info!.relief_m, classTint, dead });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.originBf = data.originBf;
    mesh.visible = false;
    mesh.frustumCulled = false; // tiles are selected CPU-side; sphere-scale bounds confuse three's culler
    scene.add(mesh);
    meshes.set(tileKey(t), mesh);
    tree.markBuilt(tileKey(t));
  }

  function update(latDeg: number, lonDeg: number, eyeAltM: number, suns: SunSpec[], buildBudget = 2): void {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const up: [number, number, number] = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    // ENU in body-fixed: east = ẑ×up (normalized), north = up×east
    const el = Math.hypot(-up[1], up[0]);
    const east: [number, number, number] = el < 1e-9 ? [1, 0, 0] : [-up[1] / el, up[0] / el, 0];
    const north: [number, number, number] = [
      up[1] * east[2] - up[2] * east[1],
      up[2] * east[0] - up[0] * east[2],
      up[0] * east[1] - up[1] * east[0],
    ];
    const camR = radiusM + eyeAltM;
    const camBf: [number, number, number] = [up[0] * camR, up[1] * camR, up[2] * camR];

    const { render, build, evict } = tree.update(camBf);

    for (const key of evict) {
      const m = meshes.get(key);
      if (m) {
        m.geometry.dispose();
        scene.remove(m);
        meshes.delete(key);
      }
    }
    for (const t of build.slice(0, buildBudget)) buildTile(t);
    pendingBuilds = Math.max(0, build.length - buildBudget);

    // body-fixed -> ENU rotation (rows east/north/up), applied scene-wide
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...east),
      new THREE.Vector3(...north),
      new THREE.Vector3(...up),
    ).transpose();
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);

    const active = new Set(render.map(tileKey));
    for (const [key, mesh] of meshes) {
      const on = active.has(key);
      mesh.visible = on;
      if (!on) continue;
      const o = mesh.userData.originBf as [number, number, number];
      // f64 subtraction BEFORE the f32 assignment: this is the RTC step
      mesh.position.set(o[0] - camBf[0], o[1] - camBf[1], o[2] - camBf[2]);
      mesh.quaternion.copy(q);
      mesh.position.applyQuaternion(q);
    }

    // sun lights: same directions as the sky pass, but terrain lighting
    // fades across the horizon (the ground darkens at night; sky BODIES
    // stay sunlit — that fix lives in ground.ts and stays there)
    sunLights.forEach((l, i) => {
      const s = suns[i];
      if (s) {
        const fade = THREE.MathUtils.smoothstep(s.dirLocal[2], -0.12, 0.06);
        l.intensity = 2.0 * s.irradiance * fade;
        l.position.set(s.dirLocal[0] * 100, s.dirLocal[1] * 100, s.dirLocal[2] * 100);
      } else {
        l.intensity = 0;
      }
    });
  }

  return { scene, update, stats: () => ({ built: meshes.size, pendingBuilds }) };
}
```

- [ ] **Step 4: Integrate in `ground.ts`** (signature stays `buildGroundScene(sim)`):

```ts
// GroundView interface changes:
  setDiscVisible(v: boolean): void;
  update(states: Float64Array, standing: Standing): SunSpec[]; // was void

// implementation: keep the disc exactly as-is, add after its creation:
  function setDiscVisible(v: boolean): void {
    ground.visible = v;
  }
// update(): add `return suns;` as its last line (after the ground tint).
// return { ..., setDiscVisible } from buildGroundScene.
```

Export `SunSpec` from `./sky` is already available (`import type { SunSpec } from './sky'`). The sky-body meshes/labels/dome/phase-light logic is untouched.

- [ ] **Step 5: Integrate in `main.ts`:**

1. Renderer: `new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })`.
2. Ground camera far plane: wherever `groundCamera` is constructed, set `far` to `5e7` and `near` to `0.3` (log depth makes this precision-safe; the space camera is untouched).
3. Globe ownership + render loop. Module-level state near the ground/space view state:

```ts
let terrainGlobe: TerrainGlobe | null = null;
function setStandingGlobe(body: number | null): void {
  terrainGlobe = body !== null ? buildTerrainGlobe(sim, body) : null;
  ground.setDiscVisible(terrainGlobe === null);
}
```

Call `setStandingGlobe(current.body)` in `enterGround` and wherever stand-here changes the standing body; call `setStandingGlobe(null)` in `exitGround`. Render loop's ground branch becomes:

```ts
      renderer.autoClear = false;
      renderer.clear();
      const suns = ground.update(states, standing);
      renderer.render(ground.scene, groundCamera);
      if (terrainGlobe) {
        const eyeAlt = (currentElevationM ?? 0) + 1.7;
        terrainGlobe.update(current.lat ?? 0, current.lon ?? 0, eyeAlt, suns, 2);
        renderer.clearDepth();
        renderer.render(terrainGlobe.scene, groundCamera);
      }
      labelRenderer.render(ground.scene, groundCamera);
```

(Adapt to the loop's actual variable names — it already calls `ground.update(...)`; capture its new return value instead of calling it twice.) `currentElevationM` is refreshed whenever standing lat/lon changes (walking, stand-here, enterGround):

```ts
let currentElevationM: number | null = null;
function refreshElevation(): void {
  currentElevationM =
    current.body !== null && current.lat !== null && current.lon !== null
      ? sim.bodyElevation(current.body, current.lat, current.lon)
      : null;
}
```

Call `refreshElevation()` after every `stepLatLon` application, in `enterGround`, and after stand-here sets lat/lon.

4. Walking in meters — replace the `WALK_DEG_PER_S` constant and step computation:

```ts
const WALK_M_PER_S = 1.4;
// in the walk branch (body radius of the stood-on body):
const rM = bodyRadiusM(sim.descriptor, bodyLayout(sim.descriptor)[current.body!]!);
const degPerMeter = 180 / (Math.PI * rM);
const step = WALK_M_PER_S * speedMult * dt * degPerMeter;
```

(Import `bodyRadiusM` if main.ts doesn't already; `speedMult` shift ×5 handling is unchanged. On a 6,400 km body this is ~1.2e-5 °/s — the old constant was sized for visible motion on a flat disc, so double-check walking still visibly moves by watching the compass lat/lon readout tick in QA; the terrain right underfoot is what makes small true-scale steps legible now.)

- [ ] **Step 6: Run all web tests** — `npx vitest run 2>&1 | tail -6`; fix fallout (ground.test.ts signature changes, `update` return type). Expected: all pass.

- [ ] **Step 7: Typecheck + full suites + commit**

```bash
npx tsc --noEmit && cd .. && cargo test --locked 2>&1 | tail -4
git add web/src && git commit -m "feat: quadtree terrain globe rendered as a second pass; walking rides the terrain"
```

---

### Task 8: Live smoke QA + ship

(Controller-level, not a subagent dispatch: final whole-branch review per subagent-driven-development, then merge from the PRIMARY repo — never from inside the worktree — push, wait for deploy, then Playwright QA on the live site: seed 42 anchor coastline, seed 3630539713810705175 IVa horizon; screenshots reviewed by eye. Ground.terrain build hitches, walking legibility, and label behavior are the known risks to look at.)

---

## Self-Review Notes (already applied)

- Spec coverage: micro-detail (T1), goldens+parity (T2), WASM batch (T3), addressing (T4), LOD/LRU (T5), skirts/colors/RTC (T6), two-pass + lights fade + meters walking + eye height (T7). Water/fog/sky-altitude/flight/HUD are **Plan 2b** (spec's movement & atmosphere sections) — deliberately absent here.
- Type consistency: `TileId/TreeUpdate/TileMeshData/TerrainGlobe` signatures repeated verbatim in each consuming task's Interfaces block.
- Known reconciliation points called out inline: skirt ring count (T6 Step 3 note), seam-test face pairing (T4 Step 4), `World::new` constructor form (T3 Step 1).
