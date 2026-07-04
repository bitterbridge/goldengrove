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

/** Vertical flight integration: hold-to-ascend/descend, rate scales with
 * altitude (min 2 m/s, alt/2 per second) so leaving the ground and reaching
 * limb view both feel responsive. Altitude clamps to [0, 10 * radiusM]. */
export function flightStep(altM: number, dUp: number, dtS: number, radiusM: number): number {
  if (dUp === 0) return altM;
  const rate = Math.max(2, altM / 2);
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
