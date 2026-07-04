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
