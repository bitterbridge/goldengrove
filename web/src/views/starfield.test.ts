import { describe, expect, it } from 'vitest';
import { buildStarfield } from './starfield';

describe('buildStarfield', () => {
  it('is deterministic per seed and puts stars on the sphere', () => {
    const a = buildStarfield('42', 1100, 300);
    const b = buildStarfield('42', 1100, 300);
    const pa = a.geometry.getAttribute('position');
    const pb = b.geometry.getAttribute('position');
    expect(pa.count).toBe(300);
    for (let i = 0; i < 10; i++) {
      expect(pa.getX(i)).toBe(pb.getX(i));
      const r = Math.hypot(pa.getX(i), pa.getY(i), pa.getZ(i));
      expect(r).toBeCloseTo(1100, 3);
    }
    const c = buildStarfield('43', 1100, 300);
    expect(c.geometry.getAttribute('position').getX(0)).not.toBe(pa.getX(0));
  });
});
