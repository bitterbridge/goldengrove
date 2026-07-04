/** LOD selection + build scheduling + LRU eviction for the terrain quadtree.
 * Pure logic — no three.js, no WASM — so it's unit-testable and the render
 * layer (terrainGlobe) stays a thin shell. */
import {
  TILE_QUADS, children, maxLevel, parent, tileCenterUnit, tileEdgeLenM, tileKey, type TileId,
} from './cubeSphere';

export interface TreeConfig { radiusM: number; splitK: number; maxLevelOverride?: number; cacheCap: number }
export interface TreeUpdate { render: TileId[]; build: TileId[]; evict: string[] }

export class TileTree {
  private readonly cfg: TreeConfig;
  private readonly deepest: number;
  private built = new Map<string, number>(); // key -> last-rendered stamp
  private stamp = 0;

  constructor(cfg: TreeConfig) {
    this.cfg = cfg;
    this.deepest = cfg.maxLevelOverride ?? maxLevel(cfg.radiusM);
  }

  isBuilt(key: string): boolean {
    return this.built.has(key);
  }

  markBuilt(key: string): void {
    if (!this.built.has(key)) this.built.set(key, this.stamp);
  }

  private dist(cameraBf: [number, number, number], t: TileId): number {
    const c = tileCenterUnit(t);
    const R = this.cfg.radiusM;
    const dx = cameraBf[0] - c[0] * R;
    const dy = cameraBf[1] - c[1] * R;
    const dz = cameraBf[2] - c[2] * R;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  update(cameraBf: [number, number, number]): TreeUpdate {
    this.stamp++;
    // 1. desired set: split toward the camera
    const desired: { t: TileId; d: number }[] = [];
    const stack: TileId[] = [];
    for (let f = 0; f < 6; f++) stack.push({ face: f, level: 0, ix: 0, iy: 0 });
    while (stack.length > 0) {
      const t = stack.pop()!;
      const d = this.dist(cameraBf, t);
      if (t.level < this.deepest && d < this.cfg.splitK * tileEdgeLenM(t.level, this.cfg.radiusM)) {
        stack.push(...children(t));
      } else {
        desired.push({ t, d });
      }
    }

    // 2. render set: nearest built ancestor per desired tile (deduped);
    //    3. build list: every unbuilt ancestor-chain tile, coarse-first.
    const render = new Map<string, TileId>();
    const wanted = new Map<string, { t: TileId; d: number }>();
    for (const { t, d } of desired) {
      let cur: TileId | null = t;
      const chain: TileId[] = [];
      let shown: TileId | null = null;
      while (cur) {
        const k = tileKey(cur);
        if (this.built.has(k)) { shown = cur; break; }
        chain.push(cur);
        cur = parent(cur);
      }
      if (shown) {
        const k = tileKey(shown);
        render.set(k, shown);
        this.built.set(k, this.stamp);
      }
      for (const c of chain) {
        const k = tileKey(c);
        const prev = wanted.get(k);
        if (!prev || d < prev.d) wanted.set(k, { t: c, d });
      }
    }
    const build = [...wanted.values()]
      .sort((a, b) => a.t.level - b.t.level || a.d - b.d)
      .map((w) => w.t);

    // 4. eviction: oldest built keys beyond cap, never currently rendered
    const evict: string[] = [];
    if (this.built.size > this.cfg.cacheCap) {
      const candidates = [...this.built.entries()]
        .filter(([k]) => !render.has(k))
        .sort((a, b) => a[1] - b[1]);
      const excess = this.built.size - this.cfg.cacheCap;
      for (const [k] of candidates.slice(0, excess)) {
        this.built.delete(k);
        evict.push(k);
      }
    }

    return { render: [...render.values()], build, evict };
  }
}
