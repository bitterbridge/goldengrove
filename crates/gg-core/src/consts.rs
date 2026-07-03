//! Physical constants, SI units.

pub const G: f64 = 6.674_30e-11; // m^3 kg^-1 s^-2
pub const C_LIGHT: f64 = 2.997_924_58e8; // m/s
pub const M_SUN: f64 = 1.988_92e30; // kg
pub const R_SUN: f64 = 6.957e8; // m
pub const L_SUN: f64 = 3.828e26; // W
pub const T_SUN: f64 = 5772.0; // K
pub const AU: f64 = 1.495_978_707e11; // m
pub const M_EARTH: f64 = 5.9722e24; // kg
pub const R_EARTH: f64 = 6.371e6; // m
pub const DAY: f64 = 86_400.0; // s
pub const YEAR: f64 = 3.155_815e7; // s (sidereal year)
/// Round-number year (s) for astrophysical scalings (lifetimes, ages, doom
/// clocks). Deliberately distinct from YEAR (sidereal); do not swap them.
pub const YEAR_APPROX: f64 = 3.156e7;
