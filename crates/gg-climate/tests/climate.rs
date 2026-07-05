use gg_climate::{climate_facts, temperature_k, Biome};
use gg_gen::descriptor::{PlanetClass, WorldState};
use gg_gen::generate;

fn anchor(seed: u64) -> (gg_gen::descriptor::SystemDescriptor, usize) {
    let desc = generate(seed);
    let idx = desc.stars.len() + desc.anchor_planet;
    (desc, idx)
}

#[test]
fn anchor_world_is_habitable_range() {
    // The anchor is guaranteed in/near the HZ: its mean-latitude sea-level
    // temperature must be broadly habitable, not venusian or cryogenic.
    for seed in [1u64, 42, 123_456_789] {
        let (desc, idx) = anchor(seed);
        let f = climate_facts(&desc, idx).expect("anchor has climate");
        let t = temperature_k(&f, 45.0, 0.0);
        assert!((210.0..340.0).contains(&t), "seed {seed}: T45 = {t}");
    }
}

#[test]
fn equator_hotter_than_poles_and_lapse_cools() {
    let (desc, idx) = anchor(42);
    let f = climate_facts(&desc, idx).unwrap();
    assert!(temperature_k(&f, 0.0, 0.0) > temperature_k(&f, 80.0, 0.0) + 15.0);
    assert!(temperature_k(&f, 10.0, 0.0) > temperature_k(&f, 10.0, 4000.0) + 20.0);
}

#[test]
fn stars_giants_and_dead_worlds_have_no_climate() {
    let (desc, _) = anchor(42);
    assert!(climate_facts(&desc, 0).is_none(), "star");

    let stars = desc.stars.len();
    let planets = desc.planets.len();
    let total = stars + planets + desc.planets.iter().map(|p| p.moons.len()).sum::<usize>();

    for body in stars..total {
        if body < stars + planets {
            // Planet: Rocky + non-Dead -> Some; Rocky + Dead -> None;
            // giants (non-Rocky) -> None regardless of state.
            let p = &desc.planets[body - stars];
            let expect_some = p.class == PlanetClass::Rocky && !matches!(p.state, WorldState::Dead);
            assert_eq!(
                climate_facts(&desc, body).is_some(),
                expect_some,
                "planet body {body}: class={:?} state={:?}",
                p.class,
                p.state
            );
        } else {
            // Moon: no world state of its own -> always qualifies, even
            // when its parent planet is Dead (airless cold-desert climate).
            assert!(
                climate_facts(&desc, body).is_some(),
                "moon body {body} should have climate"
            );
        }
    }
}

#[test]
fn moisture_properties() {
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    // bounded
    for lat in [-80.0, -30.0, 0.0, 30.0, 80.0] {
        for lon in [-170.0, -60.0, 0.0, 60.0, 170.0] {
            let m = spec.moisture(lat, lon);
            assert!((0.0..=1.0).contains(&m), "M({lat},{lon}) = {m}");
        }
    }
    // subtropics drier than equator ON AVERAGE (zonal means)
    let zonal = |lat: f64| -> f64 {
        (0..64)
            .map(|i| spec.moisture(lat, -180.0 + (i as f64 + 0.5) * 360.0 / 64.0))
            .sum::<f64>()
            / 64.0
    };
    assert!(
        zonal(0.0) > zonal(27.0),
        "equator {} vs subtropics {}",
        zonal(0.0),
        zonal(27.0)
    );
}

#[test]
fn continentality_ocean_adjacent_wetter() {
    // find, on the anchor's moisture grid latitude 40, the wettest and
    // driest cells and assert the wettest cell's 500km ring is more oceanic
    // than the driest's (structural link between continentality and M).
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();

    let lat = 40.0;
    let mut wettest = (f64::MIN, 0.0f64);
    let mut driest = (f64::MAX, 0.0f64);
    for i in 0..64 {
        let lon = -180.0 + (i as f64 + 0.5) * 360.0 / 64.0;
        let m = spec.moisture(lat, lon);
        if m > wettest.0 {
            wettest = (m, lon);
        }
        if m < driest.0 {
            driest = (m, lon);
        }
    }

    let wet_ocean_frac = gg_climate::__ring_ocean_frac(&spec, &terrain, lat, wettest.1);
    let dry_ocean_frac = gg_climate::__ring_ocean_frac(&spec, &terrain, lat, driest.1);
    assert!(
        wet_ocean_frac > dry_ocean_frac,
        "wettest lon {} (M={}) ring ocean_frac {} vs driest lon {} (M={}) ring ocean_frac {}",
        wettest.1,
        wettest.0,
        wet_ocean_frac,
        driest.1,
        driest.0,
        dry_ocean_frac
    );
}

