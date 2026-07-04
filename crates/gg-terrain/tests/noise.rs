use gg_terrain::noise::{fbm, warped_fbm};
use gg_terrain::sphere::random_unit;
use gg_core::rng::RngStream;

#[test]
fn fbm_is_deterministic_bounded_and_seed_sensitive() {
    let mut probe = RngStream::root(1).child("noise-probe");
    let mut max_abs: f64 = 0.0;
    for _ in 0..2000 {
        let p = random_unit(&mut probe);
        let q = [p[0] * 2.3, p[1] * 2.3, p[2] * 2.3];
        let a = fbm(42, q, 6);
        assert_eq!(a, fbm(42, q, 6), "same input, same output");
        assert_ne!(a, fbm(43, q, 6), "different seed, different field");
        max_abs = max_abs.max(a.abs());
        assert!(a.abs() <= 2.0, "fbm wildly out of range: {a}");
    }
    assert!(max_abs > 0.15, "fbm suspiciously flat: max {max_abs}");
}

#[test]
fn fbm_is_continuous() {
    // tiny input steps produce tiny output steps (no cell-edge pops)
    let p = [0.37, -0.81, 0.45];
    let e = 1e-5;
    let base = fbm(7, p, 6);
    for d in 0..3 {
        let mut q = p;
        q[d] += e;
        assert!((fbm(7, q, 6) - base).abs() < 1e-2, "discontinuity along axis {d}");
    }
}

#[test]
fn warp_changes_the_field_but_stays_bounded() {
    let mut probe = RngStream::root(2).child("noise-probe");
    let mut diff = 0.0;
    for _ in 0..500 {
        let p = random_unit(&mut probe);
        let q = [p[0] * 2.0, p[1] * 2.0, p[2] * 2.0];
        let plain = fbm(5, q, 5);
        let warped = warped_fbm(5, q, 5);
        assert!(warped.abs() <= 2.0);
        diff += (plain - warped).abs();
    }
    assert!(diff / 500.0 > 0.05, "warp did nothing");
}
