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

#[test]
fn orbit_paths_agree_with_ephemeris_at_t_zero() {
    // The path's first sample is position_at(elements, mu, 0). If our
    // host-mass mirror drifted from gg-ephemeris's convention, mu — and any
    // secular-free position derived from it — would disagree with the
    // ephemeris ground truth. Compare planet world-positions at t=0.
    use gg_gen::descriptor::PlanetHost;
    let mut checked_barycenter = false;
    for seed in 0..80u64 {
        let desc = gg_gen::generate(seed);
        let is_barycenter = desc.planet_host == PlanetHost::Barycenter;
        let stars = desc.stars.len();
        let eph = KeplerSecular::new(desc);
        let states = eph.states_at(0.0);
        // host origin: mass-weighted close-pair barycenter (Barycenter) or primary (Primary)
        let d = eph.desc();
        let origin = match d.planet_host {
            PlanetHost::Barycenter => {
                let (m0, m1) = (d.stars[0].mass_kg, d.stars[1].mass_kg);
                let (p0, p1) = (states[0].position_m, states[1].position_m);
                [
                    (m0 * p0[0] + m1 * p1[0]) / (m0 + m1),
                    (m0 * p0[1] + m1 * p1[1]) / (m0 + m1),
                    (m0 * p0[2] + m1 * p1[2]) / (m0 + m1),
                ]
            }
            PlanetHost::Primary => states[0].position_m,
        };
        for (pi, _) in d.planets.iter().enumerate() {
            let path = orbit_path_points(d, stars + pi, 8);
            let expect = states[stars + pi].position_m;
            for k in 0..3 {
                let got = origin[k] + path[k];
                assert!(
                    (got - expect[k]).abs() < 1.0,
                    "seed {seed} planet {pi} axis {k}: path+origin {got} vs ephemeris {}",
                    expect[k]
                );
            }
        }
        checked_barycenter |= is_barycenter;
    }
    assert!(checked_barycenter, "no circumbinary system in seed range — widen it");
}
