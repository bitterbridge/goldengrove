import type { Calendar, DateTime } from '../sim/types';

/** Local convention: a day is displayed as 24 "hours" of 60 "minutes"
 * regardless of its physical length — clock-faces travel between worlds. */
export function formatDate(d: DateTime, _cal: Calendar): string {
  const totalMinutes = Math.floor(d.day_fraction * 24 * 60);
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const mm = String(totalMinutes % 60).padStart(2, '0');
  return `Y${d.year + 1} · Day ${d.day_of_year + 1} · ${hh}:${mm}`;
}

export const SPEED_STEPS: Array<{ label: string; mult: number }> = [
  { label: '1×', mult: 1 },
  { label: '1 min/s', mult: 60 },
  { label: '1 hr/s', mult: 3600 },
  { label: '1 day/s', mult: 86400 },
  { label: '10 d/s', mult: 864000 },
  { label: '~1 mo/s', mult: 2.6e6 },
];

export interface HudCallbacks {
  onPlayPause(): void;
  onSpeed(mult: number): void;
  onTrueScale(on: boolean): void;
  onReroll(): void;
}

export interface Hud {
  setDate(s: string): void;
  setPaused(paused: boolean): void;
}

export function buildHud(root: HTMLElement, seed: string, cb: HudCallbacks): Hud {
  const topLeft = el('div', 'hud hud-top-left');
  topLeft.append(el('span', '', `seed ${seed}`));
  const reroll = el('button', '', '⟲ reroll');
  reroll.addEventListener('click', () => cb.onReroll());
  const trueScale = el('button', '', 'true scale');
  let ts = false;
  trueScale.addEventListener('click', () => {
    ts = !ts;
    trueScale.classList.toggle('active', ts);
    cb.onTrueScale(ts);
  });
  topLeft.append(reroll, trueScale);

  const topRight = el('div', 'hud hud-top-right');
  const date = el('span', '', '—');
  topRight.append(date);

  const bottom = el('div', 'hud hud-bottom');
  const play = el('button', '', '⏸');
  play.addEventListener('click', () => cb.onPlayPause());
  bottom.append(play);
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of SPEED_STEPS) {
    const b = el('button', '', s.label);
    if (s.mult === 1) b.classList.add('active');
    b.addEventListener('click', () => {
      speedButtons.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      cb.onSpeed(s.mult);
    });
    speedButtons.push(b);
    bottom.append(b);
  }

  root.append(topLeft, topRight, bottom);
  return {
    setDate: (s) => { date.textContent = s; },
    setPaused: (p) => { play.textContent = p ? '▶' : '⏸'; },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
