use gg_core::consts::G;
use gg_core::orbit::{position_at, OrbitalElements};
use gg_gen::descriptor::{PlanetHost, SystemDescriptor};
use std::f64::consts::TAU;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BodyState {
    pub position_m: [f64; 3],
    pub spin_axis: [f64; 3],
    pub rotation_rad: f64,
}

/// Body order contract: stars, then planets, then moons grouped by planet.
pub trait Ephemeris {
    fn body_count(&self) -> usize;
    fn states_at(&self, t_s: f64) -> Vec<BodyState>;
}

pub fn star_index(i: usize) -> usize {
    i
}
pub fn planet_index(desc: &SystemDescriptor, i: usize) -> usize {
    desc.stars.len() + i
}
pub fn moon_index(desc: &SystemDescriptor, planet: usize, moon: usize) -> usize {
    desc.stars.len()
        + desc.planets.len()
        + desc.planets[..planet].iter().map(|p| p.moons.len()).sum::<usize>()
        + moon
}

pub struct KeplerSecular {
    desc: SystemDescriptor,
}

/// Apply secular drift to elements: ω, Ω, and a move linearly with t.
fn elements_at(el: &OrbitalElements, sec: &gg_gen::descriptor::SecularRates, t_s: f64) -> OrbitalElements {
    let mut e = *el;
    e.arg_periapsis_rad += sec.apsidal_rad_per_s * t_s;
    e.raan_rad += sec.nodal_rad_per_s * t_s;
    // Linear drift is only meaningful for modest fractional change; freeze at
    // +/-50% of the epoch value so deep-time extrapolation can't produce
    // absurd orbits (e.g. a moon 1 m from its planet's center).
    let da = sec.migration_m_per_s * t_s;
    let max_da = 0.5 * el.semi_major_axis_m;
    e.semi_major_axis_m = el.semi_major_axis_m + da.clamp(-max_da, max_da);
    e
}

fn default_axis() -> [f64; 3] {
    [0.0, 0.0, 1.0]
}

/// Spin axis: tilted from +Z, precessing about +Z at the planet's rate.
/// (v1 approximation: orbit normal ≈ +Z; planet inclinations are < 3°.)
fn spin_axis(tilt_rad: f64, precession_rad_per_s: f64, t_s: f64) -> [f64; 3] {
    let phi = -precession_rad_per_s * t_s;
    let (st, ct) = tilt_rad.sin_cos();
    [st * phi.cos(), st * phi.sin(), ct]
}

/// Rotation angle with linear spin-drift (day slowly lengthens):
/// θ(t) = 2π (t/p0 − drift·t²/(2·p0²)).
fn rotation_rad(period_s: f64, drift_s_per_s: f64, t_s: f64) -> f64 {
    // The quadratic term is a linearization; cap its time argument at
    // 0.5*p0/drift so d(theta)/dt stays positive (rotation never reverses).
    let t_drift = if drift_s_per_s > 0.0 {
        t_s.min(0.5 * period_s / drift_s_per_s)
    } else {
        t_s
    };
    (TAU * (t_s / period_s - drift_s_per_s * t_drift * t_drift / (2.0 * period_s * period_s)))
        .rem_euclid(TAU)
}

impl KeplerSecular {
    pub fn new(desc: SystemDescriptor) -> Self {
        Self { desc }
    }

    pub fn desc(&self) -> &SystemDescriptor {
        &self.desc
    }

    /// Star positions with hierarchical barycentric recoil: each companion
    /// orbits the barycenter of all interior stars; interior stars recoil
    /// so the total barycenter stays at the origin.
    fn star_positions(&self, t_s: f64) -> Vec<[f64; 3]> {
        let stars = &self.desc.stars;
        let mut pos: Vec<[f64; 3]> = vec![[0.0; 3]; stars.len()];
        let mut interior_mass = stars[0].mass_kg;
        for k in 1..stars.len() {
            let comp = &stars[k];
            let orbit = comp.orbit.expect("companion star missing orbit");
            let mu = G * (interior_mass + comp.mass_kg);
            let rel = position_at(&orbit, mu, t_s);
            let f_comp = interior_mass / (interior_mass + comp.mass_kg);
            let f_int = comp.mass_kg / (interior_mass + comp.mass_kg);
            for p in pos.iter_mut().take(k) {
                for x in 0..3 {
                    p[x] -= rel[x] * f_int;
                }
            }
            pos[k] = [rel[0] * f_comp, rel[1] * f_comp, rel[2] * f_comp];
            interior_mass += comp.mass_kg;
        }
        pos
    }

