import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { bodyLayout, bodyName, bodyRadiusM, isTidallyLocked, type BodyRef } from '../sim/layout';
import type { Sim } from '../sim/wasm';
import { worldToLocal, type ObserverFrame } from './observer';
import { temperatureToColor } from './color';
import { proceduralBodyTexture } from './texture';
import { getTerrainTexture } from './terrainCache';

export interface LocalBodies {
  group: THREE.Group; // caller adds to the local-space (terrain) scene
  labels: CSS2DObject[]; // for the view-switch hide lifecycle
  /** observerWorldM: observer eye in WORLD meters (f64). frame: ENU basis. */
  update(
    states: Float64Array,
    observerWorldM: [number, number, number],
    frame: ObserverFrame,
    standingBody: number,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): void;
  dispose(): void;
}

const PALETTE = { Rocky: 0x9b8f7a, IceGiant: 0x7ec8e3, GasGiant: 0xd8b27a } as const;
const DOT_FLOOR_PX = 2; // below this apparent radius, the mesh yields to a dot
const DOT_TARGET_PX = 4; // dot sprite is sized to hold roughly this many pixels
const GLOW_TARGET_PX = 24; // star glow halo floor, in screen pixels
const STAR_LIGHT_DISTANCE = 100; // arbitrary; only direction matters (default target is the ENU origin)

interface StarLight {
  light: THREE.DirectionalLight;
  temperatureK: number;
}

/** Every non-standing body at TRUE position and scale, camera-relative in the
 * observer's ENU frame. Lifted from ground.ts's dome block (materials,
 * textures, labels, lock badges, rotation) — that block moves here in full;
 * ground.ts loses it once this view replaces the fixed-dome sky for local
 * (terrain) rendering. New here: true-distance placement, a sub-pixel dot
 * floor so far bodies don't vanish, and per-star lights that are never
 * gated by horizon/altitude (a moon still needs to be lit at night). */
