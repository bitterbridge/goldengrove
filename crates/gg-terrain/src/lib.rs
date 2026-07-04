//! Deterministic kinematic-plate terrain. A pure function of
//! (seed, descriptor, body index) — the descriptor itself never changes.

pub mod noise;
pub mod plates;
pub mod sphere;

use gg_core::consts::R_EARTH;
use gg_core::math;
use gg_core::rng::RngStream;
use gg_gen::descriptor::{PlanetClass, SystemDescriptor, WorldState};
use noise::{fbm, warped_fbm};
use plates::{build_plates, Plates};
use sphere::{add, cross, dot, geodesic, latlon_to_unit, normalize, random_unit, scale, sub, V3};

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

/// Width (radians) of the fade band used to smooth over triple-junction
/// ambiguity (see `RawTerrain::third_margin`). Wide enough that, sampled on
/// a 512x256 equirect grid (~0.012 rad/pixel), the fade itself never swings
/// by more than a small fraction of its range within a single pixel step —
/// otherwise the fade would just relocate the cliff instead of removing it.
const TRIPLE_JUNCTION_WIDTH: f64 = 0.4;

fn smooth01(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

struct RawTerrain {
    plates: Plates,
    noise_seed: u64,
    hotspots: Vec<Hotspot>,
}

impl RawTerrain {
    fn build(
        rng: &mut RngStream,
        facts: &BodyFacts,
        land_bias: f64,
        seed: u64,
        body_index: usize,
    ) -> Self {
        let plates = build_plates(rng, facts.radius_m, land_bias);
        // Noise seed derives from the root seed + body index, not from a draw:
        // adding octaves later must not shift the plate draws.
        let noise_seed =
            seed ^ (body_index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xC0FF_EE00_D15E_A5E5;
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
        RawTerrain {
            plates,
            noise_seed,
            hotspots,
        }
    }

    /// Plate-scale domain warp: seams and coastlines wander instead of
    /// following perfect great circles. Applied to ALL plate queries.
    fn warped(&self, p: V3) -> V3 {
        let w: V3 = [
            fbm(self.noise_seed ^ 0x5A5A, scale(p, 1.7), 4),
            fbm(self.noise_seed ^ 0xA5A5, scale(p, 1.7), 4),
            fbm(self.noise_seed ^ 0x55AA, scale(p, 1.7), 4),
        ];
        normalize(add(p, scale(w, 0.055)))
    }

    /// Third-nearest plate index and its margin over the second-nearest
    /// (`dc - db >= 0`) at `q`. Used near triple junctions, where crossing
    /// the bisector between the second- and third-nearest plates swaps `b`'s
    /// identity discontinuously even though `q` moves smoothly. Both
    /// neighboring interpretations (using the old vs. new second-nearest
    /// plate) see the margin shrink to the same zero limit, so anything
    /// gated or blended by it stays continuous through that swap.
    fn third_margin(&self, q: V3, a: usize, b: usize, db: f64) -> (usize, f64) {
        let (c, dc_dot) = self.plates.third_nearest(q, a, b);
        let dc = math::acos(dc_dot.clamp(-1.0, 1.0));
        (c, dc - db)
    }

    /// Confidence that (a, b) are unambiguously the nearest and
    /// second-nearest plates at `q`. Falls smoothly to 0 as the third-nearest
    /// plate ties with b — gates per-pair physics (velocity, continental
    /// character) that has no meaningful continuous extension across a
    /// change of which plate is second-nearest.
    fn pair_confidence(&self, q: V3, a: usize, b: usize, db: f64) -> f64 {
        let (_, margin) = self.third_margin(q, a, b, db);
        smooth01((margin / TRIPLE_JUNCTION_WIDTH).min(1.0))
    }

    fn boundary_term(&self, q: V3) -> f64 {
        let (a, b) = self.plates.nearest_two(q);
        let pa = &self.plates.plates[a];
        let pb = &self.plates.plates[b];
        let da = geodesic(q, pa.seed_point);
        let db = geodesic(q, pb.seed_point);
        // Distance from the (approximate) Voronoi edge; 0 on the edge.
        let edge = (db - da) * 0.5;
        let falloff = math::exp(-(edge / 0.09) * (edge / 0.09));
        if falloff < 1e-3 {
            return 0.0;
        }
        // Near a triple junction the second-nearest plate's identity (and
        // hence its velocity/continental character) is ambiguous; fade the
        // whole pairwise term out as that ambiguity is approached so the
        // swap to a different second-nearest plate is continuous.
        let conf = self.pair_confidence(q, a, b, db);
        if conf < 1e-3 {
            return 0.0;
        }
        // Boundary normal: from plate b's seed toward plate a's, tangent at q.
        let raw_n = sub(pa.seed_point, pb.seed_point);
        let n = normalize(sub(raw_n, scale(q, dot(raw_n, q))));
        let t = cross(q, n);
        let dv = sub(self.plates.velocity(a, q), self.plates.velocity(b, q));
        // dv·n < 0 means plate a's material moves toward plate b: convergence.
        let closing = -dot(dv, n);
        let shear = dot(dv, t).abs();

        let mut term = 0.0;
        if closing > 0.0 {
            match (pa.continental, pb.continental) {
                (true, true) => term += 1.5 * closing * falloff, // collision belts
                (false, false) => {
                    // island arc + trench, offset to the overriding side.
                    // NOTE: widened from the original 0.02 sigma to 0.06 — at
                    // 0.02 this Gaussian is narrower than one grid cell on a
                    // 512x256 sample (~0.012 rad/pixel), so even with A/B/C
                    // fixing the seam defects, this pre-existing (unrelated)
                    // narrow feature still aliases into pixel-to-pixel jumps
                    // over 0.35 on its own; measured via the continuity test.
                    term += 0.45 * closing * falloff;
                    let trench = math::exp(-((edge - 0.035) / 0.06) * ((edge - 0.035) / 0.06));
                    term -= 0.7 * closing * trench;
                }
                _ => {
                    // ocean-continent: cordillera and trench as continuous
                    // signed-side windows (no hard switch at the edge).
                    // signed distance: positive on the continental plate's side
                    let s = if pa.continental { edge } else { -edge };
                    // cordillera: gaussian window centered slightly onto the
                    // continent. NOTE: widened from the spec's 0.045 to 0.06,
                    // same grid-aliasing reason as above.
                    let ridge = math::exp(-((s - 0.025) / 0.06) * ((s - 0.025) / 0.06));
                    // trench: window centered slightly onto the ocean side.
                    // NOTE: widened from the spec's 0.02 sigma to 0.06 (same
                    // width as the ridge window) for the same grid-aliasing
                    // reason as the OO arm's trench above — the offset
                    // (+0.03) and ridge center offset are unchanged.
                    let trench = math::exp(-((s + 0.03) / 0.06) * ((s + 0.03) / 0.06));
                    term += 1.0 * closing * ridge;
                    term -= 0.9 * closing * trench;
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
        term * conf
    }

    /// Cross-edge blended base elevation. Rather than interpolate between
    /// just the nearest two plates (which reintroduces a discontinuity one
    /// rank down, at the second/third-nearest tie — and again at third/
    /// fourth, ad infinitum, at any junction where 3+ plates meet), this
    /// blends ALL plates with a distance-based softmax kernel. That has no
    /// discrete nearest-neighbor selection anywhere, so it's continuous by
    /// construction at every order, including triple (and higher) junctions.
    /// The kernel width matches the ~2.6-degree scale used by the other
    /// boundary windows; far from any boundary it reduces to (approximately)
    /// the single nearest plate's own base_elev, same as the original intent.
    fn base_elevation(&self, q: V3) -> f64 {
        const KERNEL_WIDTH: f64 = 0.045;
        let mut wsum = 0.0;
        let mut vsum = 0.0;
        for pl in &self.plates.plates {
            let d = geodesic(q, pl.seed_point);
            let w = math::exp(-d / KERNEL_WIDTH);
            wsum += w;
            vsum += w * pl.base_elev;
        }
        vsum / wsum
    }

    fn raw_elevation(&self, p: V3) -> f64 {
        let q = self.warped(p);
        let base = self.base_elevation(q);
        let boundary = self.boundary_term(q);
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
pub fn __raw_probe(
    seed: u64,
    desc: &SystemDescriptor,
    body_index: usize,
    lat_deg: f64,
    lon_deg: f64,
) -> Option<f64> {
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
            samples
                .iter()
                .filter(|(e, _)| *e < s)
                .map(|(_, w)| w)
                .sum::<f64>()
                / total_w
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

        Some(TerrainSpec {
            raw,
            sea_level,
            ocean_fraction,
            relief_m,
        })
    }

    /// Elevation relative to sea level (0 = shore), relative units;
    /// `info().relief_m` gives the meters-per-unit scale.
    pub fn elevation(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        self.raw.raw_elevation(latlon_to_unit(lat_deg, lon_deg)) - self.sea_level
    }

    /// Elevation in METERS above sea level with micro-detail octaves that
    /// continue the noise spectrum below heightmap resolution. The base
    /// field is exactly elevation() (same draws, same values); micro adds
    /// <0.7% of relief, so orrery textures and ground truth agree at
    /// texture scale. The ground view and walking consume this.
    pub fn elevation_fine(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        let p = latlon_to_unit(lat_deg, lon_deg);
        let rel = self.raw.raw_elevation(p) - self.sea_level + noise::micro(self.raw.noise_seed, p);
        rel * self.relief_m
    }

    /// Batched elevation_fine: coords is [lat0, lon0, lat1, lon1, ...] in
    /// degrees. One FFI crossing per terrain tile build.
    pub fn elevation_fine_batch(&self, coords: &[f64]) -> Vec<f32> {
        debug_assert!(
            coords.len().is_multiple_of(2),
            "coords must be lat/lon pairs"
        );
        coords
            .chunks_exact(2)
            .map(|c| self.elevation_fine(c[0], c[1]) as f32)
            .collect()
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

/// FNV-1a-64 over centimeter-quantized i32 little-endian bytes — the
/// fine-elevation determinism fingerprint (meter-scale values exceed the
/// coarse hash's ±4 relative-unit clamp, so it gets its own quantization).
pub fn fine_hash(vals: &[f32]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for e in vals {
        let q = (f64::from(*e) * 100.0).round() as i32;
        for b in q.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}
