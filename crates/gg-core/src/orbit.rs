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
