# Goldengrove v3 Plan 1 — Climate & Biomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic climate (temperature + moisture) from each system's real physics, classified into 13 biomes that color both the orrery textures and the ground-view terrain.

**Architecture:** New `gg-climate` crate: exact per-point temperature (stellar flux, tilt-shaped latitude insolation, lapse on fine elevation), a once-per-body 128×64 moisture grid (Hadley bands × rain shadow × continentality, all from the existing elevation field), and a pure classification table with Doomed/Dead/airless rules. gg-wasm exposes grid + batched lookups; TS gets one shared palette module feeding both the orrery texture path and ground tile vertex colors.

**Tech Stack:** Rust (new crate gg-climate; gg-wasm), TypeScript + vitest.

## Global Constraints

- **ZERO new RNG draws** — climate is a pure function of descriptor facts + the elevation field. `git diff` on ALL existing goldens (descriptor, terrain-seed-*, terrain-fine-seed-*) must be empty at every commit.
- All transcendentals via `gg_core::math` (libm); `f64::powi/sqrt/floor/round` allowed; wasm32 canonical; new biome goldens pinned natively AND under wasm32.
- Biome enum order is a determinism surface (goldens hash the u8 indices) — pinned in Task 3; never reorder.
- Physical constants pinned: Bond albedo 0.3; σ = 5.670374419e-8; greenhouse ΔT = 30 K × atmosphere density; lapse 6.5 K/km; latitude shape `f(φ) = cos(clamp(|φ| − 0.4·tilt, 0, π/2))`, `T(φ) = t_mean + 20 − 55·(1 − f(φ))`; Hadley `m_lat = 0.55 + 0.45·cos(6·φ_eff)` with `φ_eff = φ · 30/(22 + 8·min(1, tilt/0.4084))` (0.4084 rad = 23.4°); rain shadow 8 upwind samples × 150 km, easterly wind below 30° |lat| else westerly, `shadow = clamp(1 − Σmax(0, e_up − e_here)/(8·2500), 0.25, 1)` (elevations in meters); continentality: 16-point ring at 500 km, `cont = 0.45 + 0.55·oceanFrac`; `M = clamp(m_lat·shadow·cont, 0, 1)`.
- Atmosphere density (Rust) mirrors `web/src/sim/layout.ts::atmosphereDensityFor`: moons 0.05; rocky planets Dead 0.05 else 1.0. Vegetative classes require density ≥ 1.0 (airless worlds get deserts/ice/tundra only).
- Moons: stellar flux at the PARENT planet's `orbit.semi_major_axis_m`; tilt = parent planet's `axial_tilt_rad`. Multi-star: sum `L_i/(4π a²)` over all stars at the same a (host-origin approximation).
- Gates per commit: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --locked`; web tasks add `cd web && npx vitest run` + `npx tsc --noEmit` (Node 22 via `source ~/.nvm/nvm.sh && nvm use 22`).

## File Structure

```
crates/gg-climate/Cargo.toml, src/lib.rs      (create: ClimateSpec, model, classification)
crates/gg-climate/tests/climate.rs            (create)
crates/gg-climate/examples/biome_hashes.rs    (create: golden bootstrap)
crates/gg-climate/tests/golden/biome-seed-{1,42,123456789}.json (generated)
crates/gg-wasm/Cargo.toml, src/lib.rs         (modify: climate cache + 3 methods)
crates/gg-wasm/tests/wasm_golden.rs           (modify: biome parity)
web/src/sim/wasm.ts                           (modify: Sim.bodyBiomeGrid/bodyBiomes/bodyClimateInfo)
web/src/views/biomePalette.ts                 (create: THE shared 13-color table) + test
web/src/views/terrainTexture.ts               (modify: biome texture path) + test
web/src/views/terrainCache.ts                 (modify: pass biome grid to texture)
web/src/views/tileMesh.ts / terrainGlobe.ts   (modify: biome vertex colors) + tests
```

Workspace: add `gg-climate` to the root `Cargo.toml` members and as a dependency of `gg-wasm`.

---

### Task 1: gg-climate crate — temperature model

**Files:** Create `crates/gg-climate/Cargo.toml`, `crates/gg-climate/src/lib.rs`, `crates/gg-climate/tests/climate.rs`; modify root `Cargo.toml` (workspace member).

**Interfaces (produced):**

```rust
pub struct ClimateFacts { /* private fields */ }
/// None for stars/giants (same qualification rule as gg-terrain's body_facts:
/// rocky planets and all moons qualify) AND for Dead worlds — Dead worlds
/// have no climate (spec).
pub fn climate_facts(desc: &SystemDescriptor, body_index: usize) -> Option<ClimateFacts>;
/// Annual-mean surface temperature in K at a point, lapse-adjusted.
pub fn temperature_k(facts: &ClimateFacts, lat_deg: f64, elevation_m: f64) -> f64;
```

`ClimateFacts` carries: `t_mean_k` (from flux: `t_eq = (S(1−0.3)/(4σ))^0.25` + 30·atm_density), `tilt_rad`, `atm_density`, `doomed: bool`, `radius_m`. Cargo.toml mirrors gg-terrain's (deps gg-core, gg-gen, serde).

- [ ] **Step 1: Failing tests** — `crates/gg-climate/tests/climate.rs`:

```rust
use gg_climate::{climate_facts, temperature_k};
use gg_gen::generate;

