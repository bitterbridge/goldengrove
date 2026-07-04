/** three.js orchestrator for the quadtree terrain: owns the terrain scene,
 * drains the build queue against the WASM elevation API, and re-anchors
 * tiles camera-relative each frame (rendering-relative-to-eye).
 *
 * Frame conventions: the scene is the observer's ENU frame (x=east,
 * y=north, z=up — identical to the sky scene), so one camera drives both
 * passes. Terrain lives in BODY-FIXED coordinates (elevation is a function
 * of lat/lon only), and ENU axes expressed body-fixed depend only on
 * lat/lon — the body's rotation never enters: east = pole×up normalized,
 * north = up×east. */
import * as THREE from 'three';
import { bodyLayout, bodyRadiusM } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import type { SunSpec } from './sky';
import { tileGrid, tileKey, type TileId } from './cubeSphere';
import { TileTree } from './tileTree';
import { buildTileMesh } from './tileMesh';

export interface TerrainGlobe {
  scene: THREE.Scene;
  update(latDeg: number, lonDeg: number, eyeAltM: number, suns: SunSpec[], buildBudget?: number): void;
  stats(): { built: number; pendingBuilds: number };
}

const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
const MOON_TINT = 0x8a8f98;

export function buildTerrainGlobe(sim: Sim, bodyIndex: number): TerrainGlobe | null {
  const info = sim.bodyTerrainInfo(bodyIndex);
  if (!info) return null;
  const desc = sim.descriptor;
  const layout = bodyLayout(desc);
  const ref = layout[bodyIndex]!;
  if (ref.kind === 'star') return null;
  const radiusM = bodyRadiusM(desc, ref);
  const classHex = ref.kind === 'planet' ? PALETTE[desc.planets[ref.planet]!.class] : MOON_TINT;
  const classTint: [number, number, number] = [(classHex >> 16) & 255, (classHex >> 8) & 255, classHex & 255];
  const dead = ref.kind === 'planet' && desc.planets[ref.planet]!.state.kind === 'Dead';

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x334455, 0.3));
  const sunLights = [new THREE.DirectionalLight(0xffffff, 0), new THREE.DirectionalLight(0xffffff, 0)];
  sunLights.forEach((l) => scene.add(l));

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0 });
  // splitK 1.7 keeps the steady-state active set near ~100-200 tiles
  // (~1-1.6 M triangles); splitK 3 would triple that. cacheCap must
  // comfortably exceed the active set or the cache thrashes.
  const tree = new TileTree({ radiusM, splitK: 1.7, cacheCap: 480 });
  const meshes = new Map<string, THREE.Mesh>();
  let pendingBuilds = 0;

  function buildTile(t: TileId): void {
    const grid = tileGrid(t);
    const n = grid.lats.length;
    const coords = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      coords[2 * i] = grid.lats[i]!;
      coords[2 * i + 1] = grid.lons[i]!;
    }
    const elevs = sim.bodyElevations(bodyIndex, coords);
    if (elevs.length !== n) return; // non-terrain body (shouldn't happen here)
    const data = buildTileMesh(t, elevs, { radiusM, reliefM: info!.relief_m, classTint, dead });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.originBf = data.originBf;
    mesh.visible = false;
    mesh.frustumCulled = false; // tiles are selected CPU-side; sphere-scale bounds confuse three's culler
    scene.add(mesh);
    meshes.set(tileKey(t), mesh);
    tree.markBuilt(tileKey(t));
  }

  function update(latDeg: number, lonDeg: number, eyeAltM: number, suns: SunSpec[], buildBudget = 2): void {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const up: [number, number, number] = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    // ENU in body-fixed: east = ẑ×up (normalized), north = up×east
    const el = Math.hypot(-up[1], up[0]);
    const east: [number, number, number] = el < 1e-9 ? [1, 0, 0] : [-up[1] / el, up[0] / el, 0];
    const north: [number, number, number] = [
      up[1] * east[2] - up[2] * east[1],
      up[2] * east[0] - up[0] * east[2],
      up[0] * east[1] - up[1] * east[0],
    ];
    const camR = radiusM + eyeAltM;
    const camBf: [number, number, number] = [up[0] * camR, up[1] * camR, up[2] * camR];

    const { render, build, evict } = tree.update(camBf);

    for (const key of evict) {
      const m = meshes.get(key);
      if (m) {
        m.geometry.dispose();
        scene.remove(m);
        meshes.delete(key);
      }
    }
    for (const t of build.slice(0, buildBudget)) buildTile(t);
    pendingBuilds = Math.max(0, build.length - buildBudget);

    // body-fixed -> ENU rotation (rows east/north/up), applied scene-wide
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...east),
      new THREE.Vector3(...north),
      new THREE.Vector3(...up),
    ).transpose();
    const q = new THREE.Quaternion().setFromRotationMatrix(basis);

    const active = new Set(render.map(tileKey));
    for (const [key, mesh] of meshes) {
      const on = active.has(key);
      mesh.visible = on;
      if (!on) continue;
      const o = mesh.userData.originBf as [number, number, number];
      // f64 subtraction BEFORE the f32 assignment: this is the RTC step
      mesh.position.set(o[0] - camBf[0], o[1] - camBf[1], o[2] - camBf[2]);
      mesh.quaternion.copy(q);
      mesh.position.applyQuaternion(q);
    }

    // sun lights: same directions as the sky pass, but terrain lighting
    // fades across the horizon (the ground darkens at night; sky BODIES
    // stay sunlit — that fix lives in ground.ts and stays there)
    sunLights.forEach((l, i) => {
      const s = suns[i];
      if (s) {
        const fade = THREE.MathUtils.smoothstep(s.dirLocal[2], -0.12, 0.06);
        l.intensity = 2.0 * s.irradiance * fade;
        l.position.set(s.dirLocal[0] * 100, s.dirLocal[1] * 100, s.dirLocal[2] * 100);
      } else {
        l.intensity = 0;
      }
    });
  }

  return { scene, update, stats: () => ({ built: meshes.size, pendingBuilds }) };
}
