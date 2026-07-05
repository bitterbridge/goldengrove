//! THE determinism gate for the canonical target: wasm32 output must equal
//! the natively generated golden files byte-for-byte (spec: Determinism
//! contract). Runs under `wasm-pack test --node`.
#![cfg(target_arch = "wasm32")]

use gg_wasm::World;
use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn wasm32_matches_native_goldens() {
    for (seed, golden) in [
        (1u64, include_str!("../../gg-gen/tests/golden/seed-1.json")),
        (42, include_str!("../../gg-gen/tests/golden/seed-42.json")),
        (
            123_456_789,
            include_str!("../../gg-gen/tests/golden/seed-123456789.json"),
        ),
    ] {
        let actual = serde_json::to_string_pretty(&gg_gen::generate(seed)).unwrap();
        assert_eq!(
            actual.trim(),
            golden.trim(),
            "seed {seed}: wasm32 diverged from native goldens — determinism contract broken"
        );
    }
}

#[wasm_bindgen_test]
fn world_boundary_marshals_correctly() {
    let w = World::new("42").expect("valid seed");
    let n = w.body_count();
    assert!(n > 0);
    let states = w.states_at(1.0e7);
    assert_eq!(states.length(), (n * 7) as u32);
    // spot-check: a finite position and a normalized-ish spin axis for body 0
    let v = states.to_vec();
    assert!(v[0].is_finite() && v[1].is_finite() && v[2].is_finite());
    let axis_len = (v[3] * v[3] + v[4] * v[4] + v[5] * v[5]).sqrt();
    assert!(
        (axis_len - 1.0).abs() < 1e-9,
        "spin axis not normalized: {axis_len}"
    );
    // orbit path: stars empty, first planet non-empty
    assert_eq!(w.orbit_path(0, 64, 0.0).length(), 0);
    let desc: serde_json::Value = serde_json::from_str(&w.descriptor_json().unwrap()).unwrap();
    let n_stars = desc["stars"].as_array().unwrap().len();
    assert_eq!(w.orbit_path(n_stars, 64, 0.0).length(), 3 * 64);
    // anchor date parses and starts at year 0
    let date: serde_json::Value = serde_json::from_str(&w.anchor_date_json(0.0).unwrap()).unwrap();
    assert_eq!(date["year"].as_u64().unwrap(), 0);
    let origin = w.host_origin_at(1.0e7);
    assert_eq!(origin.length(), 3);
    assert!(origin.to_vec().iter().all(|v| v.is_finite()));
}

/// 64x32 fine-elevation grid, same pixel-center sampling as heightmap()
/// (mirrors gg-terrain's tests/terrain.rs; wasm tests can't import test
/// helpers from another crate's test binary).
fn fine_grid(spec: &gg_terrain::TerrainSpec) -> Vec<f32> {
    let (w, h) = (64usize, 32usize);
    let mut out = Vec::with_capacity(w * h);
    for row in 0..h {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / h as f64;
        for col in 0..w {
            let lon = -180.0 + (col as f64 + 0.5) * 360.0 / w as f64;
            out.push(spec.elevation_fine(lat, lon) as f32);
        }
    }
    out
}

#[wasm_bindgen_test]
fn body_elevation_scalar_and_batch_agree() {
    let world = World::new("42").unwrap();
    // anchor planet body index: stars.len() + anchor_planet, read from the descriptor JSON
    let desc: serde_json::Value = serde_json::from_str(&world.descriptor_json().unwrap()).unwrap();
    let body =
        desc["stars"].as_array().unwrap().len() + desc["anchor_planet"].as_u64().unwrap() as usize;
    let e = world.body_elevation(body, 10.0, 20.0).unwrap();
    assert!(
        e.is_finite() && e.abs() < 50_000.0,
        "implausible elevation {e}"
    );
    let batch = world.body_elevations(body, &[10.0, 20.0]);
    assert_eq!(batch.length(), 1);
    assert_eq!(batch.get_index(0), e as f32);
    // star (body 0) has no terrain
    assert!(world.body_elevation(0, 0.0, 0.0).is_err());
    assert_eq!(world.body_elevations(0, &[0.0, 0.0]).length(), 0);
}

#[wasm_bindgen_test]
fn junk_seeds_error_cleanly() {
    for bad in ["banana", "", "-5", "0x2a", "18446744073709551616"] {
        assert!(World::new(bad).is_err(), "seed {bad:?} should be rejected");
    }
}

