# Goldengrove v2 — CDLOD Geomorphing + Relief Exaggeration Design

**Date:** 2026-07-04
**Status:** Approved (Nathan; follows from the terrain spec's committed CDLOD
follow-up plus his QA reports: visible height steps at tile borders, terrain
too flat from the air).

## Goal

Kill the LOD seams (height steps at tile boundaries and pops on split/merge)
with classic CDLOD vertex geomorphing, and make relief legible from altitude
with a render-side ×3 vertical exaggeration, on by default, toggling to true
scale via the ground view's true-scale button.

## Constraints

- Render-side only: no gg-* crate changes, no golden churn; `elevation_fine`
  values remain the single source of truth; the HUD's ⛰ readout always shows
  TRUE elevation regardless of exaggeration.
- Tile layout is already CDLOD-compatible (uniform 65×65 grids — this was a
  standing constraint). Skirts REMAIN as a residual-crack backstop.

## Design

### Geomorphing

- **Parent-decimated attribute**: at tile build, each vertex gets
  `aParentPos` — its position in the parent grid's decimation: vertices with
  even (row, col) keep their own position; odd vertices take the midpoint of
  their even neighbors along the grid row/column (grid-diagonal vertices:
  midpoint of the two diagonal even neighbors). Computed CPU-side from the
  tile's own positions array — no extra elevation queries.
- **Morph uniform**: per tile per frame, `uMorph = smoothstep(d,
  0.7·splitDist, 0.95·splitDist)` where `d` = camera distance to tile center
  and `splitDist = splitK·tileEdgeLenM(level)` — 0 near the camera (own
  shape), 1 as the tile approaches merge into its parent (parent shape). At
  the split/merge moment child≡parent, so pops vanish; because split
  distances halve per level, adjacent-level neighbors sit inside each
  other's morph bands and boundary steps blend away.
- **Shader**: `MeshStandardMaterial.onBeforeCompile` injects
  `transformed = mix(position, aParentPos, uMorph);` (position morph only;
  normals unmorphed — imperceptible at these amplitudes). One material per
  tile is required for the per-tile uniform (clone the shared material;
  dispose per tile — adjust the shared-material assumptions in dispose()).
- Water tiles: flat at sea level — no morphing needed (their parent
  decimation is themselves); skip the attribute/uniform for water.

### Relief exaggeration

- `reliefScale` (default **3**) multiplies elevations at tile build
  (displacement AND aParentPos) and the eye height (`terrainM × k`) so
  walking/collision stay consistent. Hypsometric COLORS use unscaled
  elevation (palette thresholds are physical). Water stays at true sea level
  radius (exaggeration is symmetric around 0, so shorelines don't move).
- Toggle: in ground view the existing true-scale HUD button becomes
  `⛰ ×3 relief` / `⛰ true relief`; toggling disposes and rebuilds the
  standing globe (same path as a standing-body change). Orrery keeps the
  button's original meaning. Not URL-persisted (session preference).
- HUD ⛰ and the URL share TRUE elevation/lat/lon — unchanged.

## Testing

- tileMesh: even vertices' aParentPos === own position; odd vertices ===
  neighbor midpoints; exaggeration scales displacement and aParentPos but
  not colors; skirt vertices get aParentPos too (copy of their source).
- terrainGlobe: per-tile material uniform exists; uMorph 0 near / →1 far
  (drive update with two camera distances); eye math × k; toggle rebuild
  disposes cloned materials (leak check).
- Live QA: border steps gone at the reported seeds; no pops while flying a
  slow ascent; ×3 vs true toggle visibly changes relief; walking/collision
  still correct on the seed-42 peak.

## Deferred

Normal morphing (recompute in shader), per-body adaptive exaggeration,
URL-persisted preference.
