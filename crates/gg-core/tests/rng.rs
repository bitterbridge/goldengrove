use gg_core::rng::RngStream;

#[test]
fn same_seed_same_sequence() {
    let mut a = RngStream::root(42);
    let mut b = RngStream::root(42);
    for _ in 0..100 {
        assert_eq!(a.uniform(0.0, 1.0), b.uniform(0.0, 1.0));
    }
}

#[test]
fn different_labels_differ() {
    let root = RngStream::root(42);
    let mut a = root.child("stars");
    let mut b = root.child("planets");
    assert_ne!(a.uniform(0.0, 1.0), b.uniform(0.0, 1.0));
}

#[test]
fn child_independent_of_parent_draw_count() {
    // The determinism contract: deriving a child stream must not depend on
    // how many draws the parent has made.
    let mut root1 = RngStream::root(7);
    let root2 = RngStream::root(7);
    let _ = root1.uniform(0.0, 1.0);
    let _ = root1.uniform(0.0, 1.0);
    let mut c1 = root1.child("moons");
    let mut c2 = root2.child("moons");
    assert_eq!(c1.uniform(0.0, 1.0), c2.uniform(0.0, 1.0));
}

#[test]
fn ranges_respected() {
    let mut r = RngStream::root(1);
    for _ in 0..1000 {
        let u = r.uniform(2.0, 3.0);
        assert!((2.0..3.0).contains(&u));
        let l = r.log_uniform(1.0, 100.0);
        assert!((1.0..=100.0).contains(&l));
        let p = r.power_law(1.8, 0.35, 1.6);
        assert!((0.35..=1.6).contains(&p));
        let n = r.pick_count(2, 6);
        assert!((2..=6).contains(&n));
    }
}

#[test]
fn power_law_favors_small_values() {
    let mut r = RngStream::root(9);
    let below = (0..10_000)
        .filter(|_| r.power_law(1.8, 0.1, 10.0) < 1.0)
        .count();
    assert!(below > 6_000, "power law should concentrate mass at small x, got {below}");
}
