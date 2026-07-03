import { describe, expect, it } from 'vitest';
import { fnv1a32, mulberry32 } from './prng';

describe('prng', () => {
  it('fnv1a32 is stable and seed-sensitive', () => {
    expect(fnv1a32('42')).toBe(fnv1a32('42'));
    expect(fnv1a32('42')).not.toBe(fnv1a32('43'));
  });
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(mulberry32(123)()).not.toBe(mulberry32(124)());
  });
});
