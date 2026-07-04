use gg_gen::generate;
use gg_terrain::__raw_probe;
use gg_terrain::{heightmap_hash, TerrainSpec};

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
        let top: f64 =
            samples[samples.len() * 9 / 10..].iter().sum::<f64>() / (samples.len() as f64 / 10.0);
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
    assert!(
        __raw_probe(42, &desc, 0, 0.0, 0.0).is_none(),
        "stars have no terrain"
    );
    let giant = desc
        .planets
        .iter()
        .position(|p| p.class != gg_gen::descriptor::PlanetClass::Rocky);
    if let Some(g) = giant {
        assert!(__raw_probe(42, &desc, desc.stars.len() + g, 0.0, 0.0).is_none());
    }
}

#[test]
fn ocean_fraction_matches_its_draw() {
    for seed in [1u64, 42, 7, 99, 12345, 777] {
        let desc = generate(seed);
        let anchor_body = desc.stars.len() + desc.anchor_planet;
        let spec = TerrainSpec::for_body(seed, &desc, anchor_body).unwrap();
        let info = spec.info();
        let map = spec.heightmap(128, 64);
        // the solve grid IS 128x64 with cos-lat weights, so the weighted
        // measurement must match info.ocean_fraction almost exactly:
        assert!(
            (info.ocean_fraction - weighted_ocean(&map, 128, 64)).abs() < 1e-9,
            "seed {seed}: info {} vs measured",
            info.ocean_fraction
        );
        assert!(info.plate_count >= 6 && info.relief_m > 500.0);
    }
}

fn weighted_ocean(map: &[f32], w: usize, h: usize) -> f64 {
    let mut wet = 0.0;
    let mut total = 0.0;
    for row in 0..h {
        let lat = (90.0 - (row as f64 + 0.5) * 180.0 / h as f64).to_radians();
        let weight = lat.cos();
        for col in 0..w {
            total += weight;
            if map[row * w + col] < 0.0 {
                wet += weight;
            }
        }
    }
    wet / total
}

#[test]
fn dead_worlds_are_dry() {
    // seed 18's anchor is Dead (established earlier in the project QA)
    let desc = generate(18);
    let anchor_body = desc.stars.len() + desc.anchor_planet;
    assert!(matches!(
        desc.planets[desc.anchor_planet].state,
        gg_gen::descriptor::WorldState::Dead
    ));
    let spec = TerrainSpec::for_body(18, &desc, anchor_body).unwrap();
    assert!(
        spec.info().ocean_fraction <= 0.16,
        "dead world too wet: {}",
        spec.info().ocean_fraction
    );
}

#[test]
fn heightmap_layout_and_elevation_agree() {
    let desc = generate(42);
    let anchor_body = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor_body).unwrap();
    let (w, h) = (64usize, 32usize);
    let map = spec.heightmap(w, h);
    assert_eq!(map.len(), w * h);
    for (row, col) in [(0usize, 0usize), (5, 20), (31, 63)] {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / h as f64;
        let lon = -180.0 + (col as f64 + 0.5) * 360.0 / w as f64;
        let direct = spec.elevation(lat, lon);
        assert!(
            (map[row * w + col] as f64 - direct).abs() < 1e-5,
            "row {row} col {col}"
        );
    }
}

#[test]
fn moons_have_terrain_and_all_terrain_is_deterministic() {
    let desc = generate(42);
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    let first_moon = stars + planets; // moons grouped after planets
    let a = TerrainSpec::for_body(42, &desc, first_moon).expect("moons have terrain");
    let b = TerrainSpec::for_body(42, &desc, first_moon).unwrap();
    assert_eq!(a.heightmap(64, 32), b.heightmap(64, 32));
}

#[test]
fn elevation_field_is_continuous() {
    // Volleyball-seam regression: adjacent samples ~0.7 deg apart must never
    // jump like cliffs. Old code: worst single-step jump 1.52; fixed field
    // must stay under 0.35 everywhere on the same grid.
    for seed in [1u64, 42, 7] {
        let desc = generate(seed);
        let anchor_body = desc.stars.len() + desc.anchor_planet;
        let spec = TerrainSpec::for_body(seed, &desc, anchor_body).unwrap();
        let (w, h) = (512usize, 256usize);
        let map = spec.heightmap(w, h);
        let mut worst = 0.0f64;
        for r in 0..h {
            for c in 0..w {
                let here = map[r * w + c] as f64;
                let right = map[r * w + (c + 1) % w] as f64;
                worst = worst.max((here - right).abs());
                if r + 1 < h {
                    let down = map[(r + 1) * w + c] as f64;
                    worst = worst.max((here - down).abs());
                }
            }
        }
        assert!(worst < 0.35, "seed {seed}: cliff discontinuity {worst}");
    }
}

#[test]
fn golden_terrain_hashes_are_pinned() {
    for seed in [1u64, 42, 123_456_789] {
        let path = format!("tests/golden/terrain-seed-{seed}.json");
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!("missing {path}; bootstrap: cargo run -p gg-terrain --example hashes -- {seed} > crates/gg-terrain/{path}")
        });
        let expected: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&expected).unwrap();
        let desc = generate(seed);
        let total = desc.stars.len()
            + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(
                    format!("body_{body}"),
                    format!("{:#018x}", heightmap_hash(&spec.heightmap(256, 128))),
                );
            }
        }
        assert_eq!(actual, expected, "seed {seed}: terrain diverged — shared worlds would change; this is the terrain determinism contract");
    }
}

