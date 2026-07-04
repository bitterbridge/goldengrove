import { parseSeedValue } from '../ui/seed';

/** Everything a shared link reproduces. The URL hash is the only persistence. */
export interface AppState {
  seed: string;
  view: 'space' | 'ground';
  t: number;
  speed: number;
  body: number | null;
  lat: number | null;
  lon: number | null;
  alt: number | null;
}

export function defaultAppState(seed: string): AppState {
  return { seed, view: 'space', t: 0, speed: 1, body: null, lat: null, lon: null, alt: null };
}

function finiteInRange(v: string | null, lo: number, hi: number): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/** Tolerant parse: a valid seed is required; every other field falls back to
 * its default rather than failing — a mangled link still opens the world.
 * Note: range bounds below are deliberately conservative practical limits, not formal contracts. */
export function parseAppState(hash: string): AppState | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const seed = parseSeedValue(params.get('seed') ?? '');
  if (seed === null) return null;
  const s = defaultAppState(seed);
  if (params.get('view') === 'ground') s.view = 'ground';
  s.t = finiteInRange(params.get('t'), 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const speed = finiteInRange(params.get('speed'), 1e-6, 1e12);
  if (speed !== null && speed > 0) s.speed = speed;
  const body = finiteInRange(params.get('body'), 0, 10_000);
  if (body !== null && Number.isInteger(body)) s.body = body;
  s.lat = finiteInRange(params.get('lat'), -90, 90);
  s.lon = finiteInRange(params.get('lon'), -180, 180);
  s.alt = finiteInRange(params.get('alt'), 0, 1e10);
  return s;
}

/** Fixed key order; defaults omitted so simple links stay simple. */
export function serializeAppState(s: AppState): string {
  const parts = [`seed=${s.seed}`];
  if (s.view !== 'space') parts.push(`view=${s.view}`);
  const t = Math.round(s.t);
  if (t !== 0) parts.push(`t=${t}`);
  if (s.speed !== 1) parts.push(`speed=${s.speed}`);
  if (s.body !== null) parts.push(`body=${s.body}`);
  if (s.lat !== null) parts.push(`lat=${s.lat.toFixed(4).replace(/\.?0+$/, '')}`);
  if (s.lon !== null) parts.push(`lon=${s.lon.toFixed(4).replace(/\.?0+$/, '')}`);
  if (s.alt !== null && s.alt > 0) parts.push(`alt=${Math.round(s.alt)}`);
  return `#${parts.join('&')}`;
}
