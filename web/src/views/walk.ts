/** Pure lat/lon stepping for camera-relative surface walking.
 *
 * Forward along azimuth `azRad` (0 = north, +east) moves (cos az, sin az / cos lat) · step.
 * Right (azRad + 90°) moves (−sin az, cos az / cos lat) · step.
 * dF/dR are signed forward/right contributions (e.g. -1/0/+1), combined linearly.
 * Latitude clamps to ±89° (never reaches the pole, where longitude is undefined).
 * Longitude wraps to (−180, 180].
 */
export function stepLatLon(
  latDeg: number,
  lonDeg: number,
  azRad: number,
  dF: number,
  dR: number,
  stepDeg: number,
): { latDeg: number; lonDeg: number } {
  const latRad = (latDeg * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(latRad), 0.05); // guard the pole singularity
  const dLat = stepDeg * (dF * Math.cos(azRad) - dR * Math.sin(azRad));
  const dLon = (stepDeg * (dF * Math.sin(azRad) + dR * Math.cos(azRad))) / cosLat;
  const newLatDeg = Math.min(89, Math.max(-89, latDeg + dLat));
  const newLonDeg = ((lonDeg + dLon + 540) % 360) - 180;
  return { latDeg: newLatDeg, lonDeg: newLonDeg };
}

/** Rotational coupling to the ground: 1 = carried with the planet's spin
 * (walking, low flight), fading to 0 (inertial hover — the planet turns
 * beneath you) between 5% and 50% of the body radius. */
export function decoupleWeight(altM: number, radiusM: number): number {
  const lo = 0.05 * radiusM;
  const hi = 0.5 * radiusM;
  const t = Math.min(1, Math.max(0, (altM - lo) / (hi - lo)));
  return 1 - t * t * (3 - 2 * t);
}

/** Signed longitude drift for one frame at altitude: while decoupled, the
 * planet spins east under a hovering observer, so their body-frame
 * longitude drifts WEST (negative for positive spin). Add to lonDeg. */
export function lonSlipDeg(altM: number, radiusM: number, spinRateRadPerS: number, dtS: number): number {
  const w = decoupleWeight(altM, radiusM);
  const result = (-(1 - w) * spinRateRadPerS * dtS * 180) / Math.PI;
  return result === 0 ? 0 : result;
}

/** Spin rate from two ephemeris rotation samples, unwrapped mod 2π. */
export function spinRateRadPerS(rot0: number, rot1: number, dtS: number): number {
  let d = (rot1 - rot0) % (2 * Math.PI);
  if (d < -Math.PI) d += 2 * Math.PI;
  if (d > Math.PI) d -= 2 * Math.PI;
  return d / dtS;
}

/** Vertical flight integration: hold-to-ascend/descend, rate scales with
 * altitude (min 2 m/s, alt/2 per second) so leaving the ground and reaching
 * limb view both feel responsive. Altitude clamps to [0, 10 * radiusM]. */
export function flightStep(altM: number, dUp: number, dtS: number, radiusM: number, aboveTerrainM: number): number {
  if (dUp === 0) return altM;
  // Ascent: responsive exponential. Descent: same shape but braked against
  // height above terrain so landings flare instead of slam.
  const rate = dUp > 0 ? Math.max(2, altM / 2) : Math.max(2, Math.min(altM / 3, aboveTerrainM / 2));
  const next = altM + dUp * rate * dtS;
  return Math.min(10 * radiusM, Math.max(0, next));
}

/** Horizontal ground-speed ladder: walking 1.4, Shift-skim 100, flying
 * max(100, altM / 2) m/s. */
export function groundSpeedMps(altM: number, shiftHeld: boolean): number {
  if (altM > 0) return Math.max(100, altM / 2);
  return shiftHeld ? 100 : 1.4;
}

/** The camera never submerges: on ocean worlds the effective terrain height
 * under the eye floors at -0.7 m, so eye = terrain + 1.7 wades 1 m above the
 * sea surface. Dry worlds follow the terrain into any basin. */
export function eyeTerrainM(terrainM: number, oceanWorld: boolean): number {
  return oceanWorld ? Math.max(terrainM, -0.7) : terrainM;
}
