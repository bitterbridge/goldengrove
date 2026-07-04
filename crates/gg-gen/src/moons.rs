use crate::descriptor::{Moon, Planet, PlanetClass, SecularRates, WorldState};
use crate::planets::StellarContext;
use gg_core::consts::*;
use gg_core::math;
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
    a_m * math::cbrt(m_planet / (3.0 * m_star))
}

pub fn roche_limit_m(planet_radius_m: f64, planet_density: f64, moon_density: f64) -> f64 {
    2.44 * planet_radius_m * math::cbrt(planet_density / moon_density)
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
    let nodal = -0.75 * n_planet * n_planet / n_moon * math::cos(orbit.inclination_rad);
    // Apsidal advance ≈ 2.1x the nodal magnitude (lunar 8.85 yr vs 18.6 yr).
    let apsidal = 2.1 * nodal.abs();

    // Tidal migration: da/dt = K (m/M)(R/a)^5 n a; sign from synchronous orbit.
    let outward = moon_period > planet.rotation_period_s;
    let mag =
        TIDAL_K * (moon_mass_kg / planet.mass_kg) * (planet.radius_m / a).powi(5) * n_moon * a;
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
    let solar_rate = 1.5 * h * n_planet * n_planet / spin * math::cos(planet.axial_tilt_rad).abs();
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
        1.5 * h * n_planet * n_planet / spin * math::cos(planet.axial_tilt_rad).abs();

    let count = match planet.class {
        PlanetClass::Rocky => {
            let p_first = (planet.mass_kg / M_EARTH * 0.35).min(0.7);
            let first = usize::from(rng.chance(p_first));
            // second-moon roll must be drawn unconditionally: fixed draw order
            let second = usize::from(rng.chance(0.15));
            if first == 0 {
                0
            } else {
                first + second
            }
        }
        _ => rng.pick_count(2, 6),
    };

    let hill = hill_radius_m(
        planet.orbit.semi_major_axis_m,
        planet.mass_kg,
        ctx.total_mass_kg,
    );
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
        let (secular, locked, doom) =
            moon_physics(planet, moon_mass, &orbit, planet_orbit_period_s);
        let rotation = if locked {
            orbital_period_s(a, G * planet.mass_kg)
        } else {
            rng.log_uniform(6.0, 40.0) * 3600.0
        };
        let radius = math::cbrt(3.0 * moon_mass / (4.0 * std::f64::consts::PI * MOON_DENSITY));
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
    if soonest_doom < 1e8 * YEAR_APPROX {
        match planet.state {
            WorldState::Living => {
                planet.state = WorldState::Doomed {
                    doom_time_s: soonest_doom,
                }
            }
            WorldState::Doomed { doom_time_s } if soonest_doom < doom_time_s => {
                planet.state = WorldState::Doomed {
                    doom_time_s: soonest_doom,
                };
            }
            _ => {}
        }
    }
}
