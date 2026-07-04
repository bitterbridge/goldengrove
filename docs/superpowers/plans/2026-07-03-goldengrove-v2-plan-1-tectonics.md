# Goldengrove v2 — Plan 1: Tectonics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rocky planets and moons get deterministic kinematic-plate terrain, rendered as hypsometric textures in the orrery.

**Architecture:** New pure crate `gg-terrain` computes elevation from `(seed, &SystemDescriptor, body_index)` — spherical-Voronoi plates with Euler-pole motion, boundaries classified by actual relative velocity, hash-noise detail, bisected sea level. No descriptor change; terrain has its own hash goldens. gg-wasm exposes `body_heightmap`/`body_terrain_info`; TS builds slope-shaded hypsometric CanvasTextures consumed by both views' body materials. Spec: `docs/superpowers/specs/2026-07-03-goldengrove-v2-tectonics-design.md`.

**Tech Stack:** existing stack; zero new dependencies (noise is integer-hash value noise — pure arithmetic, cross-platform exact).

## Global Constraints

- **Descriptor untouched**: `SCHEMA_VERSION` stays 2; `git diff --stat crates/gg-gen/tests/golden/` empty after every task; no gg-gen source changes except none at all.
- **Determinism**: all draws via `RngStream::root(seed).child(&format!("terrain-{body_index}"))` in the FIXED order: ocean target → land bias → relief → plates → hotspots. All transcendentals via `gg_core::math` (this plan adds `sin` and `acos` wrappers). Integer hashing uses wrapping ops only (exact everywhere).
- **Heightmap contract**: equirect, row-major, row 0 = lat +90°, col 0 = lon −180°; sample centers at `lat = 90 − (row+0.5)·180/h`, `lon = −180 + (col+0.5)·360/w`; values relative (sea level = 0, `info.relief_m` says what 1.0 means in meters).
- **Terrain goldens**: FNV-1a-64 over the little-endian i16 quantization (`clamp(e, −4, 4)/4·32767`) of each terrain body's 256×128 heightmap, seeds 1/42/123456789 — pinned natively and in the wasm32 parity gate.
- Terrain bodies = Rocky planets + ALL moons (ephemeris body order). Stars/giants: none.
- Every commit: `cargo test --workspace` green, web suites green, no warnings.

## File Structure

```
crates/gg-terrain/
├── Cargo.toml
├── src/lib.rs          # TerrainSpec, for_body, elevation, heightmap, info, heightmap_hash
├── src/sphere.rs       # V3 math, random_unit, geodesic, latlon_to_unit
├── src/plates.rs       # Plate, build_plates, nearest_two, velocity
├── src/noise.rs        # hash3, value_noise, fbm, warped_fbm
├── examples/hashes.rs  # golden bootstrap: prints {body_index: hash} JSON per seed
└── tests/{sphere_plates.rs, noise.rs, terrain.rs}, tests/golden/terrain-seed-*.json
crates/gg-core/src/math.rs      # + sin, acos
crates/gg-wasm/src/lib.rs       # + body_heightmap, body_terrain_info
crates/gg-wasm/tests/wasm_golden.rs  # + terrain hash parity
web/src/views/terrainTexture.ts # hypsometricColor + terrainTexture (pure + canvas)
web/src/views/terrainCache.ts   # lazy per-body texture cache shared by both views
web/src/sim/wasm.ts             # + bodyHeightmap, bodyTerrainInfo
web/src/views/{space,ground}.ts # textured rocky bodies
```

---

### Task 1: gg-terrain scaffold — sphere math + plates

**Files:**
- Modify: `Cargo.toml` (workspace members += `"crates/gg-terrain"`)
- Modify: `crates/gg-core/src/math.rs` (+ `sin`, `acos`)
- Create: `crates/gg-terrain/Cargo.toml`, `src/lib.rs` (module decls only for now), `src/sphere.rs`, `src/plates.rs`
- Test: `crates/gg-terrain/tests/sphere_plates.rs`

**Interfaces:**
- Consumes: `gg_core::{rng::RngStream, math, consts::R_EARTH}`.
- Produces:
  - `math::sin(x) -> f64`, `math::acos(x) -> f64` (libm-backed, generation-path safe).
  - `sphere::V3 = [f64; 3]`; `sphere::{dot, cross, add, sub, scale, norm, normalize}`; `sphere::random_unit(&mut RngStream) -> V3`; `sphere::geodesic(a: V3, b: V3) -> f64` (radians); `sphere::latlon_to_unit(lat_deg: f64, lon_deg: f64) -> V3` (x=meridian, y=ortho, z=pole — the observer.ts planet-fixed convention).
  - `plates::Plate { pub seed_point: V3, pub euler_pole: V3, pub rate: f64, pub continental: bool, pub base_elev: f64 }`
  - `plates::Plates { pub plates: Vec<Plate> }` with `build_plates(rng: &mut RngStream, body_radius_m: f64, land_bias: f64) -> Plates`, `nearest_two(&self, p: V3) -> (usize, usize)` (indices by max dot), `velocity(&self, i: usize, p: V3) -> V3` (= rate·(pole × p)).

- [ ] **Step 1: Write the failing tests**

`crates/gg-terrain/tests/sphere_plates.rs`:

```rust
use gg_core::rng::RngStream;
use gg_terrain::plates::build_plates;
use gg_terrain::sphere::{cross, dot, geodesic, latlon_to_unit, norm, random_unit, sub};

#[test]
fn random_unit_is_unit_and_deterministic() {
    let mut a = RngStream::root(7).child("t");
    let mut b = RngStream::root(7).child("t");
    for _ in 0..50 {
        let u = random_unit(&mut a);
        let v = random_unit(&mut b);
        assert_eq!(u, v);
        assert!((norm(u) - 1.0).abs() < 1e-12);
    }
}

#[test]
fn geodesic_basics() {
    let x = latlon_to_unit(0.0, 0.0);
    let y = latlon_to_unit(0.0, 90.0);
    let np = latlon_to_unit(90.0, 0.0);
    assert!((geodesic(x, x)).abs() < 1e-7);
    assert!((geodesic(x, y) - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    assert!((geodesic(x, np) - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    // lat/lon convention: +lat is +z (pole), lon 90 is +y (ortho)
    assert!((np[2] - 1.0).abs() < 1e-12);
    assert!((y[1] - 1.0).abs() < 1e-12);
}

#[test]
fn plates_cover_realistic_counts_and_types() {
    for seed in 0..100u64 {
        let mut rng = RngStream::root(seed).child("plates-test");
        let p = build_plates(&mut rng, 6.371e6, 0.4);
        assert!((6..=16).contains(&p.plates.len()), "seed {seed}: {}", p.plates.len());
        assert!(p.plates.iter().any(|pl| pl.continental) || p.plates.len() < 8,
            "seed {seed}: no continents at land_bias 0.4 is possible but should be rare");
        for pl in &p.plates {
            assert!((norm(pl.seed_point) - 1.0).abs() < 1e-9);
            assert!((norm(pl.euler_pole) - 1.0).abs() < 1e-9);
            assert!(pl.rate > 0.0);
            if pl.continental { assert!(pl.base_elev > 0.0) } else { assert!(pl.base_elev < 0.0) }
        }
    }
}

#[test]
fn nearest_two_returns_distinct_ordered_plates() {
    let mut rng = RngStream::root(3).child("plates-test");
    let p = build_plates(&mut rng, 6.371e6, 0.4);
    let mut probe = RngStream::root(9).child("probe");
    for _ in 0..500 {
        let x = random_unit(&mut probe);
        let (a, b) = p.nearest_two(x);
        assert_ne!(a, b);
        assert!(geodesic(x, p.plates[a].seed_point) <= geodesic(x, p.plates[b].seed_point) + 1e-12);
    }
}

#[test]
fn velocity_is_tangent_and_scales_with_rate() {
    let mut rng = RngStream::root(4).child("plates-test");
    let p = build_plates(&mut rng, 6.371e6, 0.4);
    let mut probe = RngStream::root(10).child("probe");
    for _ in 0..100 {
        let x = random_unit(&mut probe);
        let v = p.velocity(0, x);
        assert!(dot(v, x).abs() < 1e-9, "velocity must be tangent to the sphere");
        let expected = gg_terrain::sphere::scale(cross(p.plates[0].euler_pole, x), p.plates[0].rate);
        assert!(norm(sub(v, expected)) < 1e-12);
        // relative-velocity antisymmetry (spec): dv(a,b) = -dv(b,a)
        let dv_ab = sub(p.velocity(0, x), p.velocity(1, x));
        let dv_ba = sub(p.velocity(1, x), p.velocity(0, x));
        assert!(norm(sub(dv_ab, gg_terrain::sphere::scale(dv_ba, -1.0))) < 1e-12);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p gg-terrain`
