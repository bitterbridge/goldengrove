use gg_core::orbit::OrbitalElements;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// u64 <-> JSON string: JS Numbers lose precision above 2^53.
mod seed_string {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(v)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemDescriptor {
    pub schema_version: u32,
    #[serde(with = "seed_string")]
    pub seed: u64,
    pub age_s: f64,
    pub stars: Vec<Star>,
    pub planet_host: PlanetHost,
    pub planets: Vec<Planet>,
    pub anchor_planet: usize,
}

/// What planets orbit: the stellar barycenter (close binary/trinary) or the
/// primary star alone (single star, or wide companions).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanetHost {
    Barycenter,
    Primary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Star {
    pub mass_kg: f64,
    pub radius_m: f64,
    pub luminosity_w: f64,
    pub temperature_k: f64,
    pub main_sequence_lifetime_s: f64,
    /// None for the primary. Companions orbit the barycenter of all
    /// interior (earlier-listed) stars.
    pub orbit: Option<OrbitalElements>,
}

/// Linear secular drift rates applied to orbital elements: x(t) = x0 + rate·t.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct SecularRates {
    pub apsidal_rad_per_s: f64,
    pub nodal_rad_per_s: f64,
    pub migration_m_per_s: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlanetClass {
    Rocky,
    IceGiant,
    GasGiant,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum WorldState {
    Living,
    Dead,
    Doomed { doom_time_s: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Planet {
    pub class: PlanetClass,
    pub mass_kg: f64,
    pub radius_m: f64,
    pub orbit: OrbitalElements,
    pub secular: SecularRates,
    pub axial_tilt_rad: f64,
    /// Precession of the spin axis about the orbit normal, rad/s.
    pub axial_precession_rad_per_s: f64,
    pub rotation_period_s: f64, // sidereal
    /// Tidal spin-down: rotation period lengthens at this rate (s per s).
    pub spin_drift_s_per_s: f64,
    pub state: WorldState,
    pub moons: Vec<Moon>,
    /// Present on the anchor planet only (v1).
    pub calendar: Option<Calendar>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Moon {
    pub mass_kg: f64,
    pub radius_m: f64,
    pub orbit: OrbitalElements, // around its planet
    pub secular: SecularRates,
    pub tidally_locked: bool,
    pub rotation_period_s: f64,
    /// If migrating inward: time at which a(t) crosses the Roche limit.
    pub doom_time_s: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Calendar {
    pub solar_day_s: f64,
    /// Year length in solar days (fractional).
    pub year_solar_days: f64,
    pub leap: LeapRule,
    pub months: Vec<MonthCycle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeapRule {
    pub base_days: u32,
    pub terms: Vec<LeapTerm>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeapTerm {
    pub every_years: u32,
    pub add_days: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MonthCycle {
    pub moon_index: usize,
    pub synodic_days: f64,
}
