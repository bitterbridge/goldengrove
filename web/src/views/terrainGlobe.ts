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
import { tileGrid, tileKey, tileEdgeLenM, type TileId, TILE_QUADS } from './cubeSphere';
import { TileTree } from './tileTree';
import { buildTileMesh, type TileMeshData } from './tileMesh';

export interface TerrainGlobe {
  scene: THREE.Scene;
  update(
    latDeg: number,
    lonDeg: number,
    terrainM: number,
    aboveTerrainM: number,
    suns: SunSpec[],
    buildBudget?: number,
    atmDensity?: number,
    dayFactor?: number,
  ): void;
  stats(): { built: number; pendingBuilds: number; deepestBuilt: number };
  dispose(): void;
}

const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
const MOON_TINT = 0x8a8f98;

// splitK 1.7 keeps the steady-state active set near ~100-200 tiles
// (~1-1.6 M triangles); splitK 3 would triple that. cacheCap must
// comfortably exceed the active set or the cache thrashes. Also defines
// each tile's static uSplitDist (see injectMorphShader): the same distance
// the tree used to decide whether this tile would refine further.
export const SPLIT_K = 1.7;

/** One GLSL program shared by every cloned terrain material (three.js keys
 * compiled programs by customProgramCacheKey); without this each per-tile
 * material clone would trigger its own shader compile. */
const MORPH_PROGRAM_CACHE_KEY = 'gg-morph';

/** Per-VERTEX CDLOD morph (not per-tile): a per-tile scalar morph computed
 * from tile-CENTER distance leaves a fine tile's far edge under-morphed for
 * its actual distance, missing the coarse neighbor's surface — visible as
 * cross-level crack seams. Classic CDLOD morphs each vertex by its own
 * distance-from-LOD-point instead.
 *
 * uSplitDist is static per tile (SPLIT_K * tileEdgeLenM(tile.level)), set
 * once at build — the vertex shader recomputes the morph factor every frame
 * from the vertex's own distance to uLodCamLocal, not a CPU-computed
 * per-tile scalar. This closes same-level seams: neighbors share edge
 * vertices, so they share position, aParentPos AND uSplitDist, giving
 * identical morph at the shared edge (no crack).
 *
 * INVARIANT: morph distance must be measured from the SAME point the tree
 * splits on (tree.update's cameraBf, aka the LOD camera point — radiusM +
 * aboveTerrainM, deliberately excluding terrain elevation; see update()),
 * or the "fully-morphed-at-boundary" guarantee breaks. A fine tile adjacent
 * to a coarser sibling is only guaranteed to sit at distance >= its own
 * uSplitDist from the LOD point (that's the tree's own split test) — NOT
 * from the render eye. Previously this shader measured distance from the
 * render eye (modelViewMatrix), which diverges from the LOD point by
 * roughly scaledTerrain + eye height; at 3x relief + altitude that's ~10 km
 * on tall terrain, easily larger than the 0.70-0.95 smoothstep slack, so
 * near tiles could sit UNDER their own uSplitDist in render-eye distance
 * while the tree (correctly) judged them far enough to leave coarse —
 * leaving ggMorph short of 1 at the boundary and reopening thin T-junction
 * cracks. Measuring from uLodCamLocal (the LOD point, in tile-local/RTC
 * coordinates for f32 precision) makes the shader's morph distance
 * IDENTICAL to the tree's split metric, closing the seam exactly. */
function injectMorphShader(
  shader: THREE.WebGLProgramParametersWithUniforms,
  uSplitDist: { value: number },
  uLodCamLocal: { value: THREE.Vector3 },
): void {
  shader.uniforms.uSplitDist = uSplitDist;
  shader.uniforms.uLodCamLocal = uLodCamLocal;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute vec3 aParentPos;\nuniform float uSplitDist;\nuniform vec3 uLodCamLocal;',
    )
    .replace(
      '#include <begin_vertex>',
      'float ggMorph = smoothstep( 0.7 * uSplitDist, 0.95 * uSplitDist, distance( position, uLodCamLocal ) );\n' +
        'vec3 transformed = mix( vec3( position ), aParentPos, ggMorph );',
    );
}

