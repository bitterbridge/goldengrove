//! Deterministic climate from descriptor facts + the terrain elevation
//! field. ZERO RNG: same seed -> same climate forever, and nothing about
//! existing worlds reshuffles. All transcendentals via gg_core::math.
use gg_core::math;
use gg_gen::descriptor::{PlanetClass, SystemDescriptor, WorldState};

const SIGMA: f64 = 5.670_374_419e-8;
const ALBEDO: f64 = 0.3;
const GREENHOUSE_K_PER_DENSITY: f64 = 30.0;
const LAPSE_K_PER_M: f64 = 6.5e-3;

pub struct ClimateFacts {
    t_mean_k: f64,
    tilt_rad: f64,
    atm_density: f64,
    doomed: bool,
    radius_m: f64,
}

pub fn climate_facts(desc: &SystemDescriptor, body_index: usize) -> Option<ClimateFacts> {
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    if body_index < stars {
        return None;
    }

    // (planet_index, is_moon, radius_m) resolution in ephemeris body order —
    // mirrors gg-terrain's body_facts walk exactly (planets, then moons
    // grouped by owning planet).
    let (p, radius_m, is_moon) = if body_index < stars + planets {
        let p = body_index - stars;
        if desc.planets[p].class != PlanetClass::Rocky {
            return None; // giants have no climate
        }
        (p, desc.planets[p].radius_m, false)
    } else {
        let mut m = body_index - stars - planets;
        let mut found = None;
        for (p, planet) in desc.planets.iter().enumerate() {
            if m < planet.moons.len() {
                found = Some((p, planet.moons[m].radius_m));
                break;
            }
            m -= planet.moons.len();
        }
        let (p, radius_m) = found?;
        (p, radius_m, true)
    };

    let planet = &desc.planets[p];
    if !is_moon && matches!(planet.state, WorldState::Dead) {
        return None; // Dead worlds have no climate
    }

    // Atmosphere density mirrors web/src/sim/layout.ts::atmosphereDensityFor:
    // moons 0.05; rocky planets Dead 0.05 else 1.0. (Dead planets already
    // returned None above, so the planet arm here is always non-Dead.)
    let atm_density = if is_moon { 0.05 } else { 1.0 };

    // Moons of Dead planets still qualify (airless rocks with a cold-desert
    // climate; their vegetation is blocked by atm 0.05 anyway). A moon's
    // "doomed" bias inherits from its parent planet's world state, same as
    // tilt.
    let doomed = matches!(planet.state, WorldState::Doomed { .. });

    // Stellar flux at the owning planet's orbit (multi-star: sum over all
    // stars at the same semi-major axis — host-origin approximation).
    let a = planet.orbit.semi_major_axis_m;
    let s: f64 = desc
        .stars
        .iter()
        .map(|st| st.luminosity_w / (4.0 * core::f64::consts::PI * a * a))
        .sum();
    let t_eq = math::powf(s * (1.0 - ALBEDO) / (4.0 * SIGMA), 0.25);
    let t_mean_k = t_eq + GREENHOUSE_K_PER_DENSITY * atm_density;

    Some(ClimateFacts {
        t_mean_k,
        tilt_rad: planet.axial_tilt_rad,
        atm_density,
        doomed,
        radius_m,
    })
}

impl ClimateFacts {
    pub fn doomed(&self) -> bool {
        self.doomed
    }

    pub fn atm_density(&self) -> f64 {
        self.atm_density
    }

    pub fn tilt_rad(&self) -> f64 {
        self.tilt_rad
    }

    pub fn radius_m(&self) -> f64 {
        self.radius_m
    }
}

pub fn temperature_k(f: &ClimateFacts, lat_deg: f64, elevation_m: f64) -> f64 {
    let phi = lat_deg.abs().to_radians();
    let shaped = math::cos((phi - 0.4 * f.tilt_rad).clamp(0.0, core::f64::consts::FRAC_PI_2));
    f.t_mean_k + 20.0 - 55.0 * (1.0 - shaped) - LAPSE_K_PER_M * elevation_m.max(0.0)
}
