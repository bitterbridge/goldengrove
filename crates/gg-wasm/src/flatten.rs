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
/// steps, positions RELATIVE to the parent focus, from elements with secular
/// drift applied at `t_s` (so the path's periapsis matches the body's actual
/// position at that time — see gg_ephemeris::elements_at). Stars: empty.
pub fn orbit_path_points(
    desc: &SystemDescriptor,
    body_index: usize,
    segments: usize,
    t_s: f64,
) -> Vec<f64> {
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    let (elements, secular, mu) = if body_index < stars {
        return Vec::new();
    } else if body_index < stars + planets {
        let p = &desc.planets[body_index - stars];
        (p.orbit, p.secular, G * planet_host_mass(desc))
    } else {
        let mut m = body_index - stars - planets;
        let mut found = None;
        for p in &desc.planets {
            if m < p.moons.len() {
                found = Some((p.moons[m].orbit, p.moons[m].secular, G * p.mass_kg));
                break;
            }
            m -= p.moons.len();
        }
        match found {
            Some(x) => x,
            None => return Vec::new(), // out-of-range index: empty, not panic
        }
    };
    let elements = gg_ephemeris::elements_at(&elements, &secular, t_s);
    let period = orbital_period_s(elements.semi_major_axis_m, mu);
    let mut out = Vec::with_capacity(3 * segments);
    for k in 0..segments {
        let t = period * (k as f64) / (segments as f64);
        out.extend_from_slice(&position_at(&elements, mu, t));
    }
    out
}

/// Host origin (the point planets orbit) at time t, meters.
/// THE single authority for this convention — the web layer must consume
/// this value, never reimplement it (it drifted once already).
pub fn host_origin_at(eph: &KeplerSecular, t_s: f64) -> [f64; 3] {
    let states = eph.states_at(t_s);
    let desc = eph.desc();
    match desc.planet_host {
        PlanetHost::Primary => states[0].position_m,
        PlanetHost::Barycenter => {
            let (m0, m1) = (desc.stars[0].mass_kg, desc.stars[1].mass_kg);
            let (p0, p1) = (states[0].position_m, states[1].position_m);
            let w = m0 + m1;
            [
                (m0 * p0[0] + m1 * p1[0]) / w,
                (m0 * p0[1] + m1 * p1[1]) / w,
                (m0 * p0[2] + m1 * p1[2]) / w,
            ]
        }
    }
}