fn anchor(seed: u64) -> (gg_gen::descriptor::SystemDescriptor, usize) {
    let desc = generate(seed);
    let idx = desc.stars.len() + desc.anchor_planet;
    (desc, idx)
}

#[test]
fn anchor_world_is_habitable_range() {
    // The anchor is guaranteed in/near the HZ: its mean-latitude sea-level
    // temperature must be broadly habitable, not venusian or cryogenic.
    for seed in [1u64, 42, 123_456_789] {
        let (desc, idx) = anchor(seed);
        let f = climate_facts(&desc, idx).expect("anchor has climate");
        let t = temperature_k(&f, 45.0, 0.0);
        assert!((210.0..340.0).contains(&t), "seed {seed}: T45 = {t}");
    }
}

#[test]
fn equator_hotter_than_poles_and_lapse_cools() {
    let (desc, idx) = anchor(42);
    let f = climate_facts(&desc, idx).unwrap();
    assert!(temperature_k(&f, 0.0, 0.0) > temperature_k(&f, 80.0, 0.0) + 15.0);
    assert!(temperature_k(&f, 10.0, 0.0) > temperature_k(&f, 10.0, 4000.0) + 20.0);
}

#[test]
fn stars_giants_and_dead_worlds_have_no_climate() {
    let (desc, _) = anchor(42);
    assert!(climate_facts(&desc, 0).is_none(), "star");
    let total = desc.stars.len() + desc.planets.len()
        + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
    for body in desc.stars.len()..total {
        // every Dead world must yield None; every non-dead terrain body Some
        // (mirror gg-terrain's qualification; read its body_facts for the rule)
        let _ = body; // assertions filled in per the qualification helper below
    }
}
```

Complete the third test concretely: replicate the qualification walk (stars → None; planets: Rocky+non-Dead → Some, Rocky+Dead → None, giants → None; moons of any planet → Some UNLESS... moons have no world state — moons always qualify). Read `crates/gg-terrain/src/lib.rs::body_facts` and `crates/gg-gen/src/descriptor.rs` first; `Planet.state` is the kind-tagged WorldState (`state.kind == "Dead"` on the TS side; Rust matches the enum variant).

- [ ] **Step 2: RED** — `cargo test -p gg-climate --locked 2>&1 | tail -5` (compile failure).
- [ ] **Step 3: Implement** `crates/gg-climate/src/lib.rs`:

```rust
//! Deterministic climate from descriptor facts + the terrain elevation
//! field. ZERO RNG: same seed -> same climate forever, and nothing about
//! existing worlds reshuffles. All transcendentals via gg_core::math.
use gg_core::math;
use gg_gen::descriptor::{SystemDescriptor, WorldState};

const SIGMA: f64 = 5.670_374_419e-8;
const ALBEDO: f64 = 0.3;
const GREENHOUSE_K_PER_DENSITY: f64 = 30.0;
const LAPSE_K_PER_M: f64 = 6.5e-3;

pub struct ClimateFacts {
    t_mean_k: f64,
    tilt_rad: f64,
    atm_density: f64,
    doomed: bool,
    radius_m: f64,
}

