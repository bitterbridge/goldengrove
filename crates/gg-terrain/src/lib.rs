//! Deterministic kinematic-plate terrain. A pure function of
//! (seed, descriptor, body index) — the descriptor itself never changes.

pub mod noise;
pub mod plates;
pub mod sphere;

use gg_core::consts::R_EARTH;
use gg_core::math;
use gg_core::rng::RngStream;
use gg_gen::descriptor::{PlanetClass, SystemDescriptor, WorldState};
use noise::warped_fbm;
use plates::{build_plates, Plates};
use sphere::{cross, dot, geodesic, latlon_to_unit, normalize, random_unit, scale, sub, V3};

struct Hotspot {
    center: V3,
    step: V3, // small tangent step between successive bumps (hotspot trail)
    count: usize,
    amp: f64,
}

struct BodyFacts {
    radius_m: f64,
    dead: bool,
}

/// Resolve a terrain-bearing body by ephemeris body order.
/// Rocky planets and ALL moons qualify; stars and giants do not.
fn body_facts(desc: &SystemDescriptor, body_index: usize) -> Option<BodyFacts> {
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    if body_index < stars {
        return None;
    }
    if body_index < stars + planets {
        let p = &desc.planets[body_index - stars];
        if p.class != PlanetClass::Rocky {
            return None;
        }
        return Some(BodyFacts {
            radius_m: p.radius_m,
            dead: matches!(p.state, WorldState::Dead),
        });
    }
    let mut m = body_index - stars - planets;
    for p in &desc.planets {
        if m < p.moons.len() {
            return Some(BodyFacts {
                radius_m: p.moons[m].radius_m,
                // The dry-basin rule keys on the PLANET's Dead state; moons
                // always use the normal ocean-fraction range (their own low
                // ranges arrive with climate later).
                dead: false,
            });
        }
        m -= p.moons.len();
    }
    None
}

struct RawTerrain {
    plates: Plates,
    noise_seed: u64,
    hotspots: Vec<Hotspot>,
}

