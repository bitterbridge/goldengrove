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