pub fn climate_facts(desc: &SystemDescriptor, body_index: usize) -> Option<ClimateFacts> {
    let stars = desc.stars.len();
    if body_index < stars {
        return None;
    }
    // (planet_index, is_moon) resolution in ephemeris body order — mirror
    // gg-terrain's body_facts walk exactly (planets, then moons grouped).
    // Determine: owning planet p, radius_m, atm_density, doomed.
    // Giants (class != Rocky) -> None for planets; moons always resolve.
    // Dead planets -> None. Moons of dead planets still qualify (airless
    // rocks with climate = cold deserts; their vegetation is blocked by
    // atm 0.05 anyway).
    // flux at the owning planet's orbit:
    //   let a = desc.planets[p].orbit.semi_major_axis_m;
    //   let s: f64 = desc.stars.iter().map(|st| st.luminosity_w / (4.0 * core::f64::consts::PI * a * a)).sum();
    //   let t_eq = math::powf(s * (1.0 - ALBEDO) / (4.0 * SIGMA), 0.25);
    //   t_mean = t_eq + GREENHOUSE_K_PER_DENSITY * atm_density;
    // tilt = desc.planets[p].axial_tilt_rad (moons inherit the parent's).
    unimplemented!() // replace with the real walk per the comments above
}

pub fn temperature_k(f: &ClimateFacts, lat_deg: f64, elevation_m: f64) -> f64 {
    let phi = lat_deg.abs().to_radians();
    let shaped = math::cos((phi - 0.4 * f.tilt_rad).clamp(0.0, core::f64::consts::FRAC_PI_2));
    f.t_mean_k + 20.0 - 55.0 * (1.0 - shaped) - LAPSE_K_PER_M * elevation_m.max(0.0)
}
```

The `unimplemented!()` is a scaffolding marker for THIS step only — replace it with the concrete walk before running tests (the comments specify it fully). Accessors for the private fields as needed by later tasks: add `impl ClimateFacts { pub fn doomed(&self) -> bool; pub fn atm_density(&self) -> f64; pub fn tilt_rad(&self) -> f64; pub fn radius_m(&self) -> f64; }`.

- [ ] **Step 4: GREEN** (`cargo test -p gg-climate --locked`), plus the workspace suite (`cargo test --locked` — existing goldens untouched by construction, but run the gate).
- [ ] **Step 5: fmt/clippy/commit** — `"feat: gg-climate crate — flux/tilt/lapse temperature model"`

---

### Task 2: Moisture grid

**Files:** Modify `crates/gg-climate/src/lib.rs`; test `crates/gg-climate/tests/climate.rs`.

**Interfaces (produced):**

```rust
pub struct ClimateSpec { /* facts + moisture grid (128x64 Vec<f32>) */ }
impl ClimateSpec {
    /// Builds the moisture grid from the terrain's elevation field.
    /// None when climate_facts is None.
    pub fn for_body(desc: &SystemDescriptor, body_index: usize, terrain: &gg_terrain::TerrainSpec) -> Option<ClimateSpec>;
    pub fn temperature_k(&self, lat_deg: f64, elevation_m: f64) -> f64; // delegates
    pub fn moisture(&self, lat_deg: f64, lon_deg: f64) -> f64;          // bilinear, lon-wrapped
}
```

(gg-climate gains a gg-terrain dependency here.) Grid construction per Global Constraints: for each of 128×64 pixel centers — `m_lat` (Hadley with tilt-scaled φ_eff), × rain shadow (8 samples at 150 km steps along constant latitude, eastward when |lat| < 30 else westward, elevations via `terrain.elevation_fine(lat, lon)` — wait, USE `terrain.elevation(lat, lon) * relief` for speed? NO — pin: use `terrain.elevation_fine(lat, lon)` for `e_here`/`e_up`; it is meters and already includes relief; 9 calls × 8k cells ≈ 74k samples, fine), × continentality (16-point ring at 500 km great-circle radius: walk bearings k·22.5°, small-angle lat/lon offsets with cos-lat lon scaling and pole clamp ±89°, count `elevation_fine < 0`).

- [ ] **Step 1: Failing tests** (append):

```rust
#[test]
fn moisture_properties() {
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    // bounded
    for lat in [-80.0, -30.0, 0.0, 30.0, 80.0] {
        for lon in [-170.0, -60.0, 0.0, 60.0, 170.0] {
            let m = spec.moisture(lat, lon);
            assert!((0.0..=1.0).contains(&m), "M({lat},{lon}) = {m}");
        }
    }
    // subtropics drier than equator ON AVERAGE (zonal means)
    let zonal = |lat: f64| -> f64 {
        (0..64).map(|i| spec.moisture(lat, -180.0 + (i as f64 + 0.5) * 360.0 / 64.0)).sum::<f64>() / 64.0
    };
    assert!(zonal(0.0) > zonal(27.0), "equator {} vs subtropics {}", zonal(0.0), zonal(27.0));
}

