import * as THREE from 'three';
import { biomeColor } from './biomePalette';

/** Hypsometric tint ramp. Elevations are relative (sea level = 0). */
const OCEAN_DEEP: [number, number, number] = [8, 26, 58];
const OCEAN_SHELF: [number, number, number] = [42, 92, 138];
const DRY_DEEP: [number, number, number] = [58, 47, 36];
const DRY_SHELF: [number, number, number] = [87, 73, 58];
const SHORE: [number, number, number] = [138, 127, 95];
const UPLAND: [number, number, number] = [122, 106, 88];
const PEAK: [number, number, number] = [216, 216, 216];

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const u = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

export function hypsometricColor(
  e: number,
  shade: number,
  classTint: [number, number, number],
  dead: boolean,
): [number, number, number] {
  let c: [number, number, number];
  if (e < 0) {
    const t = Math.min(1, -e / 1.5);
    c = dead ? mix(DRY_SHELF, DRY_DEEP, t) : mix(OCEAN_SHELF, OCEAN_DEEP, t);
  } else if (e < 0.6) {
    c = mix(SHORE, UPLAND, e / 0.6);
  } else {
    c = mix(UPLAND, PEAK, (e - 0.6) / 1.2);
  }
  c = mix(c, classTint, 0.22); // keep the orrery's class color language
  const s = shade;
  return [Math.min(255, c[0] * s), Math.min(255, c[1] * s), Math.min(255, c[2] * s)].map(Math.round) as [
    number,
    number,
    number,
  ];
}

/** Finite-difference relief shading, light from the NW. Flat terrain = 1.0. */
export function slopeShade(map: Float32Array, w: number, h: number, row: number, col: number): number {
  const at = (r: number, c: number) => map[Math.min(h - 1, Math.max(0, r)) * w + ((c + w) % w)]!;
  const dx = at(row, col + 1) - at(row, col - 1);
  const dy = at(row + 1, col) - at(row - 1, col);
  // light from NW: brighter when surface rises toward -x,-y
  return Math.min(1.15, Math.max(0.75, 1.0 - 0.35 * (dx + dy)));
}

export function terrainTexture(
  map: Float32Array,
  w: number,
  h: number,
  classHex: number,
  dead: boolean,
): THREE.CanvasTexture | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const tint: [number, number, number] = [(classHex >> 16) & 255, (classHex >> 8) & 255, classHex & 255];
    const img = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const e = map[row * w + col]!;
        const [r, g, b] = hypsometricColor(e, slopeShade(map, w, h, row, col), tint, dead);
        const o = (row * w + col) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}

/** Biome-colored orrery texture from the shared palette; mirrors `terrainTexture`'s shape. */
export function biomeTexture(
  biomes: Uint8Array,
  elevations: Float32Array,
  w: number,
  h: number,
): THREE.CanvasTexture | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = row * w + col;
        const [r, g, b] = biomeColor(biomes[i]!, slopeShade(elevations, w, h, row, col));
        const o = i * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}
