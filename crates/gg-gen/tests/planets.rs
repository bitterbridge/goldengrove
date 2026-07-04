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
    assert!(
        (0.90..=1.00).contains(&(inner / AU)),
        "inner {}",
        inner / AU
    );
    assert!(
        (1.30..=1.45).contains(&(outer / AU)),
        "outer {}",
        outer / AU
    );
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
        assert!(
            a >= 0.95 * inner && a <= 1.05 * outer,
            "seed {seed}: anchor at {} AU",
            a / AU
        );
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
            let rh =
                (((p1.mass_kg + p2.mass_kg) / (3.0 * ctx.total_mass_kg)).cbrt()) * (a1 + a2) / 2.0;
            assert!(
                (a2 - a1) / rh >= 8.0,
                "seed {seed}: spacing {}",
                (a2 - a1) / rh
            );
        }
        for p in &planets {
            if p.orbit.semi_major_axis_m < frost {
                assert_eq!(
                    p.class,
                    PlanetClass::Rocky,
                    "seed {seed}: giant inside frost line"
                );
            }
            assert!(p.mass_kg > 0.0 && p.radius_m > 0.0);
            assert!(p.rotation_period_s > 4.0 * 3600.0);
            // Regression floor: inward Hill-spacing pushes must not shove a
            // planet absurdly far below the innermost stable orbit.
            assert!(
                p.orbit.semi_major_axis_m >= ctx.min_planet_a_m * 0.75,
                "seed {seed}: planet at {} AU below min_planet_a_m floor",
                p.orbit.semi_major_axis_m / AU
            );
        }
    }
}

#[test]
fn low_mass_hosts_terminate_and_stay_spaced() {
    let ctx = StellarContext {
        host_mass_kg: 0.1 * M_SUN,
        total_mass_kg: 0.1 * M_SUN,
        total_luminosity_w: 0.23 * 0.1_f64.powf(2.3) * L_SUN,
        min_planet_a_m: 0.01 * AU,
        age_s: 4.5e9 * 3.156e7,
        primary_ms_lifetime_s: 10e9 * 3.156e7,
    };
    let (hz_inner, hz_outer) = habitable_zone_m(ctx.total_luminosity_w);
    for seed in 0..100u64 {
        let mut rng = RngStream::root(seed).child("planets");
        // Regression: this used to hang forever for low-mass hosts.
        let (planets, anchor) = generate_planets(&mut rng, &ctx);
        assert!(!planets.is_empty(), "seed {seed}");

        for w in planets.windows(2) {
            let (p1, p2) = (&w[0], &w[1]);
            let a1 = p1.orbit.semi_major_axis_m;
            let a2 = p2.orbit.semi_major_axis_m;
            assert!(a2 > a1, "seed {seed}: not sorted");
            let rh =
                (((p1.mass_kg + p2.mass_kg) / (3.0 * ctx.total_mass_kg)).cbrt()) * (a1 + a2) / 2.0;
            assert!(
                (a2 - a1) / rh >= 7.99,
                "seed {seed}: spacing {}",
                (a2 - a1) / rh
            );
        }

        let a_planet = &planets[anchor];
        assert_eq!(a_planet.class, PlanetClass::Rocky, "seed {seed}");
        let a = a_planet.orbit.semi_major_axis_m;
        assert!(
            a >= 0.9 * hz_inner && a <= 1.1 * hz_outer,
            "seed {seed}: anchor at {} AU",
            a / AU
        );
    }
}

#[test]
fn secular_rates_match_final_orbits() {
    let ctx = sunlike_ctx();
    for seed in 0..200u64 {
        let mut rng = RngStream::root(seed).child("planets");
        let (planets, _) = generate_planets(&mut rng, &ctx);
        for p in &planets {
            let expected = gr_apsidal_rate(ctx.host_mass_kg, &p.orbit);
            let tol = 1e-6 * expected.abs().max(1e-30);
            assert!(
                (p.secular.apsidal_rad_per_s - expected).abs() <= tol,
                "seed {seed}: secular rate {} does not match final orbit rate {expected}",
                p.secular.apsidal_rad_per_s
            );
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
            assert!(
                (doom_time_s - remaining).abs() < 1.0,
                "seed {seed}: doom {doom_time_s} != star remaining {remaining}"
            );
        }
    }
    assert!(
        doomed_seen >= 10,
        "8% of 300 should be doomed, saw {doomed_seen}"
    );
}
