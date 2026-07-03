//! The WASM boundary: coarse, data-oriented, three-call shape per the spec.

pub mod flatten;

use flatten::{flatten_states, orbit_path_points};
use gg_ephemeris::{Ephemeris, KeplerSecular};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct World {
    eph: KeplerSecular,
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
        Ok(World { eph: KeplerSecular::new(gg_gen::generate(seed)) })
    }

    pub fn descriptor_json(&self) -> String {
        serde_json::to_string(self.eph.desc()).expect("descriptor always serializes")
    }

    pub fn body_count(&self) -> usize {
        self.eph.body_count()
    }

    /// Per-frame call: 7 f64 per body (position, spin axis, rotation).
    pub fn states_at(&self, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(flatten_states(&self.eph, t_s).as_slice())
    }

    /// 3 f64 per segment, relative to the parent focus. Empty for stars.
    pub fn orbit_path(&self, body_index: usize, segments: usize) -> js_sys::Float64Array {
        js_sys::Float64Array::from(orbit_path_points(self.eph.desc(), body_index, segments).as_slice())
    }

    /// [x, y, z] of the point planets orbit, meters.
    pub fn host_origin_at(&self, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(flatten::host_origin_at(&self.eph, t_s).as_slice())
    }

    /// Anchor planet's calendar date at t.
    pub fn anchor_date_json(&self, t_s: f64) -> String {
        let desc = self.eph.desc();
        let cal = desc.planets[desc.anchor_planet]
            .calendar
            .as_ref()
            .expect("anchor planet always has a calendar");
        serde_json::to_string(&gg_gen::calendar::date_at(cal, t_s)).expect("date serializes")
    }
}
