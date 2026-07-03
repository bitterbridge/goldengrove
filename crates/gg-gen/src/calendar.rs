use crate::descriptor::{Calendar, LeapRule, LeapTerm, MonthCycle, Planet};
use gg_core::consts::G;
use gg_core::orbit::orbital_period_s;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DateTime {
    pub year: u64,
    pub day_of_year: u32,
    pub day_fraction: f64,
}

/// Solar day from sidereal day and year (prograde rotation):
/// 1/solar = 1/sidereal - 1/year.
pub fn solar_day_s(sidereal_day_s: f64, year_s: f64) -> f64 {
    sidereal_day_s / (1.0 - sidereal_day_s / year_s)
}

/// Derive a leap rule from the fractional year via signed greedy
/// continued-fraction convergents (up to 3 correction terms).
/// Corrections stop once residual drift is below 1e-4 days/year (under one day per 10,000 years — calendar-invisible).
/// 365.2422 → base 365, +1 every 4 years, -1 every 128 years.
pub fn leap_rule(year_solar_days: f64) -> LeapRule {
    let base_days = year_solar_days.floor() as u32;
    let mut r = year_solar_days.fract();
    let mut terms = Vec::new();
    for _ in 0..3 {
        if r.abs() < 1e-4 {
            break;
        }
        let every_years = (1.0 / r.abs()).round().max(1.0) as u32;
        let add_days = if r > 0.0 { 1 } else { -1 };
        terms.push(LeapTerm { every_years, add_days });
        r -= f64::from(add_days) / f64::from(every_years);
    }
    LeapRule { base_days, terms }
}

/// Total calendar days in years [0, year).
pub fn days_before_year(rule: &LeapRule, year: u64) -> i64 {
    let mut d = i64::from(rule.base_days) * year as i64;
    for t in &rule.terms {
        d += i64::from(t.add_days) * (year / u64::from(t.every_years)) as i64;
    }
    d
}

/// Calendar date at simulation time t (t_s >= 0; the epoch is year 0, day 0).
pub fn date_at(cal: &Calendar, t_s: f64) -> DateTime {
    let total_days = (t_s / cal.solar_day_s).max(0.0);
    let mut year = (total_days / cal.year_solar_days).floor() as u64;
    // The rule-based year boundaries wobble around the mean; walk locally.
    loop {
        let start = days_before_year(&cal.leap, year) as f64;
        if total_days < start {
            year -= 1;
            continue;
        }
        let next = days_before_year(&cal.leap, year + 1) as f64;
        if total_days >= next {
            year += 1;
            continue;
        }
        let into = total_days - start;
        return DateTime {
            year,
            day_of_year: into.floor() as u32,
            day_fraction: into.fract(),
        };
    }
}

/// Derive the anchor planet's calendar from its rotation, year, and moons.
pub fn derive_calendar(planet: &Planet, year_s: f64) -> Calendar {
    let solar_day = solar_day_s(planet.rotation_period_s, year_s);
    let year_solar_days = year_s / solar_day;
    let months = planet
        .moons
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let t_moon = orbital_period_s(m.orbit.semi_major_axis_m, G * planet.mass_kg);
            // Synodic period as seen from the planet: 1/syn = 1/T_moon - 1/T_year.
            let synodic_s = 1.0 / (1.0 / t_moon - 1.0 / year_s);
            MonthCycle { moon_index: i, synodic_days: synodic_s / solar_day }
        })
        .collect();
    Calendar {
        solar_day_s: solar_day,
        year_solar_days,
        leap: leap_rule(year_solar_days),
        months,
    }
}
