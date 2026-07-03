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
    10e9 * YEAR_APPROX * (mass_kg / M_SUN).powf(-2.5)
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
    let age_s = rng.uniform(0.1, 0.97) * lifetime.min(12e9 * YEAR_APPROX);

    StarsOutput { stars, planet_host, age_s }
}
