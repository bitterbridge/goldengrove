import { describe, expect, it } from 'vitest';
import type { Calendar } from '../sim/types';
import { buildHud, formatDate, SPEED_STEPS } from './hud';

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

describe('buildHud interactions', () => {
  const noop = { onPlayPause() {}, onSpeed(_: number) {}, onTrueScale(_: boolean) {}, onReroll() {}, onShare() {}, onDateJump(_: number, __: number) {} };

  it('share button fires onShare and flashes', () => {
    const root = document.createElement('div');
    let shared = 0;
    const hud = buildHud(root, '42', { ...noop, onShare: () => { shared++; } });
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'share')!;
    btn.click();
    expect(shared).toBe(1);
    hud.flashShared();
    expect(btn.textContent).toBe('copied ✓');
  });

  it('date-jump submits 0-based year and day', () => {
    const root = document.createElement('div');
    let got: [number, number] | null = null;
    buildHud(root, '42', { ...noop, onDateJump: (y, d) => { got = [y, d]; } });
    (root.querySelector('input[name="jump-year"]') as HTMLInputElement).value = '412';
    (root.querySelector('input[name="jump-day"]') as HTMLInputElement).value = '14';
    (root.querySelector('button[name="jump-go"]') as HTMLButtonElement).click();
    expect(got).toEqual([411, 13]); // UI is 1-based, engine is 0-based
  });

  it('setActiveSpeed highlights the matching step', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    hud.setActiveSpeed(86400);
    const active = [...root.querySelectorAll('.hud-bottom button.active')];
    expect(active.length).toBe(1);
    expect(active[0]!.textContent).toBe(SPEED_STEPS.find((s) => s.mult === 86400)!.label);
  });
});
