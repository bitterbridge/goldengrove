//! THE determinism gate for the canonical target: wasm32 output must equal
//! the natively generated golden files byte-for-byte (spec: Determinism
//! contract). Runs under `wasm-pack test --node`.
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn wasm32_matches_native_goldens() {
    for (seed, golden) in [
        (1u64, include_str!("../../gg-gen/tests/golden/seed-1.json")),
        (42, include_str!("../../gg-gen/tests/golden/seed-42.json")),
        (123_456_789, include_str!("../../gg-gen/tests/golden/seed-123456789.json")),
    ] {
        let actual = serde_json::to_string_pretty(&gg_gen::generate(seed)).unwrap();
        assert_eq!(
            actual.trim(),
            golden.trim(),
            "seed {seed}: wasm32 diverged from native goldens — determinism contract broken"
        );
    }
}
