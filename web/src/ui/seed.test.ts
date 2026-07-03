import { describe, expect, it } from 'vitest';
import { parseSeedFromHash, randomSeed } from './seed';

describe('parseSeedFromHash', () => {
  it('extracts a decimal seed', () => {
    expect(parseSeedFromHash('#seed=42')).toBe('42');
    expect(parseSeedFromHash('#seed=18446744073709551615')).toBe('18446744073709551615');
  });
  it('rejects out-of-range and malformed values', () => {
    expect(parseSeedFromHash('#seed=18446744073709551616')).toBeNull(); // u64::MAX + 1
    expect(parseSeedFromHash('#seed=-3')).toBeNull();
    expect(parseSeedFromHash('#seed=0x2a')).toBeNull();
    expect(parseSeedFromHash('')).toBeNull();
    expect(parseSeedFromHash('#other=1')).toBeNull();
  });
});

describe('randomSeed', () => {
  it('produces a valid u64 decimal string', () => {
    for (let i = 0; i < 20; i++) {
      const s = randomSeed();
      expect(/^\d+$/.test(s)).toBe(true);
      expect(BigInt(s) <= 0xffffffffffffffffn).toBe(true);
    }
  });
});