#[test]
fn continentality_ocean_adjacent_wetter() {
    // find, on the anchor's moisture grid latitude 40, the wettest and
    // driest cells and assert the wettest cell's 500km ring is more oceanic
    // than the driest's (structural link between continentality and M).
    // Implement by exposing a #[doc(hidden)] pub fn __ring_ocean_frac for
    // the test, mirroring gg-terrain's __raw_probe pattern.
}
```

Fill the second test concretely using the doc-hidden probe (declare it in lib.rs alongside the grid builder; same pattern as `gg_terrain::__raw_probe`).

- [ ] **Step 2: RED**, **Step 3: implement** per constraints (grid loop, bilinear `moisture()` with lon wrap and lat clamp), **Step 4: GREEN + workspace gate**, **Step 5: fmt/clippy/commit** — `"feat: moisture grid — Hadley bands, rain shadow, continentality"`

---

### Task 3: Biome classification

**Files:** Modify `crates/gg-climate/src/lib.rs`; test `crates/gg-climate/tests/climate.rs`.

**Interfaces (produced — the enum ORDER is a golden surface, never reorder):**

```rust
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Biome {
    DeepOcean = 0, Shelf = 1, Shore = 2, IceCap = 3, Tundra = 4,
    BorealForest = 5, TemperateForest = 6, Grassland = 7, Savanna = 8,
    TropicalRainforest = 9, HotDesert = 10, ColdDesert = 11, AlpineRock = 12,
}
impl ClimateSpec {
    pub fn biome(&self, terrain: &gg_terrain::TerrainSpec, lat_deg: f64, lon_deg: f64) -> Biome;
    pub fn biome_grid(&self, terrain: &gg_terrain::TerrainSpec, w: usize, h: usize) -> Vec<u8>; // pixel centers like heightmap()
    pub fn info(&self) -> ClimateInfo; // { mean_temp_k: f64, ice_fraction: f64 } serde-Serialize
}
pub fn biome_hash(grid: &[u8]) -> u64; // FNV-1a-64 over the raw bytes
```

Classification (T = lapse-adjusted `temperature_k(lat, elevation_fine)`, M = `moisture(lat, lon)`, e = `elevation_fine(lat, lon)` meters):

```
e < -400            -> DeepOcean
e < 0               -> Shelf
e < 15              -> Shore
T < 250             -> IceCap
T < 265             -> if e > 2500 { AlpineRock } else { Tundra }
T < 280             -> if M >= 0.45 { BorealForest } else if M >= 0.25 { Grassland } else { ColdDesert }
T < 293             -> if M >= 0.55 { TemperateForest } else if M >= 0.30 { Grassland }
                       else if T < 286 { ColdDesert } else { HotDesert }
else                -> if M >= 0.60 { TropicalRainforest } else if M >= 0.35 { Savanna } else { HotDesert }
```

Post-rules, in order: (1) **airless** (`atm_density < 1.0`): vegetative classes (Boreal/Temperate/Tropical/Grassland/Savanna) → ColdDesert when T < 286 else HotDesert; (2) **doomed**: one-step-arid map — TropicalRainforest→Savanna, Savanna→HotDesert, TemperateForest→Grassland, BorealForest→Grassland, Grassland→ColdDesert (oceans/Shore/IceCap/Tundra/deserts/AlpineRock unchanged).
`ice_fraction` = fraction of a 128×64 biome grid that is IceCap.

- [ ] **Step 1: Failing tests** (append; the anchor-spans test is the calibration guard):

```rust
#[test]
fn biome_grid_valid_and_anchor_spans_climates() {
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    let grid = spec.biome_grid(&terrain, 128, 64);
    assert!(grid.iter().all(|&b| b <= 12));
    let has = |v: u8| grid.iter().any(|&b| b == v);
    assert!(has(0) || has(1), "some ocean");
    assert!(has(3), "polar/alpine ice");
    // a living HZ world should have SOME vegetation
    assert!((5..=9).any(|v| has(v)), "vegetative biome present");
}

