# Goldengrove v1 — Plan 2: WASM Boundary + Space View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goldengrove becomes visible: a browser app where a seed produces a navigable 3D orrery with running time and a live calendar readout.

**Architecture:** Plan 1's crates stay untouched in behavior except two contracted changes (libm migration per the spec's wasm32-canonical policy; backlog hardening). A new `gg-wasm` crate exposes the coarse three-call boundary. A Vite + TypeScript + three.js app (`web/`) renders the space view: true-scale physics in, view-space compression out. Spec: `docs/superpowers/specs/2026-07-03-goldengrove-v1-orrery-design.md`.

**Tech Stack:** Rust (wasm-bindgen 0.2, js-sys 0.3, libm 0.2, wasm-bindgen-test 0.3, wasm-pack), TypeScript ~5.5, Vite ^5.4, three ^0.166, vitest ^2 (happy-dom).

## Global Constraints

- **Determinism contract unchanged**: bit-identical `SystemDescriptor` per seed. Task 1 intentionally breaks goldens ONCE (libm migration) and bumps `SCHEMA_VERSION` to 2; no other task may alter generation output.
- **Canonical target is wasm32** (spec, Determinism contract section): Task 3's wasm parity test and Task 7's CI make this enforceable.
- **New Rust deps limited to**: `libm 0.2` (gg-core), `wasm-bindgen 0.2` + `js-sys 0.3` + `serde_json 1` (gg-wasm), `wasm-bindgen-test 0.3` (dev). **New JS deps limited to**: `three ^0.166`, dev: `typescript ~5.5`, `vite ^5.4`, `vitest ^2`, `@types/three ^0.166`, `happy-dom ^15`, `@types/node` (types-only; the vitest suites import `node:fs`/`node:path` to read golden fixtures).
- **WASM boundary is coarse** (spec): construct-once `World`, per-frame `states_at(t) → Float64Array`, static `descriptor_json()`/`orbit_path()`, `anchor_date_json(t)`. No chatty per-object calls.
- **Flat state layout is contract**: 7 f64 per body — `[x_m, y_m, z_m, axis_x, axis_y, axis_z, rotation_rad]`, body order identical to gg-ephemeris (stars, planets, moons grouped by planet).
- **Seeds cross the JS boundary as decimal strings** (u64 exceeds JS safe integers; descriptor JSON already serializes seed as string).
- Every commit compiles, passes `cargo test --workspace`, and (once `web/` exists) passes `npm test` in `web/`.
- Tools assumed: `wasm-pack` and the `wasm32-unknown-unknown` target. If missing: `brew install wasm-pack` (per user CLAUDE.md, install missing tools via Homebrew) and `rustup target add wasm32-unknown-unknown`.

## File Structure

```
crates/
├── gg-core/src/math.rs        # NEW: libm wrappers (deterministic transcendentals)
└── gg-wasm/                   # NEW crate: the boundary
    ├── src/lib.rs             # #[wasm_bindgen] World
    ├── src/flatten.rs         # pure state-flattening + orbit paths (native-testable)
    └── tests/{flatten.rs, wasm_golden.rs}
web/                           # NEW: Vite + TS + three.js app
├── index.html, package.json, tsconfig.json, vite.config.ts
└── src/
    ├── main.ts                # boot + render loop + interaction
    ├── styles.css
    ├── sim/{types.ts, parse.ts, layout.ts, wasm.ts}   # descriptor types/validation, body layout, WASM wrapper
    ├── time/clock.ts          # SimClock
    ├── views/{compression.ts, space.ts, color.ts}     # view-space math, scene builder, star colors
    └── ui/hud.ts              # seed/reroll, play/speed, date readout, true-scale toggle
.github/workflows/ci.yml      # NEW: native tests + clippy + wasm parity + web tests + build
```

---

### Task 1: libm migration — deterministic transcendentals (SCHEMA_VERSION 2)

**Files:**
- Modify: `crates/gg-core/Cargo.toml` (add `libm = "0.2"`)
- Create: `crates/gg-core/src/math.rs`
- Modify: `crates/gg-core/src/lib.rs` (add `pub mod math;`)
- Modify: `crates/gg-core/src/rng.rs` (log_uniform, power_law)
- Modify: `crates/gg-gen/src/stars.rs`, `crates/gg-gen/src/planets.rs`, `crates/gg-gen/src/moons.rs` (all `powf`/`cbrt` call sites)
- Modify: `crates/gg-gen/src/descriptor.rs` (`SCHEMA_VERSION` 1 → 2)
- Modify: `crates/gg-gen/tests/golden/*.json` (regenerated, LAST step)

**Interfaces:**
- Consumes: existing gg-core/gg-gen code.
- Produces: `gg_core::math::{powf, ln, exp, cbrt, cos}` — all `(f64, …) -> f64`, `#[inline]`. Every generation-path transcendental call goes through these from now on (binding on all future tasks/plans).

Why: Rust's std float methods call the platform's libm on native targets but Rust-internal implementations on wasm32; results differ by ULPs, and serde_json's shortest-roundtrip float printing turns 1 ULP into different descriptor bytes. The spec records wasm32 as the canonical target. `libm` (rust-lang's pure-Rust port) computes identical bits on every target using only IEEE-exact primitive ops. `sqrt`, `powi`, `floor`, `round`, `fract`, `rem_euclid` are IEEE-exact everywhere and stay as-is. gg-ephemeris keeps std math deliberately — its output is per-frame rendering, never byte-pinned.

- [ ] **Step 1: Write the failing test**

Append to `crates/gg-gen/tests/system.rs`:

```rust
#[test]
fn schema_version_is_2_after_libm_migration() {
    assert_eq!(SCHEMA_VERSION, 2);
    let desc = generate(42);
    assert_eq!(desc.schema_version, 2);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p gg-gen --test system schema_version_is_2_after_libm_migration`
Expected: FAIL — `SCHEMA_VERSION` is 1.

- [ ] **Step 3: Implement math.rs and migrate call sites**

`crates/gg-core/Cargo.toml` — add under `[dependencies]`:

```toml
libm = "0.2"
```

`crates/gg-core/src/math.rs`:

```rust
//! Deterministic transcendental math for generation paths.
//!
//! Rust's std float methods use the platform libm on native targets but
//! Rust-internal code on wasm32 — ULP-level differences that break the
//! bit-identical descriptor contract (the canonical target is wasm32; see
//! the spec's Determinism contract). `libm` computes identical bits on
//! every target. All descriptor-affecting code MUST use these wrappers.
//! IEEE-exact ops (`sqrt`, `powi`, `floor`, `round`, `fract`) are fine as
//! std methods. gg-ephemeris intentionally keeps std math: its output is
//! per-frame rendering, never byte-pinned.

#[inline]
pub fn powf(x: f64, y: f64) -> f64 {
    libm::pow(x, y)
}

#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}

#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

#[inline]
pub fn cbrt(x: f64) -> f64 {
    libm::cbrt(x)
}

#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}
```

Add `pub mod math;` to `crates/gg-core/src/lib.rs`.

Migrate call sites — mechanical, value-for-value (`x.powf(y)` → `math::powf(x, y)`, `x.ln()` → `math::ln(x)`, `x.exp()` → `math::exp(x)`, `x.cbrt()` → `math::cbrt(x)`), with `use gg_core::math;` (or `use crate::math;` inside gg-core):

- `crates/gg-core/src/rng.rs`: `log_uniform` (`ln`, `exp`), `power_law` (three `powf`).
- `crates/gg-gen/src/stars.rs`: `luminosity_w` (three `powf`), `radius_m` (two `powf`), `temperature_k` (`powf(…, 0.25)`), `ms_lifetime_s` (`powf`), and the HZ `sqrt` stays std (exact).
- `crates/gg-gen/src/planets.rs`: `rocky_radius` (`powf`), ice-giant radius (`powf`), the mutual-Hill `cbrt` in both `generate_planets`/`enforce_hill_spacing` paths and the spacing `k_of` closure.
- `crates/gg-gen/src/moons.rs`: `hill_radius_m` (`cbrt`), `roche_limit_m` (`cbrt`), the moon-radius `cbrt` in `generate_moons`, AND the three `.cos()` sites (nodal regression from `orbit.inclination_rad`; axial-precession tilt terms in `moon_physics` and `generate_moons`) -> `math::cos` — they feed `nodal_rad_per_s` and `axial_precession_rad_per_s`, which are byte-pinned.

Leave every `sqrt`, `powi`, `sin_cos`, `sin` untouched in gg-core/orbit.rs and gg-ephemeris (render-path only). Generation-path `.cos()` sites (the three in moons.rs) migrate to `math::cos`. After migrating, `grep -n "\.cos()\|\.sin()" crates/gg-gen/src/*.rs crates/gg-core/src/rng.rs` must return zero hits.

Set `SCHEMA_VERSION` to 2 in `crates/gg-gen/src/descriptor.rs` and update its doc comment: `/// v2: generation math moved to libm (wasm32-canonical determinism).`

- [ ] **Step 4: Run the suite — only golden + schema tests should fail**

Run: `cargo test --workspace`
Expected: `golden_seeds_are_pinned` FAILS (values shifted by ULPs — this is the one sanctioned break); everything else PASSES (calibration tolerances are orders of magnitude wider than ULP shifts). If any calibration/property test fails, a call site was migrated wrong — fix before proceeding.

- [ ] **Step 5: Regenerate goldens**

