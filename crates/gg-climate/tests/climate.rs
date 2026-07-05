use gg_climate::{climate_facts, temperature_k};
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
