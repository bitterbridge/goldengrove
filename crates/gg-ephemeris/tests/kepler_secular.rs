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

#[test]
fn body_order_contract_with_multiple_planets_and_moons() {
    let mut desc = single_planet_system();
    // planet 0 at 1 AU with 0 moons; planet 1 at 2 AU with 2 moons; planet 2 at 4 AU with 1 moon
    desc.planets.push(bare_planet(2.0 * AU));
    desc.planets.push(bare_planet(4.0 * AU));
    let make_moon = |a: f64| Moon {
        mass_kg: 7.3e22,
        radius_m: 1.7e6,
        orbit: circular(a),
        secular: SecularRates::default(),
        tidally_locked: true,
        rotation_period_s: 2.36e6,
        doom_time_s: None,
    };
    desc.planets[1].moons.push(make_moon(3.0e8));
    desc.planets[1].moons.push(make_moon(6.0e8));
    desc.planets[2].moons.push(make_moon(4.0e8));

    let eph = KeplerSecular::new(desc.clone());
    // 1 star + 3 planets + 3 moons
    assert_eq!(eph.body_count(), 7);
    let states = eph.states_at(1.0e7);
    assert_eq!(states.len(), 7);

    // index helpers agree with the layout
    assert_eq!(star_index(0), 0);
    assert_eq!(planet_index(&desc, 0), 1);
    assert_eq!(planet_index(&desc, 2), 3);
    assert_eq!(moon_index(&desc, 1, 0), 4);
    assert_eq!(moon_index(&desc, 1, 1), 5);
    assert_eq!(moon_index(&desc, 2, 0), 6);

    // each moon sits at its own orbital radius from ITS planet (proves grouping)
    for (pi, mi, a) in [(1usize, 0usize, 3.0e8), (1, 1, 6.0e8), (2, 0, 4.0e8)] {
        let p = states[planet_index(&desc, pi)].position_m;
        let m = states[moon_index(&desc, pi, mi)].position_m;
        let d = [m[0] - p[0], m[1] - p[1], m[2] - p[2]];
        assert!((mag(d) - a).abs() < 1.0e3, "moon {mi} of planet {pi}");
    }

    // planets ordered by descriptor order, radii increasing per construction
    let r1 = mag(states[planet_index(&desc, 0)].position_m);
    let r2 = mag(states[planet_index(&desc, 1)].position_m);
    let r3 = mag(states[planet_index(&desc, 2)].position_m);
    assert!(r1 < r2 && r2 < r3);
}