Expected: FAIL to compile — crate doesn't exist.

- [ ] **Step 3: Implement**

Append to `crates/gg-core/src/math.rs`:

```rust
#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

#[inline]
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}
```

Workspace `Cargo.toml`: add `"crates/gg-terrain"` to `members`.

`crates/gg-terrain/Cargo.toml`:

```toml
[package]
name = "gg-terrain"
version = "0.1.0"
edition = "2021"

[dependencies]
gg-core = { path = "../gg-core" }
gg-gen = { path = "../gg-gen" }
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
serde_json = "1"
```

`crates/gg-terrain/src/lib.rs` (for now):

```rust
pub mod plates;
pub mod sphere;
// pub mod noise;   // Task 2
// TerrainSpec lands in Task 3-4
```

`crates/gg-terrain/src/sphere.rs`:

```rust
//! Unit-sphere math in the planet-fixed frame (x = prime meridian,
//! y = ortho, z = pole) — the same lat/lon convention as web observer.ts.

use gg_core::math;
use gg_core::rng::RngStream;

pub type V3 = [f64; 3];

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
pub fn normalize(a: V3) -> V3 {
    scale(a, 1.0 / norm(a))
}

pub fn random_unit(rng: &mut RngStream) -> V3 {
    let z = rng.uniform(-1.0, 1.0);
    let phi = rng.uniform(0.0, std::f64::consts::TAU);
    let s = (1.0 - z * z).max(0.0).sqrt();
    [s * math::cos(phi), s * math::sin(phi), z]
}

/// Great-circle distance in radians.
pub fn geodesic(a: V3, b: V3) -> f64 {
    math::acos(dot(a, b).clamp(-1.0, 1.0))
}

pub fn latlon_to_unit(lat_deg: f64, lon_deg: f64) -> V3 {
    let lat = lat_deg.to_radians();
    let lon = lon_deg.to_radians();
    [
        math::cos(lat) * math::cos(lon),
        math::cos(lat) * math::sin(lon),
        math::sin(lat),
    ]
}
```

`crates/gg-terrain/src/plates.rs`:

```rust
//! Kinematic plates: spherical Voronoi cells, each rotating about its own
//! Euler pole. Boundary character derives from ACTUAL relative motion.

use crate::sphere::{cross, dot, random_unit, scale, V3};
use gg_core::consts::R_EARTH;
use gg_core::rng::RngStream;

pub struct Plate {
    pub seed_point: V3,
    pub euler_pole: V3,
    /// Angular rate, arbitrary kinematic units (relative speeds are what matter).
    pub rate: f64,
    pub continental: bool,
    /// Isostatic base elevation, relative units (continents ride high).
    pub base_elev: f64,
}

pub struct Plates {
    pub plates: Vec<Plate>,
}

pub fn build_plates(rng: &mut RngStream, body_radius_m: f64, land_bias: f64) -> Plates {
    // Larger bodies host more plates (Earth ~15 major+minor; small moons fewer).
    let size = (body_radius_m / R_EARTH).clamp(0.25, 1.5);
    let count = (6.0 + 7.0 * size + rng.uniform(0.0, 3.0)).round() as usize;
    let plates = (0..count)
        .map(|_| {
            let seed_point = random_unit(rng);
            let euler_pole = random_unit(rng);
            let rate = rng.uniform(0.4, 1.6);
            let continental = rng.chance(land_bias);
            let base_elev = if continental {
                rng.uniform(0.25, 0.55)
            } else {
                rng.uniform(-0.75, -0.45)
            };
            Plate { seed_point, euler_pole, rate, continental, base_elev }
        })
        .collect();
    Plates { plates }
}

impl Plates {
    /// Indices of the nearest and second-nearest plate seeds (max dot = min geodesic).
    pub fn nearest_two(&self, p: V3) -> (usize, usize) {
        let (mut a, mut b) = (0usize, 1usize);
        let (mut da, mut db) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (i, pl) in self.plates.iter().enumerate() {
            let d = dot(p, pl.seed_point);
            if d > da {
                b = a;
                db = da;
                a = i;
                da = d;
            } else if d > db {
                b = i;
                db = d;
            }
        }
        (a, b)
    }

    /// Surface velocity of plate `i` at point `p`: rate · (pole × p).
    pub fn velocity(&self, i: usize, p: V3) -> V3 {
        scale(cross(self.plates[i].euler_pole, p), self.plates[i].rate)
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p gg-terrain && cargo test --workspace`
Expected: PASS (5 new tests; nothing else disturbed; descriptor goldens untouched).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/gg-core crates/gg-terrain
git commit -m "feat: gg-terrain scaffold — sphere math and kinematic plates"
```

---

### Task 2: Deterministic noise

**Files:**
- Modify: `crates/gg-terrain/src/lib.rs` (uncomment `pub mod noise;`)
- Create: `crates/gg-terrain/src/noise.rs`
- Test: `crates/gg-terrain/tests/noise.rs`

**Interfaces:**
- Produces: `noise::fbm(seed: u64, p: V3, octaves: u32) -> f64` (≈[−1, 1]); `noise::warped_fbm(seed: u64, p: V3, octaves: u32) -> f64`. Pure integer-hash value noise — wrapping arithmetic only, bit-identical on every platform by construction (no libm needed).

- [ ] **Step 1: Write the failing tests**

`crates/gg-terrain/tests/noise.rs`:

```rust
use gg_terrain::noise::{fbm, warped_fbm};
use gg_terrain::sphere::random_unit;
use gg_core::rng::RngStream;

