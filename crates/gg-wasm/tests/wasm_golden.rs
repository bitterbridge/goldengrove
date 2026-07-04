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
