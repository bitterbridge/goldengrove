use gg_core::rng::RngStream;
use gg_terrain::plates::build_plates;
use gg_terrain::sphere::{cross, dot, geodesic, latlon_to_unit, norm, random_unit, sub};

#[test]
fn random_unit_is_unit_and_deterministic() {
    let mut a = RngStream::root(7).child("t");
    let mut b = RngStream::root(7).child("t");
    for _ in 0..50 {
        let u = random_unit(&mut a);
        let v = random_unit(&mut b);
        assert_eq!(u, v);
        assert!((norm(u) - 1.0).abs() < 1e-12);
    }
}

#[test]
fn geodesic_basics() {
    let x = latlon_to_unit(0.0, 0.0);
    let y = latlon_to_unit(0.0, 90.0);
    let np = latlon_to_unit(90.0, 0.0);
    assert!((geodesic(x, x)).abs() < 1e-7);
    assert!((geodesic(x, y) - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    assert!((geodesic(x, np) - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    // lat/lon convention: +lat is +z (pole), lon 90 is +y (ortho)
    assert!((np[2] - 1.0).abs() < 1e-12);
    assert!((y[1] - 1.0).abs() < 1e-12);
}

#[test]
fn plates_cover_realistic_counts_and_types() {
    for seed in 0..100u64 {
        let mut rng = RngStream::root(seed).child("plates-test");
        let p = build_plates(&mut rng, 6.371e6, 0.4);
        assert!((6..=16).contains(&p.plates.len()), "seed {seed}: {}", p.plates.len());
        assert!(p.plates.iter().any(|pl| pl.continental) || p.plates.len() < 8,
            "seed {seed}: no continents at land_bias 0.4 is possible but should be rare");
        for pl in &p.plates {
            assert!((norm(pl.seed_point) - 1.0).abs() < 1e-9);
            assert!((norm(pl.euler_pole) - 1.0).abs() < 1e-9);
            assert!(pl.rate > 0.0);
            if pl.continental { assert!(pl.base_elev > 0.0) } else { assert!(pl.base_elev < 0.0) }
        }
    }
}

#[test]
fn nearest_two_returns_distinct_ordered_plates() {
    let mut rng = RngStream::root(3).child("plates-test");
    let p = build_plates(&mut rng, 6.371e6, 0.4);
    let mut probe = RngStream::root(9).child("probe");
    for _ in 0..500 {
        let x = random_unit(&mut probe);
        let (a, b) = p.nearest_two(x);
        assert_ne!(a, b);
        assert!(geodesic(x, p.plates[a].seed_point) <= geodesic(x, p.plates[b].seed_point) + 1e-12);
    }
}

#[test]
fn velocity_is_tangent_and_scales_with_rate() {
    let mut rng = RngStream::root(4).child("plates-test");
    let p = build_plates(&mut rng, 6.371e6, 0.4);
    let mut probe = RngStream::root(10).child("probe");
    for _ in 0..100 {
        let x = random_unit(&mut probe);
        let v = p.velocity(0, x);
        assert!(dot(v, x).abs() < 1e-9, "velocity must be tangent to the sphere");
        let expected = gg_terrain::sphere::scale(cross(p.plates[0].euler_pole, x), p.plates[0].rate);
        assert!(norm(sub(v, expected)) < 1e-12);
        // relative-velocity antisymmetry (spec): dv(a,b) = -dv(b,a)
        let dv_ab = sub(p.velocity(0, x), p.velocity(1, x));
        let dv_ba = sub(p.velocity(1, x), p.velocity(0, x));
        assert!(norm(sub(dv_ab, gg_terrain::sphere::scale(dv_ba, -1.0))) < 1e-12);
    }
}