impl RawTerrain {
    fn build(rng: &mut RngStream, facts: &BodyFacts, land_bias: f64, seed: u64, body_index: usize) -> Self {
        let plates = build_plates(rng, facts.radius_m, land_bias);
        // Noise seed derives from the root seed + body index, not from a draw:
        // adding octaves later must not shift the plate draws.
        let noise_seed = seed
            ^ (body_index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ 0xC0FF_EE00_D15E_A5E5;
        let hotspot_count = rng.pick_count(0, 2);
        let hotspots = (0..hotspot_count)
            .map(|_| {
                let center = random_unit(rng);
                let dir = normalize(cross(random_unit(rng), center));
                Hotspot {
                    center,
                    step: scale(dir, 0.05),
                    count: 3 + rng.pick_count(0, 4),
                    amp: rng.uniform(0.25, 0.6),
                }
            })
            .collect();
        RawTerrain { plates, noise_seed, hotspots }
    }

    fn boundary_term(&self, p: V3) -> f64 {
        let (a, b) = self.plates.nearest_two(p);
        let pa = &self.plates.plates[a];
        let pb = &self.plates.plates[b];
        let da = geodesic(p, pa.seed_point);
        let db = geodesic(p, pb.seed_point);
        // Distance from the (approximate) Voronoi edge; 0 on the edge.
        let edge_dist = (db - da) * 0.5;
        let falloff = math::exp(-(edge_dist / 0.09) * (edge_dist / 0.09));
        if falloff < 1e-3 {
            return 0.0;
        }
        // Boundary normal: from plate b's seed toward plate a's, tangent at p.
        let raw_n = sub(pa.seed_point, pb.seed_point);
        let n = normalize(sub(raw_n, scale(p, dot(raw_n, p))));
        let t = cross(p, n);
        let dv = sub(self.plates.velocity(a, p), self.plates.velocity(b, p));
        // dv·n < 0 means plate a's material moves toward plate b: convergence.
        let closing = -dot(dv, n);
        let shear = dot(dv, t).abs();

        let mut term = 0.0;
        if closing > 0.0 {
            match (pa.continental, pb.continental) {
                (true, true) => term += 1.5 * closing * falloff, // collision belts
                (false, false) => {
                    // island arc + trench, offset to the overriding side
                    term += 0.45 * closing * falloff;
                    let trench = math::exp(-((edge_dist - 0.035) / 0.02) * ((edge_dist - 0.035) / 0.02));
                    term -= 0.7 * closing * trench;
                }
                _ => {
                    // ocean-continent: cordillera on the continental side,
                    // trench on the oceanic side
                    let on_continent = if da <= db { pa.continental } else { pb.continental };
                    if on_continent {
                        term += 1.0 * closing * falloff;
                    } else {
                        let trench = math::exp(-((edge_dist - 0.03) / 0.02) * ((edge_dist - 0.03) / 0.02));
                        term -= 0.9 * closing * trench;
                    }
                }
            }
        } else {
            let opening = -closing;
            if !pa.continental && !pb.continental {
                term += 0.35 * opening * falloff; // mid-ocean ridge
            } else {
                term -= 0.6 * opening * falloff; // continental rift
            }
        }
        term += 0.12 * shear * falloff; // transform ridging
        term
    }

    fn raw_elevation(&self, p: V3) -> f64 {
        let (a, _) = self.plates.nearest_two(p);
        let base = self.plates.plates[a].base_elev;
        let boundary = self.boundary_term(p);
        let detail = 0.35 * warped_fbm(self.noise_seed, scale(p, 2.6), 6);
        let mut hot = 0.0;
        for h in &self.hotspots {
            let mut c = h.center;
            let mut amp = h.amp;
            for _ in 0..h.count {
                let d = geodesic(p, normalize(c));
                hot += amp * math::exp(-(d / 0.02) * (d / 0.02));
                c = sphere::add(c, h.step);
                amp *= 0.72;
            }
        }
        base + boundary + detail + hot
    }
}

/// Diagnostic probe: raw (pre-sea-level) elevation. Kept public-but-hidden
/// so property tests and future tuning can see the composition directly.
#[doc(hidden)]
pub fn __raw_probe(seed: u64, desc: &SystemDescriptor, body_index: usize, lat_deg: f64, lon_deg: f64) -> Option<f64> {
    let facts = body_facts(desc, body_index)?;
    let mut rng = RngStream::root(seed).child(&format!("terrain-{body_index}"));
    // FIXED DRAW ORDER (shared with TerrainSpec::for_body): ocean target,
    // land bias, relief, plates, hotspots.
    let _ocean_target = draw_ocean_target(&mut rng, &facts);
    let land_bias = rng.uniform(0.25, 0.6);
    let _relief = rng.uniform(3000.0, 12_000.0) * (facts.radius_m / R_EARTH).clamp(0.3, 1.2);
    let raw = RawTerrain::build(&mut rng, &facts, land_bias, seed, body_index);
    Some(raw.raw_elevation(latlon_to_unit(lat_deg, lon_deg)))
}

fn draw_ocean_target(rng: &mut RngStream, facts: &BodyFacts) -> f64 {
    if facts.dead {
        rng.uniform(0.0, 0.15)
    } else {
        rng.uniform(0.20, 0.85)
    }
}

pub struct TerrainSpec {
    raw: RawTerrain,
    sea_level: f64,
    ocean_fraction: f64,
    relief_m: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TerrainInfo {
    pub sea_level: f64,
    pub ocean_fraction: f64,
    pub relief_m: f64,
    pub plate_count: usize,
}

impl TerrainSpec {
    pub fn for_body(seed: u64, desc: &SystemDescriptor, body_index: usize) -> Option<TerrainSpec> {
        let facts = body_facts(desc, body_index)?;
        let mut rng = RngStream::root(seed).child(&format!("terrain-{body_index}"));
        let ocean_target = draw_ocean_target(&mut rng, &facts);
        let land_bias = rng.uniform(0.25, 0.6);
        let relief_m = rng.uniform(3000.0, 12_000.0) * (facts.radius_m / R_EARTH).clamp(0.3, 1.2);
        let raw = RawTerrain::build(&mut rng, &facts, land_bias, seed, body_index);

        // Solve sea level by bisection on a cos-lat-weighted sample grid so
        // the weighted underwater fraction hits the target.
        let (gw, gh) = (128usize, 64usize); // same grid the ocean-fraction test measures on
        let mut samples = Vec::with_capacity(gw * gh);
        for row in 0..gh {
            let lat = 90.0 - (row as f64 + 0.5) * 180.0 / gh as f64;
            let weight = math::cos(lat.to_radians());
            for col in 0..gw {
                let lon = -180.0 + (col as f64 + 0.5) * 360.0 / gw as f64;
                samples.push((raw.raw_elevation(latlon_to_unit(lat, lon)), weight));
            }
        }
        let total_w: f64 = samples.iter().map(|(_, w)| w).sum();
        let frac_below = |s: f64| -> f64 {
            samples.iter().filter(|(e, _)| *e < s).map(|(_, w)| w).sum::<f64>() / total_w
        };
        let (mut lo, mut hi) = (-6.0f64, 6.0f64);
        for _ in 0..48 {
            let mid = 0.5 * (lo + hi);
            if frac_below(mid) < ocean_target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let sea_level = 0.5 * (lo + hi);
        let ocean_fraction = frac_below(sea_level);

        Some(TerrainSpec { raw, sea_level, ocean_fraction, relief_m })
    }

    /// Elevation relative to sea level (0 = shore), relative units;
    /// `info().relief_m` gives the meters-per-unit scale.
    pub fn elevation(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        self.raw.raw_elevation(latlon_to_unit(lat_deg, lon_deg)) - self.sea_level
    }

    /// Equirect heightmap: row-major, row 0 = lat +90, col 0 = lon -180,
    /// sample centers at pixel centers.
    pub fn heightmap(&self, width: usize, height: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(width * height);
        for row in 0..height {
            let lat = 90.0 - (row as f64 + 0.5) * 180.0 / height as f64;
            for col in 0..width {
                let lon = -180.0 + (col as f64 + 0.5) * 360.0 / width as f64;
                out.push(self.elevation(lat, lon) as f32);
            }
        }
        out
    }

    pub fn info(&self) -> TerrainInfo {
        TerrainInfo {
            sea_level: self.sea_level,
            ocean_fraction: self.ocean_fraction,
            relief_m: self.relief_m,
            plate_count: self.raw.plates.plates.len(),
        }
    }
}

/// FNV-1a-64 over the little-endian bytes of the i16 quantization —
/// the terrain determinism fingerprint.
pub fn heightmap_hash(map: &[f32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for e in map {
        let q = ((f64::from(*e).clamp(-4.0, 4.0) / 4.0) * 32767.0) as i16;
        for b in q.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}
