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
