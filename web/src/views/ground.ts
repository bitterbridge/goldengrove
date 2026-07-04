import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { atmosphereDensityFor, bodyLayout, bodyName, isTidallyLocked } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { observerFrame, skyBodies, type SkyBody } from './observer';
import { buildSkyDome, type SunSpec } from './sky';
import { buildStarfield } from './starfield';
import { temperatureToColor } from './color';
import { proceduralBodyTexture } from './texture';
import { getTerrainTexture } from './terrainCache';

export interface Standing { body: number; latDeg: number; lonDeg: number }

export interface GroundView {
  scene: THREE.Scene;
  bodies: THREE.Mesh[];
  labels: CSS2DObject[];
  update(states: Float64Array, standing: Standing, altitudeM?: number): SunSpec[];
  dayFactor(): number;
  setDiscVisible(v: boolean): void;
}

const DOME_NEAR = 850;
const DOME_FAR = 950;
const MIN_APPARENT_RAD = 0.0025; // planets-as-dots floor; suns/moons stay true
const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;

export function buildGroundScene(sim: Sim): GroundView {
  const scene = new THREE.Scene();
  const desc = sim.descriptor;
  const layout = bodyLayout(desc);

  const stars = buildStarfield(sim.seed);
  stars.name = 'starfield';
  scene.add(stars);

  const sky = buildSkyDome();
  sky.mesh.name = 'skydome';
  scene.add(sky.mesh);

  const groundMat = new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.DoubleSide });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(3000, 48), groundMat);
  ground.name = 'ground-disc';
  ground.position.z = -2;
  ground.renderOrder = 2;
  scene.add(ground);

  scene.add(new THREE.AmbientLight(0x334455, 0.35));
  const sunLights = [new THREE.DirectionalLight(0xffffff, 0), new THREE.DirectionalLight(0xffffff, 0)];
  sunLights.forEach((l) => scene.add(l));

  const unit = new THREE.SphereGeometry(1, 24, 16);
  const bodies: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  const indexOf: number[] = []; // mesh slot -> body index (filled per update since standing changes)

  // One mesh per layout entry; the stood-on body's mesh is hidden each frame.
  layout.forEach((ref, i) => {
    let mat: THREE.Material;
    if (ref.kind === 'star') {
      const [r, g, b] = temperatureToColor(desc.stars[ref.star]!.temperature_k);
      mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
    } else {
      const baseHex = ref.kind === 'planet' ? PALETTE[desc.planets[ref.planet]!.class] : 0x8a8f98;
      const tex = getTerrainTexture(sim, i) ?? proceduralBodyTexture(sim.seed, i, baseHex);
      mat = new THREE.MeshStandardMaterial(tex ? { map: tex, roughness: 1 } : { color: baseHex, roughness: 1 });
    }
    const mesh = new THREE.Mesh(unit, mat);
    mesh.name = `sky-body-${i}`;
    scene.add(mesh);
    const div = document.createElement('div');
    div.className = 'body-label';
    div.textContent = bodyName(desc, i);
    if (isTidallyLocked(desc, ref)) {
      div.textContent += ' 🔒';
      div.title = 'tidally locked';
    }
    const label = new CSS2DObject(div);
    mesh.add(label);
    bodies.push(mesh);
    labels.push(label);
    indexOf.push(i);
  });

  const starQuat = new THREE.Quaternion();
  const basis = new THREE.Matrix4();

  function setDiscVisible(v: boolean): void {
    ground.visible = v;
  }

  function update(states: Float64Array, standing: Standing, altitudeM = 0): SunSpec[] {
    const frame = observerFrame(states, desc, standing.body, standing.latDeg, standing.lonDeg);
    const visible: SkyBody[] = skyBodies(states, desc, standing.body, frame);

    // world→local rotation for the starfield (rows = east/north/up)
    basis.makeBasis(
      new THREE.Vector3(...frame.east),
      new THREE.Vector3(...frame.north),
      new THREE.Vector3(...frame.up),
    ).transpose();
    starQuat.setFromRotationMatrix(basis);
    stars.quaternion.copy(starQuat);

    // rank by true distance → dome distance (nearest occludes: real eclipses)
    const ranked = [...visible].sort((a, b) => a.distM - b.distM);
    const domeDist = new Map<number, number>();
    ranked.forEach((b, r) => {
      domeDist.set(b.index, ranked.length === 1 ? DOME_NEAR : DOME_NEAR + ((DOME_FAR - DOME_NEAR) * r) / (ranked.length - 1));
    });

    const byIndex = new Map(visible.map((b) => [b.index, b]));
    const suns: SunSpec[] = [];
    let maxIrr = 0;
    for (const b of visible) {
      const ref = layout[b.index]!;
      if (ref.kind !== 'star') continue;
      const st = desc.stars[ref.star]!;
      const irr = st.luminosity_w / (b.distM * b.distM);
      maxIrr = Math.max(maxIrr, irr);
      suns.push({ dirLocal: b.dirLocal, temperatureK: st.temperature_k, irradiance: irr });
    }
    suns.forEach((s) => { s.irradiance = maxIrr > 0 ? s.irradiance / maxIrr : 0; });
    suns.sort((a, b) => b.irradiance - a.irradiance);
    sky.setSuns(suns);
    // Karman-line falloff: same scale height (H = 8500 m) as terrain fog.
    sky.setDensity(atmosphereDensityFor(desc, layout[standing.body]!) * Math.exp(-altitudeM / 8500));

    // These lights only illuminate sky-body meshes (ground disc, stars, and
    // dome are all unlit materials), so they stay on even when the sun is
    // below the observer's horizon — a moon at night is still sunlit.
    sunLights.forEach((l, i) => {
      const s = suns[i];
      if (s) {
        l.intensity = 2.2 * s.irradiance;
        l.position.set(s.dirLocal[0] * 100, s.dirLocal[1] * 100, s.dirLocal[2] * 100);
        const [r, g, bb] = temperatureToColor(s.temperatureK);
        l.color.setRGB(r, g, bb);
      } else {
        l.intensity = 0;
      }
    });

    bodies.forEach((mesh, slot) => {
      const i = indexOf[slot]!;
      const b = byIndex.get(i);
      if (!b || i === standing.body) {
        mesh.visible = false;
        labels[slot]!.visible = false;
        return;
      }
      const d = domeDist.get(i)!;
      mesh.visible = b.altRad > -0.12;
      labels[slot]!.visible = mesh.visible && b.kind !== 'star';
      mesh.position.set(b.dirLocal[0] * d, b.dirLocal[1] * d, b.dirLocal[2] * d);
      const apparent = b.kind === 'planet' ? Math.max(b.angularRadiusRad, MIN_APPARENT_RAD) : b.angularRadiusRad;
      mesh.scale.setScalar(Math.max(d * Math.tan(apparent), 0.05));
      const axis = new THREE.Vector3(states[i * 7 + 3]!, states[i * 7 + 4]!, states[i * 7 + 5]!);
      if (axis.lengthSq() > 1e-12) {
        mesh.setRotationFromAxisAngle(axis.normalize(), states[i * 7 + 6]!);
      }
    });

    const day = sky.dayFactor();
    groundMat.color.setHex(0x14100c).lerp(new THREE.Color(0x6a5a48), day);
    return suns;
  }

  return { scene, bodies, labels, update, dayFactor: () => sky.dayFactor(), setDiscVisible };
}