#[test]
fn fbm_is_deterministic_bounded_and_seed_sensitive() {
    let mut probe = RngStream::root(1).child("noise-probe");
    let mut max_abs: f64 = 0.0;
    for _ in 0..2000 {
        let p = random_unit(&mut probe);
        let q = [p[0] * 2.3, p[1] * 2.3, p[2] * 2.3];
        let a = fbm(42, q, 6);
        assert_eq!(a, fbm(42, q, 6), "same input, same output");
        assert_ne!(a, fbm(43, q, 6), "different seed, different field");
        max_abs = max_abs.max(a.abs());
        assert!(a.abs() <= 2.0, "fbm wildly out of range: {a}");
    }
    assert!(max_abs > 0.15, "fbm suspiciously flat: max {max_abs}");
}

#[test]
fn fbm_is_continuous() {
    // tiny input steps produce tiny output steps (no cell-edge pops)
    let p = [0.37, -0.81, 0.45];
    let e = 1e-5;
    let base = fbm(7, p, 6);
    for d in 0..3 {
        let mut q = p;
        q[d] += e;
        assert!((fbm(7, q, 6) - base).abs() < 1e-2, "discontinuity along axis {d}");
    }
}

#[test]
fn warp_changes_the_field_but_stays_bounded() {
    let mut probe = RngStream::root(2).child("noise-probe");
    let mut diff = 0.0;
    for _ in 0..500 {
        let p = random_unit(&mut probe);
        let q = [p[0] * 2.0, p[1] * 2.0, p[2] * 2.0];
        let plain = fbm(5, q, 5);
        let warped = warped_fbm(5, q, 5);
        assert!(warped.abs() <= 2.0);
        diff += (plain - warped).abs();
    }
    assert!(diff / 500.0 > 0.05, "warp did nothing");
}
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `cargo test -p gg-terrain --test noise` — FAIL (module missing). Then `crates/gg-terrain/src/noise.rs`:

```rust
//! Integer-hash value noise. Deliberately libm-free: floor, multiplies, and
//! wrapping integer ops are bit-exact on every target, so the noise field is
//! cross-platform deterministic by construction.

use crate::sphere::V3;

fn hash3(seed: u64, x: i64, y: i64, z: i64) -> f64 {
    let mut h = seed ^ 0x9E37_79B9_7F4A_7C15;
    for v in [x as u64, y as u64, z as u64] {
        h ^= v.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        h = h.rotate_left(31).wrapping_mul(0x94D0_49BB_1331_11EB);
    }
    // top 53 bits -> [-1, 1)
    ((h >> 11) as f64) / ((1u64 << 53) as f64) * 2.0 - 1.0
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn value_noise(seed: u64, p: V3) -> f64 {
    let fx = p[0].floor();
    let fy = p[1].floor();
    let fz = p[2].floor();
    let (ix, iy, iz) = (fx as i64, fy as i64, fz as i64);
    let (tx, ty, tz) = (smooth(p[0] - fx), smooth(p[1] - fy), smooth(p[2] - fz));
    let c = |dx: i64, dy: i64, dz: i64| hash3(seed, ix + dx, iy + dy, iz + dz);
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), tx);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), tx);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), tx);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), tx);
    lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz)
}

/// Fractional Brownian motion: octaves of value noise, lacunarity 1.9,
/// gain 0.5, normalized to roughly [-1, 1].
pub fn fbm(seed: u64, p: V3, octaves: u32) -> f64 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut freq = 1.0;
    let mut total = 0.0;
    for k in 0..octaves {
        sum += amp * value_noise(seed.wrapping_add(k as u64), [p[0] * freq, p[1] * freq, p[2] * freq]);
        total += amp;
        amp *= 0.5;
        freq *= 1.9;
    }
    sum / total
}

/// Domain-warped fbm: bends ridgelines and coastlines out of the blocky
/// value-noise grid.
pub fn warped_fbm(seed: u64, p: V3, octaves: u32) -> f64 {
    let w = [
        fbm(seed ^ 0x1111, p, 3),
        fbm(seed ^ 0x2222, p, 3),
        fbm(seed ^ 0x3333, p, 3),
    ];
    fbm(seed, [p[0] + 0.4 * w[0], p[1] + 0.4 * w[1], p[2] + 0.4 * w[2]], octaves)
}
```

- [ ] **Step 3: Run tests, commit**

Run: `cargo test -p gg-terrain` — PASS.

```bash
git add crates/gg-terrain
git commit -m "feat: cross-platform-exact hash noise (fbm + domain warp)"
```

---

### Task 3: Elevation composition — boundaries from motion

**Files:**
- Modify: `crates/gg-terrain/src/lib.rs` (TerrainSpec core, no sea level yet)
- Test: `crates/gg-terrain/tests/terrain.rs` (first half)

**Interfaces:**
- Produces (consumed by Task 4 within the crate):

```rust
pub(crate) struct RawTerrain { plates: Plates, noise_seed: u64, hotspots: Vec<Hotspot>, relief_m: f64 }
pub(crate) struct Hotspot { center: V3, along: V3, count: usize, amp: f64 }
impl RawTerrain { pub(crate) fn raw_elevation(&self, p: V3) -> f64 }  // pre-sea-level, relative units
```

- [ ] **Step 1: Write the failing tests**

Create `crates/gg-terrain/tests/terrain.rs` with the module-internal pieces tested through a temporary pub API — instead, to keep the surface clean, test through `TerrainSpec` once Task 4 lands. FOR THIS TASK, test the physics property that must hold regardless of sea level via a `#[cfg(test)]`-style probe: add to `lib.rs` a `pub fn __raw_probe(seed: u64, desc: &SystemDescriptor, body_index: usize, lat: f64, lon: f64) -> Option<f64>` marked `#[doc(hidden)]` (returns raw pre-sea-level elevation; kept forever as a cheap diagnostic — document it as such). Test:

```rust
use gg_gen::generate;
use gg_terrain::__raw_probe;

#[test]
fn convergent_continental_boundaries_rise_above_interiors() {
    // statistical: across seeds and bodies, the mean of the top-decile raw
    // elevations should comfortably exceed the mean (mountain belts exist),
    // and raw elevation must be bounded.
    let mut ratios = Vec::new();
    for seed in [1u64, 42, 7, 99, 12345] {
        let desc = generate(seed);
        let stars = desc.stars.len();
        let anchor_body = stars + desc.anchor_planet;
        let mut samples = Vec::new();
        for row in 0..48 {
            let lat = 90.0 - (row as f64 + 0.5) * 180.0 / 48.0;
            for col in 0..96 {
                let lon = -180.0 + (col as f64 + 0.5) * 360.0 / 96.0;
                let e = __raw_probe(seed, &desc, anchor_body, lat, lon).unwrap();
                assert!(e.is_finite() && e.abs() < 6.0, "seed {seed}: raw {e}");
                samples.push(e);
            }
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean: f64 = samples.iter().sum::<f64>() / samples.len() as f64;
        let top: f64 = samples[samples.len() * 9 / 10..].iter().sum::<f64>()
            / (samples.len() as f64 / 10.0);
        ratios.push(top - mean);
    }
    assert!(
        ratios.iter().filter(|r| **r > 0.4).count() >= 3,
        "mountainous tails missing: {ratios:?}"
    );
}

#[test]
fn non_terrain_bodies_probe_none() {
    let desc = generate(42);
    assert!(__raw_probe(42, &desc, 0, 0.0, 0.0).is_none(), "stars have no terrain");
    let giant = desc.planets.iter().position(|p| p.class != gg_gen::descriptor::PlanetClass::Rocky);
    if let Some(g) = giant {
        assert!(__raw_probe(42, &desc, desc.stars.len() + g, 0.0, 0.0).is_none());
    }
}
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `cargo test -p gg-terrain --test terrain` — FAIL. Then replace `crates/gg-terrain/src/lib.rs` with:

```rust
//! Deterministic kinematic-plate terrain. A pure function of
//! (seed, descriptor, body index) — the descriptor itself never changes.

