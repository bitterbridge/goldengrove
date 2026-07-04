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
    assert!(orbit_path_points(&desc, 0, 64, 0.0).is_empty());
    // every planet path: 3*segments floats, all points within [peri, apo] of the focus
    for p in 0..planets {
        let body = stars + p;
        let path = orbit_path_points(&desc, body, 64, 0.0);
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
        let path = orbit_path_points(&desc, body, 32, 0.0);
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
fn host_mass_mirror_matches_ephemeris_exactly() {
    use gg_gen::descriptor::PlanetHost;
    let mut saw_barycenter = false;
    let mut saw_primary = false;
    for seed in 0..200u64 {
        let desc = gg_gen::generate(seed);
        match desc.planet_host {
            PlanetHost::Barycenter => saw_barycenter = true,
            PlanetHost::Primary => saw_primary = true,
        }
        let mirror = gg_wasm::flatten::planet_host_mass(&desc);
        let eph = KeplerSecular::new(desc);
        assert_eq!(mirror, eph.host_mass(), "seed {seed}: host-mass conventions diverged");
    }
    assert!(saw_barycenter && saw_primary, "seed range must cover both host variants");
}

#[test]
fn orbit_path_origins_and_indexing_agree_with_ephemeris_at_epoch() {
    // At t=0 positions are mu-independent; this pins the host-ORIGIN aggregation (pair barycenter vs primary) and body indexing, not the host mass — see host_mass_mirror_matches_ephemeris_exactly for that.
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
            let path = orbit_path_points(d, stars + pi, 8, 0.0);
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

#[test]
fn host_origin_matches_ephemeris_convention() {
    use gg_gen::descriptor::PlanetHost;
    let mut saw_barycenter = false;
    for seed in 0..120u64 {
        let desc = gg_gen::generate(seed);
        let host = desc.planet_host;
        let eph = KeplerSecular::new(desc);
        for &t in &[0.0, 1.0e7, 3.0e9] {
            let origin = gg_wasm::flatten::host_origin_at(&eph, t);
            let states = eph.states_at(t);
            let d = eph.desc();
            let expected = match host {
                PlanetHost::Primary => states[0].position_m,
                PlanetHost::Barycenter => {
                    let (m0, m1) = (d.stars[0].mass_kg, d.stars[1].mass_kg);
                    let (p0, p1) = (states[0].position_m, states[1].position_m);
                    let w = m0 + m1;
                    [
                        (m0 * p0[0] + m1 * p1[0]) / w,
                        (m0 * p0[1] + m1 * p1[1]) / w,
                        (m0 * p0[2] + m1 * p1[2]) / w,
                    ]
                }
            };
            assert_eq!(origin, expected, "seed {seed} t {t}");
        }
        if host == PlanetHost::Barycenter {
            saw_barycenter = true;
        }
    }
    assert!(saw_barycenter);
}

#[test]
fn orbit_paths_follow_secular_drift() {
    // A planet with a large apsidal rate: the path sampled at a later t must
    // rotate its periapsis accordingly (epoch-frozen paths were the old bug).
    let mut desc = gg_gen::generate(42);
    desc.planets[0].orbit.eccentricity = 0.4;
    desc.planets[0].secular.apsidal_rad_per_s = 1.0e-9;
    let stars = desc.stars.len();
    let p0 = orbit_path_points(&desc, stars, 64, 0.0);
    let big_t = 1.0e9; // periapsis advanced by 1 radian
    let p1 = orbit_path_points(&desc, stars, 64, big_t);
    // same shape (same point count), rotated: first sample differs by ~a*e-scale distance
    assert_eq!(p0.len(), p1.len());
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    let a = desc.planets[0].orbit.semi_major_axis_m;
    assert!(
        (dx * dx + dy * dy).sqrt() > 0.05 * a,
        "path did not move under 1 rad of apsidal drift"
    );
}

#[test]
fn wasm_heightmaps_match_gg_terrain_directly() {
    let desc = gg_gen::generate(42);
    let anchor_body = desc.stars.len() + desc.anchor_planet;
    let direct = gg_terrain::TerrainSpec::for_body(42, &desc, anchor_body)
        .unwrap()
        .heightmap(64, 32);
    let world_map = gg_wasm::terrain_heightmap_native(&desc, 42, anchor_body, 64, 32);
    assert_eq!(direct, world_map, "boundary must not transform terrain data");
    assert!(gg_wasm::terrain_heightmap_native(&desc, 42, 0, 64, 32).is_empty(), "stars empty");
}
