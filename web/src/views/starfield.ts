import * as THREE from 'three';
import { fnv1a32, mulberry32 } from '../util/prng';

/** Seeded celestial sphere. Positions are WORLD-frame directions; the ground
 * scene rotates the whole Points object into the local frame each frame, so
 * stars wheel as the planet spins. */
export function buildStarfield(seedStr: string, radius = 1100, count = 1200): THREE.Points {
  const rand = mulberry32(fnv1a32(`stars-${seedStr}`));
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = 2 * rand() - 1;
    const phi = 2 * Math.PI * rand();
    const s = Math.sqrt(1 - z * z);
    pos[i * 3] = radius * s * Math.cos(phi);
    pos[i * 3 + 1] = radius * s * Math.sin(phi);
    pos[i * 3 + 2] = radius * z;
    const mag = rand(); // 0 bright .. 1 dim
    const warm = rand();
    const b = 0.35 + 0.65 * (1 - mag) ** 2;
    col[i * 3] = b * (0.85 + 0.15 * warm);
    col[i * 3 + 1] = b * 0.92;
    col[i * 3 + 2] = b * (1.0 - 0.2 * warm);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = 0;
  points.userData.starCount = count;
  return points;
}
