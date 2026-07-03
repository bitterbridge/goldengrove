import * as THREE from 'three';
import { temperatureToColor } from './color';

export interface SunSpec { dirLocal: [number, number, number]; temperatureK: number; irradiance: number }

export interface SkyDome {
  mesh: THREE.Mesh;
  setSuns(suns: SunSpec[]): void;
  setDensity(d: number): void;
  dayFactor(): number;
}

const MAX_SUNS = 3;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Single-scatter Rayleigh+Mie approximation summed over suns. Not physical —
 * calibrated to read right: blue days, red-orange twilight bands toward the
 * sun, alpha→0 at night so the starfield behind shows through. */
const FRAG = /* glsl */ `
uniform vec3 sunDirs[${MAX_SUNS}];
uniform vec3 sunTints[${MAX_SUNS}];
uniform int sunCount;
uniform float density;
varying vec3 vDir;

const vec3 betaR = vec3(0.30, 0.65, 1.50);

float phaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float phaseM(float c) {
  float g = 0.76; float g2 = g * g;
  return 0.1193662 * (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5);
}

void main() {
  vec3 v = normalize(vDir);
  float mu = max(v.z, 0.0);
  float depth = 1.0 / (mu + 0.12);
  vec3 col = vec3(0.0);
  for (int i = 0; i < ${MAX_SUNS}; i++) {
    if (i >= sunCount) break;
    vec3 s = sunDirs[i];
    float day = smoothstep(-0.12, 0.12, s.z);
    float c = dot(v, s);
    // near-horizon suns redden: attenuate blue with the sun's own path length
    float sunDepth = 1.0 / (max(s.z, 0.0) + 0.12);
    vec3 transmit = exp(-betaR * sunDepth * 0.35);
    col += sunTints[i] * transmit * (betaR * phaseR(c) + vec3(phaseM(c) * 0.12)) * depth * day;
  }
  col *= density * 1.6;
  col = vec3(1.0) - exp(-1.4 * col); // tonemap
  float alpha = clamp(max(col.r, max(col.g, col.b)) * 1.7, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function buildSkyDome(radius = 1400): SkyDome {
  const uniforms = {
    sunDirs: { value: Array.from({ length: MAX_SUNS }, () => new THREE.Vector3(0, 0, -1)) },
    sunTints: { value: Array.from({ length: MAX_SUNS }, () => new THREE.Color(0)) },
    sunCount: { value: 0 },
    density: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
  mesh.renderOrder = 1; // after the starfield so its alpha blends over the stars
  let lastSuns: SunSpec[] = [];

  return {
    mesh,
    setSuns(suns) {
      lastSuns = suns.slice(0, MAX_SUNS);
      uniforms.sunCount.value = lastSuns.length;
      lastSuns.forEach((s, i) => {
        uniforms.sunDirs.value[i]!.set(...s.dirLocal).normalize();
        const [r, g, b] = temperatureToColor(s.temperatureK);
        uniforms.sunTints.value[i]!.setRGB(r * s.irradiance, g * s.irradiance, b * s.irradiance);
      });
    },
    setDensity(d) {
      uniforms.density.value = Math.min(1, Math.max(0, d));
    },
    dayFactor() {
      let f = 0;
      for (const s of lastSuns) {
        const z = s.dirLocal[2] / Math.hypot(...s.dirLocal);
        f = Math.max(f, smoothstep(-0.12, 0.12, z) * s.irradiance);
      }
      return f * uniforms.density.value;
    },
  };
}