#[test]
fn airless_moons_grow_nothing() {
    let (desc, _) = anchor(42);
    let stars = desc.stars.len();
    let first_moon = stars + desc.planets.len();
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, first_moon).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, first_moon, &terrain).unwrap();
    let grid = spec.biome_grid(&terrain, 64, 32);
    assert!(grid.iter().all(|&b| !(5..=9).contains(&b)), "vegetation on an airless moon");
}

#[test]
fn doomed_bias_shifts_some_cells_arid() {
    // find a Doomed rocky planet across the three golden seeds (walk the
    // descriptors); build its spec; rebuild a Living-state twin by
    // classifying with doomed=false via a #[doc(hidden)] probe; assert the
    // two grids differ on >0 cells and the doomed one never has MORE
    // vegetative cells.
}
```

Fill the doomed test concretely with a `#[doc(hidden)] pub fn __classify_raw(...)` probe (T, M, e, atm, doomed as scalars → Biome) — which also directly unit-tests the table: add exact-threshold cases (`__classify_raw(292.9, 0.55, 100.0, 1.0, false) == TemperateForest`, etc. — pin 6 boundary cases from the table).

- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN + workspace gate**, **Step 5: fmt/clippy/commit** — `"feat: 13-biome classification with airless and doomed rules"`

---

### Task 4: Biome goldens + WASM boundary

**Files:** Create `crates/gg-climate/examples/biome_hashes.rs`, golden JSONs; modify `crates/gg-climate/tests/climate.rs`, `crates/gg-wasm/Cargo.toml`, `crates/gg-wasm/src/lib.rs`, `crates/gg-wasm/tests/wasm_golden.rs`, `web/src/sim/wasm.ts`, plus fakeSim stubs in existing web tests as tsc demands.

**Interfaces (produced):**
- Rust golden: `golden_biome_hashes_are_pinned` mirroring the terrain golden test byte-for-byte in mechanism (path `tests/golden/biome-seed-{seed}.json`, `body_N` → hex map, 256×128 grid via `biome_hash`, bootstrap example `biome_hashes`).
- gg-wasm: private `climate: RefCell<HashMap<usize, Option<gg_climate::ClimateSpec>>>` + `with_climate` helper that first ensures the terrain entry exists (both RefCells borrowed sequentially, never nested mutable borrows of the same cell), then:

```rust
pub fn body_biome_grid(&self, body_index: usize, w: usize, h: usize) -> js_sys::Uint8Array;   // empty when no climate
pub fn body_biomes(&self, body_index: usize, coords: &[f64]) -> js_sys::Uint8Array;           // batched [lat,lon,...]; empty when no climate
pub fn body_climate_info(&self, body_index: usize) -> Result<String, JsError>;
```

`body_biomes` maps pairs through `spec.biome(terrain, lat, lon) as u8`.
- TS `Sim`: `bodyBiomeGrid(bodyIndex, w, h): Uint8Array` (length 0 = no climate); `bodyBiomes(bodyIndex, coords: Float64Array): Uint8Array`; `bodyClimateInfo(bodyIndex): { mean_temp_k: number; ice_fraction: number } | null` (try/catch null).
- wasm parity test: reproduce the 256×128 grid hash for the golden seeds against the same JSONs (copy the terrain-parity mechanism), plus a boundary test (star → empty; anchor scalar/batch agreement on a few coords).

Steps: golden test RED (missing file panic names the bootstrap command) → example → generate 3 files → GREEN → wasm methods TDD via the boundary test → parity → TS wrapper + fakeSim stubs (`bodyBiomeGrid: () => new Uint8Array(0)`, `bodyBiomes: (_, c) => new Uint8Array(c.length / 2)`, `bodyClimateInfo: () => null` — and for climate-bearing fixtures return class 7 fills) → full gates both sides → commit `"feat: biome goldens + climate across the WASM boundary"`.

---

### Task 5: Shared palette + orrery biome textures

**Files:** Create `web/src/views/biomePalette.ts` + `biomePalette.test.ts`; modify `web/src/views/terrainTexture.ts`, `web/src/views/terrainCache.ts`; tests in `terrainTexture.test.ts`.

**Interfaces (produced):**

