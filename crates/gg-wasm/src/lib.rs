//! The WASM boundary: coarse, data-oriented, three-call shape per the spec.

pub mod flatten;

use flatten::{flatten_states, orbit_path_points};
use gg_ephemeris::{Ephemeris, KeplerSecular};
use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// Native-testable core of the terrain boundary (no wasm types).
pub fn terrain_heightmap_native(
    desc: &gg_gen::descriptor::SystemDescriptor,
    seed: u64,
    body_index: usize,
    width: usize,
    height: usize,
) -> Vec<f32> {
    gg_terrain::TerrainSpec::for_body(seed, desc, body_index)
        .map(|s| s.heightmap(width, height))
        .unwrap_or_default()
}

#[wasm_bindgen]
pub struct World {
    eph: KeplerSecular,
    seed: u64,
    // WASM runs single-threaded, so RefCell (rather than Mutex) is safe here
    // and avoids the overhead of atomic locking for what is effectively a
    // per-call memoization cache keyed by body index.
    terrain: RefCell<HashMap<usize, Option<gg_terrain::TerrainSpec>>>,
    // Separate cache/RefCell from `terrain`: ClimateSpec doesn't own a
    // TerrainSpec (its methods borrow one per call), so climate lookups
    // borrow both caches sequentially — never nested mutable borrows of the
    // same cell. See `with_climate`.
    climate: RefCell<HashMap<usize, Option<gg_climate::ClimateSpec>>>,
}

