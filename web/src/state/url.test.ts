import { describe, expect, it } from 'vitest';
import { defaultAppState, parseAppState, serializeAppState, type AppState } from './url';

describe('parseAppState', () => {
  it('parses a full state', () => {
    const s = parseAppState('#seed=42&view=ground&t=86400&speed=3600&body=3&lat=12.5&lon=-47.25');
    expect(s).toEqual({ seed: '42', view: 'ground', t: 86400, speed: 3600, body: 3, lat: 12.5, lon: -47.25, alt: null });
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
  it('treats empty param values as absent, not zero', () => {
    expect(parseAppState('#seed=1&lat=&lon=&body=&t=&speed=')).toEqual(defaultAppState('1'));
  });
  it('rejects junk alt without failing the parse', () => {
    expect(parseAppState('#seed=42&alt=-5')!.alt).toBeNull();
    expect(parseAppState('#seed=42&alt=zeppelin')!.alt).toBeNull();
  });
});

describe('serializeAppState', () => {
  it('omits defaults', () => {
    expect(serializeAppState(defaultAppState('42'))).toBe('#seed=42');
  });
  it('round-trips a full state', () => {
    const full: AppState = { seed: '42', view: 'ground', t: 123457, speed: 86400, body: 2, lat: 31.21, lon: -47.85, alt: null };
    expect(parseAppState(serializeAppState(full))).toEqual(full);
  });
  it('rounds t to whole seconds and coords to 4 decimals', () => {
    const s: AppState = { ...defaultAppState('1'), t: 12.7, lat: 1.23456, lon: 2.34567, view: 'ground', alt: null };
    expect(serializeAppState(s)).toBe('#seed=1&view=ground&t=13&lat=1.2346&lon=2.3457');
  });
  it('round-trips alt and omits it when grounded', () => {
    const s = { ...defaultAppState('42'), view: 'ground' as const, body: 3, lat: 2.11, lon: 44.3, alt: 12345.6 };
    const parsed = parseAppState(serializeAppState(s))!;
    expect(parsed.alt).toBe(12346);
    expect(serializeAppState({ ...s, alt: 0 })).not.toContain('alt=');
    expect(serializeAppState({ ...s, alt: null })).not.toContain('alt=');
  });
  it('serializes lat/lon to 4 decimals (11 m — walking-precision shares)', () => {
    const s = { ...defaultAppState('42'), lat: 2.110449, lon: -119.75012, alt: null };
    const out = serializeAppState(s);
    expect(out).toContain('lat=2.1104');
    expect(out).toContain('lon=-119.7501');
  });
});