pub mod noise;
pub mod plates;
pub mod sphere;

use gg_core::consts::R_EARTH;
use gg_core::math;
use gg_core::rng::RngStream;
use gg_gen::descriptor::{PlanetClass, SystemDescriptor, WorldState};
use noise::{fbm, warped_fbm};
use plates::{build_plates, Plates};
use sphere::{cross, dot, geodesic, latlon_to_unit, normalize, random_unit, scale, sub, V3};

struct Hotspot {
    center: V3,
    step: V3, // small tangent step between successive bumps (hotspot trail)
    count: usize,
    amp: f64,
}

struct BodyFacts {
    radius_m: f64,
    dead: bool,
}

/// Resolve a terrain-bearing body by ephemeris body order.
/// Rocky planets and ALL moons qualify; stars and giants do not.
fn body_facts(desc: &SystemDescriptor, body_index: usize) -> Option<BodyFacts> {
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    if body_index < stars {
        return None;
    }
    if body_index < stars + planets {
        let p = &desc.planets[body_index - stars];
        if p.class != PlanetClass::Rocky {
            return None;
        }
        return Some(BodyFacts {
            radius_m: p.radius_m,
            dead: matches!(p.state, WorldState::Dead),
        });
    }
    let mut m = body_index - stars - planets;
    for p in &desc.planets {
        if m < p.moons.len() {
            return Some(BodyFacts {
                radius_m: p.moons[m].radius_m,
                // moons inherit no world-state; they are airless and dry-ish
                // but keep normal terrain (ocean draw handles water rarity via
                // the parent planet's state? No — moons use the normal range;
                // "dead" here means the DEAD-WORLD dry-basin rule, planets only).
                dead: false,
            });
        }
        m -= p.moons.len();
    }
    None
}

struct RawTerrain {
    plates: Plates,
    noise_seed: u64,
    hotspots: Vec<Hotspot>,
}

impl RawTerrain {
    fn build(rng: &mut RngStream, facts: &BodyFacts, land_bias: f64, seed: u64, body_index: usize) -> Self {
        let plates = build_plates(rng, facts.radius_m, land_bias);
        // Noise seed derives from the root seed + body index, not from a draw:
        // adding octaves later must not shift the plate draws.
        let noise_seed = seed
            ^ (body_index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ 0xC0FF_EE00_D15E_A5E5;
        let hotspot_count = rng.pick_count(0, 2);
        let hotspots = (0..hotspot_count)
            .map(|_| {
                let center = random_unit(rng);
                let dir = normalize(cross(random_unit(rng), center));
                Hotspot {
                    center,
                    step: scale(dir, 0.05),
                    count: 3 + rng.pick_count(0, 4),
                    amp: rng.uniform(0.25, 0.6),
                }
            })
            .collect();
        RawTerrain { plates, noise_seed, hotspots }
    }

    fn boundary_term(&self, p: V3) -> f64 {
        let (a, b) = self.plates.nearest_two(p);
        let pa = &self.plates.plates[a];
        let pb = &self.plates.plates[b];
        let da = geodesic(p, pa.seed_point);
        let db = geodesic(p, pb.seed_point);
        // Distance from the (approximate) Voronoi edge; 0 on the edge.
        let edge_dist = (db - da) * 0.5;
        let falloff = math::exp(-(edge_dist / 0.09) * (edge_dist / 0.09));
        if falloff < 1e-3 {
            return 0.0;
        }
        // Boundary normal: from plate b's seed toward plate a's, tangent at p.
        let raw_n = sub(pa.seed_point, pb.seed_point);
        let n = normalize(sub(raw_n, scale(p, dot(raw_n, p))));
        let t = cross(p, n);
        let dv = sub(self.plates.velocity(a, p), self.plates.velocity(b, p));
        // dv·n < 0 means plate a's material moves toward plate b: convergence.
        let closing = -dot(dv, n);
        let shear = dot(dv, t).abs();

        let mut term = 0.0;
        if closing > 0.0 {
            match (pa.continental, pb.continental) {
                (true, true) => term += 1.5 * closing * falloff, // collision belts
                (false, false) => {
                    // island arc + trench, offset to the overriding side
                    term += 0.45 * closing * falloff;
                    let trench = math::exp(-((edge_dist - 0.035) / 0.02) * ((edge_dist - 0.035) / 0.02));
                    term -= 0.7 * closing * trench;
                }
                _ => {
                    // ocean-continent: cordillera on the continental side,
                    // trench on the oceanic side
                    let continental_side = if pa.continental { a == a } else { false };
                    let on_continent = if da <= db { pa.continental } else { pb.continental };
                    if on_continent {
                        term += 1.0 * closing * falloff;
                    } else {
                        let trench = math::exp(-((edge_dist - 0.03) / 0.02) * ((edge_dist - 0.03) / 0.02));
                        term -= 0.9 * closing * trench;
                    }
                    let _ = continental_side;
                }
            }
        } else {
            let opening = -closing;
            if !pa.continental && !pb.continental {
                term += 0.35 * opening * falloff; // mid-ocean ridge
            } else {
                term -= 0.6 * opening * falloff; // continental rift
            }
        }
        term += 0.12 * shear * falloff; // transform ridging
        term
    }

    fn raw_elevation(&self, p: V3) -> f64 {
        let (a, _) = self.plates.nearest_two(p);
        let base = self.plates.plates[a].base_elev;
        let boundary = self.boundary_term(p);
        let detail = 0.35 * warped_fbm(self.noise_seed, scale(p, 2.6), 6);
        let mut hot = 0.0;
        for h in &self.hotspots {
            let mut c = h.center;
            let mut amp = h.amp;
            for _ in 0..h.count {
                let d = geodesic(p, normalize(c));
                hot += amp * math::exp(-(d / 0.02) * (d / 0.02));
                c = sphere::add(c, h.step);
                amp *= 0.72;
            }
        }
        base + boundary + detail + hot
    }
}

/// Diagnostic probe: raw (pre-sea-level) elevation. Kept public-but-hidden
/// so property tests and future tuning can see the composition directly.
#[doc(hidden)]
pub fn __raw_probe(seed: u64, desc: &SystemDescriptor, body_index: usize, lat_deg: f64, lon_deg: f64) -> Option<f64> {
    let facts = body_facts(desc, body_index)?;
    let mut rng = RngStream::root(seed).child(&format!("terrain-{body_index}"));
    // FIXED DRAW ORDER (shared with TerrainSpec::for_body): ocean target,
    // land bias, relief, plates, hotspots.
    let _ocean_target = draw_ocean_target(&mut rng, &facts);
    let land_bias = rng.uniform(0.25, 0.6);
    let _relief = rng.uniform(3000.0, 12_000.0) * (facts.radius_m / R_EARTH).clamp(0.3, 1.2);
    let raw = RawTerrain::build(&mut rng, &facts, land_bias, seed, body_index);
    Some(raw.raw_elevation(latlon_to_unit(lat_deg, lon_deg)))
}

fn draw_ocean_target(rng: &mut RngStream, facts: &BodyFacts) -> f64 {
    if facts.dead {
        rng.uniform(0.0, 0.15)
    } else {
        rng.uniform(0.20, 0.85)
    }
}
```

Implementation note: the `continental_side` scratch variable in the mixed-boundary arm is leftover scaffolding in this plan text — write the clean version (just the `on_continent` logic). Moons: the `dead: false` comment block should say simply: the dry-basin rule keys on the PLANET's Dead state; moons always use the normal ocean-fraction range (their low ranges arrive with climate later).

- [ ] **Step 3: Run tests**

Run: `cargo test -p gg-terrain && cargo test --workspace`
Expected: PASS. Descriptor goldens untouched.

- [ ] **Step 4: Commit**

```bash
git add crates/gg-terrain
git commit -m "feat: motion-classified plate boundaries + elevation composition"
```

---

### Task 4: TerrainSpec — sea level, heightmap, info, goldens

**Files:**
- Modify: `crates/gg-terrain/src/lib.rs` (TerrainSpec public API)
- Create: `crates/gg-terrain/examples/hashes.rs`
- Create: `crates/gg-terrain/tests/golden/` (bootstrapped)
- Test: `crates/gg-terrain/tests/terrain.rs` (extend)

**Interfaces:**
- Produces (the crate's public contract, consumed by gg-wasm in Task 5):

```rust
pub struct TerrainSpec { /* private */ }
#[derive(serde::Serialize, serde::Deserialize)]
pub struct TerrainInfo { pub sea_level: f64, pub ocean_fraction: f64, pub relief_m: f64, pub plate_count: usize }
impl TerrainSpec {
    pub fn for_body(seed: u64, desc: &SystemDescriptor, body_index: usize) -> Option<TerrainSpec>;
    pub fn elevation(&self, lat_deg: f64, lon_deg: f64) -> f64;   // sea level = 0
    pub fn heightmap(&self, width: usize, height: usize) -> Vec<f32>;
    pub fn info(&self) -> TerrainInfo;
}
pub fn heightmap_hash(map: &[f32]) -> u64;  // FNV-1a-64 over LE i16 quantization (clamp(e,-4,4)/4*32767)
```

- [ ] **Step 1: Write the failing tests**

Append to `crates/gg-terrain/tests/terrain.rs`:

```rust
use gg_terrain::{heightmap_hash, TerrainSpec};

#[test]
fn ocean_fraction_matches_its_draw() {
    for seed in [1u64, 42, 7, 99, 12345, 777] {
        let desc = generate(seed);
        let anchor_body = desc.stars.len() + desc.anchor_planet;
        let spec = TerrainSpec::for_body(seed, &desc, anchor_body).unwrap();
        let info = spec.info();
        let map = spec.heightmap(128, 64);
        // the solve grid IS 128x64 with cos-lat weights, so the weighted
        // measurement must match info.ocean_fraction almost exactly:
        assert!((info.ocean_fraction - weighted_ocean(&map, 128, 64)).abs() < 1e-9,
            "seed {seed}: info {} vs measured", info.ocean_fraction);
        assert!(info.plate_count >= 6 && info.relief_m > 500.0);
    }
}

fn weighted_ocean(map: &[f32], w: usize, h: usize) -> f64 {
    let mut wet = 0.0;
    let mut total = 0.0;
    for row in 0..h {
        let lat = (90.0 - (row as f64 + 0.5) * 180.0 / h as f64).to_radians();
        let weight = lat.cos();
        for col in 0..w {
            total += weight;
            if map[row * w + col] < 0.0 {
                wet += weight;
            }
        }
    }
    wet / total
}

#[test]
fn dead_worlds_are_dry() {
    // seed 18's anchor is Dead (established earlier in the project QA)
    let desc = generate(18);
    let anchor_body = desc.stars.len() + desc.anchor_planet;
    assert!(matches!(desc.planets[desc.anchor_planet].state, gg_gen::descriptor::WorldState::Dead));
    let spec = TerrainSpec::for_body(18, &desc, anchor_body).unwrap();
    assert!(spec.info().ocean_fraction <= 0.16, "dead world too wet: {}", spec.info().ocean_fraction);
}

#[test]
fn heightmap_layout_and_elevation_agree() {
    let desc = generate(42);
    let anchor_body = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor_body).unwrap();
    let (w, h) = (64usize, 32usize);
    let map = spec.heightmap(w, h);
    assert_eq!(map.len(), w * h);
    for (row, col) in [(0usize, 0usize), (5, 20), (31, 63)] {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / h as f64;
        let lon = -180.0 + (col as f64 + 0.5) * 360.0 / w as f64;
        let direct = spec.elevation(lat, lon);
        assert!((map[row * w + col] as f64 - direct).abs() < 1e-5, "row {row} col {col}");
    }
}

