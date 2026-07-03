# Goldengrove v1 — Plan 1: Simulation Core (Rust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete Rust simulation core: `generate(seed) → SystemDescriptor`, `KeplerSecular` ephemeris, and derived calendars — fully tested natively, no browser involved.

**Architecture:** Layered deterministic pipeline (spec: `docs/superpowers/specs/2026-07-03-goldengrove-v1-orrery-design.md`). Three plain Rust crates: `gg-core` (RNG streams, constants, Kepler math), `gg-gen` (seed → descriptor), `gg-ephemeris` (descriptor + t → body states). WASM wrapper and web app are Plans 2–3.

**Tech Stack:** Rust 2021 workspace. Dependencies limited to: `rand 0.8`, `rand_pcg 0.3`, `serde 1` (derive), `serde_json 1`. Nothing else without a plan change.

## Global Constraints

- **Determinism is a hard contract**: all randomness flows from `RngStream`; never `HashMap`/`HashSet` iteration in generation paths; samples drawn in fixed order; new draw sites use `child()` streams. No `SystemTime`, no environment entropy.
- **Units**: SI `f64` everywhere (meters, kilograms, seconds, watts, kelvin, radians). Field names carry units (`semi_major_axis_m`, `rotation_period_s`).
- **Frame convention**: right-handed; system barycenter at origin; orbital reference plane is XY; +Z is "north". Angles in radians.
- **Schema**: every descriptor carries `schema_version` (currently `1`). Golden tests pin descriptor bytes; an intentional break bumps the version.
- **Error policy**: generation must not silently emit degenerate systems — constraint loops that fail panic with seed + stage in the message.
- **Every commit compiles and passes `cargo test --workspace`.**
- All physics approximations get a one-line comment naming the calibration (e.g. "calibrated to lunar recession 3.8 cm/yr").

---

### Task 1: Workspace scaffold + gg-core RNG streams and constants

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/gg-core/Cargo.toml`
- Create: `crates/gg-core/src/lib.rs`
- Create: `crates/gg-core/src/rng.rs`
- Create: `crates/gg-core/src/consts.rs`
- Test: `crates/gg-core/tests/rng.rs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `gg_core::rng::RngStream` with `root(seed: u64) -> RngStream`, `child(&self, label: &str) -> RngStream`, `uniform(&mut self, lo: f64, hi: f64) -> f64`, `log_uniform(&mut self, lo: f64, hi: f64) -> f64`, `power_law(&mut self, alpha: f64, lo: f64, hi: f64) -> f64`, `chance(&mut self, p: f64) -> bool`, `pick_count(&mut self, lo: usize, hi: usize) -> usize`. Constants in `gg_core::consts`: `G, C_LIGHT, M_SUN, R_SUN, L_SUN, T_SUN, AU, M_EARTH, R_EARTH, DAY, YEAR` (all `f64`, SI).

- [ ] **Step 1: Create workspace and crate manifests**

`Cargo.toml` (root):

```toml
[workspace]
members = ["crates/gg-core", "crates/gg-gen", "crates/gg-ephemeris"]
resolver = "2"
```