```bash
cargo run -p gg-gen --example dump -- 1 > crates/gg-gen/tests/golden/seed-1.json
cargo run -p gg-gen --example dump -- 42 > crates/gg-gen/tests/golden/seed-42.json
cargo run -p gg-gen --example dump -- 123456789 > crates/gg-gen/tests/golden/seed-123456789.json
```

- [ ] **Step 6: Run full suite and clippy to verify green**

Run: `cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`
Expected: all PASS, clippy clean. Spot-check `git diff crates/gg-gen/tests/golden/seed-42.json | head -30` — values shift in trailing digits only; `"schema_version": 2`.

- [ ] **Step 7: Commit**

```bash
git add crates/gg-core crates/gg-gen
git commit -m "feat!: move generation math to libm (wasm32-canonical determinism), schema v2"
```

---

### Task 2: Backlog hardening — debug_asserts + missing tests

**Files:**
- Modify: `crates/gg-core/src/rng.rs`, `crates/gg-core/src/orbit.rs` (debug_asserts)
- Modify: `crates/gg-gen/tests/system.rs` (u64::MAX roundtrip)
- Modify: `crates/gg-gen/tests/moons.rs` (Living→Doomed wiring; giant-moon path)
- Modify: `crates/gg-gen/tests/planets.rs` (star-death doom branch)
- Modify: `crates/gg-ephemeris/tests/kepler_secular.rs` (deep-time rotation regression)

**Interfaces:**
- Consumes: existing public APIs only. Produces: nothing new — this task only hardens. `debug_assert!` never fires in release, so generation output is untouched (goldens must NOT change; verify).

- [ ] **Step 1: Add the debug_asserts**

In `crates/gg-core/src/rng.rs`, first line of each method:

```rust
// in uniform:
debug_assert!(lo <= hi, "uniform: lo {lo} > hi {hi}");
// in log_uniform:
debug_assert!(0.0 < lo && lo <= hi, "log_uniform: need 0 < lo <= hi, got [{lo}, {hi}]");
// in power_law:
debug_assert!(alpha != 1.0, "power_law: alpha == 1 divides by zero");
debug_assert!(0.0 < lo && lo <= hi, "power_law: need 0 < lo <= hi, got [{lo}, {hi}]");
// in chance:
debug_assert!((0.0..=1.0).contains(&p), "chance: p {p} outside [0, 1]");
// in pick_count:
debug_assert!(lo <= hi, "pick_count: lo {lo} > hi {hi}");
```

In `crates/gg-core/src/orbit.rs`, first line of `solve_kepler` and `position_at`:

```rust
debug_assert!((0.0..1.0).contains(&e), "eccentricity {e} outside [0, 1)");
// (in position_at, the variable is el.eccentricity)
```

- [ ] **Step 2: Add the five missing tests**

Append to `crates/gg-gen/tests/system.rs`:

```rust
#[test]
fn u64_max_seed_survives_json_roundtrip() {
    let desc = generate(u64::MAX);
    let json = serde_json::to_string(&desc).unwrap();
    assert!(json.contains("\"18446744073709551615\""), "seed must serialize as string");
    let back: SystemDescriptor = serde_json::from_str(&json).unwrap();
    assert_eq!(desc, back);
}
```

Append to `crates/gg-gen/tests/moons.rs` (uses the existing `earth_like()` and `sunlike_ctx()` helpers in that file):

```rust
#[test]
fn inward_spiraling_moon_dooms_a_living_world() {
    // A very slowly rotating planet puts moons below synchronous orbit ->
    // inward migration. Across seeds, at least one anchor-like planet must
    // get doomed through the generate_moons wiring, with state matching the
    // soonest moon doom.
    use gg_core::orbit::orbital_period_s;
    let mut wired = 0;
    for seed in 0..300u64 {
        let mut rng = RngStream::root(seed).child("moons-doom-test");
        let mut p = earth_like();
        p.mass_kg = 2.5 * M_EARTH; // maximize moon probability
        p.radius_m = R_EARTH * 2.5f64.powf(0.27);
        p.rotation_period_s = 2000.0 * 3600.0; // slower than any moon orbit
        let period = orbital_period_s(AU, G * M_SUN);
        generate_moons(&mut rng, &mut p, period, &sunlike_ctx());
        let soonest = p.moons.iter().filter_map(|m| m.doom_time_s).fold(f64::INFINITY, f64::min);
        if soonest < 1e8 * 3.156e7 {
            wired += 1;
            match p.state {
                WorldState::Doomed { doom_time_s } => assert_eq!(doom_time_s, soonest, "seed {seed}"),
                other => panic!("seed {seed}: moon doom at {soonest} but state {other:?}"),
            }
        }
        for m in &p.moons {
            assert!(m.secular.migration_m_per_s < 0.0, "seed {seed}: slow rotator must migrate moons inward");
        }
    }
    assert!(wired >= 3, "expected several doomed cases across 300 seeds, got {wired}");
}

#[test]
fn giant_planets_get_major_moon_families() {
    let mut with_moons = 0;
    for seed in 0..200u64 {
        let mut rng = RngStream::root(seed).child("giant-moons-test");
        let mut p = earth_like();
        p.class = PlanetClass::GasGiant;
        p.mass_kg = 300.0 * M_EARTH;
        p.radius_m = 11.0 * R_EARTH;
        p.orbit.semi_major_axis_m = 5.0 * AU;
        p.rotation_period_s = 10.0 * 3600.0;
        let period = gg_core::orbit::orbital_period_s(5.0 * AU, G * M_SUN);
        generate_moons(&mut rng, &mut p, period, &sunlike_ctx());
        if !p.moons.is_empty() {
            with_moons += 1;
        }
        assert!(p.moons.len() <= 6, "seed {seed}");
        for m in &p.moons {
            let frac = m.mass_kg / p.mass_kg;
            assert!((1e-5..=3e-4).contains(&frac), "seed {seed}: giant moon mass fraction {frac}");
        }
    }
    assert!(with_moons > 150, "giants should almost always have moons, got {with_moons}/200");
}
```

