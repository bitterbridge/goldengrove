import { describe, expect, it } from 'vitest';
import { defaultAppState, parseAppState, serializeAppState, type AppState } from './url';

describe('parseAppState', () => {
  it('parses a full state', () => {
    const s = parseAppState('#seed=42&view=ground&t=86400&speed=3600&body=3&lat=12.5&lon=-47.25');
    expect(s).toEqual({ seed: '42', view: 'ground', t: 86400, speed: 3600, body: 3, lat: 12.5, lon: -47.25 });
  });
  it('defaults everything but the seed', () => {
    expect(parseAppState('#seed=42')).toEqual(defaultAppState('42'));
  });
  it('canonicalizes the seed', () => {
    expect(parseAppState('#seed=007')!.seed).toBe('7');
  });
  it('returns null without a valid seed', () => {
    expect(parseAppState('')).toBeNull();
    expect(parseAppState('#view=ground&t=5')).toBeNull();
    expect(parseAppState('#seed=18446744073709551616')).toBeNull();
  });
  it('sanitizes bad optional values instead of failing', () => {
    const s = parseAppState('#seed=1&t=-5&speed=0&body=-2&lat=999&lon=abc&view=sideways')!;
    expect(s).toEqual(defaultAppState('1'));
  });
});

describe('serializeAppState', () => {
  it('omits defaults', () => {
    expect(serializeAppState(defaultAppState('42'))).toBe('#seed=42');
  });
  it('round-trips a full state', () => {
    const full: AppState = { seed: '42', view: 'ground', t: 123457, speed: 86400, body: 2, lat: 31.21, lon: -47.85 };
    expect(parseAppState(serializeAppState(full))).toEqual(full);
  });
  it('rounds t to whole seconds and coords to 2 decimals', () => {
    const s: AppState = { ...defaultAppState('1'), t: 12.7, lat: 1.23456, lon: 2.34567, view: 'ground' };
    expect(serializeAppState(s)).toBe('#seed=1&view=ground&t=13&lat=1.23&lon=2.35');
  });
});
