import { describe, expect, it } from 'vitest';
import type { Calendar } from './types';
import { daysBeforeYear, timeAtDate } from './calendar';

const earth: Calendar = {
  solar_day_s: 86400,
  year_solar_days: 365.2422,
  leap: { base_days: 365, terms: [{ every_years: 4, add_days: 1 }, { every_years: 128, add_days: -1 }] },
  months: [],
};

describe('daysBeforeYear', () => {
  it('reproduces the Gregorian-style rule (mirrors Rust days_before_year)', () => {
    expect(daysBeforeYear(earth.leap, 0)).toBe(0);
    expect(daysBeforeYear(earth.leap, 1)).toBe(365);
    expect(daysBeforeYear(earth.leap, 4)).toBe(1461); // year 3's leap day is before year 4
    expect(daysBeforeYear(earth.leap, 10000)).toBe(3652422);
  });
});

describe('timeAtDate', () => {
  it('converts a date to sim seconds', () => {
    expect(timeAtDate(earth, 0, 0)).toBe(0);
    expect(timeAtDate(earth, 1, 0)).toBe(365 * 86400);
    expect(timeAtDate(earth, 1, 13)).toBe((365 + 13) * 86400);
  });
});