#[wasm_bindgen_test]
fn terrain_hashes_match_native_goldens_on_wasm32() {
    for (seed, golden) in [
        (
            1u64,
            include_str!("../../gg-terrain/tests/golden/terrain-seed-1.json"),
        ),
        (
            42,
            include_str!("../../gg-terrain/tests/golden/terrain-seed-42.json"),
        ),
        (
            123_456_789,
            include_str!("../../gg-terrain/tests/golden/terrain-seed-123456789.json"),
        ),
    ] {
        let expected: std::collections::BTreeMap<String, String> =
            serde_json::from_str(golden).unwrap();
        let desc = gg_gen::generate(seed);
        let total = desc.stars.len()
            + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(
                    format!("body_{body}"),
                    format!(
                        "{:#018x}",
                        gg_terrain::heightmap_hash(&spec.heightmap(256, 128))
                    ),
                );
            }
        }
        assert_eq!(
            actual, expected,
            "seed {seed}: wasm32 terrain diverged from native"
        );
    }
    // the World boundary itself (cache + marshaling) on wasm32:
    let w = World::new("42").expect("valid seed");
    assert_eq!(
        w.body_heightmap(0, 8, 4).length(),
        0,
        "stars have no terrain"
    );
    let desc: serde_json::Value = serde_json::from_str(&w.descriptor_json().unwrap()).unwrap();
    let anchor_body =
        desc["stars"].as_array().unwrap().len() + desc["anchor_planet"].as_u64().unwrap() as usize;
    assert_eq!(w.body_heightmap(anchor_body, 8, 4).length(), 32);
    assert_eq!(
        w.body_heightmap(anchor_body, 8, 4).length(),
        32,
        "cached second call identical"
    );
}

#[wasm_bindgen_test]
fn fine_hashes_match_native_goldens_on_wasm32() {
    for (seed, golden) in [
        (
            1u64,
            include_str!("../../gg-terrain/tests/golden/terrain-fine-seed-1.json"),
        ),
        (
            42,
            include_str!("../../gg-terrain/tests/golden/terrain-fine-seed-42.json"),
        ),
        (
            123_456_789,
            include_str!("../../gg-terrain/tests/golden/terrain-fine-seed-123456789.json"),
        ),
    ] {
        let expected: std::collections::BTreeMap<String, String> =
            serde_json::from_str(golden).unwrap();
        let desc = gg_gen::generate(seed);
        let total = desc.stars.len()
            + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(
                    format!("body_{body}"),
                    format!("{:#018x}", gg_terrain::fine_hash(&fine_grid(&spec))),
                );
            }
        }
        assert_eq!(
            actual, expected,
            "seed {seed}: wasm32 fine elevation diverged from native"
        );
    }
}

#[wasm_bindgen_test]
fn biome_hashes_match_native_goldens_on_wasm32() {
    for (seed, golden) in [
        (
            1u64,
            include_str!("../../gg-climate/tests/golden/biome-seed-1.json"),
        ),
        (
            42,
            include_str!("../../gg-climate/tests/golden/biome-seed-42.json"),
        ),
        (
            123_456_789,
            include_str!("../../gg-climate/tests/golden/biome-seed-123456789.json"),
        ),
    ] {
        let expected: std::collections::BTreeMap<String, String> =
            serde_json::from_str(golden).unwrap();
        let desc = gg_gen::generate(seed);
        let total = desc.stars.len()
            + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(terrain) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
                if let Some(spec) = gg_climate::ClimateSpec::for_body(&desc, body, &terrain) {
                    actual.insert(
                        format!("body_{body}"),
                        format!(
                            "{:#018x}",
                            gg_climate::biome_hash(&spec.biome_grid(&terrain, 256, 128))
                        ),
                    );
                }
            }
        }
        assert_eq!(
            actual, expected,
            "seed {seed}: wasm32 biome classification diverged from native"
        );
    }
}

#[wasm_bindgen_test]
fn climate_boundary_marshals_correctly() {
    let w = World::new("42").expect("valid seed");
    let desc: serde_json::Value = serde_json::from_str(&w.descriptor_json().unwrap()).unwrap();
    let anchor_body =
        desc["stars"].as_array().unwrap().len() + desc["anchor_planet"].as_u64().unwrap() as usize;

    // Stars have no terrain and therefore no climate: everything empties out.
    assert_eq!(
        w.body_biome_grid(0, 8, 4).length(),
        0,
        "stars have no climate"
    );
    assert_eq!(
        w.body_biomes(0, &[0.0, 0.0]).length(),
        0,
        "stars have no climate"
    );
    assert!(
        w.body_climate_info(0).is_err(),
        "stars have no climate info"
    );

    // Anchor: grid is the right shape, and scalar/batch classification agree
    // at a handful of coordinates.
    let grid = w.body_biome_grid(anchor_body, 8, 4);
    assert_eq!(grid.length(), 32);

    let coords = [10.0, 20.0, -35.5, 170.25, 89.0, -179.0];
    let batch = w.body_biomes(anchor_body, &coords);
    assert_eq!(batch.length(), 3);
    for (i, pair) in coords.chunks_exact(2).enumerate() {
        let scalar = w.body_biomes(anchor_body, &[pair[0], pair[1]]);
        assert_eq!(
            batch.get_index(i as u32),
            scalar.get_index(0),
            "coord {pair:?}: batch/scalar disagree"
        );
    }

    let info: serde_json::Value =
        serde_json::from_str(&w.body_climate_info(anchor_body).unwrap()).unwrap();
    assert!(info["mean_temp_k"].as_f64().unwrap().is_finite());
    let ice = info["ice_fraction"].as_f64().unwrap();
    assert!((0.0..=1.0).contains(&ice));
}
