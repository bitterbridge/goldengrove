import { describe, expect, it } from 'vitest';
import { buildCompass } from './compass';

describe('compass', () => {
  it('reads cardinal headings and pitch', () => {
    const root = document.createElement('div');
    const c = buildCompass(root);
    c.setHeading(0, 0.2094);
    expect(root.querySelector('.compass-readout')!.textContent).toBe('N 0° · +12°');
    c.setHeading(Math.PI / 2, -0.1);
    expect(root.querySelector('.compass-readout')!.textContent).toMatch(/^E 90° · -6°$/);
    c.setHeading(0, -0.004);
    expect(root.querySelector('.compass-readout')!.textContent!.endsWith('+0°')).toBe(true);
  });
  it('wraps yaw beyond a full turn', () => {
    const root = document.createElement('div');
    const c = buildCompass(root);
    c.setHeading(2 * Math.PI + 0.1, 0);
    const a = root.querySelector('.compass-readout')!.textContent;
    c.setHeading(0.1, 0);
    expect(root.querySelector('.compass-readout')!.textContent).toBe(a);
  });
  it('appends a position suffix only when latLon is passed', () => {
    const root = document.createElement('div');
    const c = buildCompass(root);
    // 3 decimals ≈ 111 m ticks: walking must be legible on the readout
    c.setHeading(0, 0, { latDeg: 12.0402, lonDeg: -176.4413 });
    expect(root.querySelector('.compass-readout')!.textContent).toBe('N 0° · +0° · 12.040°N 176.441°W');
    c.setHeading(0, 0);
    expect(root.querySelector('.compass-readout')!.textContent).toBe('N 0° · +0°');
  });
  it('is hidden until standing', () => {
    const root = document.createElement('div');
    const c = buildCompass(root);
    const box = root.querySelector('.hud-compass') as HTMLElement;
    expect(box.style.display).toBe('none');
    c.setVisible(true);
    expect(box.style.display).toBe('');
  });
  it('shows elevation and flight altitude when provided', () => {
    const root = document.createElement('div');
    const c = buildCompass(root);
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, 1234.4, 0);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('⛰ 1,234 m');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, -30.2, 0);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('⛰ -30 m');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, 5, 12_300);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('✈ 12.3 km');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, 5, 900);
    expect(root.querySelector('.compass-readout')!.textContent).toContain('✈ 900 m');
    c.setHeading(0, 0, { latDeg: 1, lonDeg: 2 }, null, 0);
    expect(root.querySelector('.compass-readout')!.textContent).not.toContain('⛰');
  });
});