export function buildLocalBodies(sim: Sim): LocalBodies {
  const desc = sim.descriptor;
  const layout = bodyLayout(desc);
  const group = new THREE.Group();
  group.name = 'local-bodies';

  const unitSphere = new THREE.SphereGeometry(1, 24, 16);
  const meshes: THREE.Mesh[] = [];
  const dots: THREE.Sprite[] = [];
  const glows: (THREE.Sprite | null)[] = [];
  const lights: (StarLight | null)[] = [];
  const radii: number[] = [];
  const labels: CSS2DObject[] = [];

  layout.forEach((ref: BodyRef, i: number) => {
    const isStar = ref.kind === 'star';
    let material: THREE.Material;
    let colorHex: THREE.ColorRepresentation;

    if (isStar) {
      const [r, g, b] = temperatureToColor(desc.stars[ref.star]!.temperature_k);
      colorHex = new THREE.Color(r, g, b);
      material = new THREE.MeshBasicMaterial({ color: colorHex });
    } else {
      const baseHex = ref.kind === 'planet' ? PALETTE[desc.planets[ref.planet]!.class] : 0x8a8f98;
      const tex = getTerrainTexture(sim, i) ?? proceduralBodyTexture(sim.seed, i, baseHex);
      material = new THREE.MeshStandardMaterial(tex ? { map: tex, roughness: 1 } : { color: baseHex, roughness: 1 });
      colorHex = baseHex;
    }

    const mesh = new THREE.Mesh(unitSphere, material);
    mesh.name = `local-body-${i}`;
    mesh.frustumCulled = false; // huge camera-relative positions confuse three's culler (log-depth scenes)
    mesh.userData.bodyIndex = i;
    group.add(mesh);
    meshes.push(mesh);
    radii.push(bodyRadiusM(desc, ref));

    const dotMat = new THREE.SpriteMaterial({ color: colorHex, transparent: true, opacity: 0.9, depthWrite: false });
    const dot = new THREE.Sprite(dotMat);
    dot.name = `local-dot-${i}`;
    dot.frustumCulled = false;
    dot.userData.bodyIndex = i;
    dot.userData.isDot = true;
    group.add(dot);
    dots.push(dot);

    if (isStar) {
      const glowMat = new THREE.SpriteMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.name = `local-glow-${i}`;
      glow.frustumCulled = false;
      glow.userData.bodyIndex = i;
      glow.userData.isGlow = true;
      group.add(glow);
      glows.push(glow);

      const light = new THREE.DirectionalLight(colorHex, 0);
      light.name = `local-sunlight-${i}`;
      light.userData.bodyIndex = i;
      group.add(light);
      lights.push({ light, temperatureK: desc.stars[ref.star]!.temperature_k });
    } else {
      glows.push(null);
      lights.push(null);
    }

    const div = document.createElement('div');
    div.className = 'body-label';
    div.textContent = bodyName(desc, i);
    if (isTidallyLocked(desc, ref)) {
      div.textContent += ' 🔒';
      div.title = 'tidally locked';
    }
    const label = new CSS2DObject(div);
    label.userData.bodyIndex = i;
    mesh.add(label);
    labels.push(label);
  });

  function update(
    states: Float64Array,
    observerWorldM: [number, number, number],
    frame: ObserverFrame,
    standingBody: number,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): void {
    const fovYrad = (camera.fov * Math.PI) / 180;
    const pxPerRad = viewportHeightPx / fovYrad;
    const starIrradiance: { star: StarLight; dirEnu: [number, number, number]; irr: number }[] = [];

    layout.forEach((ref: BodyRef, i: number) => {
      const mesh = meshes[i]!;
      const dot = dots[i]!;
      const label = labels[i]!;
      const glow = glows[i];
      const star = lights[i];

      if (i === standingBody) {
        mesh.visible = false;
        dot.visible = false;
        label.visible = false;
        if (glow) glow.visible = false;
        return;
      }

      // f64 discipline: rel/dist/ENU components stay plain numbers until the
      // final .set() onto a (f32) Vector3 — these positions are astronomical
      // in scale and lose precision the moment they touch three's f32 math.
      const relX = states[i * 7]! - observerWorldM[0];
      const relY = states[i * 7 + 1]! - observerWorldM[1];
      const relZ = states[i * 7 + 2]! - observerWorldM[2];
      const dist = Math.hypot(relX, relY, relZ);
      const ux = relX / dist;
      const uy = relY / dist;
      const uz = relZ / dist;
      const [ex, ey, ez] = worldToLocal([ux, uy, uz], frame);
      const posX = ex * dist;
      const posY = ey * dist;
      const posZ = ez * dist;

      mesh.position.set(posX, posY, posZ);
      dot.position.set(posX, posY, posZ);
      if (glow) glow.position.set(posX, posY, posZ);

      const radiusM = radii[i]!;
      mesh.scale.setScalar(radiusM);
      const axis = new THREE.Vector3(states[i * 7 + 3]!, states[i * 7 + 4]!, states[i * 7 + 5]!);
      if (axis.lengthSq() > 1e-12) {
        mesh.setRotationFromAxisAngle(axis.normalize(), states[i * 7 + 6]!);
      }

      const angularRadiusRad = Math.asin(Math.min(1, radiusM / dist));
      const angularRadiusPx = angularRadiusRad * pxPerRad;
      const showMesh = angularRadiusPx >= DOT_FLOOR_PX;
      mesh.visible = showMesh;
      dot.visible = !showMesh;
      const dotSize = dist * (DOT_TARGET_PX / pxPerRad);
      dot.scale.set(dotSize, dotSize, 1);
      label.visible = ref.kind !== 'star';

      if (glow) {
        glow.visible = true; // always-on, never gated by apparent size or horizon
        const glowSize = Math.max(dist * (GLOW_TARGET_PX / pxPerRad), radiusM * 2.4);
        glow.scale.set(glowSize, glowSize, 1);
      }

      if (star && ref.kind === 'star') {
        const luminosityW = desc.stars[ref.star]!.luminosity_w;
        const irr = luminosityW / (dist * dist);
        starIrradiance.push({ star, dirEnu: [ex, ey, ez], irr });
      }
    });

    // Never gated by altitude/horizon: a moon at night still needs sunlight.
    const maxIrr = starIrradiance.reduce((m, s) => Math.max(m, s.irr), 0);
    starIrradiance.forEach(({ star, dirEnu, irr }) => {
      star.light.intensity = maxIrr > 0 ? 2.0 * (irr / maxIrr) : 0;
      star.light.position.set(dirEnu[0] * STAR_LIGHT_DISTANCE, dirEnu[1] * STAR_LIGHT_DISTANCE, dirEnu[2] * STAR_LIGHT_DISTANCE);
      const [r, g, b] = temperatureToColor(star.temperatureK);
      star.light.color.setRGB(r, g, b);
    });
  }

  function dispose(): void {
    layout.forEach((_ref: BodyRef, i: number) => {
      const mesh = meshes[i]!;
      const dot = dots[i]!;
      const glow = glows[i];
      const star = lights[i];
      (mesh.material as THREE.Material).dispose();
      (dot.material as THREE.SpriteMaterial).dispose();
      group.remove(mesh);
      group.remove(dot);
      if (glow) {
        (glow.material as THREE.SpriteMaterial).dispose();
        group.remove(glow);
      }
      if (star) group.remove(star.light);
    });
    unitSphere.dispose();
  }

  return { group, labels, update, dispose };
}
