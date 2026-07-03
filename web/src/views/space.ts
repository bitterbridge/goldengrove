import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { bodyLayout, bodyName, bodyRadiusM, parentIndex, type BodyRef } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { compressPosition, displayRadius, moonViewFactor } from './compression';
import { temperatureToColor } from './color';

const ORBIT_SEGMENTS = 128;
const PATH_REFRESH_S = 3.156e8; // ~10 Earth years: far below secular timescales, cheap to refresh

export interface SpaceView {
  scene: THREE.Scene;
  bodies: THREE.Mesh[];
  labels: CSS2DObject[];
  update(states: Float64Array, trueScale: boolean, originM: Float64Array, tS: number): void;
  bodyIndexOf(object: THREE.Object3D): number | null;
  hostOriginView(): [number, number, number];
}

interface BodyMeta {
  ref: BodyRef;
  radiusM: number;
  parent: number | null;
  moonFactor: number; // view units per meter of moon-orbit offset (moons only)
  orbitLine: THREE.LineLoop | null;
}

export function buildSpaceScene(sim: Sim): SpaceView {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0x223044, 2.0));
  const layout = bodyLayout(sim.descriptor);
  const unitSphere = new THREE.SphereGeometry(1, 24, 16);
  const orbitGroup = new THREE.Group();
  orbitGroup.name = 'orbit-lines';
  scene.add(orbitGroup);

  const bodies: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  const meta: BodyMeta[] = [];
  const indexByMesh = new Map<THREE.Object3D, number>();

  layout.forEach((ref, i) => {
    let material: THREE.Material;
    if (ref.kind === 'star') {
      const [r, g, b] = temperatureToColor(sim.descriptor.stars[ref.star]!.temperature_k);
      material = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
      const light = new THREE.PointLight(new THREE.Color(r, g, b), 3, 0, 0.15);
      scene.add(light); // repositioned in update() via the mesh (see below)
      light.userData.followsBody = i;
    } else {
      const palette = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
      const color = ref.kind === 'planet' ? palette[sim.descriptor.planets[ref.planet]!.class] : 0x8a8f98;
      material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    }
    const mesh = new THREE.Mesh(unitSphere, material);
    mesh.name = `body-${i}`;
    scene.add(mesh);
    bodies.push(mesh);
    indexByMesh.set(mesh, i);

    const div = document.createElement('div');
    div.className = 'body-label';
    div.textContent = bodyName(sim.descriptor, i);
    const label = new CSS2DObject(div);
    mesh.add(label);
    labels.push(label);

    const parent = parentIndex(layout, sim.descriptor, i);
    const moonA = ref.kind === 'moon' ? sim.descriptor.planets[ref.planet]!.moons[ref.moon]!.orbit.semi_major_axis_m : 0;
    const m: BodyMeta = {
      ref,
      radiusM: bodyRadiusM(sim.descriptor, ref),
      parent,
      moonFactor: ref.kind === 'moon' ? moonViewFactor(moonA, false) : 0,
      orbitLine: null,
    };

    const path = sim.orbitPath(i, ORBIT_SEGMENTS, 0);
    if (path.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(path.length), 3));
      const line = new THREE.LineLoop(
        geo,
        new THREE.LineBasicMaterial({ color: 0x2a3a5a, transparent: true, opacity: 0.7 }),
      );
      line.name = `orbit-${i}`;
      line.userData.rawPath = path;
      line.userData.pathEpoch = 0;
      line.userData.bodyIndex = i;
      orbitGroup.add(line);
      m.orbitLine = line;
    }
    meta.push(m);
  });

  function writeOrbitLine(m: BodyMeta, trueScale: boolean): void {
    const line = m.orbitLine;
    if (!line) return;
    const raw = line.userData.rawPath as Float64Array;
    const attr = (line.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < raw.length / 3; k++) {
      let x: number, y: number, z: number;
      if (m.ref.kind === 'moon') {
        const f = trueScale ? moonViewFactor(0, true) : m.moonFactor;
        [x, y, z] = [raw[k * 3]! * f, raw[k * 3 + 1]! * f, raw[k * 3 + 2]! * f];
      } else {
        // Planet paths are already host-relative; the line object itself
        // rides originView (set every frame in update()).
        [x, y, z] = compressPosition(raw[k * 3]!, raw[k * 3 + 1]!, raw[k * 3 + 2]!, trueScale);
      }
      attr.setXYZ(k, x, y, z);
    }
    attr.needsUpdate = true;
  }

  let lastTrueScale: boolean | null = null;
  let lastOriginView: [number, number, number] = [0, 0, 0];

  function update(states: Float64Array, trueScale: boolean, originM: Float64Array, tS: number): void {
    meta.forEach((m) => {
      const line = m.orbitLine;
      if (!line) return;
      if (Math.abs(tS - (line.userData.pathEpoch as number)) > PATH_REFRESH_S) {
        line.userData.rawPath = sim.orbitPath(line.userData.bodyIndex as number, ORBIT_SEGMENTS, tS);
        line.userData.pathEpoch = tS;
        writeOrbitLine(m, lastTrueScale ?? false);
      }
    });
    const rescale = trueScale !== lastTrueScale;
    lastTrueScale = trueScale;
    // Host-origin-centric compression: compress each body's OFFSET from the
    // host origin, then translate by the compressed origin. Systems
    // displaced from the world origin (trinary recoil) keep their local
    // structure readable instead of being crushed by the asinh slope out
    // there. For originM ≈ 0 and for true scale (linear, additive) this
    // matches the old absolute behavior exactly.
    const originView = compressPosition(originM[0]!, originM[1]!, originM[2]!, trueScale);
    lastOriginView = originView;
    // planets/stars first so moon parents are already placed
    meta.forEach((m, i) => {
      if (m.ref.kind === 'moon') return;
      const [x, y, z] = compressPosition(
        states[i * 7]! - originM[0]!,
        states[i * 7 + 1]! - originM[1]!,
        states[i * 7 + 2]! - originM[2]!,
        trueScale,
      );
      bodies[i]!.position.set(originView[0] + x, originView[1] + y, originView[2] + z);
      applyCommon(m, i, states, trueScale);
      if (m.orbitLine) {
        m.orbitLine.position.set(originView[0], originView[1], originView[2]);
        if (rescale) writeOrbitLine(m, trueScale);
      }
    });
    meta.forEach((m, i) => {
      if (m.ref.kind !== 'moon') return;
      const p = m.parent!;
      const f = trueScale ? moonViewFactor(0, true) : m.moonFactor;
      const dx = states[i * 7]! - states[p * 7]!;
      const dy = states[i * 7 + 1]! - states[p * 7 + 1]!;
      const dz = states[i * 7 + 2]! - states[p * 7 + 2]!;
      bodies[i]!.position.set(
        bodies[p]!.position.x + dx * f,
        bodies[p]!.position.y + dy * f,
        bodies[p]!.position.z + dz * f,
      );
      applyCommon(m, i, states, trueScale);
      if (m.orbitLine) m.orbitLine.position.copy(bodies[p]!.position);
      if (rescale) writeOrbitLine(m, trueScale);
    });
    // star lights follow their star
    scene.traverse((o) => {
      const follows = o.userData.followsBody as number | undefined;
      if (follows !== undefined) o.position.copy(bodies[follows]!.position);
    });
  }

  function applyCommon(m: BodyMeta, i: number, states: Float64Array, trueScale: boolean): void {
    const r = displayRadius(m.ref.kind, m.radiusM, trueScale);
    bodies[i]!.scale.setScalar(Math.max(r, 1e-6));
    const axis = new THREE.Vector3(states[i * 7 + 3]!, states[i * 7 + 4]!, states[i * 7 + 5]!).normalize();
    bodies[i]!.setRotationFromAxisAngle(axis, states[i * 7 + 6]!);
  }

  return {
    scene,
    bodies,
    labels,
    update,
    bodyIndexOf: (o) => indexByMesh.get(o) ?? null,
    hostOriginView: () => [...lastOriginView] as [number, number, number],
  };
}
