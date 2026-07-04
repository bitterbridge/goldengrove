import { describe, expect, it } from 'vitest';
import { TileTree, type TreeConfig } from './tileTree';
import { TILE_QUADS, tileEdgeLenM, tileKey } from './cubeSphere';

const R = 6.371e6;
const cfg: TreeConfig = { radiusM: R, splitK: 3, cacheCap: 320 };
const surface = (): [number, number, number] => [R, 0, 0]; // on +X face center

describe('TileTree', () => {
  it('desires deep tiles near the camera and coarse ones far away', () => {
    const tree = new TileTree(cfg);
    const { build } = tree.update(surface());
    const levels = build.map((t) => t.level);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(15); // near-foot leaf
    expect(Math.min(...levels)).toBe(0);                    // far-side root
    // build order is coarse-first
    expect(levels[0]).toBe(0);
    const sorted = [...levels].every((l, i, a) => i === 0 || a[i - 1]! <= l);
    expect(sorted).toBe(true);
  });

  it('renders the nearest built ancestor until children are ready', () => {
    const tree = new TileTree(cfg);
    const first = tree.update(surface());
    expect(first.render.length).toBe(0); // nothing built yet
    // build only the six roots
    for (const t of first.build.filter((t) => t.level === 0)) tree.markBuilt(tileKey(t));
    const second = tree.update(surface());
    expect(second.render.length).toBe(6);
    expect(second.render.every((t) => t.level === 0)).toBe(true);
    // finer builds are still wanted
    expect(second.build.some((t) => t.level > 0)).toBe(true);
  });

  it('renders built leaves directly and drops them from the build list', () => {
    const tree = new TileTree(cfg);
    const { build } = tree.update(surface());
    for (const t of build) tree.markBuilt(tileKey(t));
    const next = tree.update(surface());
    expect(next.build.length).toBe(0);
    const keys = next.render.map(tileKey);
    expect(new Set(keys).size).toBe(keys.length); // deduped
    expect(next.render.length).toBeGreaterThan(6);
  });

  it('evicts least-recently-rendered tiles beyond cacheCap, never active ones', () => {
    const small: TreeConfig = { radiusM: R, splitK: 3, cacheCap: 10 };
    const tree = new TileTree(small);
    const a = tree.update(surface());
    for (const t of a.build) tree.markBuilt(tileKey(t));
    tree.update(surface());
    // walk to the antipode: an entirely different desired set
    const b = tree.update([-R, 0, 0]);
    for (const t of b.build) tree.markBuilt(tileKey(t));
    const c = tree.update([-R, 0, 0]);
    expect(c.evict.length).toBeGreaterThan(0);
    const active = new Set(c.render.map(tileKey));
    for (const k of c.evict) {
      expect(active.has(k)).toBe(false);
      expect(tree.isBuilt(k)).toBe(false); // evict unregisters
    }
  });

  it('respects maxLevelOverride', () => {
    const capped = new TileTree({ radiusM: R, splitK: 3, cacheCap: 320, maxLevelOverride: 4 });
    const { build } = capped.update(surface());
    expect(Math.max(...build.map((t) => t.level))).toBeLessThanOrEqual(4);
  });
});
