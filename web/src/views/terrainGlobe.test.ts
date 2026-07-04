import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseDescriptor } from '../sim/parse';
import { bodyLayout, bodyRadiusM } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { TILE_QUADS } from './cubeSphere';
import { buildTerrainGlobe } from './terrainGlobe';

const golden = parseDescriptor(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../crates/gg-gen/tests/golden/seed-42.json'), 'utf8'),
);

function fakeSim(): Sim {
  const n = bodyLayout(golden).length;
  return {
    seed: golden.seed,
    descriptor: golden,
    bodyCount: n,
    statesAt: () => new Float64Array(n * 7),
    orbitPath: () => new Float64Array(0),
    anchorDate: () => ({ year: 0, day_of_year: 0, day_fraction: 0 }),
    hostOriginAt: () => new Float64Array(3),
    bodyHeightmap: () => new Float32Array(0),
    bodyTerrainInfo: (i) => (i === 0 ? null : { sea_level: 0, ocean_fraction: 0.5, relief_m: 6000, plate_count: 8 }),
    bodyElevation: () => 250,
    bodyElevations: (_: number, coords: Float64Array) => {
      const out = new Float32Array(coords.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = 100 * Math.sin(coords[2 * i]! * 0.5); // smooth, lat-dependent
      return out;
    },
  };
}

/** Same as fakeSim(), but with perfectly flat (sea-level) elevations
 * everywhere — isolates normal computation from any relief-driven slope,
 * so any deviation from radially-outward normals at grid vertices can only
 * come from skirt-face pollution in computeVertexNormals(). */
function fakeFlatSim(): Sim {
  const sim = fakeSim();
  return {
    ...sim,
    bodyElevations: (_: number, coords: Float64Array) => new Float32Array(coords.length / 2),
  };
}

/** Same as fakeSim(), but with a constant elevation everywhere — used to
 * isolate the LOD split distance from terrain relief: refinement depth
 * underfoot must not depend on how tall the ground under the camera is. */
function fakeConstantElevationSim(elevM: number): Sim {
  const sim = fakeSim();
  return {
    ...sim,
    bodyElevation: () => elevM,
    bodyElevations: (_: number, coords: Float64Array) => {
      const out = new Float32Array(coords.length / 2);
      out.fill(elevM);
      return out;
    },
  };
}

describe('buildTerrainGlobe', () => {
  const anchorBody = golden.stars.length + golden.anchor_planet;
  const suns = [{ dirLocal: [0, 0, 1] as [number, number, number], temperatureK: 5800, irradiance: 1 }];

  it('returns null for non-terrain bodies (stars)', () => {
    expect(buildTerrainGlobe(fakeSim(), 0)).toBeNull();
  });

  it('builds tiles over successive updates and renders them', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    expect(g).not.toBeNull();
    for (let f = 0; f < 40; f++) g.update(15, 30, 0, 252, suns, 8);
    const s = g.stats();
    expect(s.built).toBeGreaterThan(20);
    let visibleMeshes = 0;
    g.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh && o.visible) visibleMeshes++; });
    expect(visibleMeshes).toBeGreaterThan(5);
  });

  it('keeps rendered tile positions camera-relative (no planet-scale magnitudes)', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 0, 252, suns, 8);
    // the nearest visible tile must sit within ~2 tile-lengths of the origin
    let nearest = Infinity;
    g.scene.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh && o.visible) nearest = Math.min(nearest, o.position.length());
    });
    expect(nearest).toBeLessThan(50_000);
    expect(nearest).toBeGreaterThan(0);
  });

  it('disposes all tile geometries and clears the scene on dispose()', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 0, 252, suns, 8);

    const meshesBefore: THREE.Mesh[] = [];
    g.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) meshesBefore.push(o as THREE.Mesh); });
    expect(meshesBefore.length).toBeGreaterThan(20);

    // spy on one geometry's dispose to confirm dispose() actually reaches it
    const sample = meshesBefore[0]!.geometry;
    let disposed = false;
    const originalDispose = sample.dispose.bind(sample);
    sample.dispose = () => { disposed = true; originalDispose(); };

    g.dispose();

    expect(disposed).toBe(true);
    let meshesAfter = 0;
    g.scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) meshesAfter++; });
    expect(meshesAfter).toBe(0);
  });

  it('ocean worlds get translucent water meshes on tiles that dip below sea level', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(-30, 30, 0, 252, suns, 8); // southern hemisphere: elevations < 0
    const water: THREE.Mesh[] = [];
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).transparent) water.push(m);
    });
    expect(water.length).toBeGreaterThan(0);
    // water sits at sea level: vertex radius ≈ R (position + origin round-trip)
  });

  it('dry worlds get no water meshes', () => {
    const sim = fakeSim();
    const dry = { ...sim, bodyTerrainInfo: (i: number) => (i === 0 ? null : { sea_level: 0, ocean_fraction: 0, relief_m: 6000, plate_count: 8 }) };
    const g = buildTerrainGlobe(dry as Sim, anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(-30, 30, 0, 252, suns, 8);
    let transparent = 0;
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).transparent) transparent++;
    });
    expect(transparent).toBe(0);
  });

  it('dispose also removes water meshes', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(-30, 30, 0, 252, suns, 8);
    g.dispose();
    let meshes = 0;
    g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
    expect(meshes).toBe(0);
  });

  it('has sun lights that fade below the horizon (ground darkens at night)', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    const intensityTotal = () => {
      let total = 0;
      g.scene.traverse((o) => {
        const l = o as { isDirectionalLight?: boolean; intensity?: number };
        if (l.isDirectionalLight) total += l.intensity ?? 0;
      });
      return total;
    };
    g.update(15, 30, 0, 252, [{ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }]);
    const day = intensityTotal();
    g.update(15, 30, 0, 252, [{ dirLocal: [0, 0, -0.5], temperatureK: 5800, irradiance: 1 }]);
    const night = intensityTotal();
    expect(day).toBeGreaterThan(0.5);
    expect(night).toBe(0);
  });

  it('fog density scales with atmosphere and fades with altitude; airless = no fog', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    g.update(15, 30, 0, 252, suns, 2, 1.0, 1.0);
    const fogLow = (g.scene.fog as THREE.FogExp2).density;
    expect(fogLow).toBeGreaterThan(0);
    g.update(15, 30, 0, 100_000, suns, 2, 1.0, 1.0);
    const fogHigh = (g.scene.fog as THREE.FogExp2).density;
    expect(fogHigh).toBeLessThan(fogLow / 100);
    g.update(15, 30, 0, 252, suns, 2, 0.0, 1.0);
    expect((g.scene.fog as THREE.FogExp2).density).toBe(0);
  });

  it('grid vertex normals point outward (no dark seams from skirt-face pollution)', () => {
    const g = buildTerrainGlobe(fakeFlatSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 0, 252, suns, 8);

    let mesh: THREE.Mesh | undefined;
    g.scene.traverse((o) => {
      if (!mesh && (o as { isMesh?: boolean }).isMesh && o.visible) mesh = o as THREE.Mesh;
    });
    expect(mesh).toBeDefined();

    const originBf = mesh!.userData.originBf as [number, number, number];
    const positions = mesh!.geometry.getAttribute('position');
    const normals = mesh!.geometry.getAttribute('normal');
    expect(normals).toBeDefined();

    const gridCount = (TILE_QUADS + 1) * (TILE_QUADS + 1);
    let minDot = Infinity;
    for (let i = 0; i < gridCount; i++) {
      const px = originBf[0] + positions.getX(i);
      const py = originBf[1] + positions.getY(i);
      const pz = originBf[2] + positions.getZ(i);
      const len = Math.hypot(px, py, pz);
      const ox = px / len, oy = py / len, oz = pz / len;
      const nx = normals.getX(i), ny = normals.getY(i), nz = normals.getZ(i);
      const nlen = Math.hypot(nx, ny, nz);
      const dot = (nx * ox + ny * oy + nz * oz) / nlen;
      minDot = Math.min(minDot, dot);
    }
    expect(minDot).toBeGreaterThan(0.95);
  });

  it('standing on high terrain refines to the same depth as standing at sea level', () => {
    const aboveTerrainM = 2; // eye height, identical in both cases
    const flat = buildTerrainGlobe(fakeConstantElevationSim(0), anchorBody)!;
    const high = buildTerrainGlobe(fakeConstantElevationSim(2000), anchorBody)!;
    for (let f = 0; f < 200; f++) {
      flat.update(15, 30, 0, aboveTerrainM, suns, 40);
      high.update(15, 30, 2000, aboveTerrainM, suns, 40);
    }
    // LOD refinement depth underfoot must depend only on height above the
    // LOCAL terrain, not on the terrain's elevation above sea level —
    // standing on a 2000 m peak at eye height 2 m must refine exactly as
    // deep as standing at sea level at eye height 2 m.
    expect(high.stats().deepestBuilt).toBe(flat.stats().deepestBuilt);
  });

  it('terrain tiles carry aParentPos and a per-tile morph uniform', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 252, 2, suns, 8);
    let checked = 0;
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible || (m.material as THREE.Material).transparent) return;
      expect(m.geometry.getAttribute('aParentPos')).toBeTruthy();
      expect(m.userData.uMorph).toBeTruthy();
      checked++;
    });
    expect(checked).toBeGreaterThan(3);
  });

  it('uMorph rises with distance: far tiles morph toward the parent shape', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 60; f++) g.update(15, 30, 252, 2, suns, 8);
    const morphs: number[] = [];
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.userData.uMorph) morphs.push(m.userData.uMorph.value as number);
    });
    expect(Math.max(...morphs)).toBeGreaterThan(0.5); // outer-band tiles well into their morph
    expect(Math.min(...morphs)).toBeLessThan(0.5); // underfoot tiles barely morphed
  });

  it('reliefScale=3 raises the rendered surface but not water', () => {
    const ref = bodyLayout(golden)[anchorBody]!;
    const R = ref.kind === 'star' ? 0 : bodyRadiusM(golden, ref);

    // Constant +1000 m elevation everywhere (an ocean world, but never
    // dipping below sea level here): isolates the vertical-scale check on
    // dry terrain from the water path.
    const land = buildTerrainGlobe(fakeConstantElevationSim(1000), anchorBody, 3)!;
    for (let f = 0; f < 40; f++) land.update(15, 30, 1000, 2, suns, 8);
    let terrainMesh: THREE.Mesh | undefined;
    land.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!terrainMesh && m.isMesh && m.visible) terrainMesh = m;
    });
    expect(terrainMesh).toBeDefined();
    const to = terrainMesh!.userData.originBf as [number, number, number];
    const tp = terrainMesh!.geometry.getAttribute('position');
    const tx = to[0] + tp.getX(0), ty = to[1] + tp.getY(0), tz = to[2] + tp.getZ(0);
    const terrainRadius = Math.hypot(tx, ty, tz);
    expect(Math.abs(terrainRadius - (R + 3000))).toBeLessThan(1); // R + 1000 elevM * 3 reliefScale

    // Same ocean world, queried where elevation dips below sea level (the
    // scenario the existing "ocean worlds get translucent water meshes"
    // test already exercises): water is built flat at sea level regardless
    // of reliefScale, so its vertex radius must stay ≈ R.
    const ocean = buildTerrainGlobe(fakeSim(), anchorBody, 3)!;
    for (let f = 0; f < 40; f++) ocean.update(-30, 30, 0, 252, suns, 8);
    let waterMesh: THREE.Mesh | undefined;
    ocean.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!waterMesh && m.isMesh && m.visible && (m.material as THREE.Material).transparent) waterMesh = m;
    });
    expect(waterMesh).toBeDefined();
    const wo = waterMesh!.userData.originBf as [number, number, number];
    const wp = waterMesh!.geometry.getAttribute('position');
    const wx = wo[0] + wp.getX(0), wy = wo[1] + wp.getY(0), wz = wo[2] + wp.getZ(0);
    const waterRadius = Math.hypot(wx, wy, wz);
    expect(Math.abs(waterRadius - R)).toBeLessThan(1);
  });
});
