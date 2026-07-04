import type { SystemDescriptor } from './types';

export type BodyRef =
  | { kind: 'star'; star: number }
  | { kind: 'planet'; planet: number }
  | { kind: 'moon'; planet: number; moon: number };

/** Mirrors gg-ephemeris body order: stars, planets, moons grouped by planet. */
export function bodyLayout(desc: SystemDescriptor): BodyRef[] {
  const out: BodyRef[] = [];
  desc.stars.forEach((_, i) => out.push({ kind: 'star', star: i }));
  desc.planets.forEach((_, i) => out.push({ kind: 'planet', planet: i }));
  desc.planets.forEach((p, i) => p.moons.forEach((_, j) => out.push({ kind: 'moon', planet: i, moon: j })));
  return out;
}

/** Body index of a moon's planet; null for stars and planets. */
export function parentIndex(layout: BodyRef[], desc: SystemDescriptor, index: number): number | null {
  const ref = layout[index];
  if (!ref || ref.kind !== 'moon') return null;
  return desc.stars.length + ref.planet;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export function bodyName(desc: SystemDescriptor, index: number): string {
  const layout = bodyLayout(desc);
  const ref = layout[index];
  if (!ref) return `#${index}`;
  switch (ref.kind) {
    case 'star':
      return `★${String.fromCharCode(65 + ref.star)}`;
    case 'planet':
      return ROMAN[ref.planet] ?? `P${ref.planet + 1}`;
    case 'moon':
      return `${ROMAN[ref.planet] ?? `P${ref.planet + 1}`}${String.fromCharCode(97 + ref.moon)}`;
  }
}

export function bodyRadiusM(desc: SystemDescriptor, ref: BodyRef): number {
  switch (ref.kind) {
    case 'star': return desc.stars[ref.star]!.radius_m;
    case 'planet': return desc.planets[ref.planet]!.radius_m;
    case 'moon': return desc.planets[ref.planet]!.moons[ref.moon]!.radius_m;
  }
}

/** You can stand on rocky planets and any moon; giants have no surface. */
export function standableBody(desc: SystemDescriptor, ref: BodyRef): boolean {
  if (ref.kind === 'moon') return true;
  return ref.kind === 'planet' && desc.planets[ref.planet]!.class === 'Rocky';
}

/** True for moons flagged tidally locked in the descriptor. */
export function isTidallyLocked(desc: SystemDescriptor, ref: BodyRef): boolean {
  return ref.kind === 'moon' && desc.planets[ref.planet]!.moons[ref.moon]!.tidally_locked;
}

/** Sky-shader density. Dead worlds lost their air; moons never had much. */
export function atmosphereDensityFor(desc: SystemDescriptor, ref: BodyRef): number {
  if (ref.kind === 'moon') return 0.05;
  if (ref.kind === 'planet' && desc.planets[ref.planet]!.class === 'Rocky') {
    return desc.planets[ref.planet]!.state.kind === 'Dead' ? 0.05 : 1.0;
  }
  return 1.0;
}
