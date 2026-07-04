//! Bootstrap/refresh terrain hash goldens:
//! cargo run -p gg-terrain --example hashes -- <seed> > crates/gg-terrain/tests/golden/terrain-seed-<seed>.json

use std::collections::BTreeMap;

fn main() {
    let seed: u64 = std::env::args().nth(1).expect("usage: hashes <seed>").parse().expect("u64 seed");
    let desc = gg_gen::generate(seed);
    let total = desc.stars.len()
        + desc.planets.len()
        + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
    let mut out = BTreeMap::new();
    for body in 0..total {
        if let Some(spec) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
            out.insert(
                format!("body_{body}"),
                format!("{:#018x}", gg_terrain::heightmap_hash(&spec.heightmap(256, 128))),
            );
        }
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
