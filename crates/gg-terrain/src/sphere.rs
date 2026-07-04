//! Unit-sphere math in the planet-fixed frame (x = prime meridian,
//! y = ortho, z = pole) — the same lat/lon convention as web observer.ts.

use gg_core::math;
use gg_core::rng::RngStream;

pub type V3 = [f64; 3];

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
pub fn normalize(a: V3) -> V3 {
    scale(a, 1.0 / norm(a))
}

pub fn random_unit(rng: &mut RngStream) -> V3 {
    let z = rng.uniform(-1.0, 1.0);
    let phi = rng.uniform(0.0, std::f64::consts::TAU);
    let s = (1.0 - z * z).max(0.0).sqrt();
    [s * math::cos(phi), s * math::sin(phi), z]
}

/// Great-circle distance in radians.
pub fn geodesic(a: V3, b: V3) -> f64 {
    math::acos(dot(a, b).clamp(-1.0, 1.0))
}

pub fn latlon_to_unit(lat_deg: f64, lon_deg: f64) -> V3 {
    let lat = lat_deg.to_radians();
    let lon = lon_deg.to_radians();
    [
        math::cos(lat) * math::cos(lon),
        math::cos(lat) * math::sin(lon),
        math::sin(lat),
    ]
}