Append to `crates/gg-gen/tests/planets.rs` (uses that file's `sunlike_ctx()`):

```rust
#[test]
fn old_stars_doom_by_star_death() {
    // Remaining main-sequence life < 2 Gyr forces the star-death doom branch:
    // doom_time_s must equal the star's exact remaining lifetime.
    let lifetime = 10e9 * 3.156e7;
    let ctx = StellarContext {
        age_s: 0.95 * lifetime,
        primary_ms_lifetime_s: lifetime,
        ..sunlike_ctx()
    };
    let remaining = ctx.primary_ms_lifetime_s - ctx.age_s;
    let mut doomed_seen = 0;
    for seed in 0..300u64 {
        let mut rng = RngStream::root(seed).child("planets");
        let (planets, anchor) = generate_planets(&mut rng, &ctx);
        if let WorldState::Doomed { doom_time_s } = planets[anchor].state {
            doomed_seen += 1;
            assert!((doom_time_s - remaining).abs() < 1.0, "seed {seed}: doom {doom_time_s} != star remaining {remaining}");
        }
    }
    assert!(doomed_seen >= 10, "8% of 300 should be doomed, saw {doomed_seen}");
}
```

(If `sunlike_ctx()` does not support struct-update syntax because it returns by value — it does; `StellarContext` has no non-Copy fields preventing it — this compiles as written.)

Append to `crates/gg-ephemeris/tests/kepler_secular.rs` (uses that file's `single_planet_system()` helper):

```rust
#[test]
fn rotation_never_reverses_in_deep_time() {
    // Regression for the uncapped quadratic spin-drift term, whose reversal
    // onset was t = p0/drift. Probe far beyond it.
    let mut desc = single_planet_system();
    let p0 = 86_164.0;
    let drift = 5.0e-9;
    desc.planets[0].rotation_period_s = p0;
    desc.planets[0].spin_drift_s_per_s = drift;
    let eph = KeplerSecular::new(desc);
    let t_reversal_old = p0 / drift; // ~1.7e13 s
    for &t in &[2.0 * t_reversal_old, 10.0 * t_reversal_old, 1.0e18] {
        let dt = p0 / 4.0;
        let r0 = eph.states_at(t)[1].rotation_rad;
        let r1 = eph.states_at(t + dt)[1].rotation_rad;
        let advance = (r1 - r0).rem_euclid(std::f64::consts::TAU);
        assert!(
            advance > 0.0 && advance < std::f64::consts::PI,
            "t={t}: rotation went backwards or stalled (advance {advance})"
        );
    }
}
```

- [ ] **Step 3: Run the new tests (they must pass against current code) and the full suite**

Run: `cargo test --workspace`
Expected: all PASS — these tests pin current (correct) behavior; debug_asserts fire on no existing call site. If `inward_spiraling_moon_dooms_a_living_world` finds `wired < 3`, widen the seed range to 500 before touching anything else, and report the count in your report.

- [ ] **Step 4: Verify goldens unchanged**

Run: `git diff --stat crates/gg-gen/tests/golden/`
Expected: empty — this task must not change generation output.

- [ ] **Step 5: Commit**

```bash
git add crates/
git commit -m "test: backlog hardening — debug_asserts, deep-time rotation, doom wiring, giant moons, u64::MAX roundtrip"
```

---

### Task 3: gg-wasm — the boundary crate + wasm32 golden parity

**Files:**
- Modify: `Cargo.toml` (workspace members += `"crates/gg-wasm"`)
- Modify: `crates/gg-gen/src/calendar.rs` (derive serde on `DateTime`)
- Create: `crates/gg-wasm/Cargo.toml`
- Create: `crates/gg-wasm/src/lib.rs`
- Create: `crates/gg-wasm/src/flatten.rs`
- Test: `crates/gg-wasm/tests/flatten.rs` (native), `crates/gg-wasm/tests/wasm_golden.rs` (wasm32)

**Interfaces:**
- Consumes: `gg_gen::generate`, `gg_gen::descriptor::*`, `gg_gen::calendar::{date_at, DateTime}`, `gg_ephemeris::{KeplerSecular, Ephemeris}`, `gg_core::orbit::{position_at, orbital_period_s, OrbitalElements}`, `gg_core::consts::G`.
- Produces (the JS API, consumed by Tasks 4-6):
  - `new World(seed: string)` — throws on non-u64 strings.
  - `descriptor_json(): string` — compact `SystemDescriptor` JSON.
  - `body_count(): number`
  - `states_at(t_s: number): Float64Array` — `7 * body_count` floats, layout `[x_m, y_m, z_m, axis_x, axis_y, axis_z, rotation_rad]` per body, gg-ephemeris body order.
  - `orbit_path(body_index: number, segments: number): Float64Array` — `3 * segments` floats, one orbit sampled at equal time steps, **relative to the body's parent focus** (host origin for planets, planet for moons); empty array for stars.
  - `anchor_date_json(t_s: number): string` — JSON `{"year":u64,"day_of_year":u32,"day_fraction":f64}` from the anchor planet's calendar.
  - Rust-side: `flatten::FLOATS_PER_BODY: usize = 7`, `flatten::flatten_states(&KeplerSecular, f64) -> Vec<f64>`, `flatten::orbit_path_points(&SystemDescriptor, usize, usize) -> Vec<f64>`.

- [ ] **Step 1: Prep — serde on DateTime; check toolchain**

In `crates/gg-gen/src/calendar.rs`, change the `DateTime` struct to:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DateTime {
    pub year: u64,
    pub day_of_year: u32,
    pub day_fraction: f64,
}
```

(Move/merge the `use serde…` with any existing imports.) Then:

```bash
rustup target list --installed | grep -q wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
command -v wasm-pack >/dev/null || brew install wasm-pack
```

- [ ] **Step 2: Write the failing native tests**

`crates/gg-wasm/tests/flatten.rs`:

```rust
use gg_ephemeris::{Ephemeris, KeplerSecular};
use gg_wasm::flatten::{flatten_states, orbit_path_points, FLOATS_PER_BODY};

#[test]
fn flat_layout_matches_body_count_and_states() {
    let desc = gg_gen::generate(42);
    let eph = KeplerSecular::new(desc);
    let n = eph.body_count();
    let flat = flatten_states(&eph, 1.0e7);
    assert_eq!(flat.len(), n * FLOATS_PER_BODY);
    let states = eph.states_at(1.0e7);
    for (i, s) in states.iter().enumerate() {
        let o = i * FLOATS_PER_BODY;
        assert_eq!(&flat[o..o + 3], &s.position_m);
        assert_eq!(&flat[o + 3..o + 6], &s.spin_axis);
        assert_eq!(flat[o + 6], s.rotation_rad);
    }
}

#[test]
fn orbit_paths_have_right_shape() {
    let desc = gg_gen::generate(42);
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    // stars have no path
    assert!(orbit_path_points(&desc, 0, 64).is_empty());
    // every planet path: 3*segments floats, all points within [peri, apo] of the focus
    for p in 0..planets {
        let body = stars + p;
        let path = orbit_path_points(&desc, body, 64);
        assert_eq!(path.len(), 3 * 64);
        let orbit = &desc.planets[p].orbit;
        let (a, e) = (orbit.semi_major_axis_m, orbit.eccentricity);
        for chunk in path.chunks(3) {
            let r = (chunk[0].powi(2) + chunk[1].powi(2) + chunk[2].powi(2)).sqrt();
            assert!(r >= a * (1.0 - e) * 0.999 && r <= a * (1.0 + e) * 1.001, "planet {p}: r {r} outside ellipse bounds");
        }
    }
    // first moon (if any): same property around its planet's mu
    if let Some((pi, _)) = desc.planets.iter().enumerate().find(|(_, p)| !p.moons.is_empty()) {
        let moons_before: usize = desc.planets[..pi].iter().map(|p| p.moons.len()).sum();
        let body = stars + planets + moons_before;
        let path = orbit_path_points(&desc, body, 32);
        assert_eq!(path.len(), 3 * 32);
    }
}

#[test]
fn seed_string_worlds_are_deterministic() {
    // native check of the same code path the wasm constructor uses
    let a = gg_gen::generate("42".trim().parse::<u64>().unwrap());
    let b = gg_gen::generate(42);
    assert_eq!(a, b);
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p gg-wasm`
Expected: FAIL to compile — crate doesn't exist yet.

- [ ] **Step 4: Implement the crate**

Add `"crates/gg-wasm"` to the workspace `members` in the root `Cargo.toml`.

`crates/gg-wasm/Cargo.toml`:

```toml
[package]
name = "gg-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
gg-core = { path = "../gg-core" }
gg-gen = { path = "../gg-gen" }
gg-ephemeris = { path = "../gg-ephemeris" }
wasm-bindgen = "0.2"
js-sys = "0.3"
serde_json = "1"

[dev-dependencies]
wasm-bindgen-test = "0.3"
```

`crates/gg-wasm/src/flatten.rs`:

```rust
//! Pure data-shaping between gg-ephemeris and the JS boundary.
//! Kept free of wasm-bindgen types so it tests natively.

use gg_core::consts::G;
use gg_core::orbit::{orbital_period_s, position_at};
use gg_ephemeris::{Ephemeris, KeplerSecular};
use gg_gen::descriptor::{PlanetHost, SystemDescriptor};

/// Per-body layout: [x_m, y_m, z_m, axis_x, axis_y, axis_z, rotation_rad].
pub const FLOATS_PER_BODY: usize = 7;

pub fn flatten_states(eph: &KeplerSecular, t_s: f64) -> Vec<f64> {
    let states = eph.states_at(t_s);
    let mut out = Vec::with_capacity(states.len() * FLOATS_PER_BODY);
    for s in &states {
        out.extend_from_slice(&s.position_m);
        out.extend_from_slice(&s.spin_axis);
        out.push(s.rotation_rad);
    }
    out
}

/// Mass planets orbit (mirrors gg-ephemeris's private helper: close pair
/// for Barycenter, primary alone otherwise).
fn planet_host_mass(desc: &SystemDescriptor) -> f64 {
    match desc.planet_host {
        PlanetHost::Barycenter => desc.stars[0].mass_kg + desc.stars[1].mass_kg,
        PlanetHost::Primary => desc.stars[0].mass_kg,
    }
}

/// One full orbit for a planet or moon, sampled at `segments` equal time
/// steps, positions RELATIVE to the parent focus (epoch elements — secular
/// drift over one orbit is invisible at render scale). Stars: empty.
pub fn orbit_path_points(desc: &SystemDescriptor, body_index: usize, segments: usize) -> Vec<f64> {
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    let (elements, mu) = if body_index < stars {
        return Vec::new();
    } else if body_index < stars + planets {
        let p = &desc.planets[body_index - stars];
        (p.orbit, G * planet_host_mass(desc))
    } else {
        let mut m = body_index - stars - planets;
        let mut found = None;
        for p in &desc.planets {
            if m < p.moons.len() {
                found = Some((p.moons[m].orbit, G * p.mass_kg));
                break;
            }
            m -= p.moons.len();
        }
        match found {
            Some(x) => x,
            None => return Vec::new(), // out-of-range index: empty, not panic
        }
    };
    let period = orbital_period_s(elements.semi_major_axis_m, mu);
    let mut out = Vec::with_capacity(3 * segments);
    for k in 0..segments {
        let t = period * (k as f64) / (segments as f64);
        out.extend_from_slice(&position_at(&elements, mu, t));
    }
    out
}
```

`crates/gg-wasm/src/lib.rs`:

```rust
//! The WASM boundary: coarse, data-oriented, three-call shape per the spec.

pub mod flatten;

use flatten::{flatten_states, orbit_path_points};
use gg_ephemeris::{Ephemeris, KeplerSecular};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct World {
    eph: KeplerSecular,
}

#[wasm_bindgen]
impl World {
    /// Seeds cross the boundary as decimal strings: u64 exceeds JS Number.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &str) -> Result<World, JsError> {
        let seed: u64 = seed
            .trim()
            .parse()
            .map_err(|_| JsError::new("seed must be a decimal u64 string"))?;
        Ok(World { eph: KeplerSecular::new(gg_gen::generate(seed)) })
    }

    pub fn descriptor_json(&self) -> String {
        serde_json::to_string(self.eph.desc()).expect("descriptor always serializes")
    }

    pub fn body_count(&self) -> usize {
        self.eph.body_count()
    }

    /// Per-frame call: 7 f64 per body (position, spin axis, rotation).
    pub fn states_at(&self, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(flatten_states(&self.eph, t_s).as_slice())
    }

    /// 3 f64 per segment, relative to the parent focus. Empty for stars.
    pub fn orbit_path(&self, body_index: usize, segments: usize) -> js_sys::Float64Array {
        js_sys::Float64Array::from(orbit_path_points(self.eph.desc(), body_index, segments).as_slice())
    }

    /// Anchor planet's calendar date at t.
    pub fn anchor_date_json(&self, t_s: f64) -> String {
        let desc = self.eph.desc();
        let cal = desc.planets[desc.anchor_planet]
            .calendar
            .as_ref()
            .expect("anchor planet always has a calendar");
        serde_json::to_string(&gg_gen::calendar::date_at(cal, t_s)).expect("date serializes")
    }
}
```

- [ ] **Step 5: Run native tests to verify they pass**

Run: `cargo test -p gg-wasm && cargo test --workspace`
Expected: PASS (3 new native tests; nothing else disturbed).

- [ ] **Step 6: Write the wasm32 golden-parity test**

`crates/gg-wasm/tests/wasm_golden.rs`:

```rust
//! THE determinism gate for the canonical target: wasm32 output must equal
//! the natively generated golden files byte-for-byte (spec: Determinism
//! contract). Runs under `wasm-pack test --node`.
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn wasm32_matches_native_goldens() {
    for (seed, golden) in [
        (1u64, include_str!("../../gg-gen/tests/golden/seed-1.json")),
        (42, include_str!("../../gg-gen/tests/golden/seed-42.json")),
        (123_456_789, include_str!("../../gg-gen/tests/golden/seed-123456789.json")),
    ] {
        let actual = serde_json::to_string_pretty(&gg_gen::generate(seed)).unwrap();
        assert_eq!(
            actual.trim(),
            golden.trim(),
            "seed {seed}: wasm32 diverged from native goldens — determinism contract broken"
        );
    }
}
```

- [ ] **Step 7: Run the wasm parity test**

Run: `wasm-pack test --node crates/gg-wasm`
Expected: PASS (Task 1's libm migration is what makes this true). **If it fails: STOP — report BLOCKED with the first diff line.** Do not regenerate goldens from wasm output and do not widen anything; divergence here means a std-math call site was missed in Task 1 (find it with the failing field's provenance).

- [ ] **Step 8: Verify the web-target build works**

Run: `wasm-pack build crates/gg-wasm --target web --out-dir ../../web/src/wasm/pkg`
Expected: succeeds, producing `web/src/wasm/pkg/{gg_wasm.js, gg_wasm_bg.wasm, gg_wasm.d.ts, …}`. Then add to the root `.gitignore`:

```
# Generated WASM package (rebuild: npm run build:wasm in web/)
web/src/wasm/pkg/
```

- [ ] **Step 9: Commit**

```bash
git add Cargo.toml Cargo.lock .gitignore crates/
git commit -m "feat: gg-wasm boundary crate with wasm32 golden-parity gate"
```

---

### Task 4: Web scaffold — types, descriptor validation, clock

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/src/styles.css`
- Create: `web/src/sim/types.ts`, `web/src/sim/parse.ts`, `web/src/sim/layout.ts`, `web/src/sim/wasm.ts`
- Create: `web/src/time/clock.ts`
- Test: `web/src/sim/parse.test.ts`, `web/src/sim/layout.test.ts`, `web/src/time/clock.test.ts`

**Interfaces:**
- Consumes: gg-wasm's JS API and descriptor JSON shape (Task 3), the golden files as fixtures.
- Produces (used by Tasks 5-6):
  - `types.ts`: `SystemDescriptor`, `Star`, `Planet`, `Moon`, `Calendar`, `OrbitalElements`, `WorldState` (discriminated on `kind`), `DateTime`, `PlanetClass = 'Rocky' | 'IceGiant' | 'GasGiant'`, `PlanetHost = 'Barycenter' | 'Primary'`, `AU_M = 1.495978707e11`.
  - `parse.ts`: `parseDescriptor(json: string): SystemDescriptor` (throws `Error` naming the bad path).
  - `layout.ts`: `type BodyRef = { kind: 'star' | 'planet' | 'moon'; star?: number; planet?: number; moon?: number }`, `bodyLayout(desc: SystemDescriptor): BodyRef[]` (gg-ephemeris body order), `bodyName(desc, index): string`, `parentIndex(layout: BodyRef[], desc: SystemDescriptor, index: number): number | null` (moons → their planet's body index; else null).
  - `wasm.ts`: `loadSim(seed: string): Promise<Sim>` with `interface Sim { seed: string; descriptor: SystemDescriptor; bodyCount: number; statesAt(tS: number): Float64Array; orbitPath(bodyIndex: number, segments: number): Float64Array; anchorDate(tS: number): DateTime }`.
  - `clock.ts`: `class SimClock { t: number; speed: number; paused: boolean; tick(wallDtS: number): void; }`

- [ ] **Step 1: Scaffold config files**

`web/package.json`:

```json
{
  "name": "goldengrove-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "build:wasm": "wasm-pack build ../crates/gg-wasm --target web --out-dir ../../web/src/wasm/pkg"
  },
  "dependencies": {
    "three": "^0.166.0"
  },
  "devDependencies": {
    "@types/three": "^0.166.0",
    "happy-dom": "^15.0.0",
    "typescript": "~5.5.0",
    "vite": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

`web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["vite/client", "node"],
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  test: { environment: 'happy-dom' },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Goldengrove</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/styles.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { width: 100%; height: 100%; overflow: hidden; background: #05070f; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd8e3; }
canvas { display: block; }
.hud { position: absolute; display: flex; gap: 0.5rem; align-items: center;
  background: rgba(5, 8, 18, 0.65); border: 1px solid #2a3350; border-radius: 8px;
  padding: 0.4rem 0.7rem; font-size: 0.8rem; user-select: none; }
.hud button { background: #1a2340; color: #cfd8e3; border: 1px solid #2a3350;
  border-radius: 5px; padding: 0.15rem 0.55rem; font: inherit; cursor: pointer; }
.hud button.active { background: #3350a0; }
.hud-top-left { top: 12px; left: 12px; }
.hud-top-right { top: 12px; right: 12px; }
.hud-bottom { bottom: 12px; left: 50%; transform: translateX(-50%); }
.body-label { color: #9fb0c8; font-size: 0.7rem; text-shadow: 0 0 4px #000;
  pointer-events: none; white-space: nowrap; }
```

Run `npm install` in `web/`. Expected: lockfile created, no errors. Commit checkpoint comes at the end of the task.

- [ ] **Step 2: Write the failing tests**

`web/src/sim/parse.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from './parse';

const goldenPath = new URL('../../../crates/gg-gen/tests/golden/seed-42.json', import.meta.url);
const goldenJson = readFileSync(goldenPath, 'utf8');

describe('parseDescriptor', () => {
  it('accepts the real golden descriptor (cross-boundary contract)', () => {
    const d = parseDescriptor(goldenJson);
    expect(d.schema_version).toBe(2);
    expect(d.seed).toBe('42');
    expect(d.stars.length).toBeGreaterThan(0);
    expect(d.planets.length).toBeGreaterThan(0);
    const anchor = d.planets[d.anchor_planet]!;
    expect(anchor.class).toBe('Rocky');
    expect(anchor.calendar).not.toBeNull();
    expect(anchor.calendar!.months.length).toBe(anchor.moons.length);
    for (const p of d.planets) {
      expect(p.state.kind === 'Living' || p.state.kind === 'Dead' || p.state.kind === 'Doomed').toBe(true);
      if (p.state.kind === 'Doomed') expect(p.state.doom_time_s).toBeGreaterThan(0);
    }
  });

  it('rejects wrong schema version', () => {
    const d = JSON.parse(goldenJson);
    d.schema_version = 99;
    expect(() => parseDescriptor(JSON.stringify(d))).toThrow(/schema_version/);
  });

  it('rejects structurally broken input naming the path', () => {
    const d = JSON.parse(goldenJson);
    delete d.planets[0].orbit;
    expect(() => parseDescriptor(JSON.stringify(d))).toThrow(/planets\[0\]\.orbit/);
  });
});
```

`web/src/sim/layout.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyLayout, bodyName, parentIndex } from './layout';
import { parseDescriptor } from './parse';

const golden = parseDescriptor(
  readFileSync(new URL('../../../crates/gg-gen/tests/golden/seed-42.json', import.meta.url), 'utf8'),
);

describe('bodyLayout', () => {
  it('matches the gg-ephemeris body order: stars, planets, moons grouped', () => {
    const layout = bodyLayout(golden);
    const nStars = golden.stars.length;
    const nPlanets = golden.planets.length;
    const nMoons = golden.planets.reduce((n, p) => n + p.moons.length, 0);
    expect(layout.length).toBe(nStars + nPlanets + nMoons);
    for (let i = 0; i < nStars; i++) expect(layout[i]).toEqual({ kind: 'star', star: i });
    for (let i = 0; i < nPlanets; i++) expect(layout[nStars + i]).toEqual({ kind: 'planet', planet: i });
    let m = nStars + nPlanets;
    for (let p = 0; p < nPlanets; p++) {
      for (let j = 0; j < golden.planets[p]!.moons.length; j++) {
        expect(layout[m]).toEqual({ kind: 'moon', planet: p, moon: j });
        expect(parentIndex(layout, golden, m)).toBe(nStars + p);
        m++;
      }
    }
    expect(parentIndex(layout, golden, 0)).toBeNull();
  });

  it('names bodies stably', () => {
    expect(bodyName(golden, 0)).toBe('★A');
    expect(bodyName(golden, golden.stars.length)).toBe('I');
  });
});
```

`web/src/time/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SimClock } from './clock';

describe('SimClock', () => {
  it('accumulates wall time scaled by speed', () => {
    const c = new SimClock();
    c.speed = 3600;
    c.tick(0.5);
    expect(c.t).toBeCloseTo(1800);
  });

  it('does not advance while paused', () => {
    const c = new SimClock();
    c.paused = true;
    c.tick(10);
    expect(c.t).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run`
Expected: FAIL — modules don't exist.

- [ ] **Step 4: Implement types.ts, parse.ts, layout.ts, clock.ts, wasm.ts**

`web/src/sim/types.ts`:

```ts
/** Mirrors gg-gen's SystemDescriptor JSON (schema v2). */

export const AU_M = 1.495978707e11;
export const SCHEMA_VERSION = 2;

export interface OrbitalElements {
  semi_major_axis_m: number;
  eccentricity: number;
  inclination_rad: number;
  raan_rad: number;
  arg_periapsis_rad: number;
  mean_anomaly_epoch_rad: number;
}

export interface SecularRates {
  apsidal_rad_per_s: number;
  nodal_rad_per_s: number;
  migration_m_per_s: number;
}

export interface Star {
  mass_kg: number;
  radius_m: number;
  luminosity_w: number;
  temperature_k: number;
  main_sequence_lifetime_s: number;
  orbit: OrbitalElements | null;
}

export type PlanetClass = 'Rocky' | 'IceGiant' | 'GasGiant';
export type PlanetHost = 'Barycenter' | 'Primary';

export type WorldState =
  | { kind: 'Living' }
  | { kind: 'Dead' }
  | { kind: 'Doomed'; doom_time_s: number };

export interface LeapTerm { every_years: number; add_days: number }
export interface LeapRule { base_days: number; terms: LeapTerm[] }
export interface MonthCycle { moon_index: number; synodic_days: number }

export interface Calendar {
  solar_day_s: number;
  year_solar_days: number;
  leap: LeapRule;
  months: MonthCycle[];
}

export interface Moon {
  mass_kg: number;
  radius_m: number;
  orbit: OrbitalElements;
  secular: SecularRates;
  tidally_locked: boolean;
  rotation_period_s: number;
  doom_time_s: number | null;
}

export interface Planet {
  class: PlanetClass;
  mass_kg: number;
  radius_m: number;
  orbit: OrbitalElements;
  secular: SecularRates;
  axial_tilt_rad: number;
  axial_precession_rad_per_s: number;
  rotation_period_s: number;
  spin_drift_s_per_s: number;
  state: WorldState;
  moons: Moon[];
  calendar: Calendar | null;
}

export interface SystemDescriptor {
  schema_version: number;
  seed: string;
  age_s: number;
  stars: Star[];
  planet_host: PlanetHost;
  planets: Planet[];
  anchor_planet: number;
}

export interface DateTime { year: number; day_of_year: number; day_fraction: number }
```

`web/src/sim/parse.ts`:

```ts
import { SCHEMA_VERSION, type SystemDescriptor } from './types';

function fail(path: string, why: string): never {
  throw new Error(`descriptor validation failed at ${path}: ${why}`);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected finite number, got ${JSON.stringify(v)}`);
  return v;
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected object');
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected array');
  return v;
}

function orbit(v: unknown, path: string): void {
  const o = obj(v, path);
  for (const k of ['semi_major_axis_m', 'eccentricity', 'inclination_rad', 'raan_rad', 'arg_periapsis_rad', 'mean_anomaly_epoch_rad']) {
    num(o[k], `${path}.${k}`);
  }
}

/**
 * Structural validation of the Rust-side JSON: the cross-boundary contract
 * test. Checks shape and the fields the renderer relies on; trusts numeric
 * plausibility to the Rust test suite.
 */
export function parseDescriptor(json: string): SystemDescriptor {
  const d = obj(JSON.parse(json), '$');
  if (d.schema_version !== SCHEMA_VERSION) {
    fail('$.schema_version', `expected ${SCHEMA_VERSION}, got ${JSON.stringify(d.schema_version)}`);
  }
  if (typeof d.seed !== 'string' || !/^\d+$/.test(d.seed)) fail('$.seed', 'expected decimal string');
  num(d.age_s, '$.age_s');
  if (d.planet_host !== 'Barycenter' && d.planet_host !== 'Primary') fail('$.planet_host', 'bad variant');

  const stars = arr(d.stars, '$.stars');
  if (stars.length === 0) fail('$.stars', 'empty');
  stars.forEach((s, i) => {
    const o = obj(s, `stars[${i}]`);
    for (const k of ['mass_kg', 'radius_m', 'luminosity_w', 'temperature_k']) num(o[k], `stars[${i}].${k}`);
    if (o.orbit !== null && o.orbit !== undefined) orbit(o.orbit, `stars[${i}].orbit`);
  });

  const planets = arr(d.planets, '$.planets');
  if (planets.length === 0) fail('$.planets', 'empty');
  planets.forEach((p, i) => {
    const o = obj(p, `planets[${i}]`);
    if (o.class !== 'Rocky' && o.class !== 'IceGiant' && o.class !== 'GasGiant') fail(`planets[${i}].class`, 'bad variant');
    for (const k of ['mass_kg', 'radius_m', 'rotation_period_s', 'axial_tilt_rad']) num(o[k], `planets[${i}].${k}`);
    orbit(o.orbit, `planets[${i}].orbit`);
    const state = obj(o.state, `planets[${i}].state`);
    if (state.kind !== 'Living' && state.kind !== 'Dead' && state.kind !== 'Doomed') fail(`planets[${i}].state.kind`, 'bad variant');
    if (state.kind === 'Doomed') num(state.doom_time_s, `planets[${i}].state.doom_time_s`);
    arr(o.moons, `planets[${i}].moons`).forEach((m, j) => {
      const mo = obj(m, `planets[${i}].moons[${j}]`);
      for (const k of ['mass_kg', 'radius_m', 'rotation_period_s']) num(mo[k], `planets[${i}].moons[${j}].${k}`);
      orbit(mo.orbit, `planets[${i}].moons[${j}].orbit`);
    });
    if (o.calendar !== null && o.calendar !== undefined) {
      const c = obj(o.calendar, `planets[${i}].calendar`);
      num(c.solar_day_s, `planets[${i}].calendar.solar_day_s`);
      num(c.year_solar_days, `planets[${i}].calendar.year_solar_days`);
      arr(c.months, `planets[${i}].calendar.months`);
    }
  });

  const anchor = num(d.anchor_planet, '$.anchor_planet');
  if (anchor < 0 || anchor >= planets.length) fail('$.anchor_planet', 'index out of range');
  const anchorCal = (planets[anchor] as Record<string, unknown>).calendar;
  if (anchorCal === null || anchorCal === undefined) fail(`planets[${anchor}].calendar`, 'anchor must have a calendar');

  return d as unknown as SystemDescriptor;
}
```

`web/src/sim/layout.ts`:

```ts
import type { SystemDescriptor } from './types';

export type BodyRef =
  | { kind: 'star'; star: number }
  | { kind: 'planet'; planet: number }
  | { kind: 'moon'; planet: number; moon: number };

/** Mirrors gg-ephemeris body order: stars, planets, moons grouped by planet. */
export function bodyLayout(desc: SystemDescriptor): BodyRef[] {
  const out: BodyRef[] = [];
  desc.stars.forEach((_, i) => out.push({ kind: 'star', star: i }));
  desc.planets.forEach((_, i) => out.push({ kind: 'planet', planet: i }));
  desc.planets.forEach((p, i) => p.moons.forEach((_, j) => out.push({ kind: 'moon', planet: i, moon: j })));
  return out;
}

/** Body index of a moon's planet; null for stars and planets. */
export function parentIndex(layout: BodyRef[], desc: SystemDescriptor, index: number): number | null {
  const ref = layout[index];
  if (!ref || ref.kind !== 'moon') return null;
  return desc.stars.length + ref.planet;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export function bodyName(desc: SystemDescriptor, index: number): string {
  const layout = bodyLayout(desc);
  const ref = layout[index];
  if (!ref) return `#${index}`;
  switch (ref.kind) {
    case 'star':
      return `★${String.fromCharCode(65 + ref.star)}`;
    case 'planet':
      return ROMAN[ref.planet] ?? `P${ref.planet + 1}`;
    case 'moon':
      return `${ROMAN[ref.planet] ?? `P${ref.planet + 1}`}${String.fromCharCode(97 + ref.moon)}`;
  }
}
```

`web/src/time/clock.ts`:

```ts
/** Maps wall time to simulation time. Sim time is f64 seconds from epoch. */
export class SimClock {
  t = 0;
  speed = 1;
  paused = false;

  tick(wallDtS: number): void {
    if (!this.paused) this.t += wallDtS * this.speed;
  }
}
```

`web/src/sim/wasm.ts`:

```ts
import init, { World } from '../wasm/pkg/gg_wasm.js';
import { parseDescriptor } from './parse';
import type { DateTime, SystemDescriptor } from './types';

export interface Sim {
  seed: string;
  descriptor: SystemDescriptor;
  bodyCount: number;
  statesAt(tS: number): Float64Array;
  orbitPath(bodyIndex: number, segments: number): Float64Array;
  anchorDate(tS: number): DateTime;
}

let wasmReady: Promise<unknown> | null = null;

/** Boot the WASM module (once) and build a world from a seed string. */
export async function loadSim(seed: string): Promise<Sim> {
  wasmReady ??= init(new URL('../wasm/pkg/gg_wasm_bg.wasm', import.meta.url));
  await wasmReady;
  const world = new World(seed);
  const descriptor = parseDescriptor(world.descriptor_json());
  return {
    seed,
    descriptor,
    bodyCount: world.body_count(),
    statesAt: (tS) => world.states_at(tS),
    orbitPath: (i, segments) => world.orbit_path(i, segments),
    anchorDate: (tS) => JSON.parse(world.anchor_date_json(tS)) as DateTime,
  };
}
```

(`wasm.ts` has no unit test — it needs a browser runtime; it is exercised by the Task 6 manual QA and by `vite build`'s type check.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 7 tests PASS; typecheck clean. (`tsc` needs the generated `web/src/wasm/pkg/` from Task 3 Step 8 — if missing, run `npm run build:wasm` first.)

- [ ] **Step 6: Commit**

```bash
git add web/ 
git commit -m "feat: web scaffold — descriptor types/validation, body layout, sim clock, WASM loader"
```

---

### Task 5: Space view — compression math, star colors, scene builder

**Files:**
- Create: `web/src/views/compression.ts`, `web/src/views/color.ts`, `web/src/views/space.ts`
- Test: `web/src/views/compression.test.ts`, `web/src/views/space.test.ts`

**Interfaces:**
- Consumes: `SystemDescriptor`, `bodyLayout`/`parentIndex`/`bodyName` (Task 4), gg-wasm flat state layout (7 f64/body, meters), `Sim.orbitPath`.
- Produces (used by Task 6):
  - `compression.ts`: `VIEW_UNITS_PER_AU = 10`, `compressRadial(rM: number, trueScale: boolean): number`, `compressPosition(xM, yM, zM, trueScale): [number, number, number]`, `moonViewFactor(aM: number, trueScale: boolean): number` (view-units per meter, constant per moon), `displayRadius(kind: 'star' | 'planet' | 'moon', radiusM: number, trueScale: boolean): number`.
  - `color.ts`: `temperatureToColor(kelvin: number): [number, number, number]` (0-1 RGB).
  - `space.ts`: `buildSpaceScene(sim: Sim): SpaceView` where `interface SpaceView { scene: THREE.Scene; bodies: THREE.Mesh[]; labels: CSS2DObject[]; update(states: Float64Array, trueScale: boolean): void; bodyIndexOf(object: THREE.Object3D): number | null }`.

- [ ] **Step 1: Write the failing compression tests**

`web/src/views/compression.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AU_M } from '../sim/types';
import { VIEW_UNITS_PER_AU, compressPosition, compressRadial, displayRadius, moonViewFactor } from './compression';

describe('compressRadial', () => {
  it('maps 1 AU to exactly VIEW_UNITS_PER_AU', () => {
    expect(compressRadial(AU_M, false)).toBeCloseTo(VIEW_UNITS_PER_AU, 6);
  });
  it('is monotonic and compresses the outer system', () => {
    const r1 = compressRadial(1 * AU_M, false);
    const r5 = compressRadial(5 * AU_M, false);
    const r30 = compressRadial(30 * AU_M, false);
    expect(r5).toBeGreaterThan(r1);
    expect(r30).toBeGreaterThan(r5);
    expect(r30).toBeLessThan(30 * VIEW_UNITS_PER_AU * 0.5); // strongly sublinear far out
  });
  it('true scale is linear', () => {
    expect(compressRadial(7 * AU_M, true)).toBeCloseTo(7 * VIEW_UNITS_PER_AU, 6);
  });
  it('preserves direction', () => {
    const [x, y, z] = compressPosition(3 * AU_M, 4 * AU_M, 0, false);
    expect(x / y).toBeCloseTo(3 / 4, 6);
    expect(z).toBe(0);
  });
  it('handles the origin', () => {
    expect(compressPosition(0, 0, 0, false)).toEqual([0, 0, 0]);
  });
});

describe('moon exaggeration', () => {
  it('keeps our Moon visibly outside an Earth-floor planet', () => {
    const f = moonViewFactor(3.844e8, false);
    const dView = 3.844e8 * f;
    expect(dView).toBeGreaterThanOrEqual(displayRadius('planet', 6.371e6, false) * 2.5 * 0.999);
  });
  it('caps huge moon systems', () => {
    const f = moonViewFactor(0.3 * AU_M, false); // outer giant moon
    expect(0.3 * AU_M * f).toBeLessThanOrEqual(1.5 * 1.001);
  });
  it('true scale disables exaggeration', () => {
    const f = moonViewFactor(3.844e8, true);
    expect(3.844e8 * f).toBeCloseTo((3.844e8 / AU_M) * VIEW_UNITS_PER_AU, 9);
  });
});

describe('displayRadius', () => {
  it('floors tiny true radii per class', () => {
    expect(displayRadius('star', 6.957e8, false)).toBeGreaterThanOrEqual(0.5);
    expect(displayRadius('planet', 6.371e6, false)).toBeGreaterThanOrEqual(0.15);
    expect(displayRadius('moon', 1.7e6, false)).toBeGreaterThanOrEqual(0.05);
  });
  it('true scale uses the real radius', () => {
    expect(displayRadius('star', 6.957e8, true)).toBeCloseTo((6.957e8 / AU_M) * VIEW_UNITS_PER_AU, 9);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/views/compression.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement compression.ts and color.ts**

`web/src/views/compression.ts`:

```ts
import { AU_M } from '../sim/types';

/** View-space scale: 1 AU renders as 10 scene units (compressed mode keeps this anchor). */
export const VIEW_UNITS_PER_AU = 10;

/** asinh knee: inner system ~linear, outer system logarithmic. */
const COMPRESS_K = 8;
const ASINH_K = Math.asinh(COMPRESS_K);

/** Moon-system exaggeration (compressed mode): real moon distances are
 * invisible at system scale, so moons render on a uniformly scaled-up copy
 * of their true orbit (linear per moon — ellipse shapes survive). */
const MOON_STRETCH = 200; // view units per AU of moon orbit, before clamping
const MOON_MIN_VIEW = 0.375; // = planet floor 0.15 * 2.5
const MOON_MAX_VIEW = 1.5;

const FLOORS = { star: 0.5, planet: 0.15, moon: 0.05 } as const;

export function compressRadial(rM: number, trueScale: boolean): number {
  const rAu = rM / AU_M;
  if (trueScale) return rAu * VIEW_UNITS_PER_AU;
  return (VIEW_UNITS_PER_AU * Math.asinh(rAu * COMPRESS_K)) / ASINH_K;
}

export function compressPosition(xM: number, yM: number, zM: number, trueScale: boolean): [number, number, number] {
  const r = Math.hypot(xM, yM, zM);
  if (r === 0) return [0, 0, 0];
  const s = compressRadial(r, trueScale) / r;
  return [xM * s, yM * s, zM * s];
}

/** Constant view-units-per-meter factor for one moon, from its semi-major
 * axis: uniform scaling per moon keeps its orbit ellipse similar. */
export function moonViewFactor(aM: number, trueScale: boolean): number {
  const aAu = aM / AU_M;
  if (trueScale) return VIEW_UNITS_PER_AU / AU_M;
  const target = Math.min(Math.max(aAu * MOON_STRETCH, MOON_MIN_VIEW), MOON_MAX_VIEW);
  return target / aM;
}

export function displayRadius(kind: 'star' | 'planet' | 'moon', radiusM: number, trueScale: boolean): number {
  const real = (radiusM / AU_M) * VIEW_UNITS_PER_AU;
  return trueScale ? real : Math.max(real, FLOORS[kind]);
}
```

`web/src/views/color.ts`:

```ts
/** Approximate blackbody chromaticity, good enough for star tinting
 * (Tanner Helland's fit, normalized to 0-1). Valid ~1000K-40000K. */
export function temperatureToColor(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const clamp = (v: number) => Math.min(Math.max(v, 0), 255) / 255;
  return [clamp(r), clamp(g), clamp(b)];
}
```

- [ ] **Step 4: Run compression tests to verify they pass**

Run: `cd web && npx vitest run src/views/compression.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing scene test**

`web/src/views/space.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDescriptor } from '../sim/parse';
import type { Sim } from '../sim/wasm';
import { buildSpaceScene } from './space';

const golden = parseDescriptor(
  readFileSync(new URL('../../../crates/gg-gen/tests/golden/seed-42.json', import.meta.url), 'utf8'),
);

/** A Sim backed by canned data — scene construction needs no real WASM. */
function fakeSim(): Sim {
  const layoutLen =
    golden.stars.length + golden.planets.length + golden.planets.reduce((n, p) => n + p.moons.length, 0);
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: layoutLen,
    statesAt: (tS) => {
      const out = new Float64Array(layoutLen * 7);
      for (let i = 0; i < layoutLen; i++) {
        out[i * 7] = (i + 1) * 1e10 + tS * 0; // spread bodies on +X
        out[i * 7 + 5] = 1; // spin axis +Z
      }
      return out;
    },
    orbitPath: (i, segments) => {
      if (i < golden.stars.length) return new Float64Array(0);
      const out = new Float64Array(segments * 3);
      for (let k = 0; k < segments; k++) {
        const th = (2 * Math.PI * k) / segments;
        out[k * 3] = Math.cos(th) * 1e11;
        out[k * 3 + 1] = Math.sin(th) * 1e11;
      }
      return out;
    },
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
  };
}

describe('buildSpaceScene', () => {
  it('creates one mesh + label per body and orbit lines for non-stars', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    expect(view.bodies.length).toBe(sim.bodyCount);
    expect(view.labels.length).toBe(sim.bodyCount);
    const lines = view.scene.getObjectByName('orbit-lines')!;
    expect(lines.children.length).toBe(sim.bodyCount - golden.stars.length);
  });

  it('update() positions meshes and never leaves NaNs', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    view.update(sim.statesAt(0), false);
    for (const mesh of view.bodies) {
      expect(Number.isFinite(mesh.position.x)).toBe(true);
      expect(mesh.position.length()).toBeGreaterThan(0);
    }
  });

  it('bodyIndexOf resolves meshes back to body indices', () => {
    const sim = fakeSim();
    const view = buildSpaceScene(sim);
    expect(view.bodyIndexOf(view.bodies[3]!)).toBe(3);
    expect(view.bodyIndexOf(view.scene)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify failure, then implement space.ts**

Run: `cd web && npx vitest run src/views/space.test.ts` — expect FAIL (module missing). Then:

`web/src/views/space.ts`:

```ts
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { bodyLayout, bodyName, parentIndex, type BodyRef } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { compressPosition, displayRadius, moonViewFactor } from './compression';
import { temperatureToColor } from './color';

const ORBIT_SEGMENTS = 128;

export interface SpaceView {
  scene: THREE.Scene;
  bodies: THREE.Mesh[];
  labels: CSS2DObject[];
  update(states: Float64Array, trueScale: boolean): void;
  bodyIndexOf(object: THREE.Object3D): number | null;
}

interface BodyMeta {
  ref: BodyRef;
  radiusM: number;
  parent: number | null;
  moonFactor: number; // view units per meter of moon-orbit offset (moons only)
  orbitLine: THREE.LineLoop | null;
}

function bodyRadiusM(sim: Sim, ref: BodyRef): number {
  switch (ref.kind) {
    case 'star': return sim.descriptor.stars[ref.star]!.radius_m;
    case 'planet': return sim.descriptor.planets[ref.planet]!.radius_m;
    case 'moon': return sim.descriptor.planets[ref.planet]!.moons[ref.moon]!.radius_m;
  }
}

export function buildSpaceScene(sim: Sim): SpaceView {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x223044, 2.0));
  const layout = bodyLayout(sim.descriptor);
  const unitSphere = new THREE.SphereGeometry(1, 24, 16);
  const orbitGroup = new THREE.Group();
  orbitGroup.name = 'orbit-lines';
  scene.add(orbitGroup);

  const bodies: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  const meta: BodyMeta[] = [];
  const indexByMesh = new Map<THREE.Object3D, number>();

  layout.forEach((ref, i) => {
    let material: THREE.Material;
    if (ref.kind === 'star') {
      const [r, g, b] = temperatureToColor(sim.descriptor.stars[ref.star]!.temperature_k);
      material = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
      const light = new THREE.PointLight(new THREE.Color(r, g, b), 3, 0, 0.15);
      scene.add(light); // repositioned in update() via the mesh (see below)
      (light as THREE.PointLight & { __followsBody?: number }).__followsBody = i;
    } else {
      const palette = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
      const color = ref.kind === 'planet' ? palette[sim.descriptor.planets[ref.planet]!.class] : 0x8a8f98;
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    }
    const mesh = new THREE.Mesh(unitSphere, material);
    mesh.name = `body-${i}`;
    scene.add(mesh);
    bodies.push(mesh);
    indexByMesh.set(mesh, i);

    const div = document.createElement('div');
    div.className = 'body-label';
    div.textContent = bodyName(sim.descriptor, i);
    const label = new CSS2DObject(div);
    mesh.add(label);
    labels.push(label);

    const parent = parentIndex(layout, sim.descriptor, i);
    const moonA = ref.kind === 'moon' ? sim.descriptor.planets[ref.planet]!.moons[ref.moon]!.orbit.semi_major_axis_m : 0;
    const m: BodyMeta = {
      ref,
      radiusM: bodyRadiusM(sim, ref),
      parent,
      moonFactor: ref.kind === 'moon' ? moonViewFactor(moonA, false) : 0,
      orbitLine: null,
    };

    const path = sim.orbitPath(i, ORBIT_SEGMENTS);
    if (path.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(path.length), 3));
      const line = new THREE.LineLoop(
        geo,
        new THREE.LineBasicMaterial({ color: 0x2a3a5a, transparent: true, opacity: 0.7 }),
      );
      line.name = `orbit-${i}`;
      (line as THREE.LineLoop & { __rawPath?: Float64Array }).__rawPath = path;
      orbitGroup.add(line);
      m.orbitLine = line;
    }
    meta.push(m);
  });

  function writeOrbitLine(m: BodyMeta, trueScale: boolean): void {
    const line = m.orbitLine;
    if (!line) return;
    const raw = (line as THREE.LineLoop & { __rawPath?: Float64Array }).__rawPath!;
    const attr = (line.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < raw.length / 3; k++) {
      let x: number, y: number, z: number;
      if (m.ref.kind === 'moon') {
        const f = trueScale ? moonViewFactor(0, true) : m.moonFactor;
        [x, y, z] = [raw[k * 3]! * f, raw[k * 3 + 1]! * f, raw[k * 3 + 2]! * f];
      } else {
        [x, y, z] = compressPosition(raw[k * 3]!, raw[k * 3 + 1]!, raw[k * 3 + 2]!, trueScale);
      }
      attr.setXYZ(k, x, y, z);
    }
    attr.needsUpdate = true;
  }

  let lastTrueScale: boolean | null = null;

  function update(states: Float64Array, trueScale: boolean): void {
    const rescale = trueScale !== lastTrueScale;
    lastTrueScale = trueScale;
    // planets/stars first so moon parents are already placed
    meta.forEach((m, i) => {
      if (m.ref.kind === 'moon') return;
      const [x, y, z] = compressPosition(states[i * 7]!, states[i * 7 + 1]!, states[i * 7 + 2]!, trueScale);
      bodies[i]!.position.set(x, y, z);
      applyCommon(m, i, states, trueScale);
    });
    meta.forEach((m, i) => {
      if (m.ref.kind !== 'moon') return;
      const p = m.parent!;
      const f = trueScale ? moonViewFactor(0, true) : m.moonFactor;
      const dx = states[i * 7]! - states[p * 7]!;
      const dy = states[i * 7 + 1]! - states[p * 7 + 1]!;
      const dz = states[i * 7 + 2]! - states[p * 7 + 2]!;
      bodies[i]!.position.set(
        bodies[p]!.position.x + dx * f,
        bodies[p]!.position.y + dy * f,
        bodies[p]!.position.z + dz * f,
      );
      applyCommon(m, i, states, trueScale);
      if (m.orbitLine) m.orbitLine.position.copy(bodies[p]!.position);
      if (rescale) writeOrbitLine(m, trueScale);
    });
    if (rescale) {
      meta.forEach((m) => {
        if (m.ref.kind !== 'moon') writeOrbitLine(m, trueScale);
      });
    }
    // star lights follow their star
    scene.traverse((o) => {
      const follows = (o as THREE.PointLight & { __followsBody?: number }).__followsBody;
      if (follows !== undefined) o.position.copy(bodies[follows]!.position);
    });
  }

  function applyCommon(m: BodyMeta, i: number, states: Float64Array, trueScale: boolean): void {
    const r = displayRadius(m.ref.kind, m.radiusM, trueScale);
    bodies[i]!.scale.setScalar(Math.max(r, 1e-6));
    const axis = new THREE.Vector3(states[i * 7 + 3]!, states[i * 7 + 4]!, states[i * 7 + 5]!).normalize();
    bodies[i]!.setRotationFromAxisAngle(axis, states[i * 7 + 6]!);
  }

  return {
    scene,
    bodies,
    labels,
    update,
    bodyIndexOf: (o) => indexByMesh.get(o) ?? null,
  };
}
```

- [ ] **Step 7: Run all web tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: PASS (12 tests), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/views
git commit -m "feat: space view — view-space compression, star colors, scene builder"
```

---

### Task 6: Boot, render loop, time controls, interaction

**Files:**
- Create: `web/src/main.ts`, `web/src/ui/hud.ts`, `web/src/ui/seed.ts`
- Test: `web/src/ui/hud.test.ts`, `web/src/ui/seed.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-5.
- Produces: the running app. `seed.ts`: `parseSeedFromHash(hash: string): string | null`, `randomSeed(): string`. `hud.ts`: `formatDate(d: DateTime, cal: Calendar): string`, `buildHud(opts): Hud` with `interface Hud { setDate(s: string): void; setSpeed(label: string): void }` and callbacks `{ onPlayPause(), onSpeed(mult), onTrueScale(on), onReroll() }`.

- [ ] **Step 1: Write the failing tests**

`web/src/ui/seed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSeedFromHash, randomSeed } from './seed';

describe('parseSeedFromHash', () => {
  it('extracts a decimal seed', () => {
    expect(parseSeedFromHash('#seed=42')).toBe('42');
    expect(parseSeedFromHash('#seed=18446744073709551615')).toBe('18446744073709551615');
  });
  it('rejects out-of-range and malformed values', () => {
    expect(parseSeedFromHash('#seed=18446744073709551616')).toBeNull(); // u64::MAX + 1
    expect(parseSeedFromHash('#seed=-3')).toBeNull();
    expect(parseSeedFromHash('#seed=0x2a')).toBeNull();
    expect(parseSeedFromHash('')).toBeNull();
    expect(parseSeedFromHash('#other=1')).toBeNull();
  });
});

describe('randomSeed', () => {
  it('produces a valid u64 decimal string', () => {
    for (let i = 0; i < 20; i++) {
      const s = randomSeed();
      expect(/^\d+$/.test(s)).toBe(true);
      expect(BigInt(s) <= 0xffffffffffffffffn).toBe(true);
    }
  });
});
```

`web/src/ui/hud.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Calendar } from '../sim/types';
import { formatDate } from './hud';

const cal: Calendar = {
  solar_day_s: 86400,
  year_solar_days: 365.2422,
  leap: { base_days: 365, terms: [] },
  months: [],
};

describe('formatDate', () => {
  it('renders year, day, and time-of-day', () => {
    expect(formatDate({ year: 411, day_of_year: 13, day_fraction: 0.5 }, cal)).toBe('Y412 · Day 14 · 12:00');
  });
  it('pads minutes', () => {
    expect(formatDate({ year: 0, day_of_year: 0, day_fraction: 0.0625 }, cal)).toBe('Y1 · Day 1 · 01:30');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/ui`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement seed.ts and hud.ts**

`web/src/ui/seed.ts`:

```ts
const U64_MAX = 0xffffffffffffffffn;

/** Extract a u64 decimal seed from a location hash like `#seed=42`. */
export function parseSeedFromHash(hash: string): string | null {
  const m = /^#seed=(\d+)$/.exec(hash);
  if (!m) return null;
  const s = m[1]!;
  try {
    return BigInt(s) <= U64_MAX ? s : null;
  } catch {
    return null;
  }
}

export function randomSeed(): string {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString();
}
```

`web/src/ui/hud.ts`:

```ts
import type { Calendar, DateTime } from '../sim/types';

/** Local convention: a day is displayed as 24 "hours" of 60 "minutes"
 * regardless of its physical length — clock-faces travel between worlds. */
export function formatDate(d: DateTime, _cal: Calendar): string {
  const totalMinutes = Math.floor(d.day_fraction * 24 * 60);
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const mm = String(totalMinutes % 60).padStart(2, '0');
  return `Y${d.year + 1} · Day ${d.day_of_year + 1} · ${hh}:${mm}`;
}

export const SPEED_STEPS: Array<{ label: string; mult: number }> = [
  { label: '1×', mult: 1 },
  { label: '1 min/s', mult: 60 },
  { label: '1 hr/s', mult: 3600 },
  { label: '1 day/s', mult: 86400 },
  { label: '10 d/s', mult: 864000 },
  { label: '~1 mo/s', mult: 2.6e6 },
];

export interface HudCallbacks {
  onPlayPause(): void;
  onSpeed(mult: number): void;
  onTrueScale(on: boolean): void;
  onReroll(): void;
}

export interface Hud {
  setDate(s: string): void;
  setPaused(paused: boolean): void;
}

export function buildHud(root: HTMLElement, seed: string, cb: HudCallbacks): Hud {
  const topLeft = el('div', 'hud hud-top-left');
  topLeft.append(el('span', '', `seed ${seed}`));
  const reroll = el('button', '', '⟲ reroll');
  reroll.addEventListener('click', () => cb.onReroll());
  const trueScale = el('button', '', 'true scale');
  let ts = false;
  trueScale.addEventListener('click', () => {
    ts = !ts;
    trueScale.classList.toggle('active', ts);
    cb.onTrueScale(ts);
  });
  topLeft.append(reroll, trueScale);

  const topRight = el('div', 'hud hud-top-right');
  const date = el('span', '', '—');
  topRight.append(date);

  const bottom = el('div', 'hud hud-bottom');
  const play = el('button', '', '⏸');
  play.addEventListener('click', () => cb.onPlayPause());
  bottom.append(play);
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of SPEED_STEPS) {
    const b = el('button', '', s.label);
    if (s.mult === 1) b.classList.add('active');
    b.addEventListener('click', () => {
      speedButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      cb.onSpeed(s.mult);
    });
    speedButtons.push(b);
    bottom.append(b);
  }

  root.append(topLeft, topRight, bottom);
  return {
    setDate: (s) => { date.textContent = s; },
    setPaused: (p) => { play.textContent = p ? '▶' : '⏸'; },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
```

- [ ] **Step 4: Run UI tests to verify they pass**

Run: `cd web && npx vitest run src/ui`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement main.ts**

`web/src/main.ts`:

```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadSim, type Sim } from './sim/wasm';
import { SimClock } from './time/clock';
import { buildSpaceScene, type SpaceView } from './views/space';
import { buildHud, formatDate } from './ui/hud';
import { parseSeedFromHash, randomSeed } from './ui/seed';
import './styles.css';

const app = document.getElementById('app')!;

async function boot(): Promise<void> {
  const seed = parseSeedFromHash(location.hash) ?? randomSeed();
  location.hash = `seed=${seed}`;
  app.replaceChildren();

  let sim: Sim;
  try {
    sim = await loadSim(seed);
  } catch (err) {
    const card = document.createElement('div');
    card.className = 'hud hud-top-left';
    card.textContent = `This seed found a bug — please report it. (${String(err)})`;
    app.append(card);
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  app.append(renderer.domElement, labelRenderer.domElement);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 5000);
  camera.position.set(0, -28, 16);
  camera.up.set(0, 0, 1); // +Z is system north (sim frame convention)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const view: SpaceView = buildSpaceScene(sim);
  const clock = new SimClock();
  let trueScale = false;
  let focused: number | null = null;

  const anchorCal = sim.descriptor.planets[sim.descriptor.anchor_planet]!.calendar!;
  const hud = buildHud(app, seed, {
    onPlayPause: () => { clock.paused = !clock.paused; hud.setPaused(clock.paused); },
    onSpeed: (m) => { clock.speed = m; },
    onTrueScale: (on) => { trueScale = on; },
    onReroll: () => { location.hash = `seed=${randomSeed()}`; },
  });

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = app;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  // click-to-focus (ignore drags)
  const down = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
    const ndc = new THREE.Vector2(
      (e.clientX / renderer.domElement.clientWidth) * 2 - 1,
      -(e.clientY / renderer.domElement.clientHeight) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.params.Line = { threshold: 0.05 };
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(view.bodies, false)[0];
    focused = hit ? view.bodyIndexOf(hit.object) : focused;
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') focused = null;
  });
  // Full reload on seed change: tearing down renderer/loop/listeners by hand
  // buys nothing at this app size and invites leaks.
  addEventListener('hashchange', () => location.reload());

  let lastWall = performance.now();
  let lastDateUpdate = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - lastWall) / 1000, 0.1); // clamp tab-switch jumps
    lastWall = now;
    clock.tick(dt);

    view.update(sim.statesAt(clock.t), trueScale);
    if (focused !== null) {
      controls.target.lerp(view.bodies[focused]!.position, 0.15);
    }
    controls.update();

    if (now - lastDateUpdate > 250) {
      lastDateUpdate = now;
      hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
    }
    renderer.render(view.scene, camera);
    labelRenderer.render(view.scene, camera);
  });
}

void boot();
```

- [ ] **Step 6: Typecheck, test, and build**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build:wasm && npm run build`
Expected: typecheck clean, 16 tests pass, wasm + vite builds succeed.

- [ ] **Step 7: Manual QA (required — this is the plan's eyeball gate)**

Run: `cd web && npm run dev` and open the printed URL. Verify each, and record actual observations in your report:

1. `#seed=42` — an M-dwarf **binary**: two star meshes near the center, planets orbiting both; anchor planet (label `II` area) shows moons when clicked.
2. Speed `1 day/s` — inner planets visibly move; the date readout (top right) advances through days.
3. Click a planet — camera target glides to it; its moons and their orbit rings are visible around it. `Esc` releases focus.
4. `true scale` toggle — bodies collapse to dots/invisible (that's correct), orbit lines spread out; toggling back restores the stylized view.
5. `⟲ reroll` — new seed in the URL hash, new system loads.
6. `#seed=16` (edit the hash, reload) — a **trinary**: close pair + distant third star; planets hug the close pair (this is the Plan-1 Critical fix, visible).
7. No console errors during any of the above.

If any check fails, fix before committing; if the fix is non-obvious, report BLOCKED with the console output.

- [ ] **Step 8: Commit**

```bash
git add web/
git commit -m "feat: orrery boots — render loop, time controls, focus, HUD"
```

---

### Task 7: CI — the determinism gate runs on every push

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything; changes nothing.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
          components: clippy
      - uses: Swatinem/rust-cache@v2
      - name: Native tests
        run: cargo test --workspace --locked
      - name: Clippy
        run: cargo clippy --workspace --all-targets --locked -- -D warnings
      - name: Install wasm-pack
        run: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
      - name: wasm32 golden parity (canonical determinism target)
        run: wasm-pack test --node crates/gg-wasm
      - name: Build WASM package
        run: wasm-pack build crates/gg-wasm --target web --out-dir ../../web/src/wasm/pkg
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - name: Web tests + build
        working-directory: web
        run: |
          npm ci
          npx vitest run
          npx tsc --noEmit
          npx vite build
```

- [ ] **Step 2: Validate and dry-run what's runnable locally**

```bash
command -v yq >/dev/null || brew install yq
yq eval '.jobs.test.steps | length' .github/workflows/ci.yml
```
Expected: prints the step count (11) — confirms valid YAML. Then re-run the local equivalents to confirm CI would pass: `cargo test --workspace --locked && cargo clippy --workspace --all-targets --locked -- -D warnings && wasm-pack test --node crates/gg-wasm && cd web && npx vitest run`.

- [ ] **Step 3: Commit**

```bash
git add .github/
git commit -m "ci: native + wasm32-parity + web gates"
```

---

## Plan 2 Definition of Done

- `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` green.
- `wasm-pack test --node crates/gg-wasm` green (wasm32 golden parity — the canonical-target gate).
- `cd web && npx vitest run && npx tsc --noEmit && npm run build` green.
- Manual QA checklist (Task 6 Step 7) verified and recorded.
- Goldens at schema v2, regenerated exactly once (Task 1).

**Deferred to Plan 3:** ground view + sky rendering, URL time/camera state + share button, date-jump input, twin-lens orrery inset, system-tree drawer, doomed-planet UI badges.
