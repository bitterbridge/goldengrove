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
    c.setHeading(0, 0, { latDeg: 12.04, lonDeg: -176.44 });
    expect(root.querySelector('.compass-readout')!.textContent).toBe('N 0° · +0° · 12.0°N 176.4°W');
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
});
