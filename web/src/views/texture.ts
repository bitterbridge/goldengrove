import * as THREE from 'three';
import { fnv1a32, mulberry32 } from '../util/prng';

/** Blotchy two-tone surface so rotation and phase read. Returns null when no
 * 2D canvas exists (headless tests) — callers fall back to a flat color. */
export function proceduralBodyTexture(seedStr: string, bodyIndex: number, baseHex: number): THREE.CanvasTexture | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rand = mulberry32(fnv1a32(`tex-${seedStr}-${bodyIndex}`));
    const base = new THREE.Color(baseHex);
    ctx.fillStyle = `#${base.getHexString()}`;
    ctx.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 46; i++) {
      const shade = base.clone().multiplyScalar(0.75 + 0.5 * rand());
      ctx.fillStyle = `#${shade.getHexString()}`;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.ellipse(rand() * 128, rand() * 64, 4 + rand() * 18, 3 + rand() * 9, rand() * Math.PI, 0, 2 * Math.PI);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    return null;
  }
}
