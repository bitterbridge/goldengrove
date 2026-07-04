# Goldengrove v2 — Ground-View 3D Terrain Design (Quadtree Cube-Sphere)

**Date:** 2026-07-04
**Status:** Draft — Nathan chose the global quadtree (Outer Wilds arc:
smooth ground↔space movement eventually). Two sub-decisions taken on the
recommended path in his absence, flagged at the bottom: free-flight ships
this stage; LOD seams use skirts v1.

## Goal

The ground view's flat disc becomes a real planet: a global quadtree
cube-sphere terrain engine with ~1.5 m detail underfoot that scales
seamlessly to seeing the planet's limb from altitude. Walking rides the
terrain; a free-flight mode (hold-to-ascend/descend) proves the LOD at every
altitude. The full merge with the space view — one continuous scene from
surface to interplanetary space — is a **later stage**; this stage builds
the terrain engine that makes it possible and keeps the existing
two-view/URL structure.

## Constraints Inherited From v1/v2

- **Determinism**: same seed → identical output everywhere, forever. New
  detail derives from the existing `noise_seed` with new XOR channels —
  **zero new RNG draws, zero changes to draw order**. Descriptor goldens AND
  existing terrain goldens stay byte-identical; `elevation()`, `heightmap()`,
  and `SCHEMA_VERSION` (2) are untouched.
- All generation-path math through `gg_core::math` (libm); wasm32 canonical.
- Lat/lon convention identical to `observer.ts`/`gg-terrain` (shared basis).
- No backend; everything client-side.

## Why a new elevation function

The current cascade's finest octave has ~100 km wavelength — at walking
scale the ground is glass-smooth. This stage adds **micro-detail**: a
deterministic continuation of the existing fBm spectrum (same
lacunarity/gain cadence, frequencies from ~100 km down to ~50 m wavelength):

```
TerrainSpec::elevation_fine(lat_deg, lon_deg) -> f64        // meters above sea level
TerrainSpec::elevation_fine_batch(coords: &[f64]) -> Vec<f32>  // [lat,lon,...] pairs
```

`elevation_fine = to_meters(elevation()) + micro(p)` where `micro` uses
`noise_seed` with fresh XOR constants and continues the detail cascade's
amplitude decay so the spectrum has no seam. `to_meters` scales relative
units by the body's relief figure — exact mapping pinned in the plan; JS
receives meters and needs no unit knowledge. Micro amplitude fades to zero
over its top ~2 octave wavelengths so `elevation_fine` agrees with
`elevation()` at heightmap resolution (orrery textures and ground truth
never visibly disagree).

## Architecture

### Rust (gg-terrain, gg-wasm)

- `micro(p: V3) -> f64` in `gg-terrain`: octave loop over the existing
  integer-hash value noise (libm-free, bit-exact by construction).
- WASM boundary (gg-wasm `World`):
  - `body_elevation(body_index, lat_deg, lon_deg) -> Result<f64, JsError>` —
    scalar, for spawn height and the HUD readout.
  - `body_elevations(body_index, coords: &[f64]) -> js_sys::Float32Array` —
    batched `[lat0, lon0, lat1, lon1, …]` → meters; **one call per tile
    build** (thousands of samples per FFI crossing, never one-at-a-time).
  - Both reuse the existing lazy per-body `TerrainSpec` cache; non-terrain
    bodies error/return empty exactly like `body_heightmap`.

### TypeScript: the quadtree engine

New modules, each pure and unit-testable:

- **`cubeSphere.ts`** — tile addressing math. Six root faces; a tile id is
  `(face, level, ix, iy)`. Functions: tile → lat/lon grid of its
  (N+1)×(N+1) vertices (N = 64 quads/side), tile center/corner unit
  vectors, child/parent ids, tile angular extent. Handles lon wrap and pole
  faces by construction (cube faces have no pole singularity).
- **`tileTree.ts`** — LOD selection + lifecycle. Split criterion: distance
  from camera to tile's bounding sphere < K × tile edge length (K pinned in
  the plan; screen-space-error equivalent). Produces the active tile set
  for a camera position/altitude each frame. Frustum culling + horizon-cone
  culling per tile. Tiles build **asynchronously** from a priority queue
  (nearest/coarsest first) into an LRU cache (~300 tiles); a parent renders
  until all four children are ready — the world sharpens as tiles stream
  in, never hitches. Cap ~17 levels below face root for an Earth-size body
  (~1.5 m vertex spacing); cap scales with body radius so small moons stop
  at comparable spacing.
