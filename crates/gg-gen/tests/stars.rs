use gg_core::consts::*;
use gg_core::rng::RngStream;
use gg_gen::descriptor::PlanetHost;
use gg_gen::stars::*;

#[test]
fn sunlike_relations_match_the_sun() {
    let l = luminosity_w(M_SUN);
    assert!((l / L_SUN - 1.0).abs() < 0.05, "L(M_sun) = {l}");
    let r = radius_m(M_SUN);
    assert!((r / R_SUN - 1.0).abs() < 0.05);
    let t = temperature_k(l, r);
    assert!((t / T_SUN - 1.0).abs() < 0.05);
    let life = ms_lifetime_s(M_SUN);
    assert!((life / (10e9 * 3.156e7) - 1.0).abs() < 0.1, "sun lifetime {life}");
}

#[test]
fn luminosity_increases_with_mass() {
    assert!(luminosity_w(1.4 * M_SUN) > luminosity_w(1.0 * M_SUN));
    assert!(luminosity_w(1.0 * M_SUN) > luminosity_w(0.5 * M_SUN));
}

#[test]
fn population_properties_hold_over_many_seeds() {
    let mut singles = 0;
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("stars");
        let out = generate_stars(&mut rng);
        let n = out.stars.len();
        assert!((1..=3).contains(&n), "seed {seed}: {n} stars");
        if n == 1 {
            singles += 1;
            assert_eq!(out.planet_host, PlanetHost::Primary);
        }
        let primary = &out.stars[0];
        assert!(primary.orbit.is_none());
        assert!(primary.mass_kg >= 0.35 * M_SUN && primary.mass_kg <= 1.6 * M_SUN);
        assert!(out.age_s > 0.0 && out.age_s < primary.main_sequence_lifetime_s);
        for c in &out.stars[1..] {
            let orbit = c.orbit.expect("companions must have orbits");
            assert!(c.mass_kg < primary.mass_kg);
            let a = orbit.semi_major_axis_m;
            // close pair or wide companion, never in the planet-forming middle
            assert!(a <= 0.25 * AU || a >= 50.0 * AU, "seed {seed}: companion at {} AU", a / AU);
        }
    }
    // ~55% singles; loose bounds so the test isn't seed-brittle
    assert!((150..=400).contains(&singles), "singles = {singles}");
}

#[test]
fn close_binary_means_circumbinary_planets() {
    for seed in 0..500u64 {
        let mut rng = RngStream::root(seed).child("stars");
        let out = generate_stars(&mut rng);
        let has_close_pair = out.stars.get(1).map_or(false, |c| {
            c.orbit.unwrap().semi_major_axis_m < 1.0 * AU
        });
        if has_close_pair {
            assert_eq!(out.planet_host, PlanetHost::Barycenter, "seed {seed}");
        }
    }
}
