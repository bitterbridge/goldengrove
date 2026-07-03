import { SCHEMA_VERSION, type SystemDescriptor } from './types';

function fail(path: string, why: string): never {
  throw new Error(`descriptor validation failed at ${path}: ${why}`);
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected finite number, got ${JSON.stringify(v)}`);
  return v;
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected object');
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected array');
  return v;
}

function orbit(v: unknown, path: string): void {
  const o = obj(v, path);
  for (const k of ['semi_major_axis_m', 'eccentricity', 'inclination_rad', 'raan_rad', 'arg_periapsis_rad', 'mean_anomaly_epoch_rad']) {
    num(o[k], `${path}.${k}`);
  }
}

/**
 * Structural validation of the Rust-side JSON: the cross-boundary contract
 * test. Checks shape and the fields the renderer relies on; trusts numeric
 * plausibility to the Rust test suite.
 */
export function parseDescriptor(json: string): SystemDescriptor {
  const d = obj(JSON.parse(json), '$');
  if (d.schema_version !== SCHEMA_VERSION) {
    fail('$.schema_version', `expected ${SCHEMA_VERSION}, got ${JSON.stringify(d.schema_version)}`);
  }
  if (typeof d.seed !== 'string' || !/^\d+$/.test(d.seed)) fail('$.seed', 'expected decimal string');
  num(d.age_s, '$.age_s');
  if (d.planet_host !== 'Barycenter' && d.planet_host !== 'Primary') fail('$.planet_host', 'bad variant');

  const stars = arr(d.stars, '$.stars');
  if (stars.length === 0) fail('$.stars', 'empty');
  stars.forEach((s, i) => {
    const o = obj(s, `stars[${i}]`);
    for (const k of ['mass_kg', 'radius_m', 'luminosity_w', 'temperature_k']) num(o[k], `stars[${i}].${k}`);
    if (o.orbit !== null && o.orbit !== undefined) orbit(o.orbit, `stars[${i}].orbit`);
  });

  const planets = arr(d.planets, '$.planets');
  if (planets.length === 0) fail('$.planets', 'empty');
  planets.forEach((p, i) => {
    const o = obj(p, `planets[${i}]`);
    if (o.class !== 'Rocky' && o.class !== 'IceGiant' && o.class !== 'GasGiant') fail(`planets[${i}].class`, 'bad variant');
    for (const k of ['mass_kg', 'radius_m', 'rotation_period_s', 'axial_tilt_rad']) num(o[k], `planets[${i}].${k}`);
    orbit(o.orbit, `planets[${i}].orbit`);
    const state = obj(o.state, `planets[${i}].state`);
    if (state.kind !== 'Living' && state.kind !== 'Dead' && state.kind !== 'Doomed') fail(`planets[${i}].state.kind`, 'bad variant');
    if (state.kind === 'Doomed') num(state.doom_time_s, `planets[${i}].state.doom_time_s`);
    arr(o.moons, `planets[${i}].moons`).forEach((m, j) => {
      const mo = obj(m, `planets[${i}].moons[${j}]`);
      for (const k of ['mass_kg', 'radius_m', 'rotation_period_s']) num(mo[k], `planets[${i}].moons[${j}].${k}`);
      orbit(mo.orbit, `planets[${i}].moons[${j}].orbit`);
    });
    if (o.calendar !== null && o.calendar !== undefined) {
      const c = obj(o.calendar, `planets[${i}].calendar`);
      num(c.solar_day_s, `planets[${i}].calendar.solar_day_s`);
      num(c.year_solar_days, `planets[${i}].calendar.year_solar_days`);
      arr(c.months, `planets[${i}].calendar.months`);
    }
  });

  const anchor = num(d.anchor_planet, '$.anchor_planet');
  if (anchor < 0 || anchor >= planets.length) fail('$.anchor_planet', 'index out of range');
  const anchorCal = (planets[anchor] as Record<string, unknown>).calendar;
  if (anchorCal === null || anchorCal === undefined) fail(`planets[${anchor}].calendar`, 'anchor must have a calendar');

  return d as unknown as SystemDescriptor;
}