#[wasm_bindgen]
impl World {
    /// Seeds cross the boundary as decimal strings: u64 exceeds JS Number.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: &str) -> Result<World, JsError> {
        let seed: u64 = seed
            .trim()
            .parse()
            .map_err(|_| JsError::new("seed must be a decimal u64 string"))?;
        Ok(World {
            eph: KeplerSecular::new(gg_gen::generate(seed)),
            seed,
            terrain: RefCell::new(HashMap::new()),
            climate: RefCell::new(HashMap::new()),
        })
    }

    pub fn descriptor_json(&self) -> Result<String, JsError> {
        serde_json::to_string(self.eph.desc())
            .map_err(|e| JsError::new(&format!("descriptor serialization failed: {e}")))
    }

    pub fn body_count(&self) -> usize {
        self.eph.body_count()
    }

    /// Per-frame call: 7 f64 per body (position, spin axis, rotation).
    pub fn states_at(&self, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(flatten_states(&self.eph, t_s).as_slice())
    }

    /// 3 f64 per segment, relative to the parent focus, sampled from the
    /// secular-drifted elements at time t. Empty for stars.
    pub fn orbit_path(&self, body_index: usize, segments: usize, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(
            orbit_path_points(self.eph.desc(), body_index, segments, t_s).as_slice(),
        )
    }

    /// [x, y, z] of the point planets orbit, meters.
    pub fn host_origin_at(&self, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(flatten::host_origin_at(&self.eph, t_s).as_slice())
    }

    /// Anchor planet's calendar date at t.
    pub fn anchor_date_json(&self, t_s: f64) -> Result<String, JsError> {
        let desc = self.eph.desc();
        let cal = desc.planets[desc.anchor_planet]
            .calendar
            .as_ref()
            .ok_or_else(|| JsError::new("anchor planet has no calendar"))?;
        serde_json::to_string(&gg_gen::calendar::date_at(cal, t_s))
            .map_err(|e| JsError::new(&format!("date serialization failed: {e}")))
    }

    fn with_terrain<R>(
        &self,
        body_index: usize,
        f: impl FnOnce(Option<&gg_terrain::TerrainSpec>) -> R,
    ) -> R {
        let mut cache = self.terrain.borrow_mut();
        let entry = cache.entry(body_index).or_insert_with(|| {
            gg_terrain::TerrainSpec::for_body(self.seed, self.eph.desc(), body_index)
        });
        f(entry.as_ref())
    }

    /// Equirect heightmap (row 0 = lat +90). Empty array = no terrain body.
    pub fn body_heightmap(
        &self,
        body_index: usize,
        width: usize,
        height: usize,
    ) -> js_sys::Float32Array {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => js_sys::Float32Array::from(s.heightmap(width, height).as_slice()),
            None => js_sys::Float32Array::new_with_length(0),
        })
    }

    pub fn body_terrain_info(&self, body_index: usize) -> Result<String, JsError> {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => serde_json::to_string(&s.info())
                .map_err(|e| JsError::new(&format!("terrain info serialization failed: {e}"))),
            None => Err(JsError::new("no terrain for this body")),
        })
    }

    /// Fine elevation (METERS above sea level) at a surface point.
    /// Error for bodies with no terrain (stars, giants).
    pub fn body_elevation(
        &self,
        body_index: usize,
        lat_deg: f64,
        lon_deg: f64,
    ) -> Result<f64, JsError> {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => Ok(s.elevation_fine(lat_deg, lon_deg)),
            None => Err(JsError::new("no terrain for this body")),
        })
    }

    /// Batched fine elevations: coords = [lat0, lon0, lat1, lon1, ...] deg.
    /// Empty array = no terrain body (renderer skips), matching body_heightmap.
    pub fn body_elevations(&self, body_index: usize, coords: &[f64]) -> js_sys::Float32Array {
        self.with_terrain(body_index, |spec| match spec {
            Some(s) => js_sys::Float32Array::from(s.elevation_fine_batch(coords).as_slice()),
            None => js_sys::Float32Array::new_with_length(0),
        })
    }

    /// Ensures the terrain entry exists first (a separate RefCell, borrowed
    /// then dropped), then borrows `terrain` (immutable) and `climate`
    /// (mutable) sequentially — never nested mutable borrows of the same
    /// cell. `ClimateSpec` doesn't own a `TerrainSpec`, so callers get both
    /// references together.
    fn with_climate<R>(
        &self,
        body_index: usize,
        f: impl FnOnce(Option<(&gg_climate::ClimateSpec, &gg_terrain::TerrainSpec)>) -> R,
    ) -> R {
        self.with_terrain(body_index, |_| {});

        let terrain_cache = self.terrain.borrow();
        let terrain = terrain_cache.get(&body_index).and_then(|t| t.as_ref());

        let mut climate_cache = self.climate.borrow_mut();
        let climate_entry = climate_cache.entry(body_index).or_insert_with(|| {
            terrain.and_then(|t| gg_climate::ClimateSpec::for_body(self.eph.desc(), body_index, t))
        });

        match (climate_entry.as_ref(), terrain) {
            (Some(c), Some(t)) => f(Some((c, t))),
            _ => f(None),
        }
    }

    /// Equirect biome classification grid (u8 per cell, row 0 = lat +90).
    /// Empty array = no climate for this body.
    pub fn body_biome_grid(&self, body_index: usize, w: usize, h: usize) -> js_sys::Uint8Array {
        self.with_climate(body_index, |data| match data {
            Some((spec, terrain)) => {
                js_sys::Uint8Array::from(spec.biome_grid(terrain, w, h).as_slice())
            }
            None => js_sys::Uint8Array::new_with_length(0),
        })
    }

    /// Batched biome classification: coords = [lat0, lon0, lat1, lon1, ...]
    /// deg. Empty array = no climate for this body, matching body_biome_grid.
    pub fn body_biomes(&self, body_index: usize, coords: &[f64]) -> js_sys::Uint8Array {
        self.with_climate(body_index, |data| match data {
            Some((spec, terrain)) => {
                let out: Vec<u8> = coords
                    .chunks_exact(2)
                    .map(|pair| spec.biome(terrain, pair[0], pair[1]) as u8)
                    .collect();
                js_sys::Uint8Array::from(out.as_slice())
            }
            None => js_sys::Uint8Array::new_with_length(0),
        })
    }

    pub fn body_climate_info(&self, body_index: usize) -> Result<String, JsError> {
        self.with_climate(body_index, |data| match data {
            Some((spec, _)) => serde_json::to_string(&spec.info())
                .map_err(|e| JsError::new(&format!("climate info serialization failed: {e}"))),
            None => Err(JsError::new("no climate for this body")),
        })
    }
}
