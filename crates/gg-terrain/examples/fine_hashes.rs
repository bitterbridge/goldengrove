//! Bootstrap/refresh fine-elevation hash goldens:
//! cargo run -p gg-terrain --example fine_hashes -- <seed> > crates/gg-terrain/tests/golden/terrain-fine-seed-<seed>.json

use std::collections::BTreeMap;

/// 64x32 fine-elevation grid, same pixel-center sampling as heightmap().
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

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .expect("usage: fine_hashes <seed>")
        .parse()
        .expect("u64 seed");
    let desc = gg_gen::generate(seed);
    let total = desc.stars.len()
        + desc.planets.len()
        + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
    let mut out = BTreeMap::new();
    for body in 0..total {
        if let Some(spec) = gg_terrain::TerrainSpec::for_body(seed, &desc, body) {
            out.insert(
                format!("body_{body}"),
                format!("{:#018x}", gg_terrain::fine_hash(&fine_grid(&spec))),
            );
        }
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
