# Goldengrove v2 — Ground-View 3D Terrain Design

**Date:** 2026-07-04
**Status:** Draft — Nathan was away during brainstorming; all decisions below
follow the recommended options and are flagged for his review.

## Goal

The ground view's flat disc becomes real terrain: ridgelines on the horizon,
valleys, coastlines you can walk to, and an eye that rides the surface. The
observer stays a pedestrian this stage — no flight, no ground↔orbit LOD.

## Constraints Inherited From v1/v2

- **Determinism**: same seed → identical output everywhere, forever. New
  detail must come from the existing `noise_seed` with new XOR channels or
  new child streams — **zero changes to existing draw order**. Descriptor
  goldens AND existing terrain goldens stay byte-identical; `elevation()`,
  `heightmap()`, and `SCHEMA_VERSION` (2) are untouched.
- All generation-path math through `gg_core::math` (libm); wasm32 canonical.
- Lat/lon convention identical to `observer.ts`/`gg-terrain` (shared basis).
- No backend; everything client-side.

## Why a new elevation function

The current cascade's finest octave has ~100 km wavelength — at walking
scale the ground is glass-smooth. This stage adds **micro-detail**: a
deterministic continuation of the existing fBm spectrum (same lacunarity/gain
cadence, frequencies from ~100 km down to ~50 m wavelength), exposed as:

```
TerrainSpec::elevation_fine(lat_deg, lon_deg) -> f64   // meters above sea level
TerrainSpec::elevation_fine_batch(coords: &[f64]) -> Vec<f32>  // [lat,lon,...] pairs
```

`elevation_fine = to_meters(elevation()) + micro(p)` where `micro` uses
`noise_seed` with fresh XOR constants (no new RNG draws → nothing reshuffles)
and its amplitude continues the detail cascade's decay so the spectrum has no
seam. `to_meters` scales relative units by the body's relief figure — the
exact mapping is pinned in the plan; JS receives meters and needs no unit
knowledge. Micro amplitude fades to zero over the top ~2 octave wavelengths
so `elevation_fine` agrees with `elevation()` at heightmap resolution
(orrery textures and ground truth never visibly disagree).

## Architecture

### Rust (gg-terrain, gg-wasm)

- `micro(p: V3) -> f64` in `gg-terrain`: octave loop over existing
  integer-hash value noise (libm-free, bit-exact by construction).
- WASM boundary (gg-wasm `World`):
  - `body_elevation(body_index, lat_deg, lon_deg) -> Result<f64, JsError>`
    — scalar, for spawn height and the HUD readout.
  - `body_elevations(body_index, coords: &[f64]) -> js_sys::Float32Array`
    — batched `[lat0, lon0, lat1, lon1, …]` → meters; one call per clipmap
    ring rebuild (thousands of samples per FFI crossing, not one).
  - Both reuse the existing lazy per-body `TerrainSpec` cache; non-terrain
    bodies error/return empty exactly like `body_heightmap`.

### TypeScript (web)

New module `web/src/views/terrainPatch.ts` — pure geometry + a build step:

- **Moving clipmap**: L concentric square grids centered on the observer's
  lat/lon, ENU tangent-plane coordinates (x=east, y=north, z=up — same frame
  the ground view already uses). Near ring ~1.5 m vertex spacing, spacing ×4
  per ring, outer radius ~75 km (clamped to a fraction of the body's
  circumference for small moons). Concrete level counts/sizes are plan-level
  numbers with a stated triangle budget (~100–150 k).
- Each vertex maps ENU offset → lat/lon (small-angle on the sphere, lon
  wrap + pole clamp), batched through `body_elevations`, displaced to
  `z = elevation_m − d²/2R` (curvature drop — the horizon is real geometry;
  beyond-horizon terrain hides itself).
- **Recenter with hysteresis**: a ring rebuilds only when the observer has
  moved > ¼ of its spacing extent; inner rings rebuild often (cheap, few k
  samples), outer rings almost never. Rebuild is synchronous v1 (measured
  budget in plan; if a full rebuild ever exceeds ~100 ms, rings amortize
  across frames — plan carries the fallback).
