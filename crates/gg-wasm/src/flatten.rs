//! Pure data-shaping between gg-ephemeris and the JS boundary.
//! Kept free of wasm-bindgen types so it tests natively.

use gg_core::consts::G;
use gg_core::orbit::{orbital_period_s, position_at};
use gg_ephemeris::{Ephemeris, KeplerSecular};
use gg_gen::descriptor::{PlanetHost, SystemDescriptor};

/// Per-body layout: [x_m, y_m, z_m, axis_x, axis_y, axis_z, rotation_rad].
pub const FLOATS_PER_BODY: usize = 7;

pub fn flatten_states(eph: &KeplerSecular, t_s: f64) -> Vec<f64> {
    let states = eph.states_at(t_s);
    let mut out = Vec::with_capacity(states.len() * FLOATS_PER_BODY);
    for s in &states {
        out.extend_from_slice(&s.position_m);
        out.extend_from_slice(&s.spin_axis);
        out.push(s.rotation_rad);
    }
    out
}

/// Mass planets orbit (mirrors gg-ephemeris's private helper: close pair
/// for Barycenter, primary alone otherwise).
pub fn planet_host_mass(desc: &SystemDescriptor) -> f64 {
    match desc.planet_host {
        PlanetHost::Barycenter => desc.stars[0].mass_kg + desc.stars[1].mass_kg,
        PlanetHost::Primary => desc.stars[0].mass_kg,
    }
}

/// One full orbit for a planet or moon, sampled at `segments` equal time
/// steps, positions RELATIVE to the parent focus (epoch elements — secular
/// drift over one orbit is invisible at render scale). Stars: empty.
pub fn orbit_path_points(desc: &SystemDescriptor, body_index: usize, segments: usize) -> Vec<f64> {
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    let (elements, mu) = if body_index < stars {
        return Vec::new();
    } else if body_index < stars + planets {
        let p = &desc.planets[body_index - stars];
        (p.orbit, G * planet_host_mass(desc))
    } else {
        let mut m = body_index - stars - planets;
        let mut found = None;
        for p in &desc.planets {
            if m < p.moons.len() {
                found = Some((p.moons[m].orbit, G * p.mass_kg));
                break;
            }
            m -= p.moons.len();
        }
        match found {
            Some(x) => x,
            None => return Vec::new(), // out-of-range index: empty, not panic
        }
    };
    let period = orbital_period_s(elements.semi_major_axis_m, mu);
    let mut out = Vec::with_capacity(3 * segments);
    for k in 0..segments {
        let t = period * (k as f64) / (segments as f64);
        out.extend_from_slice(&position_at(&elements, mu, t));
    }
    out
}
