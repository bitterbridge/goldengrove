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