#[test]
fn biome_grid_valid_and_anchor_spans_climates() {
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    let grid = spec.biome_grid(&terrain, 128, 64);
    assert!(grid.iter().all(|&b| b <= 12));
    let has = |v: u8| grid.contains(&v);
    assert!(has(0) || has(1), "some ocean");
    assert!(has(3), "polar/alpine ice");
    // a living HZ world should have SOME vegetation
    assert!((5..=9).any(has), "vegetative biome present");
}

#[test]
fn airless_moons_grow_nothing() {
    let (desc, _) = anchor(42);
    let stars = desc.stars.len();
    let first_moon = stars + desc.planets.len();
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, first_moon).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, first_moon, &terrain).unwrap();
    let grid = spec.biome_grid(&terrain, 64, 32);
    assert!(
        grid.iter().all(|&b| !(5..=9).contains(&b)),
        "vegetation on an airless moon"
    );
}

#[test]
fn doomed_bias_shifts_some_cells_arid() {
    // Walk the three golden seeds looking for a Doomed rocky planet.
    let mut found = None;
    for seed in [1u64, 42, 123_456_789] {
        let desc = generate(seed);
        let stars = desc.stars.len();
        if let Some(p) = desc.planets.iter().position(|p| {
            p.class == PlanetClass::Rocky && matches!(p.state, WorldState::Doomed { .. })
        }) {
            found = Some((seed, desc, stars + p));
            break;
        }
    }
    let (seed, desc, idx) = found.expect("expected a Doomed rocky planet among the golden seeds");

    let terrain = gg_terrain::TerrainSpec::for_body(seed, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    let doomed_grid = spec.biome_grid(&terrain, 64, 32);

    // Rebuild a Living-state twin cell-by-cell via the raw probe: same T/M/e
    // fields (a direct rocky planet always has atm_density 1.0), doomed=false.
    let (w, h) = (64usize, 32usize);
    let mut living_grid = Vec::with_capacity(w * h);
    for row in 0..h {
        let lat = 90.0 - (row as f64 + 0.5) * 180.0 / h as f64;
        for col in 0..w {
            let lon = -180.0 + (col as f64 + 0.5) * 360.0 / w as f64;
            let e = terrain.elevation_fine(lat, lon);
            let t = spec.temperature_k(lat, e);
            let m = spec.moisture(lat, lon);
            living_grid.push(gg_climate::__classify_raw(t, m, e, 1.0, false) as u8);
        }
    }

    let diff = doomed_grid
        .iter()
        .zip(&living_grid)
        .filter(|(a, b)| a != b)
        .count();
    assert!(diff > 0, "doomed grid never differs from its living twin");

    let is_veg = |b: &u8| (5..=9).contains(b);
    let doomed_veg = doomed_grid.iter().filter(|b| is_veg(b)).count();
    let living_veg = living_grid.iter().filter(|b| is_veg(b)).count();
    assert!(
        doomed_veg <= living_veg,
        "doomed grid has MORE vegetative cells ({doomed_veg}) than its living twin ({living_veg})"
    );
}

#[test]
fn classify_raw_pins_table_boundaries() {
    use gg_climate::__classify_raw;

    // Elevation thresholds dominate T/M (-400 / 0 / 15).
    assert_eq!(
        __classify_raw(280.0, 0.5, -400.1, 1.0, false),
        Biome::DeepOcean
    );
    assert_eq!(__classify_raw(280.0, 0.5, -400.0, 1.0, false), Biome::Shelf);
    assert_eq!(__classify_raw(280.0, 0.5, -0.1, 1.0, false), Biome::Shelf);
    assert_eq!(__classify_raw(280.0, 0.5, 0.0, 1.0, false), Biome::Shore);
    assert_eq!(__classify_raw(280.0, 0.5, 14.9, 1.0, false), Biome::Shore);
    assert_eq!(
        __classify_raw(280.0, 0.60, 15.0, 1.0, false),
        Biome::TemperateForest
    );

    // T = 250 boundary.
    assert_eq!(__classify_raw(249.9, 0.5, 100.0, 1.0, false), Biome::IceCap);
    assert_eq!(__classify_raw(250.0, 0.5, 100.0, 1.0, false), Biome::Tundra);

    // T = 265 boundary, plus the e = 2500 alpine threshold.
    assert_eq!(
        __classify_raw(264.9, 0.5, 2600.0, 1.0, false),
        Biome::AlpineRock
    );
    assert_eq!(
        __classify_raw(264.9, 0.5, 2500.0, 1.0, false),
        Biome::Tundra
    );
    assert_eq!(
        __classify_raw(265.0, 0.5, 2600.0, 1.0, false),
        Biome::BorealForest
    );

    // T = 280 boundary, moisture cutoffs 0.45 / 0.25.
    assert_eq!(
        __classify_raw(279.9, 0.45, 100.0, 1.0, false),
        Biome::BorealForest
    );
    assert_eq!(
        __classify_raw(279.9, 0.44, 100.0, 1.0, false),
        Biome::Grassland
    );
    assert_eq!(
        __classify_raw(279.9, 0.25, 100.0, 1.0, false),
        Biome::Grassland
    );
    assert_eq!(
        __classify_raw(279.9, 0.24, 100.0, 1.0, false),
        Biome::ColdDesert
    );

    // T = 293 boundary, moisture cutoffs 0.55 / 0.30, and the 286 sub-split.
    assert_eq!(
        __classify_raw(292.9, 0.55, 100.0, 1.0, false),
        Biome::TemperateForest
    );
    assert_eq!(
        __classify_raw(292.9, 0.54, 100.0, 1.0, false),
        Biome::Grassland
    );
    assert_eq!(
        __classify_raw(285.9, 0.29, 100.0, 1.0, false),
        Biome::ColdDesert
    );
    assert_eq!(
        __classify_raw(286.0, 0.29, 100.0, 1.0, false),
        Biome::HotDesert
    );

    // Tropical band (>= 293), moisture cutoffs 0.60 / 0.35.
    assert_eq!(
        __classify_raw(293.0, 0.60, 100.0, 1.0, false),
        Biome::TropicalRainforest
    );
    assert_eq!(
        __classify_raw(293.0, 0.35, 100.0, 1.0, false),
        Biome::Savanna
    );
    assert_eq!(
        __classify_raw(293.0, 0.34, 100.0, 1.0, false),
        Biome::HotDesert
    );
}

#[test]
fn classify_raw_airless_post_rule() {
    use gg_climate::__classify_raw;

    // Vegetative classes fold to Cold/HotDesert by the T < 286 split.
    assert_eq!(
        __classify_raw(292.9, 0.55, 100.0, 0.05, false),
        Biome::HotDesert
    );
    assert_eq!(
        __classify_raw(270.0, 0.55, 100.0, 0.05, false),
        Biome::ColdDesert
    );
    // Non-vegetative classes are untouched by the airless rule.
    assert_eq!(
        __classify_raw(240.0, 0.5, 100.0, 0.05, false),
        Biome::IceCap
    );
    assert_eq!(
        __classify_raw(280.0, 0.5, -400.1, 0.05, false),
        Biome::DeepOcean
    );
}

#[test]
fn classify_raw_doomed_post_rule() {
    use gg_climate::__classify_raw;

    assert_eq!(
        __classify_raw(293.0, 0.60, 100.0, 1.0, true),
        Biome::Savanna
    ); // TropicalRainforest -> Savanna
    assert_eq!(
        __classify_raw(293.0, 0.35, 100.0, 1.0, true),
        Biome::HotDesert
    ); // Savanna -> HotDesert
    assert_eq!(
        __classify_raw(292.9, 0.55, 100.0, 1.0, true),
        Biome::Grassland
    ); // TemperateForest -> Grassland
    assert_eq!(
        __classify_raw(279.9, 0.45, 100.0, 1.0, true),
        Biome::Grassland
    ); // BorealForest -> Grassland
    assert_eq!(
        __classify_raw(292.9, 0.40, 100.0, 1.0, true),
        Biome::ColdDesert
    ); // Grassland -> ColdDesert
       // Unaffected classes stay put.
    assert_eq!(__classify_raw(240.0, 0.5, 100.0, 1.0, true), Biome::IceCap);
    assert_eq!(
        __classify_raw(264.9, 0.5, 2600.0, 1.0, true),
        Biome::AlpineRock
    );
    assert_eq!(
        __classify_raw(286.0, 0.29, 100.0, 1.0, true),
        Biome::HotDesert
    );
}

#[test]
fn info_reports_mean_temp_and_ice_fraction() {
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    let info = spec.info();
    assert!(
        info.mean_temp_k > 150.0 && info.mean_temp_k < 400.0,
        "{}",
        info.mean_temp_k
    );
    assert!((0.0..=1.0).contains(&info.ice_fraction));
}

#[test]
fn biome_hash_is_deterministic_and_sensitive() {
    let (desc, idx) = anchor(42);
    let terrain = gg_terrain::TerrainSpec::for_body(42, &desc, idx).unwrap();
    let spec = gg_climate::ClimateSpec::for_body(&desc, idx, &terrain).unwrap();
    let grid = spec.biome_grid(&terrain, 128, 64);
    let h1 = gg_climate::biome_hash(&grid);
    let h2 = gg_climate::biome_hash(&grid);
    assert_eq!(h1, h2, "hash must be a pure function of the grid bytes");

    let mut mutated = grid.clone();
    mutated[0] = mutated[0].wrapping_add(1) % 13;
    if mutated[0] == grid[0] {
        mutated[0] = (mutated[0] + 1) % 13;
    }
    assert_ne!(
        gg_climate::biome_hash(&mutated),
        h1,
        "hash must be sensitive to content"
    );
}
