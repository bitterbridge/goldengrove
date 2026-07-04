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
import { tileGrid, tileKey, type TileId, TILE_QUADS } from './cubeSphere';
import { TileTree } from './tileTree';
import { buildTileMesh, type TileMeshData } from './tileMesh';

export interface TerrainGlobe {
  scene: THREE.Scene;
  update(
    latDeg: number,
    lonDeg: number,
    eyeAltM: number,
    suns: SunSpec[],
    buildBudget?: number,
    atmDensity?: number,
    dayFactor?: number,
  ): void;
  stats(): { built: number; pendingBuilds: number };
  dispose(): void;
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
  scene.fog = new THREE.FogExp2(0x0a0e14, 0);
  scene.add(new THREE.AmbientLight(0x334455, 0.3));
  const sunLights = [new THREE.DirectionalLight(0xffffff, 0), new THREE.DirectionalLight(0xffffff, 0)];
  sunLights.forEach((l) => scene.add(l));

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0 });
  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x1c4a78, transparent: true, opacity: 0.82, roughness: 0.35, metalness: 0,
  });
  const hasOcean = info.ocean_fraction > 0;
  // splitK 1.7 keeps the steady-state active set near ~100-200 tiles
  // (~1-1.6 M triangles); splitK 3 would triple that. cacheCap must
  // comfortably exceed the active set or the cache thrashes.
  const tree = new TileTree({ radiusM, splitK: 1.7, cacheCap: 480 });
  const meshes = new Map<string, THREE.Mesh>();
  const waterMeshes = new Map<string, THREE.Mesh>();
  let pendingBuilds = 0;

  const GRID_COUNT = (TILE_QUADS + 1) * (TILE_QUADS + 1);

  // Vertex normals must come from grid faces only: computing them over the
  // full index (grid + vertical skirt-wall quads) averages near-vertical
  // skirt-face normals into border grid vertices, darkening every tile
  // edge under directional lighting (visible as a grid of dark seams at
  // altitude). Skirt vertices don't need their own lighting fidelity —
  // they're a hidden crack-filler — so they simply inherit their source
  // grid vertex's normal.
  function computeGridOnlyNormals(geo: THREE.BufferGeometry, data: TileMeshData): void {
    const fullIndex = data.indices;
    geo.setIndex(new THREE.BufferAttribute(fullIndex.subarray(0, data.gridIndexCount), 1));
    geo.computeVertexNormals();
    geo.setIndex(new THREE.BufferAttribute(fullIndex, 1));
    const normal = geo.getAttribute('normal') as THREE.BufferAttribute;
    data.skirtSourceIndices.forEach((srcGi, s) => {
      const skirtI = GRID_COUNT + s;
      normal.setXYZ(skirtI, normal.getX(srcGi), normal.getY(srcGi), normal.getZ(srcGi));
    });
    normal.needsUpdate = true;
  }

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
    computeGridOnlyNormals(geo, data);
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.originBf = data.originBf;
    mesh.visible = false;
    mesh.frustumCulled = false; // tiles are selected CPU-side; sphere-scale bounds confuse three's culler
    scene.add(mesh);
    meshes.set(tileKey(t), mesh);

    if (hasOcean) {
      let dipsBelow = false;
      for (let i = 0; i < elevs.length; i++) if (elevs[i]! < 0) { dipsBelow = true; break; }
      if (dipsBelow) {
        const flat = new Float32Array(elevs.length); // all zeros = sea level
        const w = buildTileMesh(t, flat, { radiusM, reliefM: info!.relief_m, classTint, dead });
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.BufferAttribute(w.positions, 3));
        wg.setIndex(new THREE.BufferAttribute(w.indices, 1));
        computeGridOnlyNormals(wg, w);
        const wm = new THREE.Mesh(wg, waterMaterial);
        wm.userData.originBf = w.originBf;
        wm.visible = false;
        wm.frustumCulled = false;
        scene.add(wm);
        waterMeshes.set(tileKey(t), wm);
      }
    }
    tree.markBuilt(tileKey(t));
  }

  function update(
    latDeg: number,
    lonDeg: number,
    eyeAltM: number,
    suns: SunSpec[],
    buildBudget = 2,
    atmDensity = 0,
    dayFactor = 0,
  ): void {
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
      const wm = waterMeshes.get(key);
      if (wm) {
        wm.geometry.dispose();
        scene.remove(wm);
        waterMeshes.delete(key);
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

      const wm = waterMeshes.get(key);
      if (wm) {
        wm.visible = true;
        const wo = wm.userData.originBf as [number, number, number];
        wm.position.set(wo[0] - camBf[0], wo[1] - camBf[1], wo[2] - camBf[2]);
        wm.quaternion.copy(q);
        wm.position.applyQuaternion(q);
      }
    }
    for (const [key, wm] of waterMeshes) {
      if (!active.has(key)) wm.visible = false;
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

    // exponential distance fog: scales with atmosphere thickness and thins
    // with eye altitude (scale height H = 8500 m, Earth-like); airless
    // bodies (atmDensity = 0) get none.
    const fog = scene.fog as THREE.FogExp2;
    fog.density = 2.5e-5 * atmDensity * Math.exp(-eyeAltM / 8500);
    fog.color.setHex(0x0a0e14).lerp(new THREE.Color(0x9db4c8), dayFactor);
  }

  function dispose(): void {
    for (const [, mesh] of meshes) {
      mesh.geometry.dispose();
      scene.remove(mesh);
    }
    meshes.clear();
    material.dispose();
    for (const [, wm] of waterMeshes) {
      wm.geometry.dispose();
      scene.remove(wm);
    }
    waterMeshes.clear();
    waterMaterial.dispose();
  }

  return { scene, update, stats: () => ({ built: meshes.size, pendingBuilds }), dispose };
}
