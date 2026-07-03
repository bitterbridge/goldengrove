use gg_core::consts::*;
use gg_core::orbit::{orbital_period_s, OrbitalElements};
use gg_gen::calendar::*;
use gg_gen::descriptor::*;

#[test]
fn earth_solar_day_from_sidereal() {
    let d = solar_day_s(86_164.0905, YEAR);
    assert!((d - 86_400.0).abs() < 5.0, "solar day {d}");
}

#[test]
fn earth_leap_rule_is_the_classic() {
    let rule = leap_rule(365.2422);
    assert_eq!(rule.base_days, 365);
    assert_eq!(rule.terms[0], LeapTerm { every_years: 4, add_days: 1 });
    assert_eq!(rule.terms[1], LeapTerm { every_years: 128, add_days: -1 });
}

#[test]
fn leap_rule_stays_aligned_over_ten_thousand_years() {
    for &year_days in &[365.2422, 388.71, 401.203, 500.5, 209.917] {
        let rule = leap_rule(year_days);
        let calendar_days = days_before_year(&rule, 10_000) as f64;
        let true_days = year_days * 10_000.0;
        assert!(
            (calendar_days - true_days).abs() < 20.0,
            "year_days {year_days}: drift {}",
            calendar_days - true_days
        );
    }
}

#[test]
fn date_at_is_consistent_and_monotonic() {
    let cal = Calendar {
        solar_day_s: 86_400.0,
        year_solar_days: 365.2422,
        leap: leap_rule(365.2422),
        months: vec![],
    };
    let d0 = date_at(&cal, 0.0);
    assert_eq!((d0.year, d0.day_of_year), (0, 0));
    // one (non-leap) year later
    let d1 = date_at(&cal, 365.0 * 86_400.0);
    assert_eq!(d1.year, 1);
    // ~1000 years in, verify roundtrip: start-of-year day count matches rule
    let y1000_start_days = days_before_year(&cal.leap, 1000) as f64;
    let d = date_at(&cal, y1000_start_days * 86_400.0 + 3600.0);
    assert_eq!(d.year, 1000);
    assert_eq!(d.day_of_year, 0);
}

#[test]
fn lunar_synodic_month_is_29_and_a_half_days() {
    let moon = Moon {
        mass_kg: 7.342e22,
        radius_m: 1.737e6,
        orbit: OrbitalElements {
            semi_major_axis_m: 3.844e8,
            eccentricity: 0.0549,
            inclination_rad: 0.09,
            raan_rad: 0.0,
            arg_periapsis_rad: 0.0,
            mean_anomaly_epoch_rad: 0.0,
        },
        secular: SecularRates::default(),
        tidally_locked: true,
        rotation_period_s: 2.36e6,
        doom_time_s: None,
    };
    let planet = Planet {
        class: PlanetClass::Rocky,
        mass_kg: M_EARTH,
        radius_m: R_EARTH,
        orbit: OrbitalElements {
            semi_major_axis_m: AU,
            eccentricity: 0.017,
            inclination_rad: 0.0,
            raan_rad: 0.0,
            arg_periapsis_rad: 0.0,
            mean_anomaly_epoch_rad: 0.0,
        },
        secular: SecularRates::default(),
        axial_tilt_rad: 0.41,
        axial_precession_rad_per_s: 0.0,
        rotation_period_s: 86_164.0905,
        spin_drift_s_per_s: 0.0,
        state: WorldState::Living,
        moons: vec![moon],
        calendar: None,
    };
    let year_s = orbital_period_s(AU, G * M_SUN);
    let cal = derive_calendar(&planet, year_s);
    assert_eq!(cal.months.len(), 1);
    let synodic = cal.months[0].synodic_days;
    assert!((29.0..30.1).contains(&synodic), "synodic {synodic}");
    assert!((365.0..365.5).contains(&cal.year_solar_days));
}
