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

// --- Moisture grid ----------------------------------------------------
//
// Zero new RNG draws: the grid is a pure function of ClimateFacts (tilt,
// radius) and the already-built terrain elevation field. Pinned constants
// per the plan's Global Constraints:
//   m_lat = 0.55 + 0.45*cos(6*phi_eff), phi_eff = phi * 30/(22 + 8*min(1, tilt/0.4084))
//   shadow = clamp(1 - sum(max(0, e_up - e_here))/(8*2500), 0.25, 1)
//     over 8 upwind samples at 150 km steps along constant latitude,
//     eastward when |lat| < 30 deg else westward.
//   cont = 0.45 + 0.55*oceanFrac, oceanFrac over a 16-point 500 km ring
//     (elevation_fine < 0 counts as ocean).
//   M = clamp(m_lat * shadow * cont, 0, 1)

const MOISTURE_GRID_W: usize = 128;
const MOISTURE_GRID_H: usize = 64;

const HADLEY_BASE: f64 = 0.55;
const HADLEY_AMP: f64 = 0.45;
const HADLEY_TILT_REF_RAD: f64 = 0.4084; // 23.4 degrees

const RAIN_SHADOW_SAMPLES: usize = 8;
const RAIN_SHADOW_STEP_M: f64 = 150_000.0;
const RAIN_SHADOW_NORM: f64 = RAIN_SHADOW_SAMPLES as f64 * 2500.0;

const CONT_RING_SAMPLES: usize = 16;
const CONT_RING_RADIUS_M: f64 = 500_000.0;
const CONT_BASE: f64 = 0.45;
const CONT_AMP: f64 = 0.55;

const POLE_CLAMP_DEG: f64 = 89.0;

pub struct ClimateSpec {
    facts: ClimateFacts,
    // width x height (128x64), row-major, pixel centers like
    // gg_terrain::TerrainSpec::heightmap (row 0 = lat +90, col 0 = lon -180).
    moisture_grid: Vec<f32>,
}

impl ClimateSpec {
    /// Builds the moisture grid from the terrain's elevation field.
    /// None when climate_facts is None.
    pub fn for_body(
        desc: &SystemDescriptor,
        body_index: usize,
        terrain: &gg_terrain::TerrainSpec,
    ) -> Option<ClimateSpec> {
        let facts = climate_facts(desc, body_index)?;
        let moisture_grid = build_moisture_grid(&facts, terrain);
        Some(ClimateSpec {
            facts,
            moisture_grid,
        })
    }

    /// Annual-mean surface temperature in K; delegates to `temperature_k`.
    pub fn temperature_k(&self, lat_deg: f64, elevation_m: f64) -> f64 {
        temperature_k(&self.facts, lat_deg, elevation_m)
    }

    /// Bilinear sample of the moisture grid, wrapped in longitude and
    /// clamped in latitude.
    pub fn moisture(&self, lat_deg: f64, lon_deg: f64) -> f64 {
        sample_equirect(
            &self.moisture_grid,
            MOISTURE_GRID_W,
            MOISTURE_GRID_H,
            lat_deg,
            lon_deg,
        )
    }
}

fn hadley_m_lat(lat_deg: f64, tilt_rad: f64) -> f64 {
    let scale = 30.0 / (22.0 + 8.0 * (tilt_rad / HADLEY_TILT_REF_RAD).min(1.0));
    let phi_eff_deg = lat_deg * scale;
    HADLEY_BASE + HADLEY_AMP * math::cos((6.0 * phi_eff_deg).to_radians())
}

/// Rain shadow factor: integrates positive relief along `samples` upwind
/// steps of `step_m` at constant latitude (eastward below 30 deg |lat|,
/// westward above).
fn rain_shadow(
    terrain: &gg_terrain::TerrainSpec,
    radius_m: f64,
    lat_deg: f64,
    lon_deg: f64,
) -> f64 {
    let e_here = terrain.elevation_fine(lat_deg, lon_deg);
    let cos_lat = math::cos(lat_deg.to_radians()).abs().max(1e-6);
    let direction = if lat_deg.abs() < 30.0 { 1.0 } else { -1.0 };

    let mut deficit = 0.0;
    for i in 1..=RAIN_SHADOW_SAMPLES {
        let dist_m = RAIN_SHADOW_STEP_M * i as f64;
        let dlon_rad = direction * dist_m / (radius_m * cos_lat);
        let lon_up = lon_deg + dlon_rad.to_degrees();
        let e_up = terrain.elevation_fine(lat_deg, lon_up);
        deficit += (e_up - e_here).max(0.0);
    }
    (1.0 - deficit / RAIN_SHADOW_NORM).clamp(0.25, 1.0)
}