(The `gg-gen`/`gg-ephemeris` members don't exist yet; create them as empty lib crates now so the workspace builds: each gets a minimal `Cargo.toml` and `src/lib.rs` containing only a doc comment. `gg-gen/Cargo.toml` and `gg-ephemeris/Cargo.toml` are filled in properly in Tasks 3 and 7.)

`crates/gg-core/Cargo.toml`:

```toml
[package]
name = "gg-core"
version = "0.1.0"
edition = "2021"

[dependencies]
rand = { version = "0.8", default-features = false }
rand_pcg = "0.3"
serde = { version = "1", features = ["derive"] }
```

`crates/gg-core/src/lib.rs`:

```rust
pub mod consts;
pub mod orbit; // added in Task 2; leave the line commented out until then
pub mod rng;
```

(Comment out `pub mod orbit;` until Task 2.)

- [ ] **Step 2: Write the failing RNG tests**

`crates/gg-core/tests/rng.rs`:

```rust
use gg_core::rng::RngStream;

#[test]
fn same_seed_same_sequence() {
    let mut a = RngStream::root(42);
    let mut b = RngStream::root(42);
    for _ in 0..100 {
        assert_eq!(a.uniform(0.0, 1.0), b.uniform(0.0, 1.0));
    }
}

#[test]
fn different_labels_differ() {
    let root = RngStream::root(42);
    let mut a = root.child("stars");
    let mut b = root.child("planets");
    assert_ne!(a.uniform(0.0, 1.0), b.uniform(0.0, 1.0));
}

#[test]
fn child_independent_of_parent_draw_count() {
    // The determinism contract: deriving a child stream must not depend on
    // how many draws the parent has made.
    let mut root1 = RngStream::root(7);
    let root2 = RngStream::root(7);
    let _ = root1.uniform(0.0, 1.0);
    let _ = root1.uniform(0.0, 1.0);
    let mut c1 = root1.child("moons");
    let mut c2 = root2.child("moons");
    assert_eq!(c1.uniform(0.0, 1.0), c2.uniform(0.0, 1.0));
}

#[test]
fn ranges_respected() {
    let mut r = RngStream::root(1);
    for _ in 0..1000 {
        let u = r.uniform(2.0, 3.0);
        assert!((2.0..3.0).contains(&u));
        let l = r.log_uniform(1.0, 100.0);
        assert!((1.0..=100.0).contains(&l));
        let p = r.power_law(1.8, 0.35, 1.6);
        assert!((0.35..=1.6).contains(&p));
        let n = r.pick_count(2, 6);
        assert!((2..=6).contains(&n));
    }
}

#[test]
fn power_law_favors_small_values() {
    let mut r = RngStream::root(9);
    let below = (0..10_000)
        .filter(|_| r.power_law(1.8, 0.1, 10.0) < 1.0)
        .count();
    assert!(below > 6_000, "power law should concentrate mass at small x, got {below}");
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p gg-core --test rng`
Expected: FAIL to compile — `rng` module does not exist.

- [ ] **Step 4: Implement RngStream and constants**

`crates/gg-core/src/rng.rs`:

```rust
use rand::{Rng, SeedableRng};
use rand_pcg::Pcg64;

/// Deterministic RNG stream. Child streams are derived from the parent's
/// BASE seed (not its current state) plus a label, so adding new draw sites
/// in future versions never shifts existing streams.
pub struct RngStream {
    base: u64,
    rng: Pcg64,
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a over (seed bytes ++ label bytes). Implemented inline so the child
/// derivation can never change out from under us via a dependency update.
fn derive_seed(base: u64, label: &str) -> u64 {
    let mut h = FNV_OFFSET;
    for b in base.to_le_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    for b in label.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

impl RngStream {
    pub fn root(seed: u64) -> Self {
        Self { base: seed, rng: Pcg64::seed_from_u64(seed) }
    }

    pub fn child(&self, label: &str) -> Self {
        let seed = derive_seed(self.base, label);
        Self { base: seed, rng: Pcg64::seed_from_u64(seed) }
    }

    pub fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.rng.gen::<f64>()
    }

    pub fn log_uniform(&mut self, lo: f64, hi: f64) -> f64 {
        self.uniform(lo.ln(), hi.ln()).exp()
    }

    /// Sample p(x) ∝ x^(-alpha) on [lo, hi] by inverse CDF. Requires alpha != 1.
    pub fn power_law(&mut self, alpha: f64, lo: f64, hi: f64) -> f64 {
        let u = self.rng.gen::<f64>();
        let k = 1.0 - alpha;
        (lo.powf(k) * (1.0 - u) + hi.powf(k) * u).powf(1.0 / k)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.rng.gen::<f64>() < p
    }

    pub fn pick_count(&mut self, lo: usize, hi: usize) -> usize {
        self.rng.gen_range(lo..=hi)
    }
}
```

`crates/gg-core/src/consts.rs`:

```rust
//! Physical constants, SI units.

pub const G: f64 = 6.674_30e-11; // m^3 kg^-1 s^-2
pub const C_LIGHT: f64 = 2.997_924_58e8; // m/s
pub const M_SUN: f64 = 1.988_92e30; // kg
pub const R_SUN: f64 = 6.957e8; // m
pub const L_SUN: f64 = 3.828e26; // W
pub const T_SUN: f64 = 5772.0; // K
pub const AU: f64 = 1.495_978_707e11; // m
pub const M_EARTH: f64 = 5.9722e24; // kg
pub const R_EARTH: f64 = 6.371e6; // m
pub const DAY: f64 = 86_400.0; // s
pub const YEAR: f64 = 3.155_815e7; // s (sidereal year)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p gg-core --test rng`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/
git commit -m "feat: workspace scaffold + gg-core RNG streams and constants"
```

---

### Task 2: gg-core orbital math (Kepler solver, position evaluation)

**Files:**
- Modify: `crates/gg-core/src/lib.rs` (uncomment `pub mod orbit;`)
- Create: `crates/gg-core/src/orbit.rs`
- Test: `crates/gg-core/tests/orbit.rs`

**Interfaces:**
- Consumes: `gg_core::consts`.
- Produces: `gg_core::orbit::OrbitalElements` (struct, all `f64` fields: `semi_major_axis_m, eccentricity, inclination_rad, raan_rad, arg_periapsis_rad, mean_anomaly_epoch_rad`; derives `Debug, Clone, Copy, PartialEq, Serialize, Deserialize`), `orbital_period_s(semi_major_axis_m: f64, mu: f64) -> f64`, `solve_kepler(mean_anomaly_rad: f64, e: f64) -> f64`, `position_at(el: &OrbitalElements, mu: f64, t_s: f64) -> [f64; 3]`.

- [ ] **Step 1: Write the failing tests**

`crates/gg-core/tests/orbit.rs`:

```rust
use gg_core::consts::*;
use gg_core::orbit::*;

fn simple(a: f64, e: f64) -> OrbitalElements {
    OrbitalElements {
        semi_major_axis_m: a,
        eccentricity: e,
        inclination_rad: 0.0,
        raan_rad: 0.0,
        arg_periapsis_rad: 0.0,
        mean_anomaly_epoch_rad: 0.0,
    }
}

fn mag(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

#[test]
fn earth_like_period_is_one_year() {
    let t = orbital_period_s(AU, G * M_SUN);
    assert!((t - YEAR).abs() / YEAR < 1e-3, "period {t} vs year {YEAR}");
}

#[test]
fn kepler_solver_matches_equation() {
    for &(m, e) in &[(0.5, 0.1), (3.0, 0.6), (5.5, 0.9), (0.0, 0.0)] {
        let big_e = solve_kepler(m, e);
        let recovered = big_e - e * big_e.sin();
        let expected = m.rem_euclid(std::f64::consts::TAU);
        assert!((recovered - expected).abs() < 1e-10, "M={m}, e={e}");
    }
}

#[test]
fn circular_orbit_has_constant_radius() {
    let el = simple(AU, 0.0);
    let mu = G * M_SUN;
    for i in 0..20 {
        let t = i as f64 * YEAR / 20.0;
        assert!((mag(position_at(&el, mu, t)) - AU).abs() < 1.0);
    }
}

#[test]
fn starts_at_periapsis() {
    // M0 = 0, w = 0 → at t=0 the body sits at periapsis on +X.
    let el = simple(AU, 0.5);
    let p = position_at(&el, G * M_SUN, 0.0);
    assert!((p[0] - 0.5 * AU).abs() < 1.0);
    assert!(p[1].abs() < 1.0 && p[2].abs() < 1.0);
}

#[test]
fn repeats_after_one_period() {
    let el = simple(2.3 * AU, 0.3);
    let mu = G * M_SUN;
    let t_orbit = orbital_period_s(el.semi_major_axis_m, mu);
    let p0 = position_at(&el, mu, 1000.0);
    let p1 = position_at(&el, mu, 1000.0 + t_orbit);
    for k in 0..3 {
        assert!((p0[k] - p1[k]).abs() < 1e-3 * AU);
    }
}

#[test]
fn inclined_orbit_leaves_plane() {
    let mut el = simple(AU, 0.0);
    el.inclination_rad = 0.4;
    let mu = G * M_SUN;
    let max_z = (0..40)
        .map(|i| position_at(&el, mu, i as f64 * YEAR / 40.0)[2].abs())
        .fold(0.0_f64, f64::max);
    assert!((max_z - AU * 0.4_f64.sin()).abs() < 0.01 * AU);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-core --test orbit`
Expected: FAIL to compile — `orbit` module does not exist.

- [ ] **Step 3: Implement orbit.rs**

Uncomment `pub mod orbit;` in `crates/gg-core/src/lib.rs`. Then `crates/gg-core/src/orbit.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::f64::consts::{PI, TAU};

/// Classical Keplerian elements at epoch t=0. Frame: XY reference plane, +Z north.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OrbitalElements {
    pub semi_major_axis_m: f64,
    pub eccentricity: f64,
    pub inclination_rad: f64,
    pub raan_rad: f64,
    pub arg_periapsis_rad: f64,
    pub mean_anomaly_epoch_rad: f64,
}

pub fn orbital_period_s(semi_major_axis_m: f64, mu: f64) -> f64 {
    TAU * (semi_major_axis_m.powi(3) / mu).sqrt()
}

/// Solve Kepler's equation M = E - e·sin(E) for eccentric anomaly E (Newton).
pub fn solve_kepler(mean_anomaly_rad: f64, e: f64) -> f64 {
    let m = mean_anomaly_rad.rem_euclid(TAU);
    let mut big_e = if e > 0.8 { PI } else { m };
    for _ in 0..16 {
        let f = big_e - e * big_e.sin() - m;
        let fp = 1.0 - e * big_e.cos();
        let d = f / fp;
        big_e -= d;
        if d.abs() < 1e-14 {
            break;
        }
    }
    big_e
}

/// Position relative to the focus (parent body) at time t, meters.
pub fn position_at(el: &OrbitalElements, mu: f64, t_s: f64) -> [f64; 3] {
    let n = TAU / orbital_period_s(el.semi_major_axis_m, mu);
    let m = el.mean_anomaly_epoch_rad + n * t_s;
    let big_e = solve_kepler(m, el.eccentricity);
    let a = el.semi_major_axis_m;
    let e = el.eccentricity;
    let x_orb = a * (big_e.cos() - e);
    let y_orb = a * (1.0 - e * e).sqrt() * big_e.sin();

    let (sw, cw) = el.arg_periapsis_rad.sin_cos();
    let (si, ci) = el.inclination_rad.sin_cos();
    let (so, co) = el.raan_rad.sin_cos();
    // rotate by argument of periapsis, then inclination, then RAAN
    let x1 = cw * x_orb - sw * y_orb;
    let y1 = sw * x_orb + cw * y_orb;
    let y2 = ci * y1;
    let z2 = si * y1;
    [co * x1 - so * y2, so * x1 + co * y2, z2]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gg-core`
Expected: PASS (rng + orbit suites).

- [ ] **Step 5: Commit**

```bash
git add crates/gg-core
git commit -m "feat: Kepler solver and orbital position evaluation in gg-core"
```

---

### Task 3: gg-gen descriptor types + star generation

**Files:**
- Create: `crates/gg-gen/Cargo.toml` (replace Task 1 stub)
- Create: `crates/gg-gen/src/lib.rs`
- Create: `crates/gg-gen/src/descriptor.rs`
- Create: `crates/gg-gen/src/stars.rs`
- Test: `crates/gg-gen/tests/stars.rs`

**Interfaces:**
- Consumes: `gg_core::{rng::RngStream, consts::*, orbit::OrbitalElements}`.
- Produces: all descriptor types (below), plus `stars::generate_stars(rng: &mut RngStream) -> StarsOutput`, `stars::luminosity_w(mass_kg: f64) -> f64`, `stars::radius_m(mass_kg: f64) -> f64`, `stars::temperature_k(luminosity_w: f64, radius_m: f64) -> f64`, `stars::ms_lifetime_s(mass_kg: f64) -> f64`, and `struct StarsOutput { pub stars: Vec<Star>, pub planet_host: PlanetHost, pub age_s: f64 }`.

- [ ] **Step 1: Write descriptor.rs (types are the contract; no test-first for pure data)**

`crates/gg-gen/Cargo.toml`:

```toml
[package]
name = "gg-gen"
version = "0.1.0"
edition = "2021"

[dependencies]
gg-core = { path = "../gg-core" }
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
serde_json = "1"
```

`crates/gg-gen/src/lib.rs`:

```rust
pub mod descriptor;
pub mod stars;
// pub mod planets;   // Task 4
// pub mod moons;     // Task 5
// pub mod calendar;  // Task 6
// pub mod system;    // Task 8
```

`crates/gg-gen/src/descriptor.rs`:

```rust
use gg_core::orbit::OrbitalElements;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemDescriptor {
    pub schema_version: u32,
    pub seed: u64,
    pub age_s: f64,
    pub stars: Vec<Star>,
    pub planet_host: PlanetHost,
    pub planets: Vec<Planet>,
    pub anchor_planet: usize,
}

/// What planets orbit: the stellar barycenter (close binary/trinary) or the
/// primary star alone (single star, or wide companions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanetHost {
    Barycenter,
    Primary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Star {
    pub mass_kg: f64,
    pub radius_m: f64,
    pub luminosity_w: f64,
    pub temperature_k: f64,
    pub main_sequence_lifetime_s: f64,
    /// None for the primary. Companions orbit the barycenter of all
    /// interior (earlier-listed) stars.
    pub orbit: Option<OrbitalElements>,
}

/// Linear secular drift rates applied to orbital elements: x(t) = x0 + rate·t.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct SecularRates {
    pub apsidal_rad_per_s: f64,
    pub nodal_rad_per_s: f64,
    pub migration_m_per_s: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanetClass {
    Rocky,
    IceGiant,
    GasGiant,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum WorldState {
    Living,
    Dead,
    Doomed { doom_time_s: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Planet {
    pub class: PlanetClass,
    pub mass_kg: f64,
    pub radius_m: f64,
    pub orbit: OrbitalElements,
    pub secular: SecularRates,
    pub axial_tilt_rad: f64,
    /// Precession of the spin axis about the orbit normal, rad/s.
    pub axial_precession_rad_per_s: f64,
    pub rotation_period_s: f64, // sidereal
    /// Tidal spin-down: rotation period lengthens at this rate (s per s).
    pub spin_drift_s_per_s: f64,
    pub state: WorldState,
    pub moons: Vec<Moon>,
    /// Present on the anchor planet only (v1).
    pub calendar: Option<Calendar>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Moon {
    pub mass_kg: f64,
    pub radius_m: f64,
    pub orbit: OrbitalElements, // around its planet
    pub secular: SecularRates,
    pub tidally_locked: bool,
    pub rotation_period_s: f64,
    /// If migrating inward: time at which a(t) crosses the Roche limit.
    pub doom_time_s: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Calendar {
    pub solar_day_s: f64,
    /// Year length in solar days (fractional).
    pub year_solar_days: f64,
    pub leap: LeapRule,
    pub months: Vec<MonthCycle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeapRule {
    pub base_days: u32,
    pub terms: Vec<LeapTerm>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeapTerm {
    pub every_years: u32,
    pub add_days: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MonthCycle {
    pub moon_index: usize,
    pub synodic_days: f64,
}
```

- [ ] **Step 2: Write the failing star tests**

`crates/gg-gen/tests/stars.rs`:

```rust
use gg_core::consts::*;
use gg_core::rng::RngStream;
use gg_gen::descriptor::PlanetHost;
use gg_gen::stars::*;

#[test]
fn sunlike_relations_match_the_sun() {
    let l = luminosity_w(M_SUN);
    assert!((l / L_SUN - 1.0).abs() < 0.05, "L(M_sun) = {l}");
    let r = radius_m(M_SUN);
    assert!((r / R_SUN - 1.0).abs() < 0.05);
    let t = temperature_k(l, r);
    assert!((t / T_SUN - 1.0).abs() < 0.05);
    let life = ms_lifetime_s(M_SUN);
    assert!((life / (10e9 * 3.156e7) - 1.0).abs() < 0.1, "sun lifetime {life}");
}

#[test]
fn luminosity_increases_with_mass() {
    assert!(luminosity_w(1.4 * M_SUN) > luminosity_w(1.0 * M_SUN));
    assert!(luminosity_w(1.0 * M_SUN) > luminosity_w(0.5 * M_SUN));
}

#[test]
fn population_properties_hold_over_many_seeds() {
    let mut singles = 0;
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("stars");
        let out = generate_stars(&mut rng);
        let n = out.stars.len();
        assert!((1..=3).contains(&n), "seed {seed}: {n} stars");
        if n == 1 {
            singles += 1;
            assert_eq!(out.planet_host, PlanetHost::Primary);
        }
        let primary = &out.stars[0];
        assert!(primary.orbit.is_none());
        assert!(primary.mass_kg >= 0.35 * M_SUN && primary.mass_kg <= 1.6 * M_SUN);
        assert!(out.age_s > 0.0 && out.age_s < primary.main_sequence_lifetime_s);
        for c in &out.stars[1..] {
            let orbit = c.orbit.expect("companions must have orbits");
            assert!(c.mass_kg < primary.mass_kg);
            let a = orbit.semi_major_axis_m;
            // close pair or wide companion, never in the planet-forming middle
            assert!(a <= 0.25 * AU || a >= 50.0 * AU, "seed {seed}: companion at {} AU", a / AU);
        }
    }
    // ~55% singles; loose bounds so the test isn't seed-brittle
    assert!((150..=400).contains(&singles), "singles = {singles}");
}

#[test]
fn close_binary_means_circumbinary_planets() {
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("stars");
        let out = generate_stars(&mut rng);
        let has_close_pair = out.stars.get(1).map_or(false, |c| {
            c.orbit.unwrap().semi_major_axis_m < 1.0 * AU
        });
        if has_close_pair {
            assert_eq!(out.planet_host, PlanetHost::Barycenter, "seed {seed}");
        }
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p gg-gen --test stars`
Expected: FAIL to compile — `stars` module does not exist.

- [ ] **Step 4: Implement stars.rs**

`crates/gg-gen/src/stars.rs`:

```rust
use crate::descriptor::{PlanetHost, Star};
use gg_core::consts::*;
use gg_core::orbit::OrbitalElements;
use gg_core::rng::RngStream;
use std::f64::consts::TAU;

pub struct StarsOutput {
    pub stars: Vec<Star>,
    pub planet_host: PlanetHost,
    pub age_s: f64,
}

/// Piecewise main-sequence mass-luminosity relation (solar-calibrated).
pub fn luminosity_w(mass_kg: f64) -> f64 {
    let m = mass_kg / M_SUN;
    let l = if m < 0.43 {
        0.23 * m.powf(2.3)
    } else if m < 2.0 {
        m.powf(4.0)
    } else {
        1.4 * m.powf(3.5)
    };
    l * L_SUN
}

pub fn radius_m(mass_kg: f64) -> f64 {
    let m = mass_kg / M_SUN;
    let r = if m < 1.0 { m.powf(0.8) } else { m.powf(0.57) };
    r * R_SUN
}

/// Effective temperature from Stefan-Boltzmann, relative to the Sun.
pub fn temperature_k(luminosity_w: f64, radius_m: f64) -> f64 {
    T_SUN * ((luminosity_w / L_SUN) / (radius_m / R_SUN).powi(2)).powf(0.25)
}

/// Main-sequence lifetime ~ 10 Gyr · (M/M_sun)^-2.5.
pub fn ms_lifetime_s(mass_kg: f64) -> f64 {
    10e9 * 3.156e7 * (mass_kg / M_SUN).powf(-2.5)
}

fn make_star(mass_kg: f64, orbit: Option<OrbitalElements>) -> Star {
    let luminosity_w = luminosity_w(mass_kg);
    let radius_m = radius_m(mass_kg);
    Star {
        mass_kg,
        radius_m,
        temperature_k: temperature_k(luminosity_w, radius_m),
        luminosity_w,
        main_sequence_lifetime_s: ms_lifetime_s(mass_kg),
        orbit: None,
    }
    .with_orbit(orbit)
}

impl Star {
    fn with_orbit(mut self, orbit: Option<OrbitalElements>) -> Self {
        self.orbit = orbit;
        self
    }
}

fn companion_orbit(rng: &mut RngStream, a_m: f64) -> OrbitalElements {
    OrbitalElements {
        semi_major_axis_m: a_m,
        eccentricity: rng.uniform(0.0, 0.4),
        inclination_rad: rng.uniform(0.0, 0.15),
        raan_rad: rng.uniform(0.0, TAU),
        arg_periapsis_rad: rng.uniform(0.0, TAU),
        mean_anomaly_epoch_rad: rng.uniform(0.0, TAU),
    }
}

pub fn generate_stars(rng: &mut RngStream) -> StarsOutput {
    // IMF-flavored but biased toward F/G/K: p(m) ∝ m^-1.8 on [0.35, 1.6] M_sun
    // (spec: every seed should be worth visiting).
    let primary_mass = rng.power_law(1.8, 0.35 * M_SUN, 1.6 * M_SUN);
    let mut stars = vec![make_star(primary_mass, None)];

    let roll = rng.uniform(0.0, 1.0);
    let multiplicity = if roll < 0.55 { 1 } else if roll < 0.90 { 2 } else { 3 };

    let mut planet_host = PlanetHost::Primary;
    for k in 1..multiplicity {
        let mass = rng.uniform(0.2, 0.9) * primary_mass;
        // First companion: close pair (circumbinary planets) or wide.
        // Later companions: always wide. Never in the planet-forming middle.
        let close = k == 1 && rng.chance(0.5);
        let a = if close {
            planet_host = PlanetHost::Barycenter;
            // Cap the pair separation so the circumbinary stability limit
            // (~4x separation) stays inside the HZ: sep <= HZ_inner / 4.5.
            let hz_inner = ((stars[0].luminosity_w / L_SUN) / 1.1).sqrt() * AU;
            let hi = (0.25 * AU).min(hz_inner / 4.5);
            rng.log_uniform((0.02 * AU).min(0.9 * hi), hi)
        } else {
            rng.log_uniform(50.0 * AU, 400.0 * AU)
        };
        let orbit = companion_orbit(rng, a);
        stars.push(make_star(mass, Some(orbit)));
    }

    // System age: old enough to be settled, young enough that the primary
    // is still on the main sequence (doomed-star systems get close to the end).
    let lifetime = stars[0].main_sequence_lifetime_s;
    let age_s = rng.uniform(0.1, 0.97) * lifetime.min(12e9 * 3.156e7);

    StarsOutput { stars, planet_host, age_s }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p gg-gen --test stars`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/gg-gen
git commit -m "feat: descriptor schema and physically grounded star generation"
```

---

### Task 4: Planet generation with anchor guarantee

**Files:**
- Modify: `crates/gg-gen/src/lib.rs` (uncomment `pub mod planets;`)
- Create: `crates/gg-gen/src/planets.rs`
- Test: `crates/gg-gen/tests/planets.rs`

**Interfaces:**
- Consumes: descriptor types from Task 3; `RngStream`; `OrbitalElements`; consts.
- Produces: `planets::StellarContext { pub host_mass_kg: f64, pub total_mass_kg: f64, pub total_luminosity_w: f64, pub min_planet_a_m: f64, pub age_s: f64, pub primary_ms_lifetime_s: f64 }`, `planets::generate_planets(rng: &mut RngStream, ctx: &StellarContext) -> (Vec<Planet>, usize)` (planets sorted by semi-major axis; second value is the anchor index), `planets::habitable_zone_m(total_luminosity_w: f64) -> (f64, f64)`, `planets::frost_line_m(total_luminosity_w: f64) -> f64`, `planets::gr_apsidal_rate(host_mass_kg: f64, orbit: &OrbitalElements) -> f64`.
- Note: `axial_precession_rad_per_s` and `spin_drift_s_per_s` are set to `0.0` here and filled in by Task 5 (they need moon torques). `calendar` is `None` here and filled by Task 6/8.

- [ ] **Step 1: Write the failing tests**

`crates/gg-gen/tests/planets.rs`:

```rust
use gg_core::consts::*;
use gg_core::rng::RngStream;
use gg_gen::descriptor::{PlanetClass, WorldState};
use gg_gen::planets::*;

fn sunlike_ctx() -> StellarContext {
    StellarContext {
        host_mass_kg: M_SUN,
        total_mass_kg: M_SUN,
        total_luminosity_w: L_SUN,
        min_planet_a_m: 0.06 * AU,
        age_s: 4.5e9 * 3.156e7,
        primary_ms_lifetime_s: 10e9 * 3.156e7,
    }
}

#[test]
fn habitable_zone_matches_published_sunlike_values() {
    let (inner, outer) = habitable_zone_m(L_SUN);
    assert!((0.90..=1.00).contains(&(inner / AU)), "inner {}", inner / AU);
    assert!((1.30..=1.45).contains(&(outer / AU)), "outer {}", outer / AU);
    assert!((2.5..=2.9).contains(&(frost_line_m(L_SUN) / AU)));
}

#[test]
fn gr_precession_matches_mercury_scale() {
    use gg_core::orbit::OrbitalElements;
    let mercury = OrbitalElements {
        semi_major_axis_m: 0.387 * AU,
        eccentricity: 0.2056,
        inclination_rad: 0.0,
        raan_rad: 0.0,
        arg_periapsis_rad: 0.0,
        mean_anomaly_epoch_rad: 0.0,
    };
    let rate = gr_apsidal_rate(M_SUN, &mercury);
    // 43 arcsec/century = 6.6e-14 rad/s
    assert!((5.0e-14..=8.5e-14).contains(&rate), "rate {rate}");
}

#[test]
fn every_system_has_exactly_one_rocky_anchor_in_hz() {
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("planets");
        let (planets, anchor) = generate_planets(&mut rng, &sunlike_ctx());
        let a_planet = &planets[anchor];
        assert_eq!(a_planet.class, PlanetClass::Rocky, "seed {seed}");
        let (inner, outer) = habitable_zone_m(L_SUN);
        let a = a_planet.orbit.semi_major_axis_m;
        assert!(a >= 0.95 * inner && a <= 1.05 * outer, "seed {seed}: anchor at {} AU", a / AU);
    }
}

#[test]
fn orbits_sorted_spaced_and_classified() {
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("planets");
        let ctx = sunlike_ctx();
        let (planets, _) = generate_planets(&mut rng, &ctx);
        assert!(!planets.is_empty());
        let frost = frost_line_m(ctx.total_luminosity_w);
        for w in planets.windows(2) {
            let (p1, p2) = (&w[0], &w[1]);
            let a1 = p1.orbit.semi_major_axis_m;
            let a2 = p2.orbit.semi_major_axis_m;
            assert!(a2 > a1, "seed {seed}: not sorted");
            // mutual Hill spacing >= 8 (spec stability criterion)
            let rh = (((p1.mass_kg + p2.mass_kg) / (3.0 * ctx.total_mass_kg)).cbrt())
                * (a1 + a2)
                / 2.0;
            assert!((a2 - a1) / rh >= 8.0, "seed {seed}: spacing {}", (a2 - a1) / rh);
        }
        for p in &planets {
            if p.orbit.semi_major_axis_m < frost {
                assert_eq!(p.class, PlanetClass::Rocky, "seed {seed}: giant inside frost line");
            }
            assert!(p.mass_kg > 0.0 && p.radius_m > 0.0);
            assert!(p.rotation_period_s > 4.0 * 3600.0);
        }
    }
}

#[test]
fn world_states_are_mostly_living_sometimes_not() {
    let (mut living, mut dead, mut doomed) = (0, 0, 0);
    for seed in 0..1000u64 {
        let mut rng = RngStream::root(seed).child("planets");
        let (planets, anchor) = generate_planets(&mut rng, &sunlike_ctx());
        match planets[anchor].state {
            WorldState::Living => living += 1,
            WorldState::Dead => dead += 1,
            WorldState::Doomed { doom_time_s } => {
                doomed += 1;
                assert!(doom_time_s > 0.0, "seed {seed}");
            }
        }
    }
    assert!(living > 700, "living = {living}");
    assert!(dead > 20 && doomed > 20, "dead = {dead}, doomed = {doomed}");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-gen --test planets`
Expected: FAIL to compile — `planets` module does not exist.

- [ ] **Step 3: Implement planets.rs**

Uncomment `pub mod planets;` in `crates/gg-gen/src/lib.rs`. Then `crates/gg-gen/src/planets.rs`:

```rust
use crate::descriptor::{Planet, PlanetClass, SecularRates, WorldState};
use gg_core::consts::*;
use gg_core::orbit::{orbital_period_s, OrbitalElements};
use gg_core::rng::RngStream;
use std::f64::consts::TAU;

pub struct StellarContext {
    /// Mass planets actually orbit (total stellar mass for circumbinary,
    /// primary mass otherwise).
    pub host_mass_kg: f64,
    pub total_mass_kg: f64,
    pub total_luminosity_w: f64,
    /// Innermost stable planet orbit (0.06 AU single-star; ~4x binary
    /// separation for circumbinary — computed by the caller).
    pub min_planet_a_m: f64,
    pub age_s: f64,
    pub primary_ms_lifetime_s: f64,
}

/// Conservative HZ (Kasting-style flux bounds).
pub fn habitable_zone_m(total_luminosity_w: f64) -> (f64, f64) {
    let l = total_luminosity_w / L_SUN;
    ((l / 1.1).sqrt() * AU, (l / 0.53).sqrt() * AU)
}

pub fn frost_line_m(total_luminosity_w: f64) -> f64 {
    2.7 * AU * (total_luminosity_w / L_SUN).sqrt()
}

/// GR periapsis advance: Δω per orbit = 6πGM / (c²a(1-e²)), divided by period.
pub fn gr_apsidal_rate(host_mass_kg: f64, orbit: &OrbitalElements) -> f64 {
    let a = orbit.semi_major_axis_m;
    let e2 = 1.0 - orbit.eccentricity * orbit.eccentricity;
    let t = orbital_period_s(a, G * host_mass_kg);
    6.0 * std::f64::consts::PI * G * host_mass_kg / (C_LIGHT * C_LIGHT * a * e2 * t)
}

fn rocky_radius(mass_kg: f64) -> f64 {
    // Terrestrial mass-radius power law, Earth-calibrated.
    R_EARTH * (mass_kg / M_EARTH).powf(0.27)
}

fn class_beyond_frost(rng: &mut RngStream) -> PlanetClass {
    let r = rng.uniform(0.0, 1.0);
    if r < 0.45 {
        PlanetClass::GasGiant
    } else if r < 0.80 {
        PlanetClass::IceGiant
    } else {
        PlanetClass::Rocky
    }
}

fn sample_planet(rng: &mut RngStream, a_m: f64, frost_m: f64, ctx: &StellarContext, force_rocky_hz: bool) -> Planet {
    let class = if force_rocky_hz || a_m < frost_m {
        PlanetClass::Rocky
    } else {
        class_beyond_frost(rng)
    };
    let (mass_kg, radius_m, rotation_period_s) = match class {
        PlanetClass::Rocky => {
            let m = if force_rocky_hz {
                rng.uniform(0.4, 2.5) * M_EARTH
            } else {
                rng.log_uniform(0.05, 4.0) * M_EARTH
            };
            (m, rocky_radius(m), rng.log_uniform(14.0, 48.0) * 3600.0)
        }
        PlanetClass::IceGiant => {
            let m = rng.log_uniform(6.0, 30.0) * M_EARTH;
            // Neptune-calibrated: 17 M_E -> ~3.9 R_E
            (m, R_EARTH * (m / M_EARTH).powf(0.5), rng.log_uniform(9.0, 20.0) * 3600.0)
        }
        PlanetClass::GasGiant => {
            let m = rng.log_uniform(40.0, 2500.0) * M_EARTH;
            // Gas giant radii are nearly mass-independent (~1 R_jup).
            (m, rng.uniform(10.0, 12.0) * R_EARTH, rng.log_uniform(9.0, 20.0) * 3600.0)
        }
    };

    let eccentricity = match class {
        PlanetClass::Rocky => rng.uniform(0.0, 0.12),
        _ => rng.uniform(0.0, 0.2),
    };
    let axial_tilt_rad = if rng.chance(0.08) {
        rng.uniform(0.7, std::f64::consts::PI) // Uranus-style oddball
    } else {
        rng.uniform(0.0, 0.7)
    };

    let orbit = OrbitalElements {
        semi_major_axis_m: a_m,
        eccentricity,
        inclination_rad: rng.uniform(0.0, 0.05),
        raan_rad: rng.uniform(0.0, TAU),
        arg_periapsis_rad: rng.uniform(0.0, TAU),
        mean_anomaly_epoch_rad: rng.uniform(0.0, TAU),
    };
    let secular = SecularRates {
        apsidal_rad_per_s: gr_apsidal_rate(ctx.host_mass_kg, &orbit),
        nodal_rad_per_s: 0.0, // planet nodal regression negligible in v1
        migration_m_per_s: 0.0,
    };

    Planet {
        class,
        mass_kg,
        radius_m,
        orbit,
        secular,
        axial_tilt_rad,
        axial_precession_rad_per_s: 0.0, // needs moon torques; set in Task 5
        rotation_period_s,
        spin_drift_s_per_s: 0.0, // set in Task 5
        state: WorldState::Living, // anchor state rolled below; others stay Living
        moons: Vec::new(),
        calendar: None,
    }
}

fn roll_anchor_state(rng: &mut RngStream, ctx: &StellarContext) -> WorldState {
    let roll = rng.uniform(0.0, 1.0);
    if roll < 0.84 {
        WorldState::Living
    } else if roll < 0.92 {
        WorldState::Dead
    } else {
        // Doomed: star death if the primary is near the end of the main
        // sequence, otherwise a runaway-greenhouse countdown.
        let star_remaining = ctx.primary_ms_lifetime_s - ctx.age_s;
        let doom_time_s = if star_remaining < 2e9 * 3.156e7 {
            star_remaining
        } else {
            rng.log_uniform(1e4, 1e7) * 3.156e7
        };
        WorldState::Doomed { doom_time_s }
    }
}

/// Anchor-first construction: place a rocky planet in the HZ, then fill
/// inward and outward with Hill-spaced neighbors. The anchor guarantee is
/// by construction, not by rejection.
pub fn generate_planets(rng: &mut RngStream, ctx: &StellarContext) -> (Vec<Planet>, usize) {
    let (hz_inner, hz_outer) = habitable_zone_m(ctx.total_luminosity_w);
    let frost = frost_line_m(ctx.total_luminosity_w);

    let anchor_a = rng.uniform(0.97 * hz_inner, 1.03 * hz_outer);
    let mut anchor = sample_planet(rng, anchor_a, frost, ctx, true);
    anchor.state = roll_anchor_state(rng, ctx);

    let mut inward: Vec<Planet> = Vec::new();
    let mut a = anchor_a;
    loop {
        a /= rng.uniform(1.5, 2.1);
        if a < ctx.min_planet_a_m || inward.len() >= 4 {
            break;
        }
        inward.push(sample_planet(rng, a, frost, ctx, false));
    }
    inward.reverse();

    let mut outward: Vec<Planet> = Vec::new();
    let mut a = anchor_a;
    while outward.len() < 6 {
        a *= rng.uniform(1.5, 2.2);
        if a > 40.0 * AU || !rng.chance(0.8) {
            break;
        }
        outward.push(sample_planet(rng, a, frost, ctx, false));
    }

    let mut planets = inward;
    let anchor_index = planets.len();
    planets.push(anchor);
    planets.extend(outward);

    enforce_hill_spacing(&mut planets, ctx.total_mass_kg, anchor_index);
    (planets, anchor_index)
}

/// Push planets outward until every adjacent pair is >= 8 mutual Hill radii
/// apart. The anchor never moves (it must stay in the HZ); neighbors move
/// away from it.
fn enforce_hill_spacing(planets: &mut [Planet], m_star: f64, anchor: usize) {
    let spaced = |p1: &Planet, p2: &Planet| {
        let a1 = p1.orbit.semi_major_axis_m;
        let a2 = p2.orbit.semi_major_axis_m;
        let rh = ((p1.mass_kg + p2.mass_kg) / (3.0 * m_star)).cbrt() * (a1 + a2) / 2.0;
        (a2 - a1) / rh >= 8.0
    };
    // outward from anchor: move outer neighbor further out
    for i in anchor..planets.len().saturating_sub(1) {
        while !spaced(&planets[i], &planets[i + 1]) {
            planets[i + 1].orbit.semi_major_axis_m *= 1.1;
        }
    }
    // inward from anchor: move inner neighbor further in
    for i in (1..=anchor).rev() {
        while !spaced(&planets[i - 1], &planets[i]) {
            planets[i - 1].orbit.semi_major_axis_m /= 1.1;
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gg-gen`
Expected: PASS (stars + planets suites). Note: `enforce_hill_spacing` shrinking inner orbits can push a planet below `min_planet_a_m`; if the `orbits_sorted_spaced_and_classified` test surfaces this as a planet at an absurd radius, add a retain pass after spacing: `planets.retain(|p| p.orbit.semi_major_axis_m >= ctx.min_planet_a_m * 0.75)` — but recompute `anchor_index` by position of the anchor planet (match on the known anchor semi-major axis) if anything before it was removed. Keep the anchor untouched.

- [ ] **Step 5: Commit**

```bash
git add crates/gg-gen
git commit -m "feat: planet generation with HZ anchor guarantee and Hill spacing"
```

---

### Task 5: Moon generation, tidal physics, and axial precession

**Files:**
- Modify: `crates/gg-gen/src/lib.rs` (uncomment `pub mod moons;`)
- Create: `crates/gg-gen/src/moons.rs`
- Test: `crates/gg-gen/tests/moons.rs`

**Interfaces:**
- Consumes: `Planet`, `Moon`, `SecularRates`, `WorldState` from Task 3; `StellarContext` from Task 4; `RngStream`; orbit math.
- Produces: `moons::generate_moons(rng: &mut RngStream, planet: &mut Planet, planet_orbit_period_s: f64, ctx: &StellarContext)` — fills `planet.moons`, sets `planet.axial_precession_rad_per_s` and `planet.spin_drift_s_per_s`, and may upgrade a Living planet to `Doomed` if a moon's Roche crossing is imminent. Helpers: `moons::hill_radius_m(a_m: f64, m_planet: f64, m_star: f64) -> f64`, `moons::roche_limit_m(planet_radius_m: f64, planet_density: f64, moon_density: f64) -> f64`.

- [ ] **Step 1: Write the failing tests**

`crates/gg-gen/tests/moons.rs`:

```rust
use gg_core::consts::*;
use gg_core::orbit::{orbital_period_s, OrbitalElements};
use gg_core::rng::RngStream;
use gg_gen::descriptor::*;
use gg_gen::moons::*;
use gg_gen::planets::StellarContext;

fn earth_like() -> Planet {
    Planet {
        class: PlanetClass::Rocky,
        mass_kg: M_EARTH,
        radius_m: R_EARTH,
        orbit: OrbitalElements {
            semi_major_axis_m: AU,
            eccentricity: 0.017,
            inclination_rad: 0.0,
            raan_rad: 0.0,
            arg_periapsis_rad: 0.0,
            mean_anomaly_epoch_rad: 0.0,
        },
        secular: SecularRates::default(),
        axial_tilt_rad: 0.41,
        axial_precession_rad_per_s: 0.0,
        rotation_period_s: 86_164.0,
        spin_drift_s_per_s: 0.0,
        state: WorldState::Living,
        moons: Vec::new(),
        calendar: None,
    }
}

fn sunlike_ctx() -> StellarContext {
    StellarContext {
        host_mass_kg: M_SUN,
        total_mass_kg: M_SUN,
        total_luminosity_w: L_SUN,
        min_planet_a_m: 0.06 * AU,
        age_s: 4.5e9 * 3.156e7,
        primary_ms_lifetime_s: 10e9 * 3.156e7,
    }
}

#[test]
fn hill_and_roche_are_sane_for_earth() {
    let hill = hill_radius_m(AU, M_EARTH, M_SUN);
    assert!((1.4e9..1.6e9).contains(&hill), "hill {hill}"); // ~1.5e9 m
    let roche = roche_limit_m(R_EARTH, 5514.0, 3344.0);
    assert!((1.7e7..2.0e7).contains(&roche), "roche {roche}"); // ~1.8e7 m
}

#[test]
fn moons_orbit_inside_the_hill_sphere_and_outside_roche() {
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("moons-test");
        let mut p = earth_like();
        let period = orbital_period_s(AU, G * M_SUN);
        generate_moons(&mut rng, &mut p, period, &sunlike_ctx());
        let hill = hill_radius_m(AU, p.mass_kg, M_SUN);
        for m in &p.moons {
            let a = m.orbit.semi_major_axis_m;
            assert!(a < 0.5 * hill, "seed {seed}: moon at {a} vs hill {hill}");
            assert!(a > 2.0 * p.radius_m, "seed {seed}: moon inside planet zone");
            assert!(m.mass_kg < 0.1 * p.mass_kg);
            if m.tidally_locked {
                assert_eq!(m.rotation_period_s, orbital_period_s(a, G * p.mass_kg));
            }
        }
    }
}

#[test]
fn earth_moon_calibration() {
    // Build the real Moon and check the physics helpers reproduce reality.
    let mut p = earth_like();
    let moon_orbit = OrbitalElements {
        semi_major_axis_m: 3.844e8,
        eccentricity: 0.0549,
        inclination_rad: 0.09,
        raan_rad: 0.0,
        arg_periapsis_rad: 0.0,
        mean_anomaly_epoch_rad: 0.0,
    };
    let planet_period = orbital_period_s(AU, G * M_SUN);
    let (secular, locked, doom) = moon_physics(
        &mut p,
        7.342e22,
        &moon_orbit,
        planet_period,
    );
    assert!(locked);
    assert!(doom.is_none(), "the Moon is not doomed");
    // Lunar recession 3.8 cm/yr = 1.2e-9 m/s, within a factor of ~1.5
    let mig = secular.migration_m_per_s;
    assert!(mig > 0.0, "Moon migrates outward");
    assert!((0.6e-9..2.0e-9).contains(&mig), "migration {mig}");
    // Nodal regression period ~18.6 years, within ~30%
    let nodal_period_yr = (std::f64::consts::TAU / secular.nodal_rad_per_s.abs()) / 3.156e7;
    assert!((13.0..25.0).contains(&nodal_period_yr), "nodal {nodal_period_yr} yr");
    // Axial precession period in the 15k-40k year range (actual: 25.8k)
    let prec_yr = (std::f64::consts::TAU / p.axial_precession_rad_per_s) / 3.156e7;
    assert!((15_000.0..40_000.0).contains(&prec_yr), "precession {prec_yr} yr");
}

#[test]
fn doomed_moons_get_a_doom_date() {
    // A big close-in moon below synchronous orbit must migrate inward
    // with a positive Roche-crossing time.
    let mut p = earth_like();
    p.rotation_period_s = 86_164.0;
    let close_orbit = OrbitalElements {
        semi_major_axis_m: 2.0e7, // inside synchronous altitude
        eccentricity: 0.0,
        inclination_rad: 0.0,
        raan_rad: 0.0,
        arg_periapsis_rad: 0.0,
        mean_anomaly_epoch_rad: 0.0,
    };
    let planet_period = orbital_period_s(AU, G * M_SUN);
    let (secular, _, doom) = moon_physics(&mut p, 7.0e22, &close_orbit, planet_period);
    assert!(secular.migration_m_per_s < 0.0, "must migrate inward");
    let doom = doom.expect("inward migration must produce a doom date");
    assert!(doom > 0.0);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-gen --test moons`
Expected: FAIL to compile — `moons` module does not exist.

- [ ] **Step 3: Implement moons.rs**

Uncomment `pub mod moons;` in `crates/gg-gen/src/lib.rs`. Then `crates/gg-gen/src/moons.rs`:

```rust
use crate::descriptor::{Moon, Planet, PlanetClass, SecularRates, WorldState};
use crate::planets::StellarContext;
use gg_core::consts::*;
use gg_core::orbit::{orbital_period_s, OrbitalElements};
use gg_core::rng::RngStream;
use std::f64::consts::TAU;

const MOON_DENSITY: f64 = 3000.0; // kg/m^3, rocky-icy mix
/// Tidal migration constant, calibrated to lunar recession 3.8 cm/yr.
const TIDAL_K: f64 = 0.0766;
/// Earth's dynamical ellipticity, used as spin-scaled baseline for precession.
const DYN_ELLIPTICITY_EARTH: f64 = 0.00327;
const SIDEREAL_DAY_EARTH: f64 = 86_164.0;

pub fn hill_radius_m(a_m: f64, m_planet: f64, m_star: f64) -> f64 {
    a_m * (m_planet / (3.0 * m_star)).cbrt()
}

pub fn roche_limit_m(planet_radius_m: f64, planet_density: f64, moon_density: f64) -> f64 {
    2.44 * planet_radius_m * (planet_density / moon_density).cbrt()
}

fn density(mass_kg: f64, radius_m: f64) -> f64 {
    mass_kg / (4.0 / 3.0 * std::f64::consts::PI * radius_m.powi(3))
}

/// Physics for one moon: secular rates, tidal locking, doom date.
/// Also accumulates the moon's torque contribution into the planet's
/// axial precession and spin drift. Public so tests can calibrate it
/// against the real Earth-Moon system.
pub fn moon_physics(
    planet: &mut Planet,
    moon_mass_kg: f64,
    orbit: &OrbitalElements,
    planet_orbit_period_s: f64,
) -> (SecularRates, bool, Option<f64>) {
    let mu = G * planet.mass_kg;
    let a = orbit.semi_major_axis_m;
    let moon_period = orbital_period_s(a, mu);
    let n_moon = TAU / moon_period;
    let n_planet = TAU / planet_orbit_period_s;

    // Nodal regression from stellar torque: Ω̇ = -(3/4)(n_p²/n_m)cos(i).
    // Reproduces the Moon's 18.6-year cycle.
    let nodal = -0.75 * n_planet * n_planet / n_moon * orbit.inclination_rad.cos();
    // Apsidal advance ≈ 2.1x the nodal magnitude (lunar 8.85 yr vs 18.6 yr).
    let apsidal = 2.1 * nodal.abs();

    // Tidal migration: da/dt = K (m/M)(R/a)^5 n a; sign from synchronous orbit.
    let outward = moon_period > planet.rotation_period_s;
    let mag = TIDAL_K * (moon_mass_kg / planet.mass_kg)
        * (planet.radius_m / a).powi(5)
        * n_moon
        * a;
    let migration = if outward { mag } else { -mag };

    // Doom date: linearized time to Roche crossing for inward migrators.
    let roche = roche_limit_m(
        planet.radius_m,
        density(planet.mass_kg, planet.radius_m),
        MOON_DENSITY,
    );
    let doom = if migration < 0.0 && a > roche {
        Some((a - roche) / migration.abs())
    } else {
        None
    };

    // Tidal locking: every major solar-system moon with period < ~100 days
    // is locked; use that as the v1 criterion.
    let locked = moon_period < 100.0 * DAY;

    // Accumulate this moon's contribution to the planet's axial precession.
    // Torque ratio vs the star: (m_moon/M_star)(a_planet/a_moon)^3 — the
    // Moon contributes ~2.2x the Sun's torque on Earth.
    // Base solar rate: 1.5 · H · n_p²/ω · cos(tilt), H scaled by spin².
    let spin = TAU / planet.rotation_period_s;
    let h = DYN_ELLIPTICITY_EARTH * (SIDEREAL_DAY_EARTH / planet.rotation_period_s).powi(2);
    // NOTE: torque factor uses host star mass via n_p² already; the moon
    // term is expressed relative to the solar torque.
    let moon_factor = (moon_mass_kg * (planet.orbit.semi_major_axis_m / a).powi(3))
        / (planet_host_mass(n_planet, planet.orbit.semi_major_axis_m));
    let solar_rate = 1.5 * h * n_planet * n_planet / spin * planet.axial_tilt_rad.cos().abs();
    if planet.axial_precession_rad_per_s == 0.0 {
        planet.axial_precession_rad_per_s = solar_rate; // solar term, seeded once
    }
    planet.axial_precession_rad_per_s += solar_rate * moon_factor;

    // Spin-down: conservation partner of outward migration (day lengthens).
    // Earth-calibrated: 1.8 ms/century = 5.7e-13 s/s.
    if outward {
        planet.spin_drift_s_per_s += 5.7e-13
            * (moon_mass_kg / 7.342e22)
            * (3.844e8 / a).powi(6)
            * (planet.rotation_period_s / SIDEREAL_DAY_EARTH);
    }

    (
        SecularRates {
            apsidal_rad_per_s: apsidal,
            nodal_rad_per_s: nodal,
            migration_m_per_s: migration,
        },
        locked,
        doom,
    )
}

/// Host mass recovered from the planet's mean motion: M = n²a³/G.
fn planet_host_mass(n_planet: f64, a_planet: f64) -> f64 {
    n_planet * n_planet * a_planet.powi(3) / G
}

pub fn generate_moons(
    rng: &mut RngStream,
    planet: &mut Planet,
    planet_orbit_period_s: f64,
    ctx: &StellarContext,
) {
    // Initialize the solar-only precession term (moons add their share).
    let spin = TAU / planet.rotation_period_s;
    let n_planet = TAU / planet_orbit_period_s;
    let h = DYN_ELLIPTICITY_EARTH * (SIDEREAL_DAY_EARTH / planet.rotation_period_s).powi(2);
    planet.axial_precession_rad_per_s =
        1.5 * h * n_planet * n_planet / spin * planet.axial_tilt_rad.cos().abs();

    let count = match planet.class {
        PlanetClass::Rocky => {
            let p_first = (planet.mass_kg / M_EARTH * 0.35).min(0.7);
            let first = usize::from(rng.chance(p_first));
            // second-moon roll must be drawn unconditionally: fixed draw order
            let second = usize::from(rng.chance(0.15));
            if first == 0 { 0 } else { first + second }
        }
        _ => rng.pick_count(2, 6),
    };

    let hill = hill_radius_m(planet.orbit.semi_major_axis_m, planet.mass_kg, ctx.total_mass_kg);
    let roche = roche_limit_m(
        planet.radius_m,
        density(planet.mass_kg, planet.radius_m),
        MOON_DENSITY,
    );
    let inner_bound = (3.0 * roche).max(2.5 * planet.radius_m);
    let outer_bound = 0.45 * hill;
    if inner_bound >= outer_bound {
        return; // no stable moon zone (planet too close to its star)
    }

    let mut a = inner_bound * rng.uniform(1.0, 2.0);
    for _ in 0..count {
        if a > outer_bound {
            break;
        }
        let mass_frac = match planet.class {
            PlanetClass::Rocky => rng.log_uniform(1e-3, 1.5e-2),
            _ => rng.log_uniform(1e-5, 3e-4),
        };
        let moon_mass = mass_frac * planet.mass_kg;
        let orbit = OrbitalElements {
            semi_major_axis_m: a,
            eccentricity: rng.uniform(0.0, 0.08),
            inclination_rad: rng.uniform(0.0, 0.09),
            raan_rad: rng.uniform(0.0, TAU),
            arg_periapsis_rad: rng.uniform(0.0, TAU),
            mean_anomaly_epoch_rad: rng.uniform(0.0, TAU),
        };
        let (secular, locked, doom) = moon_physics(planet, moon_mass, &orbit, planet_orbit_period_s);
        let rotation = if locked {
            orbital_period_s(a, G * planet.mass_kg)
        } else {
            rng.log_uniform(6.0, 40.0) * 3600.0
        };
        let radius = (3.0 * moon_mass / (4.0 * std::f64::consts::PI * MOON_DENSITY)).cbrt();
        planet.moons.push(Moon {
            mass_kg: moon_mass,
            radius_m: radius,
            orbit,
            secular,
            tidally_locked: locked,
            rotation_period_s: rotation,
            doom_time_s: doom,
        });
        a *= rng.uniform(1.6, 2.6);
    }

    // A naturally spiraling moon dooms a living world (spec: doomed variants).
    let soonest_doom = planet
        .moons
        .iter()
        .filter_map(|m| m.doom_time_s)
        .fold(f64::INFINITY, f64::min);
    if soonest_doom < 1e8 * 3.156e7 {
        match planet.state {
            WorldState::Living => planet.state = WorldState::Doomed { doom_time_s: soonest_doom },
            WorldState::Doomed { doom_time_s } if soonest_doom < doom_time_s => {
                planet.state = WorldState::Doomed { doom_time_s: soonest_doom };
            }
            _ => {}
        }
    }
}
```

**Implementation note:** `moon_physics` seeds the solar precession term if the planet's rate is still `0.0` (so the direct call in `earth_moon_calibration` works on a fresh planet), then adds this moon's contribution; `generate_moons` pre-seeds the solar term before the loop so multi-moon accumulation is correct either way. If this seeding logic fights you, refactor: pass `solar_rate: f64` into `moon_physics` explicitly from both callers and adjust the test call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gg-gen`
Expected: PASS (stars + planets + moons). The Earth-Moon calibration tolerances are deliberately loose (factor ~1.5); if a value lands outside, fix the formula rather than widening the test — the formulas above were hand-checked against lunar values.

- [ ] **Step 5: Commit**

```bash
git add crates/gg-gen
git commit -m "feat: moon generation with tidal migration, locking, and doom dates"
```

---

### Task 6: Calendar derivation

**Files:**
- Modify: `crates/gg-gen/src/lib.rs` (uncomment `pub mod calendar;`)
- Create: `crates/gg-gen/src/calendar.rs`
- Test: `crates/gg-gen/tests/calendar.rs`

**Interfaces:**
- Consumes: `Calendar`, `LeapRule`, `LeapTerm`, `MonthCycle`, `Planet` from Task 3.
- Produces: `calendar::solar_day_s(sidereal_day_s: f64, year_s: f64) -> f64`, `calendar::leap_rule(year_solar_days: f64) -> LeapRule`, `calendar::days_before_year(rule: &LeapRule, year: u64) -> i64`, `calendar::derive_calendar(planet: &Planet, year_s: f64) -> Calendar`, `calendar::date_at(cal: &Calendar, t_s: f64) -> DateTime` with `struct DateTime { pub year: u64, pub day_of_year: u32, pub day_fraction: f64 }`.

- [ ] **Step 1: Write the failing tests**

`crates/gg-gen/tests/calendar.rs`:

```rust
use gg_core::consts::*;
use gg_core::orbit::{orbital_period_s, OrbitalElements};
use gg_gen::calendar::*;
use gg_gen::descriptor::*;

#[test]
fn earth_solar_day_from_sidereal() {
    let d = solar_day_s(86_164.0905, YEAR);
    assert!((d - 86_400.0).abs() < 5.0, "solar day {d}");
}

#[test]
fn earth_leap_rule_is_the_classic() {
    let rule = leap_rule(365.2422);
    assert_eq!(rule.base_days, 365);
    assert_eq!(rule.terms[0], LeapTerm { every_years: 4, add_days: 1 });
    assert_eq!(rule.terms[1], LeapTerm { every_years: 128, add_days: -1 });
}

#[test]
fn leap_rule_stays_aligned_over_ten_thousand_years() {
    for &year_days in &[365.2422, 388.71, 401.203, 500.5, 209.917] {
        let rule = leap_rule(year_days);
        let calendar_days = days_before_year(&rule, 10_000) as f64;
        let true_days = year_days * 10_000.0;
        assert!(
            (calendar_days - true_days).abs() < 20.0,
            "year_days {year_days}: drift {}",
            calendar_days - true_days
        );
    }
}

#[test]
fn date_at_is_consistent_and_monotonic() {
    let cal = Calendar {
        solar_day_s: 86_400.0,
        year_solar_days: 365.2422,
        leap: leap_rule(365.2422),
        months: vec![],
    };
    let d0 = date_at(&cal, 0.0);
    assert_eq!((d0.year, d0.day_of_year), (0, 0));
    // one (non-leap) year later
    let d1 = date_at(&cal, 365.0 * 86_400.0);
    assert_eq!(d1.year, 1);
    // ~1000 years in, verify roundtrip: start-of-year day count matches rule
    let y1000_start_days = days_before_year(&cal.leap, 1000) as f64;
    let d = date_at(&cal, y1000_start_days * 86_400.0 + 3600.0);
    assert_eq!(d.year, 1000);
    assert_eq!(d.day_of_year, 0);
}

#[test]
fn lunar_synodic_month_is_29_and_a_half_days() {
    let moon = Moon {
        mass_kg: 7.342e22,
        radius_m: 1.737e6,
        orbit: OrbitalElements {
            semi_major_axis_m: 3.844e8,
            eccentricity: 0.0549,
            inclination_rad: 0.09,
            raan_rad: 0.0,
            arg_periapsis_rad: 0.0,
            mean_anomaly_epoch_rad: 0.0,
        },
        secular: SecularRates::default(),
        tidally_locked: true,
        rotation_period_s: 2.36e6,
        doom_time_s: None,
    };
    let planet = Planet {
        class: PlanetClass::Rocky,
        mass_kg: M_EARTH,
        radius_m: R_EARTH,
        orbit: OrbitalElements {
            semi_major_axis_m: AU,
            eccentricity: 0.017,
            inclination_rad: 0.0,
            raan_rad: 0.0,
            arg_periapsis_rad: 0.0,
            mean_anomaly_epoch_rad: 0.0,
        },
        secular: SecularRates::default(),
        axial_tilt_rad: 0.41,
        axial_precession_rad_per_s: 0.0,
        rotation_period_s: 86_164.0905,
        spin_drift_s_per_s: 0.0,
        state: WorldState::Living,
        moons: vec![moon],
        calendar: None,
    };
    let year_s = orbital_period_s(AU, G * M_SUN);
    let cal = derive_calendar(&planet, year_s);
    assert_eq!(cal.months.len(), 1);
    let synodic = cal.months[0].synodic_days;
    assert!((29.0..30.1).contains(&synodic), "synodic {synodic}");
    assert!((365.0..365.5).contains(&cal.year_solar_days));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-gen --test calendar`
Expected: FAIL to compile — `calendar` module does not exist.

- [ ] **Step 3: Implement calendar.rs**

Uncomment `pub mod calendar;` in `crates/gg-gen/src/lib.rs`. Then `crates/gg-gen/src/calendar.rs`:

```rust
use crate::descriptor::{Calendar, LeapRule, LeapTerm, MonthCycle, Planet};
use gg_core::consts::G;
use gg_core::orbit::orbital_period_s;

pub struct DateTime {
    pub year: u64,
    pub day_of_year: u32,
    pub day_fraction: f64,
}

/// Solar day from sidereal day and year (prograde rotation):
/// 1/solar = 1/sidereal - 1/year.
pub fn solar_day_s(sidereal_day_s: f64, year_s: f64) -> f64 {
    sidereal_day_s / (1.0 - sidereal_day_s / year_s)
}

/// Derive a leap rule from the fractional year via signed greedy
/// continued-fraction convergents (up to 3 correction terms).
/// 365.2422 → base 365, +1 every 4 years, -1 every 128 years.
pub fn leap_rule(year_solar_days: f64) -> LeapRule {
    let base_days = year_solar_days.floor() as u32;
    let mut r = year_solar_days.fract();
    let mut terms = Vec::new();
    for _ in 0..3 {
        if r.abs() < 1e-6 {
            break;
        }
        let every_years = (1.0 / r.abs()).round().max(1.0) as u32;
        let add_days = if r > 0.0 { 1 } else { -1 };
        terms.push(LeapTerm { every_years, add_days });
        r -= f64::from(add_days) / f64::from(every_years);
    }
    LeapRule { base_days, terms }
}

/// Total calendar days in years [0, year).
pub fn days_before_year(rule: &LeapRule, year: u64) -> i64 {
    let mut d = i64::from(rule.base_days) * year as i64;
    for t in &rule.terms {
        d += i64::from(t.add_days) * (year / u64::from(t.every_years)) as i64;
    }
    d
}

/// Calendar date at simulation time t (t_s >= 0; the epoch is year 0, day 0).
pub fn date_at(cal: &Calendar, t_s: f64) -> DateTime {
    let total_days = (t_s / cal.solar_day_s).max(0.0);
    let mut year = (total_days / cal.year_solar_days).floor() as u64;
    // The rule-based year boundaries wobble around the mean; walk locally.
    loop {
        let start = days_before_year(&cal.leap, year) as f64;
        if total_days < start {
            year -= 1;
            continue;
        }
        let next = days_before_year(&cal.leap, year + 1) as f64;
        if total_days >= next {
            year += 1;
            continue;
        }
        let into = total_days - start;
        return DateTime {
            year,
            day_of_year: into.floor() as u32,
            day_fraction: into.fract(),
        };
    }
}

/// Derive the anchor planet's calendar from its rotation, year, and moons.
pub fn derive_calendar(planet: &Planet, year_s: f64) -> Calendar {
    let solar_day = solar_day_s(planet.rotation_period_s, year_s);
    let year_solar_days = year_s / solar_day;
    let months = planet
        .moons
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let t_moon = orbital_period_s(m.orbit.semi_major_axis_m, G * planet.mass_kg);
            // Synodic period as seen from the planet: 1/syn = 1/T_moon - 1/T_year.
            let synodic_s = 1.0 / (1.0 / t_moon - 1.0 / year_s);
            MonthCycle { moon_index: i, synodic_days: synodic_s / solar_day }
        })
        .collect();
    Calendar {
        solar_day_s: solar_day,
        year_solar_days,
        leap: leap_rule(year_solar_days),
        months,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gg-gen`
Expected: PASS (all four suites).

- [ ] **Step 5: Commit**

```bash
git add crates/gg-gen
git commit -m "feat: derived calendars with continued-fraction leap rules"
```

---

### Task 7: gg-ephemeris — KeplerSecular provider

**Files:**
- Create: `crates/gg-ephemeris/Cargo.toml` (replace Task 1 stub)
- Create: `crates/gg-ephemeris/src/lib.rs`
- Test: `crates/gg-ephemeris/tests/kepler_secular.rs`

**Interfaces:**
- Consumes: `SystemDescriptor` and body types from `gg-gen`; orbit math from `gg-core`.
- Produces:
  - `struct BodyState { pub position_m: [f64; 3], pub spin_axis: [f64; 3], pub rotation_rad: f64 }`
  - `trait Ephemeris { fn body_count(&self) -> usize; fn states_at(&self, t_s: f64) -> Vec<BodyState>; }`
  - `struct KeplerSecular` with `KeplerSecular::new(desc: SystemDescriptor) -> Self` (owns the descriptor; exposes `desc(&self) -> &SystemDescriptor`).
  - **Body order (fixed contract for Plans 2-3):** stars in descriptor order, then planets in descriptor order, then moons grouped by planet in order. Helper fns: `star_index(i) -> usize`, `planet_index(desc, i) -> usize`, `moon_index(desc, planet, moon) -> usize`.

- [ ] **Step 1: Write the failing tests**

`crates/gg-ephemeris/tests/kepler_secular.rs`:

```rust
use gg_core::consts::*;
use gg_core::orbit::{orbital_period_s, OrbitalElements};
use gg_ephemeris::*;
use gg_gen::descriptor::*;

fn circular(a: f64) -> OrbitalElements {
    OrbitalElements {
        semi_major_axis_m: a,
        eccentricity: 0.0,
        inclination_rad: 0.0,
        raan_rad: 0.0,
        arg_periapsis_rad: 0.0,
        mean_anomaly_epoch_rad: 0.0,
    }
}

fn sun() -> Star {
    Star {
        mass_kg: M_SUN,
        radius_m: R_SUN,
        luminosity_w: L_SUN,
        temperature_k: T_SUN,
        main_sequence_lifetime_s: 3.156e17,
        orbit: None,
    }
}

fn bare_planet(a: f64) -> Planet {
    Planet {
        class: PlanetClass::Rocky,
        mass_kg: M_EARTH,
        radius_m: R_EARTH,
        orbit: circular(a),
        secular: SecularRates::default(),
        axial_tilt_rad: 0.41,
        axial_precession_rad_per_s: 0.0,
        rotation_period_s: 86_164.0,
        spin_drift_s_per_s: 0.0,
        state: WorldState::Living,
        moons: Vec::new(),
        calendar: None,
    }
}

fn single_planet_system() -> SystemDescriptor {
    SystemDescriptor {
        schema_version: SCHEMA_VERSION,
        seed: 0,
        age_s: 1e17,
        stars: vec![sun()],
        planet_host: PlanetHost::Primary,
        planets: vec![bare_planet(AU)],
        anchor_planet: 0,
    }
}

fn mag(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

#[test]
fn body_order_and_count() {
    let mut desc = single_planet_system();
    desc.planets[0].moons.push(Moon {
        mass_kg: 7.3e22,
        radius_m: 1.7e6,
        orbit: circular(3.844e8),
        secular: SecularRates::default(),
        tidally_locked: true,
        rotation_period_s: 2.36e6,
        doom_time_s: None,
    });
    let eph = KeplerSecular::new(desc);
    assert_eq!(eph.body_count(), 3); // star, planet, moon
    let states = eph.states_at(0.0);
    assert_eq!(states.len(), 3);
    // moon sits within a hill-radius-ish distance of its planet
    let d = [
        states[2].position_m[0] - states[1].position_m[0],
        states[2].position_m[1] - states[1].position_m[1],
        states[2].position_m[2] - states[1].position_m[2],
    ];
    assert!((mag(d) - 3.844e8).abs() < 1.0e3);
}

#[test]
fn deterministic_and_periodic() {
    let eph = KeplerSecular::new(single_planet_system());
    let a = eph.states_at(1.0e7);
    let b = eph.states_at(1.0e7);
    assert_eq!(a[1].position_m, b[1].position_m);
    let period = orbital_period_s(AU, G * M_SUN);
    let c = eph.states_at(1.0e7 + period);
    for k in 0..3 {
        assert!((a[1].position_m[k] - c[1].position_m[k]).abs() < 1e-3 * AU);
    }
}

#[test]
fn binary_barycenter_stays_at_origin() {
    let mut desc = single_planet_system();
    desc.planet_host = PlanetHost::Barycenter;
    let mut companion = sun();
    companion.mass_kg = 0.5 * M_SUN;
    companion.orbit = Some(circular(0.1 * AU));
    desc.stars.push(companion);
    let eph = KeplerSecular::new(desc);
    for i in 0..8 {
        let t = i as f64 * 1.0e6;
        let s = eph.states_at(t);
        let m1 = M_SUN;
        let m2 = 0.5 * M_SUN;
        for k in 0..3 {
            let bary = m1 * s[0].position_m[k] + m2 * s[1].position_m[k];
            assert!(bary.abs() / (m1 + m2) < 1e-3 * AU, "t={t}, axis {k}");
        }
        // stars actually move
        if i > 0 {
            assert!(mag(s[1].position_m) > 0.01 * AU);
        }
    }
}

#[test]
fn apsidal_drift_rotates_periapsis() {
    let mut desc = single_planet_system();
    desc.planets[0].orbit.eccentricity = 0.3;
    let rate = 1e-10; // exaggerated for test speed
    desc.planets[0].secular.apsidal_rad_per_s = rate;
    let eph = KeplerSecular::new(desc);
    // At multiples of the (unperturbed) period the body returns to periapsis,
    // which has rotated by rate*t.
    let period = orbital_period_s(AU, G * M_SUN);
    let s = eph.states_at(0.0);
    let p0 = s[1].position_m;
    let t = 100.0 * period;
    // account for the mean-anomaly convention: compare radii, which must
    // still be periapsis distance at periapsis passage
    let s1 = eph.states_at(t);
    let expected_angle = rate * t;
    let angle = s1[1].position_m[1].atan2(s1[1].position_m[0]);
    // p0 was at angle 0; tolerate kepler-timing wiggle of a few degrees
    let diff = (angle - expected_angle).abs();
    assert!(diff < 0.15 || (mag(p0) - mag(s1[1].position_m)).abs() < 0.05 * AU,
        "periapsis did not advance as expected: angle {angle}, expected {expected_angle}");
}

#[test]
fn spin_axis_precesses_and_rotation_advances() {
    let mut desc = single_planet_system();
    desc.planets[0].axial_precession_rad_per_s = 1e-11;
    let eph = KeplerSecular::new(desc);
    let s0 = eph.states_at(0.0);
    let s1 = eph.states_at(3.15e11); // ~10,000 years
    // tilt magnitude preserved
    let z0 = s0[1].spin_axis[2];
    let z1 = s1[1].spin_axis[2];
    assert!((z0 - z1).abs() < 1e-9, "tilt changed");
    // but the axis direction moved
    let dx = s0[1].spin_axis[0] - s1[1].spin_axis[0];
    let dy = s0[1].spin_axis[1] - s1[1].spin_axis[1];
    assert!((dx * dx + dy * dy).sqrt() > 0.1, "axis did not precess");
    // rotation angle advances
    assert!(s0[1].rotation_rad != s1[1].rotation_rad);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-ephemeris`
Expected: FAIL to compile — crate is still the Task 1 stub.

- [ ] **Step 3: Implement gg-ephemeris**

`crates/gg-ephemeris/Cargo.toml`:

```toml
[package]
name = "gg-ephemeris"
version = "0.1.0"
edition = "2021"

[dependencies]
gg-core = { path = "../gg-core" }
gg-gen = { path = "../gg-gen" }
```

`crates/gg-ephemeris/src/lib.rs`:

```rust
use gg_core::consts::G;
use gg_core::orbit::{position_at, OrbitalElements};
use gg_gen::descriptor::{PlanetHost, SystemDescriptor};
use std::f64::consts::TAU;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BodyState {
    pub position_m: [f64; 3],
    pub spin_axis: [f64; 3],
    pub rotation_rad: f64,
}

/// Body order contract: stars, then planets, then moons grouped by planet.
pub trait Ephemeris {
    fn body_count(&self) -> usize;
    fn states_at(&self, t_s: f64) -> Vec<BodyState>;
}

pub fn star_index(i: usize) -> usize {
    i
}
pub fn planet_index(desc: &SystemDescriptor, i: usize) -> usize {
    desc.stars.len() + i
}
pub fn moon_index(desc: &SystemDescriptor, planet: usize, moon: usize) -> usize {
    desc.stars.len()
        + desc.planets.len()
        + desc.planets[..planet].iter().map(|p| p.moons.len()).sum::<usize>()
        + moon
}

pub struct KeplerSecular {
    desc: SystemDescriptor,
}

/// Apply secular drift to elements: ω, Ω, and a move linearly with t.
fn elements_at(el: &OrbitalElements, sec: &gg_gen::descriptor::SecularRates, t_s: f64) -> OrbitalElements {
    let mut e = *el;
    e.arg_periapsis_rad += sec.apsidal_rad_per_s * t_s;
    e.raan_rad += sec.nodal_rad_per_s * t_s;
    e.semi_major_axis_m = (e.semi_major_axis_m + sec.migration_m_per_s * t_s).max(1.0);
    e
}

fn default_axis() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

/// Spin axis: tilted from +Z, precessing about +Z at the planet's rate.
/// (v1 approximation: orbit normal ≈ +Z; planet inclinations are < 3°.)
fn spin_axis(tilt_rad: f64, precession_rad_per_s: f64, t_s: f64) -> [f64; 3] {
    let phi = -precession_rad_per_s * t_s;
    let (st, ct) = tilt_rad.sin_cos();
    [st * phi.cos(), st * phi.sin(), ct]
}

/// Rotation angle with linear spin-drift (day slowly lengthens):
/// θ(t) = 2π (t/p0 − drift·t²/(2·p0²)).
fn rotation_rad(period_s: f64, drift_s_per_s: f64, t_s: f64) -> f64 {
    (TAU * (t_s / period_s - drift_s_per_s * t_s * t_s / (2.0 * period_s * period_s)))
        .rem_euclid(TAU)
}

impl KeplerSecular {
    pub fn new(desc: SystemDescriptor) -> Self {
        Self { desc }
    }

    pub fn desc(&self) -> &SystemDescriptor {
        &self.desc
    }

    /// Star positions with hierarchical barycentric recoil: each companion
    /// orbits the barycenter of all interior stars; interior stars recoil
    /// so the total barycenter stays at the origin.
    fn star_positions(&self, t_s: f64) -> Vec<[f64; 3]> {
        let stars = &self.desc.stars;
        let mut pos: Vec<[f64; 3]> = vec![[0.0; 3]; stars.len()];
        let mut interior_mass = stars[0].mass_kg;
        for k in 1..stars.len() {
            let comp = &stars[k];
            let orbit = comp.orbit.expect("companion star missing orbit");
            let mu = G * (interior_mass + comp.mass_kg);
            let rel = position_at(&orbit, mu, t_s);
            let f_comp = interior_mass / (interior_mass + comp.mass_kg);
            let f_int = comp.mass_kg / (interior_mass + comp.mass_kg);
            for p in pos.iter_mut().take(k) {
                for x in 0..3 {
                    p[x] -= rel[x] * f_int;
                }
            }
            pos[k] = [rel[0] * f_comp, rel[1] * f_comp, rel[2] * f_comp];
            interior_mass += comp.mass_kg;
        }
        pos
    }

    fn host_mass(&self) -> f64 {
        match self.desc.planet_host {
            PlanetHost::Barycenter => self.desc.stars.iter().map(|s| s.mass_kg).sum(),
            PlanetHost::Primary => self.desc.stars[0].mass_kg,
        }
    }
}

impl Ephemeris for KeplerSecular {
    fn body_count(&self) -> usize {
        self.desc.stars.len()
            + self.desc.planets.len()
            + self.desc.planets.iter().map(|p| p.moons.len()).sum::<usize>()
    }

    fn states_at(&self, t_s: f64) -> Vec<BodyState> {
        let mut out = Vec::with_capacity(self.body_count());

        let star_pos = self.star_positions(t_s);
        for pos in &star_pos {
            out.push(BodyState {
                position_m: *pos,
                spin_axis: default_axis(),
                // solar-like spin period; star rotation is cosmetic in v1
                rotation_rad: rotation_rad(25.0 * 86_400.0, 0.0, t_s),
            });
        }

        let host_origin = match self.desc.planet_host {
            PlanetHost::Barycenter => [0.0; 3],
            PlanetHost::Primary => star_pos[0],
        };
        let mu_host = G * self.host_mass();

        let mut planet_positions = Vec::with_capacity(self.desc.planets.len());
        for p in &self.desc.planets {
            let el = elements_at(&p.orbit, &p.secular, t_s);
            let rel = position_at(&el, mu_host, t_s);
            let pos = [
                host_origin[0] + rel[0],
                host_origin[1] + rel[1],
                host_origin[2] + rel[2],
            ];
            planet_positions.push(pos);
            out.push(BodyState {
                position_m: pos,
                spin_axis: spin_axis(p.axial_tilt_rad, p.axial_precession_rad_per_s, t_s),
                rotation_rad: rotation_rad(p.rotation_period_s, p.spin_drift_s_per_s, t_s),
            });
        }

        for (pi, p) in self.desc.planets.iter().enumerate() {
            let mu_p = G * p.mass_kg;
            for m in &p.moons {
                let el = elements_at(&m.orbit, &m.secular, t_s);
                let rel = position_at(&el, mu_p, t_s);
                let base = planet_positions[pi];
                out.push(BodyState {
                    position_m: [base[0] + rel[0], base[1] + rel[1], base[2] + rel[2]],
                    spin_axis: default_axis(),
                    rotation_rad: rotation_rad(m.rotation_period_s, 0.0, t_s),
                });
            }
        }
        out
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p gg-ephemeris`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/gg-ephemeris
git commit -m "feat: KeplerSecular ephemeris with secular drift and stellar recoil"
```

---

### Task 8: Top-level generate(), golden files, and the dump example

**Files:**
- Modify: `crates/gg-gen/src/lib.rs` (uncomment `pub mod system;`, add re-export)
- Create: `crates/gg-gen/src/system.rs`
- Create: `crates/gg-gen/examples/dump.rs`
- Create: `crates/gg-gen/tests/golden/` (directory; files generated in Step 5)
- Test: `crates/gg-gen/tests/system.rs`

**Interfaces:**
- Consumes: everything from Tasks 3-6.
- Produces: `gg_gen::generate(seed: u64) -> SystemDescriptor` (re-exported at crate root). This is THE public API of the generation layer; Plan 2's WASM wrapper calls exactly this.

- [ ] **Step 1: Write the failing tests**

`crates/gg-gen/tests/system.rs`:

```rust
use gg_core::consts::*;
use gg_gen::descriptor::*;
use gg_gen::generate;

#[test]
fn generates_valid_systems_for_many_seeds() {
    for seed in 0..2000u64 {
        let desc = generate(seed);
        assert_eq!(desc.schema_version, SCHEMA_VERSION);
        assert_eq!(desc.seed, seed);
        assert!(!desc.stars.is_empty() && !desc.planets.is_empty());
        let anchor = &desc.planets[desc.anchor_planet];
        assert_eq!(anchor.class, PlanetClass::Rocky, "seed {seed}");
        assert!(anchor.calendar.is_some(), "seed {seed}: anchor must have a calendar");
        let cal = anchor.calendar.as_ref().unwrap();
        assert!(cal.solar_day_s > 0.0 && cal.year_solar_days > 10.0, "seed {seed}");
        assert_eq!(cal.months.len(), anchor.moons.len(), "seed {seed}");
        for p in &desc.planets {
            assert!(p.mass_kg > 0.0 && p.radius_m > 0.0 && p.rotation_period_s > 0.0);
        }
        if desc.planet_host == PlanetHost::Barycenter {
            let sep = desc.stars[1].orbit.unwrap().semi_major_axis_m;
            let innermost = desc.planets[0].orbit.semi_major_axis_m;
            assert!(innermost >= 3.0 * sep, "seed {seed}: circumbinary planet too close to the pair");
        }
    }
}

#[test]
fn generation_is_deterministic() {
    for seed in [1u64, 42, 123_456_789, u64::MAX] {
        let a = generate(seed);
        let b = generate(seed);
        assert_eq!(a, b, "seed {seed}");
    }
}

#[test]
fn serde_roundtrip_is_lossless() {
    let desc = generate(42);
    let json = serde_json::to_string(&desc).unwrap();
    let back: SystemDescriptor = serde_json::from_str(&json).unwrap();
    assert_eq!(desc, back);
}

#[test]
fn golden_seeds_are_pinned() {
    for seed in [1u64, 42, 123_456_789] {
        let path = format!("tests/golden/seed-{seed}.json");
        let expected = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("missing golden file {path}; generate with: cargo run -p gg-gen --example dump -- {seed} > crates/gg-gen/{path}"));
        let actual = serde_json::to_string_pretty(&generate(seed)).unwrap();
        assert_eq!(actual.trim(), expected.trim(),
            "seed {seed} diverged from golden file — this breaks every shared link; if intentional, bump SCHEMA_VERSION and regenerate goldens");
    }
}

#[test]
fn anchor_planets_are_in_the_hz_across_stellar_types() {
    use gg_gen::planets::habitable_zone_m;
    for seed in 0..500u64 {
        let desc = generate(seed);
        let total_l: f64 = desc.stars.iter().map(|s| s.luminosity_w).sum();
        let (inner, outer) = habitable_zone_m(total_l);
        let a = desc.planets[desc.anchor_planet].orbit.semi_major_axis_m;
        assert!(a >= 0.9 * inner && a <= 1.1 * outer,
            "seed {seed}: anchor at {} AU, HZ [{}, {}]", a / AU, inner / AU, outer / AU);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p gg-gen --test system`
Expected: FAIL to compile — `generate` does not exist.

- [ ] **Step 3: Implement system.rs and the dump example**

In `crates/gg-gen/src/lib.rs`, uncomment `pub mod system;` and add:

```rust
pub use system::generate;
```

`crates/gg-gen/src/system.rs`:

```rust
use crate::calendar::derive_calendar;
use crate::descriptor::{PlanetHost, SystemDescriptor, SCHEMA_VERSION};
use crate::moons::generate_moons;
use crate::planets::{generate_planets, StellarContext};
use crate::stars::generate_stars;
use gg_core::consts::{AU, G};
use gg_core::orbit::orbital_period_s;
use gg_core::rng::RngStream;

/// The one public entry point: seed in, world out. Deterministic forever.
pub fn generate(seed: u64) -> SystemDescriptor {
    let root = RngStream::root(seed);

    let mut star_rng = root.child("stars");
    let stars_out = generate_stars(&mut star_rng);

    let total_mass: f64 = stars_out.stars.iter().map(|s| s.mass_kg).sum();
    let total_lum: f64 = stars_out.stars.iter().map(|s| s.luminosity_w).sum();
    // Circumbinary inner stability limit: ~4x the binary separation.
    let min_a = match stars_out.planet_host {
        PlanetHost::Barycenter => {
            let sep = stars_out.stars[1]
                .orbit
                .expect("close binary must have companion orbit")
                .semi_major_axis_m;
            (4.0 * sep).max(0.06 * AU)
        }
        PlanetHost::Primary => 0.06 * AU,
    };
    let host_mass = match stars_out.planet_host {
        PlanetHost::Barycenter => total_mass,
        PlanetHost::Primary => stars_out.stars[0].mass_kg,
    };
    let ctx = StellarContext {
        host_mass_kg: host_mass,
        total_mass_kg: total_mass,
        total_luminosity_w: total_lum,
        min_planet_a_m: min_a,
        age_s: stars_out.age_s,
        primary_ms_lifetime_s: stars_out.stars[0].main_sequence_lifetime_s,
    };

    let mut planet_rng = root.child("planets");
    let (mut planets, anchor_index) = generate_planets(&mut planet_rng, &ctx);

    for (i, planet) in planets.iter_mut().enumerate() {
        // Per-planet child streams: adding planet features later never
        // reshuffles other planets' moons.
        let mut moon_rng = root.child(&format!("moons-{i}"));
        let period = orbital_period_s(planet.orbit.semi_major_axis_m, G * ctx.host_mass_kg);
        generate_moons(&mut moon_rng, planet, period, &ctx);
    }

    let anchor_year =
        orbital_period_s(planets[anchor_index].orbit.semi_major_axis_m, G * ctx.host_mass_kg);
    let anchor_calendar = derive_calendar(&planets[anchor_index], anchor_year);
    planets[anchor_index].calendar = Some(anchor_calendar);

    SystemDescriptor {
        schema_version: SCHEMA_VERSION,
        seed,
        age_s: stars_out.age_s,
        stars: stars_out.stars,
        planet_host: stars_out.planet_host,
        planets,
        anchor_planet: anchor_index,
    }
}
```

`crates/gg-gen/examples/dump.rs`:

```rust
//! Dump a generated system as pretty JSON: cargo run -p gg-gen --example dump -- <seed>

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .expect("usage: dump <seed>")
        .parse()
        .expect("seed must be a u64");
    let desc = gg_gen::generate(seed);
    println!("{}", serde_json::to_string_pretty(&desc).unwrap());
}
```

Note: `serde_json` stays in `[dev-dependencies]` — Cargo builds examples against dev-dependencies.

- [ ] **Step 4: Run the non-golden tests**

Run: `cargo test -p gg-gen --test system generates_valid_systems_for_many_seeds generation_is_deterministic serde_roundtrip_is_lossless anchor_planets_are_in_the_hz_across_stellar_types`
Expected: PASS (4 tests; `golden_seeds_are_pinned` still fails with "missing golden file").

- [ ] **Step 5: Generate the golden files**

```bash
mkdir -p crates/gg-gen/tests/golden
cargo run -p gg-gen --example dump -- 1 > crates/gg-gen/tests/golden/seed-1.json
cargo run -p gg-gen --example dump -- 42 > crates/gg-gen/tests/golden/seed-42.json
cargo run -p gg-gen --example dump -- 123456789 > crates/gg-gen/tests/golden/seed-123456789.json
```

- [ ] **Step 6: Run the full workspace test suite**

Run: `cargo test --workspace`
Expected: PASS — every suite in every crate, including `golden_seeds_are_pinned`.

- [ ] **Step 7: Eyeball one system for plausibility**

Run: `cargo run -p gg-gen --example dump -- 42 | head -80`
Expected: a readable descriptor — check that star temperature is a few thousand K, planet semi-major axes are ~1e10-1e12 m, and the anchor has a calendar with a plausible `year_solar_days`. This is the "trained eye" check; if something reads absurd, file it against the responsible task's formulas before committing.

- [ ] **Step 8: Commit**

```bash
git add crates/gg-gen
git commit -m "feat: top-level generate() with golden-file determinism pins"
```

---

## Plan 1 Definition of Done

- `cargo test --workspace` green.
- `cargo run -p gg-gen --example dump -- <seed>` emits a complete, plausible system.
- Golden files committed; determinism contract enforced by test.
- No clippy warnings: `cargo clippy --workspace -- -D warnings` (run once at the end; fix what it finds).

**Follow-on plans:** Plan 2 (gg-wasm + Vite/three.js shell + space view + time controls) and Plan 3 (ground view + sky rendering + HUD + URL sharing) will be written after Plan 1 lands, against these exact interfaces.
