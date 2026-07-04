use crate::calendar::derive_calendar;
use crate::descriptor::{PlanetHost, SystemDescriptor, SCHEMA_VERSION};
use crate::moons::generate_moons;
use crate::planets::{generate_planets, StellarContext};
use crate::stars::generate_stars;
use gg_core::consts::{AU, G};
use gg_core::orbit::orbital_period_s;
use gg_core::rng::RngStream;

/// The one public entry point: seed in, world out. Deterministic forever.
pub fn generate(seed: u64) -> SystemDescriptor {
    let root = RngStream::root(seed);

    let mut star_rng = root.child("stars");
    let stars_out = generate_stars(&mut star_rng);

    let total_mass: f64 = stars_out.stars.iter().map(|s| s.mass_kg).sum();
    let total_lum: f64 = stars_out.stars.iter().map(|s| s.luminosity_w).sum();
    // Circumbinary inner stability limit: ~4x the binary separation.
    let min_a = match stars_out.planet_host {
        PlanetHost::Barycenter => {
            let sep = stars_out.stars[1]
                .orbit
                .expect("close binary must have companion orbit")
                .semi_major_axis_m;
            (4.0 * sep).max(0.06 * AU)
        }
        PlanetHost::Primary => 0.06 * AU,
    };
    let host_mass = match stars_out.planet_host {
        // Circumbinary planets orbit the close pair only (stars[0] + [1]);
        // generate_stars guarantees the close companion is always index 1
        // when the host is Barycenter. A wide tertiary contributes to
        // total_mass_kg (Hill radii) but not to the planets' host mass.
        PlanetHost::Barycenter => stars_out.stars[0].mass_kg + stars_out.stars[1].mass_kg,
        PlanetHost::Primary => stars_out.stars[0].mass_kg,
    };
    let ctx = StellarContext {
        host_mass_kg: host_mass,
        total_mass_kg: total_mass,
        total_luminosity_w: total_lum,
        min_planet_a_m: min_a,
        age_s: stars_out.age_s,
        primary_ms_lifetime_s: stars_out.stars[0].main_sequence_lifetime_s,
    };

    let mut planet_rng = root.child("planets");
    let (mut planets, anchor_index) = generate_planets(&mut planet_rng, &ctx);

    for (i, planet) in planets.iter_mut().enumerate() {
        // Per-planet child streams: adding planet features later never
        // reshuffles other planets' moons.
        let mut moon_rng = root.child(&format!("moons-{i}"));
        let period = orbital_period_s(planet.orbit.semi_major_axis_m, G * ctx.host_mass_kg);
        generate_moons(&mut moon_rng, planet, period, &ctx);
    }

    let anchor_year = orbital_period_s(
        planets[anchor_index].orbit.semi_major_axis_m,
        G * ctx.host_mass_kg,
    );
    let anchor_calendar = derive_calendar(&planets[anchor_index], anchor_year);
    planets[anchor_index].calendar = Some(anchor_calendar);

    SystemDescriptor {
        schema_version: SCHEMA_VERSION,
        seed,
        age_s: stars_out.age_s,
        stars: stars_out.stars,
        planet_host: stars_out.planet_host,
        planets,
        anchor_planet: anchor_index,
    }
}
