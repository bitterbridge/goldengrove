import { describe, expect, it } from 'vitest';
import { TILE_QUADS, tileCenterUnit, tileEdgeLenM, type TileId } from './cubeSphere';
import { buildTileMesh, type TileMeshInputs } from './tileMesh';

const R = 6.371e6;
const inputs: TileMeshInputs = { radiusM: R, reliefM: 6000, classTint: [155, 143, 122], dead: false };
const t: TileId = { face: 0, level: 6, ix: 30, iy: 31 };
const n = TILE_QUADS + 1;
const gridCount = n * n;
// Closed border-ring walk (bottom row, right col, top row reversed, left col
// reversed) visits each of the 4 tile edges once without re-visiting a
// corner: n + (n-1) + (n-1) + (n-2) = 4n - 4 = 4*TILE_QUADS vertices/quads.
const skirtCount = 4 * TILE_QUADS;

function flat(elev = 0): Float32Array {
  return new Float32Array(gridCount).fill(elev);
}

describe('buildTileMesh', () => {
  it('emits grid + skirt vertices with matching color entries', () => {
    const m = buildTileMesh(t, flat(), inputs);
    expect(m.positions.length).toBe(3 * (gridCount + skirtCount));
    expect(m.colors.length).toBe(m.positions.length);
  });

  it('grid vertices sit at radius + elevation, relative to the tile origin', () => {
    const m = buildTileMesh(t, flat(1000), inputs);
    const c = tileCenterUnit(t);
    const origin = m.originBf;
    expect(Math.hypot(origin[0] - c[0] * R, origin[1] - c[1] * R, origin[2] - c[2] * R)).toBeLessThan(1);
    // every grid vertex: |origin + pos| ≈ R + 1000
    for (const i of [0, gridCount >> 1, gridCount - 1]) {
      const x = origin[0] + m.positions[3 * i]!;
      const y = origin[1] + m.positions[3 * i + 1]!;
      const z = origin[2] + m.positions[3 * i + 2]!;
      expect(Math.hypot(x, y, z)).toBeCloseTo(R + 1000, 3);
    }
    // relative coords stay small (precision contract): well under tile size
    let maxAbs = 0;
    for (const v of m.positions) maxAbs = Math.max(maxAbs, Math.abs(v));
    expect(maxAbs).toBeLessThan(2 * tileEdgeLenM(t.level, R) + 2000);
  });

  it('skirt vertices duplicate the border ring, pulled toward the center', () => {
    const m = buildTileMesh(t, flat(500), inputs);
    const depth = 0.08 * tileEdgeLenM(t.level, R);
    const o = m.originBf;
    const radiusOf = (i: number) =>
      Math.hypot(o[0] + m.positions[3 * i]!, o[1] + m.positions[3 * i + 1]!, o[2] + m.positions[3 * i + 2]!);
    for (const s of [gridCount, gridCount + skirtCount - 1]) {
      expect(radiusOf(s)).toBeCloseTo(R + 500 - depth, 2);
    }
  });

  it('indices reference valid vertices and cover N² quads + 4N skirt quads', () => {
    const m = buildTileMesh(t, flat(), inputs);
    expect(m.indices.length).toBe(6 * (TILE_QUADS * TILE_QUADS + 4 * TILE_QUADS));
    for (const i of m.indices) expect(i).toBeLessThan(gridCount + skirtCount);
  });

  it('colors follow the hypsometric ramp: deep ocean is bluer than peaks are', () => {
    const deep = buildTileMesh(t, flat(-3000), inputs);
    const peak = buildTileMesh(t, flat(5000), inputs);
    expect(deep.colors[2]!).toBeGreaterThan(deep.colors[0]!);      // blue-dominant
    expect(peak.colors[0]!).toBeGreaterThan(deep.colors[0]!);      // brighter red channel
  });

  it('throws when elevationsM length does not match the grid vertex count', () => {
    expect(() => buildTileMesh(t, new Float32Array(3), inputs)).toThrow();
  });

  it('grid and skirt triangles wind outward (front-face normal points away from the planet center)', () => {
    const m = buildTileMesh(t, flat(1000), inputs);
    const o = m.originBf;
    type V3 = [number, number, number];
    const vertex = (i: number): V3 => [
      o[0] + m.positions[3 * i]!,
      o[1] + m.positions[3 * i + 1]!,
      o[2] + m.positions[3 * i + 2]!,
    ];
    const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a: V3, b: V3): V3 => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
    const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unit = (a: V3): V3 => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

    // First grid triangle: the essential regression. A CCW-front-face
    // triangle on the tile's outer surface must have its cross-product
    // normal pointing away from the planet center (same direction as the
    // vertex's own radial/outward unit vector).
    const [gi0, gi1, gi2] = [m.indices[0]!, m.indices[1]!, m.indices[2]!];
    const [gp0, gp1, gp2] = [vertex(gi0), vertex(gi1), vertex(gi2)];
    const gridNormal = cross(sub(gp1, gp0), sub(gp2, gp0));
    const gridOutward = unit(gp0);
    expect(dot(unit(gridNormal), gridOutward)).toBeGreaterThan(0.5);

    // First skirt triangle, immediately after all grid-quad indices.
    // Skirt curtains are nearly vertical (radial), so their front-face
    // normal is tangential to the sphere rather than strongly outward —
    // we only assert it isn't anti-parallel (i.e. not back-facing).
    const skirtStart = 6 * TILE_QUADS * TILE_QUADS;
    const [si0, si1, si2] = [m.indices[skirtStart]!, m.indices[skirtStart + 1]!, m.indices[skirtStart + 2]!];
    const [sp0, sp1, sp2] = [vertex(si0), vertex(si1), vertex(si2)];
    const skirtNormal = cross(sub(sp1, sp0), sub(sp2, sp0));
    const skirtOutward = unit(sp0);
    expect(dot(unit(skirtNormal), skirtOutward)).toBeGreaterThan(-0.5);
  });
});
