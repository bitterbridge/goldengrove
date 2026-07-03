import { bodyLayout, bodyRadiusM, type BodyRef } from '../sim/layout';
import type { SystemDescriptor } from '../sim/types';

export type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / len(a));

export interface ObserverFrame { positionM: Vec3; up: Vec3; east: Vec3; north: Vec3 }

export interface SkyBody {
  index: number;
  kind: 'star' | 'planet' | 'moon';
  dirLocal: Vec3;
  altRad: number;
  azRad: number;
  distM: number;
  angularRadiusRad: number;
}

/** Planet-fixed frame from spin axis + rotation angle. The prime meridian's
 * zero reference is world +X projected into the equator plane (falls back to
 * +Y when the axis is within ~0.001 rad of +X). Arbitrary but FIXED — lat/lon
 * mean the same surface point at every t, which is all a vantage needs. */
export function planetBasis(axis: Vec3, rotationRad: number): { pole: Vec3; meridian: Vec3; ortho: Vec3 } {
  const pole = norm(axis);
  let ref: Vec3 = [1, 0, 0];
  let e0 = sub(ref, scale(pole, dot(ref, pole)));
  if (len(e0) < 1e-3) {
    ref = [0, 1, 0];
    e0 = sub(ref, scale(pole, dot(ref, pole)));
  }
  e0 = norm(e0);
  const e90 = cross(pole, e0);
  const c = Math.cos(rotationRad);
  const s = Math.sin(rotationRad);
  const meridian: Vec3 = add(scale(e0, c), scale(e90, s));
  const ortho = cross(pole, meridian);
  return { pole, meridian, ortho };
}

function bodyState(states: Float64Array, i: number) {
  return {
    pos: [states[i * 7]!, states[i * 7 + 1]!, states[i * 7 + 2]!] as Vec3,
    axis: [states[i * 7 + 3]!, states[i * 7 + 4]!, states[i * 7 + 5]!] as Vec3,
    rot: states[i * 7 + 6]!,
  };
}

export function observerFrame(
  states: Float64Array,
  desc: SystemDescriptor,
  bodyIndex: number,
  latDeg: number,
  lonDeg: number,
): ObserverFrame {
  const layout = bodyLayout(desc);
  const ref = layout[bodyIndex]!;
  const { pos, axis, rot } = bodyState(states, bodyIndex);
  const b = planetBasis(axis, rot);
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const up = add(
    add(scale(b.meridian, Math.cos(lat) * Math.cos(lon)), scale(b.ortho, Math.cos(lat) * Math.sin(lon))),
    scale(b.pole, Math.sin(lat)),
  );
  let east = cross(b.pole, up);
  east = len(east) < 1e-9 ? b.meridian : norm(east); // pole fallback: arbitrary but stable
  const north = cross(up, east);
  const positionM = add(pos, scale(up, bodyRadiusM(desc, ref)));
  return { positionM, up, east, north };
}

export function worldToLocal(d: Vec3, f: ObserverFrame): Vec3 {
  return [dot(d, f.east), dot(d, f.north), dot(d, f.up)];
}

export function skyBodies(
  states: Float64Array,
  desc: SystemDescriptor,
  standingIndex: number,
  frame: ObserverFrame,
): SkyBody[] {
  const layout = bodyLayout(desc);
  const out: SkyBody[] = [];
  layout.forEach((ref: BodyRef, i: number) => {
    if (i === standingIndex) return;
    const { pos } = bodyState(states, i);
    const d = sub(pos, frame.positionM);
    const distM = len(d);
    const dirLocal = worldToLocal(scale(d, 1 / distM), frame);
    const altRad = Math.asin(Math.min(1, Math.max(-1, dirLocal[2])));
    const azRad = Math.atan2(dirLocal[0], dirLocal[1]); // 0=N, +east
    const angularRadiusRad = Math.asin(Math.min(1, bodyRadiusM(desc, ref) / distM));
    out.push({ index: i, kind: ref.kind, dirLocal, altRad, azRad, distM, angularRadiusRad });
  });
  return out;
}

/** Inverse of the surface-point construction: world-frame unit direction from
 * the planet's center to a surface point → lat/lon under the same basis. */
export function pointToLatLon(dirFromCenterWorld: Vec3, axis: Vec3, rotationRad: number): { latDeg: number; lonDeg: number } {
  const b = planetBasis(axis, rotationRad);
  const u = norm(dirFromCenterWorld);
  const latDeg = (Math.asin(Math.min(1, Math.max(-1, dot(u, b.pole)))) * 180) / Math.PI;
  const lonDeg = (Math.atan2(dot(u, b.ortho), dot(u, b.meridian)) * 180) / Math.PI;
  return { latDeg, lonDeg };
}
