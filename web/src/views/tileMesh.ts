/** Tile geometry: a uniform (N+1)² displaced grid (CDLOD-compatible layout)
 * plus a skirt ring pulled toward the planet center to hide LOD cracks.
 * Positions are relative to the tile's own body-fixed origin so f32 GPU
 * buffers never carry planet-scale magnitudes (no vertex jitter). */
import { TILE_QUADS, tileCenterUnit, tileEdgeLenM, tileGrid, type TileId } from './cubeSphere';
import { hypsometricColor } from './terrainTexture';

export interface TileMeshInputs {
  radiusM: number;
  reliefM: number;
  classTint: [number, number, number];
  dead: boolean;
}

export interface TileMeshData {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  originBf: [number, number, number];
}

export function buildTileMesh(t: TileId, elevationsM: Float32Array, inputs: TileMeshInputs): TileMeshData {
  const n = TILE_QUADS + 1;
  const gridCount = n * n;
  if (elevationsM.length !== gridCount) {
    throw new Error(`tile ${t.face}:${t.level}:${t.ix}:${t.iy}: expected ${gridCount} elevations, got ${elevationsM.length}`);
  }
  const grid = tileGrid(t);
  const c = tileCenterUnit(t);
  const R = inputs.radiusM;
  const originBf: [number, number, number] = [c[0] * R, c[1] * R, c[2] * R];

  // Border ring, walked as a closed loop: bottom row, right col, top row
  // (reversed), left col (reversed). Each corner is visited exactly once,
  // so the loop yields n + (n-1) + (n-1) + (n-2) = 4n - 4 = 4*TILE_QUADS
  // vertices — not 4*TILE_QUADS + 4. (See task-6-report.md for the
  // reconciliation against the brief's originally-stated test constants.)
  const ring: number[] = [];
  for (let col = 0; col < n; col++) ring.push(col); // bottom (row 0)
  for (let row = 1; row < n; row++) ring.push(row * n + (n - 1)); // right
  for (let col = n - 2; col >= 0; col--) ring.push((n - 1) * n + col); // top
  for (let row = n - 2; row >= 1; row--) ring.push(row * n); // left
  const skirtCount = ring.length; // = 4 * TILE_QUADS

  const positions = new Float32Array(3 * (gridCount + skirtCount));
  const colors = new Float32Array(3 * (gridCount + skirtCount));
  const skirtDepth = 0.08 * tileEdgeLenM(t.level, R);

  const writeVertex = (out: number, gi: number, radialOffset: number) => {
    const ux = grid.units[3 * gi]!;
    const uy = grid.units[3 * gi + 1]!;
    const uz = grid.units[3 * gi + 2]!;
    const r = R + elevationsM[gi]! + radialOffset;
    positions[3 * out] = ux * r - originBf[0];
    positions[3 * out + 1] = uy * r - originBf[1];
    positions[3 * out + 2] = uz * r - originBf[2];
    const [cr, cg, cb] = hypsometricColor(elevationsM[gi]! / inputs.reliefM, 1.0, inputs.classTint, inputs.dead);
    colors[3 * out] = cr / 255;
    colors[3 * out + 1] = cg / 255;
    colors[3 * out + 2] = cb / 255;
  };

  for (let i = 0; i < gridCount; i++) writeVertex(i, i, 0);
  ring.forEach((gi, s) => writeVertex(gridCount + s, gi, -skirtDepth));

  // Indices: N² grid quads + one quad per skirt edge segment (4*TILE_QUADS
  // segments, since the ring is a closed loop of 4*TILE_QUADS vertices).
  const quadCount = TILE_QUADS * TILE_QUADS + ring.length;
  const indices = new Uint32Array(6 * quadCount);
  let o = 0;
  for (let row = 0; row < TILE_QUADS; row++) {
    for (let col = 0; col < TILE_QUADS; col++) {
      const i0 = row * n + col;
      const i1 = i0 + 1;
      const i2 = i0 + n;
      const i3 = i2 + 1;
      indices.set([i0, i1, i2, i1, i3, i2], o);
      o += 6;
    }
  }
  for (let s = 0; s < ring.length; s++) {
    const gi0 = ring[s]!;
    const gi1 = ring[(s + 1) % ring.length]!;
    const s0 = gridCount + s;
    const s1 = gridCount + ((s + 1) % ring.length);
    indices.set([gi0, gi1, s0, gi1, s1, s0], o);
    o += 6;
  }

  return { positions, colors, indices, originBf };
}
