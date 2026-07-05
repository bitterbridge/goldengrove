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
  const noop = { onPlayPause() {}, onSpeed(_: number) {}, onTrueScale() {}, onReroll() {}, onShare() {}, onDateJump(_: number, __: number) {}, onToggleView() {} };

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

  it('setMaxSpeed disables steps above the cap; null re-enables all', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const speedButtons = [...root.querySelectorAll('.hud-bottom button')].slice(1) as HTMLButtonElement[]; // drop play/pause

    hud.setMaxSpeed(3600);
    const expectedDisabled = SPEED_STEPS.filter((s) => s.mult > 3600).length;
    expect(speedButtons.filter((b) => b.disabled).length).toBe(expectedDisabled);
    SPEED_STEPS.forEach((s, i) => { expect(speedButtons[i]!.disabled).toBe(s.mult > 3600); });

    hud.setMaxSpeed(null);
    expect(speedButtons.every((b) => !b.disabled)).toBe(true);
  });

  it('setTrueScaleLabel relabels the true-scale button', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'true scale')!;
    hud.setTrueScaleLabel('⛰ ×3 relief');
    expect(btn.textContent).toBe('⛰ ×3 relief');
  });

  it('true-scale button click fires onTrueScale without flipping its own active class', () => {
    const root = document.createElement('div');
    let calls = 0;
    const hud = buildHud(root, '42', { ...noop, onTrueScale: () => { calls++; } });
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'true scale')!;
    btn.click();
    expect(calls).toBe(1);
    expect(btn.classList.contains('active')).toBe(false); // hud is stateless — the caller owns activeness
    btn.click();
    expect(calls).toBe(2);
    expect(btn.classList.contains('active')).toBe(false); // still not flipped after a second click
  });

  it('setTrueScaleActive sets and clears the active class independent of clicks', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'true scale')!;
    hud.setTrueScaleActive(true);
    expect(btn.classList.contains('active')).toBe(true);
    hud.setTrueScaleActive(false);
    expect(btn.classList.contains('active')).toBe(false);
    // clicking never toggles it on its own — only the explicit setter does
    btn.click();
    expect(btn.classList.contains('active')).toBe(false);
  });

  it('view-toggle button is controllable', () => {
    const root = document.createElement('div');
    let toggles = 0;
    const hud = buildHud(root, '42', { ...noop, onToggleView: () => { toggles++; } });
    const btn = root.querySelector('button[name="view-toggle"]') as HTMLButtonElement;
    expect(btn.style.display).toBe('none'); // hidden until controller decides
    hud.setViewButton('⏚ stand here', true);
    expect(btn.style.display).toBe('');
    expect(btn.textContent).toBe('⏚ stand here');
    btn.click();
    expect(toggles).toBe(1);
  });
});
