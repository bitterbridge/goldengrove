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