    fn host_mass(&self) -> f64 {
        match self.desc.planet_host {
            // Circumbinary planets orbit the close pair only (stars[0] and
            // [1]); generate_stars guarantees the close companion is always
            // index 1 when the host is Barycenter. A wide tertiary's mass
            // must not inflate the host mass planets actually orbit.
            PlanetHost::Barycenter => self.desc.stars[0].mass_kg + self.desc.stars[1].mass_kg,
            PlanetHost::Primary => self.desc.stars[0].mass_kg,
        }
    }
}

impl Ephemeris for KeplerSecular {
    fn body_count(&self) -> usize {
        self.desc.stars.len()
            + self.desc.planets.len()
            + self.desc.planets.iter().map(|p| p.moons.len()).sum::<usize>()
    }

    fn states_at(&self, t_s: f64) -> Vec<BodyState> {
        let mut out = Vec::with_capacity(self.body_count());

        let star_pos = self.star_positions(t_s);
        for pos in &star_pos {
            out.push(BodyState {
                position_m: *pos,
                spin_axis: default_axis(),
                // solar-like spin period; star rotation is cosmetic in v1
                rotation_rad: rotation_rad(25.0 * 86_400.0, 0.0, t_s),
            });
        }

        let host_origin = match self.desc.planet_host {
            // A wide tertiary companion's recoil displaces the close pair
            // far from the system origin (total-mass barycenter). Planets
            // ride the pair, not the origin, so their host is the close
            // pair's own mass-weighted barycenter at time t — not [0,0,0].
            PlanetHost::Barycenter => {
                let m0 = self.desc.stars[0].mass_kg;
                let m1 = self.desc.stars[1].mass_kg;
                let p0 = star_pos[0];
                let p1 = star_pos[1];
                [
                    (m0 * p0[0] + m1 * p1[0]) / (m0 + m1),
                    (m0 * p0[1] + m1 * p1[1]) / (m0 + m1),
                    (m0 * p0[2] + m1 * p1[2]) / (m0 + m1),
                ]
            }
            PlanetHost::Primary => star_pos[0],
        };
        let mu_host = G * self.host_mass();

        let mut planet_positions = Vec::with_capacity(self.desc.planets.len());
        for p in &self.desc.planets {
            let el = elements_at(&p.orbit, &p.secular, t_s);
            let rel = position_at(&el, mu_host, t_s);
            let pos = [
                host_origin[0] + rel[0],
                host_origin[1] + rel[1],
                host_origin[2] + rel[2],
            ];
            planet_positions.push(pos);
            out.push(BodyState {
                position_m: pos,
                spin_axis: spin_axis(p.axial_tilt_rad, p.axial_precession_rad_per_s, t_s),
                rotation_rad: rotation_rad(p.rotation_period_s, p.spin_drift_s_per_s, t_s),
            });
        }

        for (pi, p) in self.desc.planets.iter().enumerate() {
            let mu_p = G * p.mass_kg;
            for m in &p.moons {
                let el = elements_at(&m.orbit, &m.secular, t_s);
                let rel = position_at(&el, mu_p, t_s);
                let base = planet_positions[pi];
                out.push(BodyState {
                    position_m: [base[0] + rel[0], base[1] + rel[1], base[2] + rel[2]],
                    spin_axis: default_axis(),
                    rotation_rad: rotation_rad(m.rotation_period_s, 0.0, t_s),
                });
            }
        }
        out
    }
}