- **`tileMesh.ts`** — geometry build. For a tile: batched
  `body_elevations` call, vertices displaced along their sphere normals to
  `R + elevation_m`, stored **relative to the tile's own f64 origin**
  (float32 GPU buffers never see planet-scale coordinates → no vertex
  jitter). Edge **skirts** (short curtains dropped along tile borders, depth
  scaled to the level's max expected neighbor error) hide LOD cracks.
  Per-vertex hypsometric color + slope shading, reusing `terrainTexture.ts`
  color logic (extracted to shared helpers, not duplicated). Buffer reuse
  via a pool.
- **Rendering** — rendering-relative-to-eye: each frame, tile meshes get
  positions = (tile origin − camera world position) in f64 CPU-side, camera
  sits at scene origin. `logarithmicDepthBuffer: true` covers
  footstep-to-orbit depth ranges.

### Water, fog, lighting

- Bodies with `ocean_fraction > 0`: a second, shallower quadtree (undis-
  placed sphere at sea-level radius, capped ~6 levels — it's smooth) with a
  translucent deep-blue material, drawn after terrain.
- Exponential distance fog tinted toward the sky dome's horizon color,
  density scaled by atmosphere density **and** fading with camera altitude
  (space is clear); airless bodies get none (knife-edge horizon).
- The sky dome's scattering density likewise fades with altitude (existing
  `setDensity` scaled by an exponential atmosphere-height falloff, scale
  height pinned in the plan) — ascending, the sky deepens toward black and
  stars emerge in daytime, Kármán-line style.
- The terrain scene gets its own ambient + directional sun lights driven
  from the same per-frame sun directions as the sky pass; unlike the
  sky-body phase lights these DO fade across the horizon (smoothstep
  matching the sky shader's ramp) so the ground darkens at night while
  moons overhead stay sunlit.

### Render integration (two-pass)

`ground.ts` renders two passes sharing one camera orientation:
1. **Sky pass** — existing scene: starfield, sky dome, sun/moon/planet dome
   meshes, labels. Unchanged behavior, including eclipse ordering.
2. **Terrain pass** — depth cleared, then quadtree terrain + water. Terrain
   always occludes sky: moons rise from behind ridgelines; from altitude the
   planet's limb curves against the stars.

The flat ground disc is deleted.

### Movement

- **Walk mode** (default): `stepLatLon` keeps its math; step size becomes
  true meters: `stepDeg = speed_mps · dt · 180/(π·R_body)`, walk speed
  1.4 m/s, Shift ×5. Eye: `camera altitude = max(terrain_m + 1.7,
  water ? +1.0 : −∞)` — wades, never submerges (v1).
- **Flight mode**: hold-to-ascend/descend (e.g. Space/C or R/F — plan
  pins keys with the same input-focus guard as WASD). Speed scales with
  altitude (~altitude/2 per second, floor 2 m/s) so both leaving the ground
  and reaching limb-view altitude feel responsive. Horizontal movement in
  flight uses the same heading controls, speed also altitude-scaled.
  Landing (descending to eye height) returns to walk mode. Altitude is
  session-local this stage: **URL schema unchanged** (shared links reproduce
  lat/lon standing position; a flying moment shares as its ground point).
- HUD: compass gains an elevation readout (`⛰ 1,234 m`); flight adds an
  altitude readout. Stand-here still lands on the sub-parent/clicked point;
  spawn-on-land deferred.

## Performance envelope

- Elevation sampling is the budget: ~2–5 µs/sample under wasm. One tile =
  65×65 ≈ 4.2 k samples ≈ 10–20 ms, built async off the render loop's
  critical path (queue drains a bounded number of tiles per frame).
  Walking steady-state touches a handful of tiles per minute; flight ascent
  requests coarser tiles (fewer, not more). Numbers verified by a measured
  spike in the plan's first task.
- Active tile set at eye height ≈ 60–120 tiles ≈ 0.5–1 M triangles worst
  case — within budget for the existing full-bleed renderer; the plan
  carries a measured check and N=32 fallback if low-end hardware struggles.

## Testing

- **Rust**: micro-detail continuity property test (worst adjacent jump
  bound on a fine grid); spectrum-seam test
  (`|elevation_fine − to_meters(elevation)|` bounded by the micro amplitude
  budget); existing goldens byte-identical (regression gate, NOT
  regenerated); new fine-elevation hash golden (64×32 grid, anchor bodies,
  seeds 1/42/123456789) pinned natively **and** in the wasm32 parity suite.
- **TS unit**: cube-sphere addressing (face seams share vertices bit-exactly,
  child/parent round-trips, no pole singularity); LOD selection (splits
  approaching camera, merges receding, respects level cap and radius
  scaling); async build lifecycle (parent renders until children ready; LRU
  eviction never evicts an active tile); skirt geometry (edge curtains
  present, depth per level); tile-origin relative coordinates (max |vertex|
  small relative to tile size); walk meters→degrees; flight mode
  transitions (ascend leaves walk, landing returns); water present iff
  `ocean_fraction > 0`; two-pass structure (ground disc gone); eye-height
  clamp.
- **Live QA**: Playwright on seed 42 anchor coast (walk a shoreline) + seed
  3630539713810705175 IVa (airless knife-edge horizon; parent planet rising
  behind terrain) + one ascent to limb altitude, screenshots reviewed.

## Out of scope (deferred)

Space-view merge (continuous surface↔interplanetary scene — next stage on
this arc, gets its own spec), CDLOD geomorphing (skirts pop-fix follow-up),
erosion, rivers, slope-limited walking/collision, shadows, waves,
spawn-on-land, biome coloring, texture splatting, URL-shareable flight
moments.

## Open items flagged for Nathan

1. **Free-flight ships this stage** (recommended A) — hold-to-ascend within
   the ground view; proves the LOD the quadtree exists for. Space-view merge
   still later.
2. **Skirts v1 over CDLOD morphing** (recommended A) — robust and simple;
   accepts visible LOD pops; morphing is a drop-in follow-up if pops annoy.
3. True-scale relief and curvature, no exaggeration — carried from the
   first draft (physically-grounded ethos).
4. Micro-detail floor ~50 m wavelength — hills/valleys underfoot;
   rock-scale detail needs normal maps (later).