export function buildTerrainGlobe(sim: Sim, bodyIndex: number, reliefScale = 3): TerrainGlobe | null {
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
  const tree = new TileTree({ radiusM, splitK: SPLIT_K, cacheCap: 480 });
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
    const data = buildTileMesh(t, elevs, { radiusM, reliefM: info!.relief_m, classTint, dead, verticalScale: reliefScale });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setAttribute('aParentPos', new THREE.BufferAttribute(data.parentPositions, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    computeGridOnlyNormals(geo, data);

    // Per-tile cloned material: each tile needs its own static uSplitDist
    // uniform, but all clones share ONE compiled GLSL program
    // (customProgramCacheKey) so cloning doesn't multiply shader compiles.
    const tileMat = material.clone();
    tileMat.customProgramCacheKey = () => MORPH_PROGRAM_CACHE_KEY;
    const uSplitDist = { value: SPLIT_K * tileEdgeLenM(t.level, radiusM) };
    const uLodCamLocal = { value: new THREE.Vector3() };
    tileMat.onBeforeCompile = (shader) => injectMorphShader(shader, uSplitDist, uLodCamLocal);

    const mesh = new THREE.Mesh(geo, tileMat);
    mesh.userData.originBf = data.originBf;
    mesh.userData.uSplitDist = uSplitDist;
    mesh.userData.uLodCamLocal = uLodCamLocal;
    mesh.userData.level = t.level; // test introspection only; not read by render code
    mesh.visible = false;
    mesh.frustumCulled = false; // tiles are selected CPU-side; sphere-scale bounds confuse three's culler
    scene.add(mesh);
    meshes.set(tileKey(t), mesh);

    if (hasOcean) {
      let dipsBelow = false;
      for (let i = 0; i < elevs.length; i++) if (elevs[i]! < 0) { dipsBelow = true; break; }
      if (dipsBelow) {
        const flat = new Float32Array(elevs.length); // all zeros = sea level
        const w = buildTileMesh(t, flat, { radiusM, reliefM: info!.relief_m, classTint, dead, verticalScale: 1 });
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
    terrainM: number,
    aboveTerrainM: number,
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
    // LOD split distances are measured against the UNDISPLACED sphere, so
    // the camera point fed to the tree must rise only by height ABOVE THE
    // LOCAL TERRAIN — including terrain elevation here would make the split
    // test think the camera is that much farther from every tile center,
    // stalling refinement early exactly underfoot (e.g. standing on a
    // 2000 m peak would look like flying at 2 km to the LOD tree). True eye
    // altitude (terrain + above-terrain) is reserved for things that need
    // the real camera height: fog falloff and the RTC re-anchor position.
    const eyeAltM = terrainM + aboveTerrainM;
    const camRLod = radiusM + aboveTerrainM;
    const camR = radiusM + eyeAltM;
    const camBfLod: [number, number, number] = [up[0] * camRLod, up[1] * camRLod, up[2] * camRLod];
    const camBf: [number, number, number] = [up[0] * camR, up[1] * camR, up[2] * camR];

    const { render, build, evict } = tree.update(camBfLod);

    for (const key of evict) {
      const m = meshes.get(key);
      if (m) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose(); // per-tile cloned material
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

    const activeTiles = new Map(render.map((t) => [tileKey(t), t]));
    for (const [key, mesh] of meshes) {
      const t = activeTiles.get(key);
      mesh.visible = t !== undefined;
      if (!t) continue;
      const o = mesh.userData.originBf as [number, number, number];
      // f64 subtraction BEFORE the f32 assignment: this is the RTC step
      mesh.position.set(o[0] - camBf[0], o[1] - camBf[1], o[2] - camBf[2]);
      mesh.quaternion.copy(q);
      mesh.position.applyQuaternion(q);
      // Drive the morph shader's distance origin from the exact same point
      // tree.update() split on (camBfLod), expressed tile-local (f64
      // subtraction against this tile's own origin, same RTC pattern as the
      // mesh position above) so the f32 uniform stays precise. See the
      // invariant comment on injectMorphShader.
      const uLodCamLocal = mesh.userData.uLodCamLocal as { value: THREE.Vector3 } | undefined;
      uLodCamLocal?.value.set(camBfLod[0] - o[0], camBfLod[1] - o[1], camBfLod[2] - o[2]);

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
      if (!activeTiles.has(key)) wm.visible = false;
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
      (mesh.material as THREE.Material).dispose(); // per-tile cloned material
      scene.remove(mesh);
    }
    meshes.clear();
    material.dispose(); // shared base material the clones were made from
    for (const [, wm] of waterMeshes) {
      wm.geometry.dispose();
      scene.remove(wm);
    }
    waterMeshes.clear();
    waterMaterial.dispose();
  }

  function deepestBuilt(): number {
    let deepest = -1;
    for (const key of meshes.keys()) {
      const level = Number(key.split(':')[1]);
      if (level > deepest) deepest = level;
    }
    return deepest;
  }

  return { scene, update, stats: () => ({ built: meshes.size, pendingBuilds, deepestBuilt: deepestBuilt() }), dispose };
}