/// Fraction of a 500 km great-circle ring (16 bearings, small-angle offsets
/// with cos-lat longitude scaling, latitude clamped to +-89) that is ocean
/// (`elevation_fine < 0`).
fn ring_ocean_frac(
    terrain: &gg_terrain::TerrainSpec,
    radius_m: f64,
    lat_deg: f64,
    lon_deg: f64,
) -> f64 {
    let ring_angle_rad = CONT_RING_RADIUS_M / radius_m;
    let cos_lat = math::cos(lat_deg.to_radians()).abs().max(1e-6);

    let mut ocean = 0usize;
    for k in 0..CONT_RING_SAMPLES {
        let bearing_rad = (k as f64 * 360.0 / CONT_RING_SAMPLES as f64).to_radians();
        let dlat_deg = (ring_angle_rad * math::cos(bearing_rad)).to_degrees();
        let dlon_deg = (ring_angle_rad * math::sin(bearing_rad) / cos_lat).to_degrees();
        let lat_p = (lat_deg + dlat_deg).clamp(-POLE_CLAMP_DEG, POLE_CLAMP_DEG);
        let lon_p = wrap_lon_deg(lon_deg + dlon_deg);
        if terrain.elevation_fine(lat_p, lon_p) < 0.0 {
            ocean += 1;
        }
    }
    ocean as f64 / CONT_RING_SAMPLES as f64
}

/// Wraps a longitude in degrees to `[-180, 180)`.
fn wrap_lon_deg(lon_deg: f64) -> f64 {
    (lon_deg + 180.0).rem_euclid(360.0) - 180.0
}

fn build_moisture_grid(facts: &ClimateFacts, terrain: &gg_terrain::TerrainSpec) -> Vec<f32> {
    let radius_m = facts.radius_m();
    let mut grid = Vec::with_capacity(MOISTURE_GRID_W * MOISTURE_GRID_H);
    for row in 0..MOISTURE_GRID_H {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / MOISTURE_GRID_H as f64;
        for col in 0..MOISTURE_GRID_W {
            let lon = -180.0 + (col as f64 + 0.5) * 360.0 / MOISTURE_GRID_W as f64;
            let m_lat = hadley_m_lat(lat, facts.tilt_rad());
            let shadow = rain_shadow(terrain, radius_m, lat, lon);
            let cont = CONT_BASE + CONT_AMP * ring_ocean_frac(terrain, radius_m, lat, lon);
            let m = (m_lat * shadow * cont).clamp(0.0, 1.0);
            grid.push(m as f32);
        }
    }
    grid
}

/// Bilinear sample of an equirect grid at pixel centers (row 0 = lat +90,
/// col 0 = lon -180; same convention as `gg_terrain::TerrainSpec::heightmap`).
/// Longitude wraps; latitude clamps to the grid's valid range.
fn sample_equirect(grid: &[f32], width: usize, height: usize, lat_deg: f64, lon_deg: f64) -> f64 {
    let lat = lat_deg.clamp(-90.0, 90.0);
    let lon = wrap_lon_deg(lon_deg);

    let row_f = ((90.0 - lat) / 180.0 * height as f64 - 0.5).clamp(0.0, (height - 1) as f64);
    let row0 = row_f.floor() as usize;
    let row1 = (row0 + 1).min(height - 1);
    let ty = row_f - row0 as f64;

    let col_f = (lon + 180.0) / 360.0 * width as f64 - 0.5;
    let col0f = col_f.floor();
    let tx = col_f - col0f;
    let col0 = (col0f as i64).rem_euclid(width as i64) as usize;
    let col1 = (col0 + 1) % width;

    let at = |r: usize, c: usize| f64::from(grid[r * width + c]);
    let top = at(row0, col0) * (1.0 - tx) + at(row0, col1) * tx;
    let bot = at(row1, col0) * (1.0 - tx) + at(row1, col1) * tx;
    top * (1.0 - ty) + bot * ty
}

/// Diagnostic probe: ocean fraction of the 500 km continentality ring at a
/// point. Kept public-but-hidden so tests can link continentality to the
/// resulting moisture value directly (mirrors `gg_terrain::__raw_probe`).
#[doc(hidden)]
pub fn __ring_ocean_frac(
    spec: &ClimateSpec,
    terrain: &gg_terrain::TerrainSpec,
    lat_deg: f64,
    lon_deg: f64,
) -> f64 {
    ring_ocean_frac(terrain, spec.facts.radius_m(), lat_deg, lon_deg)
}
