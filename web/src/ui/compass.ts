/** Sliding heading tape for the ground view. Azimuth 0 = north, +east. */
export interface Compass {
  setHeading(yawRad: number, pitchRad: number, latLon?: { latDeg: number; lonDeg: number }): void;
  setVisible(v: boolean): void;
}

const PX_PER_DEG = 1.2;
const WINDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function buildCompass(root: HTMLElement): Compass {
  const box = document.createElement('div');
  box.className = 'hud hud-compass';
  box.style.display = 'none';
  const window_ = document.createElement('div');
  window_.className = 'compass-window';
  const tape = document.createElement('div');
  tape.className = 'compass-tape';
  // three copies (-360..720) so the tape never shows a seam while wrapping
  for (let d = -360; d <= 720; d += 15) {
    const mark = document.createElement('span');
    mark.className = 'compass-mark';
    const norm = ((d % 360) + 360) % 360;
    const isCardinal = norm % 90 === 0;
    mark.textContent = norm % 45 === 0 ? WINDS[(norm / 45) % 8]! : '·';
    if (isCardinal) mark.classList.add('cardinal');
    mark.style.left = `${(d + 360) * PX_PER_DEG}px`;
    tape.appendChild(mark);
  }
  window_.appendChild(tape);
  const needle = document.createElement('div');
  needle.className = 'compass-needle';
  needle.textContent = '▲';
  const readout = document.createElement('div');
  readout.className = 'compass-readout';
  box.append(window_, needle, readout);
  root.appendChild(box);

  return {
    setHeading(yawRad, pitchRad, latLon) {
      const deg = ((yawRad * 180) / Math.PI % 360 + 360) % 360;
      // window is 288px wide at 1.2 px/deg: displays a 240deg span
      tape.style.transform = `translateX(${-(deg + 360) * PX_PER_DEG + 144}px)`;
      const wind = WINDS[Math.round(deg / 45) % 8]!;
      const pitchDeg = (pitchRad * 180) / Math.PI;
      const p = Math.round(pitchDeg) + 0;
      const sign = p >= 0 ? '+' : '';
      let text = `${wind} ${deg.toFixed(0)}° · ${sign}${p}°`;
      if (latLon) {
        const ns = latLon.latDeg < 0 ? 'S' : 'N';
        const ew = latLon.lonDeg < 0 ? 'W' : 'E';
        // 3 decimals ≈ 111 m per tick — anything coarser and true-scale
        // walking produces no visible change on any readout
        text += ` · ${Math.abs(latLon.latDeg).toFixed(3)}°${ns} ${Math.abs(latLon.lonDeg).toFixed(3)}°${ew}`;
      }
      readout.textContent = text;
    },
    setVisible(v) {
      box.style.display = v ? '' : 'none';
    },
  };
}
