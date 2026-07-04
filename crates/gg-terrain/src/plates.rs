//! Kinematic plates: spherical Voronoi cells, each rotating about its own
//! Euler pole. Boundary character derives from ACTUAL relative motion.

use crate::sphere::{cross, dot, random_unit, scale, V3};
use gg_core::consts::R_EARTH;
use gg_core::rng::RngStream;

pub struct Plate {
    pub seed_point: V3,
    pub euler_pole: V3,
    /// Angular rate, arbitrary kinematic units (relative speeds are what matter).
    pub rate: f64,
    pub continental: bool,
    /// Isostatic base elevation, relative units (continents ride high).
    pub base_elev: f64,
}

pub struct Plates {
    pub plates: Vec<Plate>,
}

pub fn build_plates(rng: &mut RngStream, body_radius_m: f64, land_bias: f64) -> Plates {
    // Larger bodies host more plates (Earth ~15 major+minor; small moons fewer).
    let size = (body_radius_m / R_EARTH).clamp(0.25, 1.5);
    let count = (6.0 + 7.0 * size + rng.uniform(0.0, 3.0)).round() as usize;
    let plates = (0..count)
        .map(|_| {
            let seed_point = random_unit(rng);
            let euler_pole = random_unit(rng);
            let rate = rng.uniform(0.4, 1.6);
            let continental = rng.chance(land_bias);
            let base_elev = if continental {
                rng.uniform(0.25, 0.55)
            } else {
                rng.uniform(-0.75, -0.45)
            };
            Plate { seed_point, euler_pole, rate, continental, base_elev }
        })
        .collect();
    Plates { plates }
}

impl Plates {
    /// Indices of the nearest and second-nearest plate seeds (max dot = min geodesic).
    pub fn nearest_two(&self, p: V3) -> (usize, usize) {
        let (mut a, mut b) = (0usize, 1usize);
        let (mut da, mut db) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (i, pl) in self.plates.iter().enumerate() {
            let d = dot(p, pl.seed_point);
            if d > da {
                b = a;
                db = da;
                a = i;
                da = d;
            } else if d > db {
                b = i;
                db = d;
            }
        }
        (a, b)
    }

    /// Surface velocity of plate `i` at point `p`: rate · (pole × p).
    pub fn velocity(&self, i: usize, p: V3) -> V3 {
        scale(cross(self.plates[i].euler_pole, p), self.plates[i].rate)
    }
}