```ts
// biomePalette.ts — THE single source of truth for biome colors.
export const BIOME_COUNT = 13;
export const BIOME_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [12, 42, 82],    // 0 DeepOcean
  [42, 92, 138],   // 1 Shelf
  [207, 192, 154], // 2 Shore
  [238, 243, 246], // 3 IceCap
  [154, 160, 140], // 4 Tundra
  [63, 95, 66],    // 5 BorealForest
  [79, 122, 69],   // 6 TemperateForest
  [154, 168, 94],  // 7 Grassland
  [185, 164, 95],  // 8 Savanna
  [47, 107, 60],   // 9 TropicalRainforest
  [217, 181, 120], // 10 HotDesert
  [179, 165, 142], // 11 ColdDesert
  [141, 133, 120], // 12 AlpineRock
];
export function biomeColor(classIndex: number, shade: number): [number, number, number]; // clamps index, applies shade like hypsometricColor's shade factor
```

`terrainTexture.ts` gains `biomeTexture(biomes: Uint8Array, elevations: Float32Array, w, h): THREE.CanvasTexture | null` — per pixel: `biomeColor(class, slopeShade(elevations,...))` (reuse the existing `slopeShade`). `terrainCache.ts`'s `getTerrainTexture` requests `sim.bodyBiomeGrid(i, 512, 256)` alongside the heightmap: non-empty → `biomeTexture`; empty (dead/giant) → existing hypsometric path unchanged.

Tests: palette length/count parity; `biomeColor` clamps out-of-range to AlpineRock-grey (index 12) — pinned defensive rule; biomeTexture returns null without canvas (jsdom) exactly like terrainTexture (so cache falls through — assert `getTerrainTexture` still returns null in tests, no crash with a non-empty grid). TDD, full web gates, commit `"feat: biome-colored orrery textures from the shared palette"`.

---

### Task 6: Ground tiles in biome colors

**Files:** Modify `web/src/views/tileMesh.ts`, `web/src/views/terrainGlobe.ts`; tests in both test files.

**Interfaces:** `TileMeshInputs` gains `biomes: Uint8Array | null` (null → existing hypsometric colors — the dead-world path). When present, vertex color = `biomeColor(biomes[gi], 1.0)` /255 (elevation shading stays with the scene lights; skirt vertices copy their source color as positions already do). `terrainGlobe.buildTile` makes the second batched call `sim.bodyBiomes(bodyIndex, coords)` (same coords buffer) and passes it through — empty result → null. Water tiles pass null.

Tests: tile with a biome array → vertex colors match palette rows (spot-check grass vs desert vertices); empty/null → colors equal the pre-change hypsometric output (regression: reuse an existing expected-color assertion); terrainGlobe passes through (fake sim returning class-7 fill → visible tile's color attribute ≈ grassland RGB). TDD, full gates both sides (`cargo test --locked` too — untouched), commit `"feat: ground terrain wears its biomes"`.

---

### Task 7: Ship + live QA

(Controller-level: final whole-branch review (fork, full-context); merge from PRIMARY; push; SHA-keyed deploy watch; live QA per spec — seed 42 anchor from orbit (banding: caps, tropics), forest↔desert ground transition, doomed world stressed palette, dead world unchanged, IVa cold-desert; screenshots eyeballed; memory + ROADMAP updates.)

## Self-Review Notes (applied)

- Spec coverage: temperature (T1), moisture (T2), classification+doomed/dead/airless (T3), goldens+wasm+parity (T4), palette+orrery (T5), ground tiles (T6), QA (T7). Ice emergent via classification ✓; zero RNG ✓ (no RngStream anywhere in gg-climate).
- Type consistency: `ClimateSpec::for_body(desc, body_index, &TerrainSpec)` (T2) used by T3/T4; `biome(terrain, lat, lon)` threading the TerrainSpec explicitly (no stored references — cache-friendly); `biomes: Uint8Array | null` (T6) named identically in both files; `biomeColor` (T5) consumed in T6.
- Known reconciliation points: descriptor field shapes for the qualification walk (T1 reads gg-terrain's body_facts + descriptor.rs first — the plan's walk comments are normative, the field spellings come from the source); `Star.orbit: Option<OrbitalElements>` is irrelevant to flux (we use the planet's a).
- Deliberate scaffolding: T1 Step 3 contains one `unimplemented!()` with a complete normative comment — replaced within the same step, never committed.