#[test]
fn micro_detail_is_small_and_continuous() {
    // Amplitude budget: |micro| is bounded by its octave-amplitude sum,
    // 0.07/(1-0.8) = 0.35 relative units worst case (empirical max is far
    // lower; the 0.20 bound below holds with margin). Adjacent samples
    // 1e-5 rad apart (~60 m) must not jump more than the finest octaves
    // can move.
    let mut worst_val = 0.0f64;
    let mut worst_jump = 0.0f64;
    let mut prev: Option<f64> = None;
    for i in 0..20_000 {
        let t = i as f64 * 1e-5;
        let p = gg_terrain::sphere::latlon_to_unit(12.0 + t * 57.2957795, 40.0);
        let m = gg_terrain::noise::micro(0xDEADBEEF, p);
        worst_val = worst_val.max(m.abs());
        if let Some(pv) = prev {
            worst_jump = worst_jump.max((m - pv).abs());
        }
        prev = Some(m);
    }
    assert!(
        worst_val < 0.20,
        "micro amplitude {worst_val} exceeds spectral budget"
    );
    assert!(
        worst_jump < 0.03,
        "micro jump {worst_jump} over ~60 m step — discontinuous"
    );
    assert!(
        worst_val > 0.01,
        "micro is degenerate — retune lost its amplitude"
    );
}

#[test]
fn fine_terrain_has_walking_scale_relief() {
    // RMS slope sampled at ~1 km spacing must be mountain-legible. The
    // pre-retune spectrum measured ~0.005 here; the retune targets ~0.05+
    // globally (land masked higher, plains lower).
    let desc = generate(42);
    let anchor = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor).unwrap();
    let radius: f64 = 6.371e6; // sampling geometry only; slope is dimensionless
    let step_deg = (1000.0 / radius).to_degrees();
    let mut sq_sum = 0.0;
    let n = 4000;
    for i in 0..n {
        let lat = -60.0 + 120.0 * (i as f64) / (n as f64);
        let lon = -170.0 + 340.0 * (i as f64 * 0.618_033_988_75).fract();
        let e0 = spec.elevation_fine(lat, lon);
        let e1 = spec.elevation_fine(lat + step_deg, lon);
        let slope = (e1 - e0) / 1000.0;
        sq_sum += slope * slope;
    }
    let rms = (sq_sum / n as f64).sqrt();
    assert!(rms > 0.02, "terrain is glassy: RMS 1km slope {rms}");
    assert!(rms < 0.60, "terrain is spiky noise: RMS 1km slope {rms}");
}

#[test]
fn elevation_fine_agrees_with_elevation_at_scale() {
    // fine = relief_m * (elevation + mask * micro): the base field is
    // untouched, so fine/relief must stay within micro's masked amplitude
    // of elevation() everywhere. The geometric bound is 0.07/(1-0.8) = 0.35
    // relative units; empirically the worst masked seam measures ~0.11, so
    // the 0.20 assert below carries real margin while staying tight enough
    // to catch an accidental amplitude blow-up.
    let desc = generate(42);
    let anchor = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor).unwrap();
    let relief = spec.info().relief_m;
    for row in 0..32 {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / 32.0;
        for col in 0..64 {
            let lon = -180.0 + (col as f64 + 0.5) * 360.0 / 64.0;
            let coarse = spec.elevation(lat, lon);
            let fine = spec.elevation_fine(lat, lon);
            let diff = (fine / relief - coarse).abs();
            assert!(diff < 0.20, "spectral seam at ({lat},{lon}): {diff}");
        }
    }
}

#[test]
fn elevation_fine_batch_matches_scalar() {
    let desc = generate(42);
    let anchor = desc.stars.len() + desc.anchor_planet;
    let spec = TerrainSpec::for_body(42, &desc, anchor).unwrap();
    let coords = [10.0, 20.0, -35.5, 170.25, 89.0, -179.0];
    let batch = spec.elevation_fine_batch(&coords);
    assert_eq!(batch.len(), 3);
    for (i, pair) in coords.chunks_exact(2).enumerate() {
        assert_eq!(batch[i], spec.elevation_fine(pair[0], pair[1]) as f32);
    }
}

/// 64x32 fine-elevation grid, same pixel-center sampling as heightmap().
fn fine_grid(spec: &TerrainSpec) -> Vec<f32> {
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

#[test]
fn golden_fine_hashes_are_pinned() {
    for seed in [1u64, 42, 123_456_789] {
        let path = format!("tests/golden/terrain-fine-seed-{seed}.json");
        let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            panic!("missing {path}; bootstrap: cargo run -p gg-terrain --example fine_hashes -- {seed} > crates/gg-terrain/{path}")
        });
        let expected: std::collections::BTreeMap<String, String> =
            serde_json::from_str(&expected).unwrap();
        let desc = generate(seed);
        let total = desc.stars.len()
            + desc.planets.len()
            + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();
        let mut actual = std::collections::BTreeMap::new();
        for body in 0..total {
            if let Some(spec) = TerrainSpec::for_body(seed, &desc, body) {
                actual.insert(
                    format!("body_{body}"),
                    format!("{:#018x}", gg_terrain::fine_hash(&fine_grid(&spec))),
                );
            }
        }
        assert_eq!(actual, expected, "seed {seed}: fine elevation diverged — ground terrain would change under walkers' feet");
    }
}
