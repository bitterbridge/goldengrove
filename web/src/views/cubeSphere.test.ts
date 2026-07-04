import { describe, expect, it } from 'vitest';
import {
  TILE_QUADS, children, containingTile, faceUnit, maxLevel, parent,
  tileCenterUnit, tileEdgeLenM, tileGrid, tileKey, unitLatLon, type TileId,
} from './cubeSphere';

describe('cubeSphere addressing', () => {
  it('faceUnit covers the sphere: 6 faces × corners are unit-length and distinct-ish', () => {
    const seen = new Set<string>();
    for (let f = 0; f < 6; f++) {
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as const) {
        const u = faceUnit(f, a, b);
        expect(Math.hypot(...u)).toBeCloseTo(1, 12);
        seen.add(u.map((x) => x.toFixed(6)).join(','));
      }
    }
    expect(seen.size).toBe(6 + 8); // 6 distinct centers + 8 shared corners
  });

  it('adjacent faces produce bit-identical points along shared edges', () => {
    // +X face at a=1 runs along the cube edge x=1,y=1; find the neighbor
    // face/param that generates the same edge, and compare EXACTLY (===).
    for (let i = 0; i <= 8; i++) {
      const b = -1 + (2 * i) / 8;
      const fromX = faceUnit(0, 1, b);
      const fromY = faceUnit(2, -1, b);
      expect(fromX[0]).toBe(fromY[0]);
      expect(fromX[1]).toBe(fromY[1]);
      expect(fromX[2]).toBe(fromY[2]);
    }
  });

  it('unitLatLon inverts the terrain lat/lon convention', () => {
    const u = faceUnit(4, 0, 0); // +Z face center = north pole
    expect(unitLatLon(u).latDeg).toBeCloseTo(90, 10);
    const eq = faceUnit(0, 0, 0); // +X face center = lat 0, lon 0
    const { latDeg, lonDeg } = unitLatLon(eq);
    expect(latDeg).toBeCloseTo(0, 10);
    expect(lonDeg).toBeCloseTo(0, 10);
  });

  it('children/parent round-trip and refine the same square', () => {
    const t: TileId = { face: 3, level: 4, ix: 5, iy: 9 };
    const kids = children(t);
    expect(kids.length).toBe(4);
    for (const k of kids) {
      expect(k.level).toBe(5);
      expect(parent(k)).toEqual(t);
    }
    expect(new Set(kids.map(tileKey)).size).toBe(4);
    expect(parent({ face: 0, level: 0, ix: 0, iy: 0 })).toBeNull();
  });

  it('tileGrid yields (N+1)² aligned lat/lon/unit samples with exact shared edges', () => {
    const t: TileId = { face: 1, level: 2, ix: 1, iy: 2 };
    const g = tileGrid(t);
    const n = TILE_QUADS + 1;
    expect(g.lats.length).toBe(n * n);
    expect(g.units.length).toBe(3 * n * n);
    // right edge of this tile === left edge of its east neighbor (same level)
    const nb: TileId = { face: 1, level: 2, ix: 2, iy: 2 };
    const gn = tileGrid(nb);
    for (let row = 0; row < n; row++) {
      const a = row * n + (n - 1); // last column of t
      const bIdx = row * n + 0;    // first column of neighbor
      expect(g.units[3 * a]).toBe(gn.units[3 * bIdx]);
      expect(g.units[3 * a + 1]).toBe(gn.units[3 * bIdx + 1]);
      expect(g.units[3 * a + 2]).toBe(gn.units[3 * bIdx + 2]);
    }
  });

  it('edge length halves per level; maxLevel lands near 1.5 m spacing', () => {
    const R = 6.371e6;
    expect(tileEdgeLenM(3, R)).toBeCloseTo(tileEdgeLenM(2, R) / 2, 6);
    const L = maxLevel(R);
    const spacing = tileEdgeLenM(L, R) / TILE_QUADS;
    expect(spacing).toBeGreaterThan(0.7);
    expect(spacing).toBeLessThan(3.0);
    expect(maxLevel(1e4)).toBeGreaterThanOrEqual(3); // tiny body clamps low but valid
  });

  it('containingTile finds the tile whose square holds the point', () => {
    const t: TileId = { face: 2, level: 6, ix: 17, iy: 40 };
    const c = tileCenterUnit(t);
    expect(containingTile(c, 6)).toEqual(t);
  });
});
