import type { Calendar, LeapRule } from './types';

/** Mirrors gg-gen's days_before_year exactly (crates/gg-gen/src/calendar.rs). */
export function daysBeforeYear(rule: LeapRule, year: number): number {
  let d = rule.base_days * year;
  for (const t of rule.terms) d += t.add_days * Math.floor(year / t.every_years);
  return d;
}

/** Sim seconds at the start of (0-based) year/dayOfYear. Inverse of date_at
 * up to the intra-day fraction. */
export function timeAtDate(cal: Calendar, year: number, dayOfYear: number): number {
  return (daysBeforeYear(cal.leap, year) + dayOfYear) * cal.solar_day_s;
}
