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
