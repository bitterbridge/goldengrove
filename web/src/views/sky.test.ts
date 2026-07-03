import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildSkyDome } from './sky';

describe('buildSkyDome', () => {
  it('exposes normalized sun uniforms and counts', () => {
    const sky = buildSkyDome();
    sky.setSuns([
      { dirLocal: [0, 0, 2], temperatureK: 5800, irradiance: 1 }, // non-unit on purpose
      { dirLocal: [1, 0, 0], temperatureK: 3200, irradiance: 0.2 },
    ]);
    const u = (sky.mesh.material as THREE.ShaderMaterial).uniforms;
    expect(u.sunCount!.value).toBe(2);
    const d0 = u.sunDirs!.value[0];
    expect(Math.hypot(d0.x, d0.y, d0.z)).toBeCloseTo(1, 6);
    expect(d0.z).toBeCloseTo(1, 6);
  });
  it('caps at 3 suns and clamps density', () => {
    const sky = buildSkyDome();
    sky.setSuns(new Array(5).fill({ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }));
    const u = (sky.mesh.material as THREE.ShaderMaterial).uniforms;
    expect(u.sunCount!.value).toBe(3);
    sky.setDensity(7);
    expect(u.density!.value).toBe(1);
  });
  it('dayFactor: 1 at high noon, 0 at deep night, between at twilight', () => {
    const sky = buildSkyDome();
    sky.setDensity(1);
    sky.setSuns([{ dirLocal: [0, 0, 1], temperatureK: 5800, irradiance: 1 }]);
    expect(sky.dayFactor()).toBeCloseTo(1, 6);
    sky.setSuns([{ dirLocal: [0, 0, -1], temperatureK: 5800, irradiance: 1 }]);
    expect(sky.dayFactor()).toBeCloseTo(0, 6);
    sky.setSuns([{ dirLocal: [1, 0, 0], temperatureK: 5800, irradiance: 1 }]); // sun ON the horizon
    expect(sky.dayFactor()).toBeGreaterThan(0.3);
    expect(sky.dayFactor()).toBeLessThan(0.7);
  });
});