- **Coloring**: per-vertex hypsometric ramp + slope shading reusing
  `terrainTexture.ts`'s color logic (extracted to shared helpers, not
  duplicated), tinted by body class. Biomes are a later stage.
- **Water**: bodies with `ocean_fraction > 0` get a second surface on the
  same grids at `z = −d²/2R` (sea level + curvature), translucent deep-blue,
  drawn after terrain. Dead dry worlds get none.
- **Fog**: exponential distance fog tinted toward the sky dome's horizon
  color, density scaled by atmosphere density; airless bodies get none
  (knife-edge horizon).

### Render integration (two-pass)

`ground.ts` renders in two passes sharing one camera orientation:
1. **Sky pass** — existing scene: starfield, sky dome, sun/moon/planet dome
   meshes, labels. Unchanged behavior, including eclipse ordering.
2. **Terrain pass** — depth cleared, then the clipmap + water render. Terrain
   therefore always occludes sky: moons rise from behind ridgelines.

The flat ground disc is deleted. The terrain scene gets its own ambient +
directional sun lights, driven from the same per-frame sun directions as the
sky pass — but unlike the sky-body phase lights, the terrain's sun lights DO
fade with sun altitude (smoothstep across the horizon, matching the sky
shader's ramp) so the ground itself darkens at night while moons overhead
stay sunlit.

### Walking & standing

- `stepLatLon` keeps its math; the step size becomes true meters:
  `stepDeg = speed_mps · dt · 180/(π·R_body)` with walk speed 1.4 m/s and
  Shift ×5 (fast-travel beyond that is future work).
- Eye height: `camera.z = max(terrain_m + 1.7, water ? 1.0 : −∞)` — the
  camera wades but never submerges (v1).
- The compass HUD gains an elevation readout (`⛰ 1,234 m`); the URL schema
  is unchanged (elevation derives from lat/lon).
- Stand-here still lands on the sub-parent point / clicked point; spawning
  on land specifically is deferred (roadmap).

## Performance envelope

- Elevation sampling is the budget: ~2–5 µs/sample under wasm. Ring sizes
  are chosen so a *full* cold build is ≲ 60 k samples (~150–300 ms, once per
  body entry) and a typical walking rebuild is ≲ 10 k samples (≲ 50 ms,
  every few hundred meters of travel). Numbers verified by a measured spike
  in the plan's first task.
- Geometry buffers are reused across rebuilds (no per-rebuild allocation).

## Testing

- **Rust**: micro-detail continuity property test (worst adjacent jump bound
  on a fine grid); spectrum-seam test (`|elevation_fine − to_meters(elevation)|`
  bounded by the micro amplitude budget); existing goldens byte-identical
  (regression gate, no regeneration); new fine-elevation hash golden
  (64×32 grid, anchor bodies, seeds 1/42/123456789) pinned natively **and**
  in the wasm32 parity suite.
- **TS unit**: ENU↔lat/lon vertex mapping (incl. lon wrap, pole clamp,
  antipode safety); curvature drop math; recenter hysteresis (no rebuild
  under threshold, rebuild past it); walk-speed meters→degrees; water
  present iff ocean_fraction > 0; two-pass structure (terrain scene exists,
  ground disc gone); eye-height clamp.
- **Live QA**: Playwright pass on seed 42 anchor coast + seed
  3630539713810705175 IVa (airless-horizon check), screenshots reviewed.

## Out of scope (deferred)

Flight/altitude LOD, erosion, rivers, slope-limited walking/collision,
shadows, waves, spawn-on-land, biome coloring, ground-level texture splatting.

## Open items flagged for Nathan

1. Pedestrian-first (no flight) — assumed from the walking UX investment.
2. True-scale relief and curvature, no exaggeration — assumed from the
   "physically grounded" ethos.
3. Water as translucent static surface (no waves) — cheapest credible v1.
4. Micro-detail floor at ~50 m wavelength — enough for hills/valleys
   underfoot; rock-scale detail would need normal maps (later).
