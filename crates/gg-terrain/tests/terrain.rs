use gg_gen::generate;
use gg_terrain::__raw_probe;

#[test]
fn convergent_continental_boundaries_rise_above_interiors() {
    // statistical: across seeds and bodies, the mean of the top-decile raw
    // elevations should comfortably exceed the mean (mountain belts exist),
    // and raw elevation must be bounded.
    let mut ratios = Vec::new();
    for seed in [1u64, 42, 7, 99, 12345] {
        let desc = generate(seed);
        let stars = desc.stars.len();
        let anchor_body = stars + desc.anchor_planet;
        let mut samples = Vec::new();
        for row in 0..48 {
            let lat = 90.0 - (row as f64 + 0.5) * 180.0 / 48.0;
            for col in 0..96 {
                let lon = -180.0 + (col as f64 + 0.5) * 360.0 / 96.0;
                let e = __raw_probe(seed, &desc, anchor_body, lat, lon).unwrap();
                assert!(e.is_finite() && e.abs() < 6.0, "seed {seed}: raw {e}");
                samples.push(e);
            }
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mean: f64 = samples.iter().sum::<f64>() / samples.len() as f64;
        let top: f64 = samples[samples.len() * 9 / 10..].iter().sum::<f64>()
            / (samples.len() as f64 / 10.0);
        ratios.push(top - mean);
    }
    assert!(
        ratios.iter().filter(|r| **r > 0.4).count() >= 3,
        "mountainous tails missing: {ratios:?}"
    );
}

#[test]
fn non_terrain_bodies_probe_none() {
    let desc = generate(42);
    assert!(__raw_probe(42, &desc, 0, 0.0, 0.0).is_none(), "stars have no terrain");
    let giant = desc.planets.iter().position(|p| p.class != gg_gen::descriptor::PlanetClass::Rocky);
    if let Some(g) = giant {
        assert!(__raw_probe(42, &desc, desc.stars.len() + g, 0.0, 0.0).is_none());
    }
}
