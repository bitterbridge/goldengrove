import { AU_M } from '../sim/types';

/** View-space scale: 1 AU renders as 10 scene units (compressed mode keeps this anchor). */
export const VIEW_UNITS_PER_AU = 10;

/** asinh knee: inner system ~linear, outer system logarithmic. */
const COMPRESS_K = 8;
const ASINH_K = Math.asinh(COMPRESS_K);

/** Moon-system exaggeration (compressed mode): real moon distances are
 * invisible at system scale, so moons render on a uniformly scaled-up copy
 * of their true orbit (linear per moon — ellipse shapes survive). */
const MOON_STRETCH = 200; // view units per AU of moon orbit, before clamping
const MOON_MIN_VIEW = 0.375; // = planet floor 0.15 * 2.5
const MOON_MAX_VIEW = 1.5;

const FLOORS = { star: 0.5, planet: 0.15, moon: 0.05 } as const;

export function compressRadial(rM: number, trueScale: boolean): number {
  const rAu = rM / AU_M;
  if (trueScale) return rAu * VIEW_UNITS_PER_AU;
  return (VIEW_UNITS_PER_AU * Math.asinh(rAu * COMPRESS_K)) / ASINH_K;
}

export function compressPosition(xM: number, yM: number, zM: number, trueScale: boolean): [number, number, number] {
  const r = Math.hypot(xM, yM, zM);
  if (r === 0) return [0, 0, 0];
  const s = compressRadial(r, trueScale) / r;
  return [xM * s, yM * s, zM * s];
}

/** Constant view-units-per-meter factor for one moon, from its semi-major
 * axis: uniform scaling per moon keeps its orbit ellipse similar. */
export function moonViewFactor(aM: number, trueScale: boolean): number {
  const aAu = aM / AU_M;
  if (trueScale) return VIEW_UNITS_PER_AU / AU_M;
  const target = Math.min(Math.max(aAu * MOON_STRETCH, MOON_MIN_VIEW), MOON_MAX_VIEW);
  return target / aM;
}

export function displayRadius(kind: 'star' | 'planet' | 'moon', radiusM: number, trueScale: boolean): number {
  const real = (radiusM / AU_M) * VIEW_UNITS_PER_AU;
  return trueScale ? real : Math.max(real, FLOORS[kind]);
}
