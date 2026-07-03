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
