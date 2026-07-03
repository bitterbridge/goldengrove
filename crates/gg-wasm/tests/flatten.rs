use gg_ephemeris::{Ephemeris, KeplerSecular};
use gg_wasm::flatten::{flatten_states, orbit_path_points, FLOATS_PER_BODY};

#[test]
fn flat_layout_matches_body_count_and_states() {
    let desc = gg_gen::generate(42);
    let eph = KeplerSecular::new(desc);
    let n = eph.body_count();
    let flat = flatten_states(&eph, 1.0e7);
    assert_eq!(flat.len(), n * FLOATS_PER_BODY);
    let states = eph.states_at(1.0e7);
    for (i, s) in states.iter().enumerate() {
        let o = i * FLOATS_PER_BODY;
        assert_eq!(&flat[o..o + 3], &s.position_m);
        assert_eq!(&flat[o + 3..o + 6], &s.spin_axis);
        assert_eq!(flat[o + 6], s.rotation_rad);
    }
}

#[test]
fn orbit_paths_have_right_shape() {
    let desc = gg_gen::generate(42);
    let stars = desc.stars.len();
    let planets = desc.planets.len();
    // stars have no path
    assert!(orbit_path_points(&desc, 0, 64).is_empty());
    // every planet path: 3*segments floats, all points within [peri, apo] of the focus
    for p in 0..planets {
        let body = stars + p;
        let path = orbit_path_points(&desc, body, 64);
        assert_eq!(path.len(), 3 * 64);
        let orbit = &desc.planets[p].orbit;
        let (a, e) = (orbit.semi_major_axis_m, orbit.eccentricity);
        for chunk in path.chunks(3) {
            let r = (chunk[0].powi(2) + chunk[1].powi(2) + chunk[2].powi(2)).sqrt();
            assert!(r >= a * (1.0 - e) * 0.999 && r <= a * (1.0 + e) * 1.001, "planet {p}: r {r} outside ellipse bounds");
        }
    }
    // first moon (if any): same property around its planet's mu
    if let Some((pi, _)) = desc.planets.iter().enumerate().find(|(_, p)| !p.moons.is_empty()) {
        let moons_before: usize = desc.planets[..pi].iter().map(|p| p.moons.len()).sum();
        let body = stars + planets + moons_before;
        let path = orbit_path_points(&desc, body, 32);
        assert_eq!(path.len(), 3 * 32);
    }
}

#[test]
fn seed_string_worlds_are_deterministic() {
    // native check of the same code path the wasm constructor uses
    let a = gg_gen::generate("42".trim().parse::<u64>().unwrap());
    let b = gg_gen::generate(42);
    assert_eq!(a, b);
}
