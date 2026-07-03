import { describe, expect, it } from 'vitest';
import type { Calendar } from '../sim/types';
import { formatDate } from './hud';

const cal: Calendar = {
  solar_day_s: 86400,
  year_solar_days: 365.2422,
  leap: { base_days: 365, terms: [] },
  months: [],
};

describe('formatDate', () => {
  it('renders year, day, and time-of-day', () => {
    expect(formatDate({ year: 411, day_of_year: 13, day_fraction: 0.5 }, cal)).toBe('Y412 · Day 14 · 12:00');
  });
  it('pads minutes', () => {
    expect(formatDate({ year: 0, day_of_year: 0, day_fraction: 0.0625 }, cal)).toBe('Y1 · Day 1 · 01:30');
  });
});
