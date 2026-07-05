//! Bootstrap/refresh biome hash goldens:
//! cargo run -p gg-climate --example biome_hashes -- <seed> > crates/gg-climate/tests/golden/biome-seed-<seed>.json

use std::collections::BTreeMap;

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .expect("usage: biome_hashes <seed>")
        .parse()
        .expect("u64 seed");
    let desc = gg_gen::generate(seed);
    let total = desc.stars.len()
        + desc.planets.len()
        + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
    let mut out = BTreeMap::new();
    for body in 0..total {
        if let Some(terrain) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
            if let Some(spec) = gg_climate::ClimateSpec::for_body(&desc, body, &terrain) {
                out.insert(
                    format!("body_{body}"),
                    format!(
                        "{:#018x}",
                        gg_climate::biome_hash(&spec.biome_grid(&terrain, 256, 128))
                    ),
                );
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
