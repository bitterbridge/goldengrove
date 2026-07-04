/** Sliding heading tape for the ground view. Azimuth 0 = north, +east. */
export interface Compass {
  setHeading(yawRad: number, pitchRad: number): void;
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
    mark.textContent = norm % 90 === 0 ? WINDS[(norm / 45) % 8]! : norm % 45 === 0 ? WINDS[(norm / 45) % 8]! : '·';
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
    setHeading(yawRad, pitchRad) {
      const deg = ((yawRad * 180) / Math.PI % 360 + 360) % 360;
      // window is 288px wide at 1.2 px/deg: displays a 240deg span
      tape.style.transform = `translateX(${-(deg + 360) * PX_PER_DEG + 144}px)`;
      const wind = WINDS[Math.round(deg / 45) % 8]!;
      const pitchDeg = (pitchRad * 180) / Math.PI;
      readout.textContent = `${wind} ${deg.toFixed(0)}° · ${pitchDeg >= 0 ? '+' : ''}${pitchDeg.toFixed(0)}°`;
    },
    setVisible(v) {
      box.style.display = v ? '' : 'none';
    },
  };
}