#[test]
fn moons_have_terrain_and_all_terrain_is_deterministic() {
    let desc = generate(42);
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    let first_moon = stars + planets; // moons grouped after planets
    let a = TerrainSpec::for_body(42, &desc, first_moon).expect("moons have terrain");
    let b = TerrainSpec::for_body(42, &desc, first_moon).unwrap();
    assert_eq!(a.heightmap(64, 32), b.heightmap(64, 32));
}

#[test]
fn golden_terrain_hashes_are_pinned() {
    for seed in [1u64, 42, 123_456_789] {
        let path = format!("tests/golden/terrain-seed-{seed}.json");
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!("missing {path}; bootstrap: cargo run -p gg-terrain --example hashes -- {seed} > crates/gg-terrain/{path}")
        });
        let expected: std::collections::BTreeMap<String, String> = serde_json::from_str(&expected).unwrap();
        let desc = generate(seed);
        let total = desc.stars.len() + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(format!("body_{body}"), format!("{:#018x}", heightmap_hash(&spec.heightmap(256, 128))));
            }
        }
        assert_eq!(actual, expected, "seed {seed}: terrain diverged — shared worlds would change; this is the terrain determinism contract");
    }
}
```

- [ ] **Step 2: Run to verify failure, then implement TerrainSpec**

Extend `crates/gg-terrain/src/lib.rs`:

```rust
pub struct TerrainSpec {
    raw: RawTerrain,
    sea_level: f64,
    ocean_fraction: f64,
    relief_m: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TerrainInfo {
    pub sea_level: f64,
    pub ocean_fraction: f64,
    pub relief_m: f64,
    pub plate_count: usize,
}

impl TerrainSpec {
    pub fn for_body(seed: u64, desc: &SystemDescriptor, body_index: usize) -> Option<TerrainSpec> {
        let facts = body_facts(desc, body_index)?;
        let mut rng = RngStream::root(seed).child(&format!("terrain-{body_index}"));
        let ocean_target = draw_ocean_target(&mut rng, &facts);
        let land_bias = rng.uniform(0.25, 0.6);
        let relief_m = rng.uniform(3000.0, 12_000.0) * (facts.radius_m / R_EARTH).clamp(0.3, 1.2);
        let raw = RawTerrain::build(&mut rng, &facts, land_bias, seed, body_index);

        // Solve sea level by bisection on a cos-lat-weighted sample grid so
        // the weighted underwater fraction hits the target.
        let (gw, gh) = (128usize, 64usize); // same grid the ocean-fraction test measures on
        let mut samples = Vec::with_capacity(gw * gh);
        for row in 0..gh {
            let lat = 90.0 - (row as f64 + 0.5) * 180.0 / gh as f64;
            let weight = math::cos(lat.to_radians());
            for col in 0..gw {
                let lon = -180.0 + (col as f64 + 0.5) * 360.0 / gw as f64;
                samples.push((raw.raw_elevation(latlon_to_unit(lat, lon)), weight));
            }
        }
        let total_w: f64 = samples.iter().map(|(_, w)| w).sum();
        let frac_below = |s: f64| -> f64 {
            samples.iter().filter(|(e, _)| *e < s).map(|(_, w)| w).sum::<f64>() / total_w
        };
        let (mut lo, mut hi) = (-6.0f64, 6.0f64);
        for _ in 0..48 {
            let mid = 0.5 * (lo + hi);
            if frac_below(mid) < ocean_target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let sea_level = 0.5 * (lo + hi);
        let ocean_fraction = frac_below(sea_level);

        Some(TerrainSpec { raw, sea_level, ocean_fraction, relief_m })
    }

    /// Elevation relative to sea level (0 = shore), relative units;
    /// `info().relief_m` gives the meters-per-unit scale.
    pub fn elevation(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        self.raw.raw_elevation(latlon_to_unit(lat_deg, lon_deg)) - self.sea_level
    }

    /// Equirect heightmap: row-major, row 0 = lat +90, col 0 = lon -180,
    /// sample centers at pixel centers.
    pub fn heightmap(&self, width: usize, height: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(width * height);
        for row in 0..height {
            let lat = 90.0 - (row as f64 + 0.5) * 180.0 / height as f64;
            for col in 0..width {
                let lon = -180.0 + (col as f64 + 0.5) * 360.0 / width as f64;
                out.push(self.elevation(lat, lon) as f32);
            }
        }
        out
    }

    pub fn info(&self) -> TerrainInfo {
        TerrainInfo {
            sea_level: self.sea_level,
            ocean_fraction: self.ocean_fraction,
            relief_m: self.relief_m,
            plate_count: self.raw.plates.plates.len(),
        }
    }
}

/// FNV-1a-64 over the little-endian bytes of the i16 quantization —
/// the terrain determinism fingerprint.
pub fn heightmap_hash(map: &[f32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for e in map {
        let q = ((f64::from(*e).clamp(-4.0, 4.0) / 4.0) * 32767.0) as i16;
        for b in q.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}
```

`crates/gg-terrain/examples/hashes.rs`:

```rust
//! Bootstrap/refresh terrain hash goldens:
//! cargo run -p gg-terrain --example hashes -- <seed> > crates/gg-terrain/tests/golden/terrain-seed-<seed>.json

use std::collections::BTreeMap;

fn main() {
    let seed: u64 = std::env::args().nth(1).expect("usage: hashes <seed>").parse().expect("u64 seed");
    let desc = gg_gen::generate(seed);
    let total = desc.stars.len()
        + desc.planets.len()
        + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
    let mut out = BTreeMap::new();
    for body in 0..total {
        if let Some(spec) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
            out.insert(
                format!("body_{body}"),
                format!("{:#018x}", gg_terrain::heightmap_hash(&spec.heightmap(256, 128))),
            );
        }
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
```

- [ ] **Step 3: Bootstrap goldens, run everything**

```bash
mkdir -p crates/gg-terrain/tests/golden
for s in 1 42 123456789; do
  cargo run -q -p gg-terrain --example hashes -- $s > crates/gg-terrain/tests/golden/terrain-seed-$s.json
done
cargo test --workspace
```

Expected: all PASS including `golden_terrain_hashes_are_pinned`; descriptor goldens untouched (`git diff --stat crates/gg-gen/tests/golden/` empty). The solve grid and the test's measurement grid are deliberately the same 128×64 with identical cos-lat weights — the fraction check is exact, not a tolerance game.

- [ ] **Step 4: Commit**

```bash
git add crates/gg-terrain
git commit -m "feat: TerrainSpec — sea-level solve, heightmaps, terrain hash goldens"
```

---

### Task 5: WASM boundary + wasm32 terrain parity

**Files:**
- Modify: `crates/gg-wasm/Cargo.toml` (+ gg-terrain dep)
- Modify: `crates/gg-wasm/src/lib.rs` (+ 2 methods)
- Modify: `crates/gg-wasm/tests/flatten.rs` (native), `crates/gg-wasm/tests/wasm_golden.rs` (parity)
- Modify: `web/src/sim/wasm.ts`, `web/src/sim/types.ts` (Sim additions)

**Interfaces:**
- Produces:

```rust
// World methods:
pub fn body_heightmap(&self, body_index: usize, width: usize, height: usize) -> js_sys::Float32Array // empty for non-terrain bodies
pub fn body_terrain_info(&self, body_index: usize) -> Result<String, JsError> // Err for non-terrain bodies
```
```ts
// types.ts:
export interface TerrainInfo { sea_level: number; ocean_fraction: number; relief_m: number; plate_count: number }
// Sim:
bodyHeightmap(bodyIndex: number, width: number, height: number): Float32Array; // length 0 => no terrain
bodyTerrainInfo(bodyIndex: number): TerrainInfo | null;                        // null => no terrain
```

TerrainSpec construction is O(solve grid) — cache built specs in `World` behind a `RefCell<HashMap<usize, Option<TerrainSpec>>>` (wasm is single-threaded; document that).

- [ ] **Step 1: Write the failing native test**

Append to `crates/gg-wasm/tests/flatten.rs`:

```rust
#[test]
fn wasm_heightmaps_match_gg_terrain_directly() {
    let desc = gg_gen::generate(42);
    let anchor_body = desc.stars.len() + desc.anchor_planet;
    let direct = gg_terrain::TerrainSpec::for_body(42, &desc, anchor_body)
        .unwrap()
        .heightmap(64, 32);
    let world_map = gg_wasm::terrain_heightmap_native(&desc, 42, anchor_body, 64, 32);
    assert_eq!(direct, world_map, "boundary must not transform terrain data");
    assert!(gg_wasm::terrain_heightmap_native(&desc, 42, 0, 64, 32).is_empty(), "stars empty");
}
```

(`terrain_heightmap_native` is a thin pub helper in gg-wasm so the logic tests natively; the `#[wasm_bindgen]` method wraps it. The World cache is exercised on wasm32.)

- [ ] **Step 2: Run to verify failure, then implement**

`crates/gg-wasm/Cargo.toml`: add `gg-terrain = { path = "../gg-terrain" }`.

`crates/gg-wasm/src/lib.rs` — add:

```rust
use std::cell::RefCell;
use std::collections::HashMap;
```

Give `World` a cache field (WASM runs single-threaded; RefCell is safe here):

```rust
#[wasm_bindgen]
pub struct World {
    eph: KeplerSecular,
    seed: u64,
    terrain: RefCell<HashMap<usize, Option<gg_terrain::TerrainSpec>>>,
}
```

(Constructor stores `seed` before moving it into generate; initialize `terrain: RefCell::new(HashMap::new())`.)

```rust
/// Native-testable core of the terrain boundary (no wasm types).
pub fn terrain_heightmap_native(
    desc: &gg_gen::descriptor::SystemDescriptor,
    seed: u64,
    body_index: usize,
    width: usize,
    height: usize,
) -> Vec<f32> {
    gg_terrain::TerrainSpec::for_body(seed, desc, body_index)
        .map(|s| s.heightmap(width, height))
        .unwrap_or_default()
}

#[wasm_bindgen]
impl World {
    fn with_terrain<R>(&self, body_index: usize, f: impl FnOnce(Option<&gg_terrain::TerrainSpec>) -> R) -> R {
        let mut cache = self.terrain.borrow_mut();
        let entry = cache
            .entry(body_index)
            .or_insert_with(|| gg_terrain::TerrainSpec::for_body(self.seed, self.eph.desc(), body_index));
        f(entry.as_ref())
    }

    /// Equirect heightmap (row 0 = lat +90). Empty array = no terrain body.
    pub fn body_heightmap(&self, body_index: usize, width: usize, height: usize) -> js_sys::Float32Array {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => js_sys::Float32Array::from(s.heightmap(width, height).as_slice()),
            None => js_sys::Float32Array::new_with_length(0),
        })
    }

    pub fn body_terrain_info(&self, body_index: usize) -> Result<String, JsError> {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => serde_json::to_string(&s.info())
                .map_err(|e| JsError::new(&format!("terrain info serialization failed: {e}"))),
            None => Err(JsError::new("no terrain for this body")),
        })
    }
}
```

Append to `crates/gg-wasm/tests/wasm_golden.rs` (inside the wasm32 cfg):

```rust
#[wasm_bindgen_test]
fn terrain_hashes_match_native_goldens_on_wasm32() {
    for (seed, golden) in [
        (1u64, include_str!("../../gg-terrain/tests/golden/terrain-seed-1.json")),
        (42, include_str!("../../gg-terrain/tests/golden/terrain-seed-42.json")),
        (123_456_789, include_str!("../../gg-terrain/tests/golden/terrain-seed-123456789.json")),
    ] {
        let expected: std::collections::BTreeMap<String, String> = serde_json::from_str(golden).unwrap();
        let desc = gg_gen::generate(seed);
        let total = desc.stars.len() + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(format!("body_{body}"), format!("{:#018x}", gg_terrain::heightmap_hash(&spec.heightmap(256, 128))));
            }
        }
        assert_eq!(actual, expected, "seed {seed}: wasm32 terrain diverged from native");
    }
    // the World boundary itself (cache + marshaling) on wasm32:
    let w = World::new("42").expect("valid seed");
    assert_eq!(w.body_heightmap(0, 8, 4).length(), 0, "stars have no terrain");
    let desc: serde_json::Value = serde_json::from_str(&w.descriptor_json().unwrap()).unwrap();
    let anchor_body = desc["stars"].as_array().unwrap().len() + desc["anchor_planet"].as_u64().unwrap() as usize;
    assert_eq!(w.body_heightmap(anchor_body, 8, 4).length(), 32);
    assert_eq!(w.body_heightmap(anchor_body, 8, 4).length(), 32, "cached second call identical");
}
```

`web/src/sim/types.ts` — add `TerrainInfo` interface. `web/src/sim/wasm.ts` — add to `Sim` + implementation:

```ts
    bodyHeightmap: (i, w, h) => world.body_heightmap(i, w, h),
    bodyTerrainInfo: (i) => {
      try {
        return JSON.parse(world.body_terrain_info(i)) as TerrainInfo;
      } catch {
        return null;
      }
    },
```

- [ ] **Step 3: Run all suites**

Run: `cargo test --workspace && wasm-pack test --node crates/gg-wasm` (Node 22) `&& cd web && npm run build:wasm && npx vitest run && npx tsc --noEmit`
Expected: all PASS, including the new wasm32 terrain parity test (libm + integer noise make it exact). If parity FAILS: STOP, report BLOCKED with the first differing body hash — a std-math call slipped into the terrain path.

- [ ] **Step 4: Commit**

```bash
git add crates web/src
git commit -m "feat: terrain over the WASM boundary with wasm32 hash parity"
```

---

### Task 6: Orrery hypsometric textures

**Files:**
- Create: `web/src/views/terrainTexture.ts` + `web/src/views/terrainTexture.test.ts`
- Create: `web/src/views/terrainCache.ts`
- Modify: `web/src/views/space.ts`, `web/src/views/ground.ts` (use terrain textures for rocky bodies)
- Modify: `web/src/views/space.test.ts`, `web/src/views/ground.test.ts` (fakes gain the two Sim methods)

**Interfaces:**
- Produces:

```ts
// terrainTexture.ts
export function hypsometricColor(e: number, shade: number, classTint: [number, number, number], dead: boolean): [number, number, number]; // 0-255 RGB
export function slopeShade(map: Float32Array, w: number, h: number, row: number, col: number): number; // ~0.75..1.15, NW light
export function terrainTexture(map: Float32Array, w: number, h: number, classHex: number, dead: boolean): THREE.CanvasTexture | null; // null when canvas 2D unavailable
// terrainCache.ts
export function getTerrainTexture(sim: Sim, bodyIndex: number): THREE.CanvasTexture | null; // lazy Map cache; null for non-terrain bodies or headless canvas
```

- [ ] **Step 1: Write the failing tests**

`web/src/views/terrainTexture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hypsometricColor, slopeShade } from './terrainTexture';

const tint: [number, number, number] = [155, 143, 122]; // Rocky palette 0x9b8f7a

describe('hypsometricColor', () => {
  it('deep ocean is dark blue, shallows lighter', () => {
    const deep = hypsometricColor(-1.5, 1, tint, false);
    const shallow = hypsometricColor(-0.05, 1, tint, false);
    expect(deep[2]).toBeGreaterThan(deep[0]); // blue dominant
    expect(shallow[2]).toBeGreaterThan(shallow[0]);
    expect(shallow[0] + shallow[1] + shallow[2]).toBeGreaterThan(deep[0] + deep[1] + deep[2]);
  });
  it('land climbs from lowland tones to pale peaks', () => {
    const low = hypsometricColor(0.05, 1, tint, false);
    const peak = hypsometricColor(1.8, 1, tint, false);
    expect(peak[0] + peak[1] + peak[2]).toBeGreaterThan(low[0] + low[1] + low[2]);
    expect(Math.abs(peak[0] - peak[2])).toBeLessThan(30); // peaks near-grey
  });
  it('dead worlds have no blue basins', () => {
    const basin = hypsometricColor(-1.0, 1, tint, true);
    expect(basin[2]).toBeLessThanOrEqual(basin[0]); // browns, not blues
  });
  it('shade scales brightness', () => {
    const flat = hypsometricColor(0.5, 1.0, tint, false);
    const lit = hypsometricColor(0.5, 1.15, tint, false);
    const shadow = hypsometricColor(0.5, 0.8, tint, false);
    expect(lit[0]).toBeGreaterThan(flat[0]);
    expect(shadow[0]).toBeLessThan(flat[0]);
  });
});

describe('slopeShade', () => {
  it('west-facing slopes catch the NW light', () => {
    // simple ramp descending eastward: west faces brighter than east faces
    const w = 8, h = 4;
    const map = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) map[r * w + c] = -c * 0.2;
    const bright = slopeShade(map, w, h, 2, 4);
    const flat = slopeShade(new Float32Array(w * h), w, h, 2, 4);
    expect(bright).toBeGreaterThan(flat);
    expect(flat).toBeCloseTo(1.0, 5);
  });
  it('clamps to a sane range', () => {
    const w = 8, h = 4;
    const cliff = new Float32Array(w * h).map((_, i) => (i % w) % 2 ? 50 : -50);
    const s = slopeShade(cliff, w, h, 2, 3);
    expect(s).toBeGreaterThanOrEqual(0.75);
    expect(s).toBeLessThanOrEqual(1.15);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

`web/src/views/terrainTexture.ts`:

```ts
import * as THREE from 'three';

/** Hypsometric tint ramp. Elevations are relative (sea level = 0). */
const OCEAN_DEEP: [number, number, number] = [8, 26, 58];
const OCEAN_SHELF: [number, number, number] = [42, 92, 138];
const DRY_DEEP: [number, number, number] = [58, 47, 36];
const DRY_SHELF: [number, number, number] = [87, 73, 58];
const SHORE: [number, number, number] = [138, 127, 95];
const UPLAND: [number, number, number] = [122, 106, 88];
const PEAK: [number, number, number] = [216, 216, 216];

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

export function hypsometricColor(
  e: number,
  shade: number,
  classTint: [number, number, number],
  dead: boolean,
): [number, number, number] {
  let c: [number, number, number];
  if (e < 0) {
    const t = Math.min(1, -e / 1.5);
    c = dead ? mix(DRY_SHELF, DRY_DEEP, t) : mix(OCEAN_SHELF, OCEAN_DEEP, t);
  } else if (e < 0.6) {
    c = mix(SHORE, UPLAND, e / 0.6);
  } else {
    c = mix(UPLAND, PEAK, (e - 0.6) / 1.2);
  }
  c = mix(c, classTint, 0.22); // keep the orrery's class color language
  const s = shade;
  return [Math.min(255, c[0] * s), Math.min(255, c[1] * s), Math.min(255, c[2] * s)].map(Math.round) as [
    number,
    number,
    number,
  ];
}

/** Finite-difference relief shading, light from the NW. Flat terrain = 1.0. */
export function slopeShade(map: Float32Array, w: number, h: number, row: number, col: number): number {
  const at = (r: number, c: number) => map[Math.min(h - 1, Math.max(0, r)) * w + ((c + w) % w)]!;
  const dx = at(row, col + 1) - at(row, col - 1);
  const dy = at(row + 1, col) - at(row - 1, col);
  // light from NW: brighter when surface rises toward -x,-y
  return Math.min(1.15, Math.max(0.75, 1.0 - 0.35 * (dx + dy)));
}

export function terrainTexture(
  map: Float32Array,
  w: number,
  h: number,
  classHex: number,
  dead: boolean,
): THREE.CanvasTexture | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const tint: [number, number, number] = [(classHex >> 16) & 255, (classHex >> 8) & 255, classHex & 255];
    const img = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const e = map[row * w + col]!;
        const [r, g, b] = hypsometricColor(e, slopeShade(map, w, h, row, col), tint, dead);
        const o = (row * w + col) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}
```

`web/src/views/terrainCache.ts`:

```ts
import type * as THREE from 'three';
import { bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { terrainTexture } from './terrainTexture';

const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
const RESOLUTION: [number, number] = [512, 256];
const cache = new Map<string, THREE.CanvasTexture | null>();

/** Lazy terrain texture per body; null for non-terrain bodies or headless canvas. */
export function getTerrainTexture(sim: Sim, bodyIndex: number): THREE.CanvasTexture | null {
  const key = `${sim.seed}:${bodyIndex}`;
  if (cache.has(key)) return cache.get(key)!;
  const info = sim.bodyTerrainInfo(bodyIndex);
  let tex: THREE.CanvasTexture | null = null;
  if (info) {
    const map = sim.bodyHeightmap(bodyIndex, RESOLUTION[0], RESOLUTION[1]);
    if (map.length > 0) {
      const layout = bodyLayout(sim.descriptor);
      const ref = layout[bodyIndex]!;
      const classHex = ref.kind === 'planet' ? PALETTE[sim.descriptor.planets[ref.planet]!.class] : 0x8a8f98;
      const dead = ref.kind === 'planet' && sim.descriptor.planets[ref.planet]!.state.kind === 'Dead';
      tex = terrainTexture(map, RESOLUTION[0], RESOLUTION[1], classHex, dead);
    }
  }
  cache.set(key, tex);
  return tex;
}
```

`web/src/views/space.ts` — in the body-material construction for non-stars, try terrain first:

```ts
      const terrain = getTerrainTexture(sim, i);
      const baseHex = ref.kind === 'planet' ? palette[sim.descriptor.planets[ref.planet]!.class] : 0x8a8f98;
      material = terrain
        ? new THREE.MeshStandardMaterial({ map: terrain, roughness: 0.95 })
        : new THREE.MeshStandardMaterial({ color: baseHex, roughness: 0.9 });
```

`web/src/views/ground.ts` — same substitution where `proceduralBodyTexture` is currently used (terrain texture if available, else the existing procedural fallback).

Update `space.test.ts` and `ground.test.ts` fakes: add `bodyHeightmap: () => new Float32Array(0), bodyTerrainInfo: () => null,` to every fake `Sim` object (headless: no terrain, fallback materials — existing assertions unchanged). Add one scene test to `space.test.ts`:

```ts
  it('uses terrain textures when the sim provides them (headless canvas may still yield null)', () => {
    const sim = fakeSim();
    sim.bodyTerrainInfo = (i) => (i >= golden.stars.length ? { sea_level: 0, ocean_fraction: 0.6, relief_m: 6000, plate_count: 9 } : null);
    sim.bodyHeightmap = (i, w, h) => (i >= golden.stars.length ? new Float32Array(w * h) : new Float32Array(0));
    const view = buildSpaceScene(sim);
    // structural: construction succeeds either way; material is either mapped or fallback
    expect(view.bodies.length).toBe(sim.bodyCount);
  });
```

- [ ] **Step 3: Run web suites**

Run: `cd web && npm run build:wasm && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS (terrainTexture unit tests are the real gate; canvas-dependent paths null out in happy-dom).

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: hypsometric terrain textures on rocky worlds in both views"
```

---

### Task 7: Ship + live verification (controller-run)

**Files:** none (operations).

- [ ] **Step 1: Merge to main, push, watch the run** (standard commands; the CI wasm parity step now also guards terrain hashes).
- [ ] **Step 2: Live QA with screenshots:**
  1. `#seed=42` orrery: rocky planets show continents/oceans; zoom the anchor — coastlines, mountain belts near plate boundaries, trenches offshore. Giants unchanged (banded blotches).
  2. Dead-world seed 18: dry basins, no blue.
  3. Stand on a moon of a rocky planet (seed 42 planet I / moon Ia): the parent planet overhead shows its map.
  4. Timing: first load of a system generates ~10 textures at 512×256 — confirm no visible hitch (log Performance timing; < 250ms total acceptable, else note for a Plan-2 worker/deferral).
  5. Zero console errors.

## Definition of Done

- All suites green (native, wasm parity incl. terrain hashes, web); descriptor goldens byte-identical; clippy clean.
- Terrain goldens committed for seeds 1/42/123456789.
- Live orrery shows kinematically-consistent terrain; screenshots recorded.
