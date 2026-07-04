import * as THREE from 'three';
import { atmosphereDensityFor, bodyLayout } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { observerFrame, sunSpecs } from './observer';
import { buildSkyDome, type SunSpec } from './sky';
import { buildStarfield } from './starfield';

export interface Standing { body: number; latDeg: number; lonDeg: number }

export interface GroundView {
  scene: THREE.Scene;
  update(states: Float64Array, standing: Standing, altitudeM?: number): SunSpec[];
  dayFactor(): number;
  setDiscVisible(v: boolean): void;
}

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

  const starQuat = new THREE.Quaternion();
  const basis = new THREE.Matrix4();

  function setDiscVisible(v: boolean): void {
    ground.visible = v;
  }

  function update(states: Float64Array, standing: Standing, altitudeM = 0): SunSpec[] {
    const frame = observerFrame(states, desc, standing.body, standing.latDeg, standing.lonDeg);

    // world→local rotation for the starfield (rows = east/north/up)
    basis.makeBasis(
      new THREE.Vector3(...frame.east),
      new THREE.Vector3(...frame.north),
      new THREE.Vector3(...frame.up),
    ).transpose();
    starQuat.setFromRotationMatrix(basis);
    stars.quaternion.copy(starQuat);

    const suns = sunSpecs(states, desc, standing.body, frame);
    sky.setSuns(suns);
    // Karman-line falloff: same scale height (H = 8500 m) as terrain fog.
    sky.setDensity(atmosphereDensityFor(desc, layout[standing.body]!) * Math.exp(-altitudeM / 8500));

    const day = sky.dayFactor();
    groundMat.color.setHex(0x14100c).lerp(new THREE.Color(0x6a5a48), day);
    return suns;
  }

  return { scene, update, dayFactor: () => sky.dayFactor(), setDiscVisible };
}
