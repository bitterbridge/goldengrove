# Goldengrove v3 — Climate & Biomes Design

**Date:** 2026-07-05
**Status:** Draft — Nathan was away during brainstorming; all decisions take
the recommended option and are flagged in "Open items" for his review.

## Goal

Deterministic climate derived from each system's real physics, classified
into biomes that color both the orrery textures and the ground-view terrain.
A hot close-in world grows real deserts; a high-tilt world grows wide
seasonal belts; mountains cast rain shadows because the plates put them
there.

## Constraints Inherited

- Determinism: same seed → identical output forever. Climate uses ZERO new
  RNG draws — it is a pure function of existing facts (star luminosity,
  orbit, axial tilt, atmosphere, radius) and the existing elevation field.
  Nothing reshuffles; descriptor + coarse/fine terrain goldens stay
  byte-identical.
- All transcendentals via `gg_core::math`; wasm32 canonical; new biome
  goldens pinned natively and in the wasm parity suite.
- No descriptor change; `SCHEMA_VERSION` stays 2. Climate computes lazily
  per body, cached like `TerrainSpec`.

## Architecture

### New crate `gg-climate` (deps: gg-core, gg-gen, gg-terrain)

```
ClimateSpec::for_body(seed, desc, body_index, &TerrainSpec) -> Option<ClimateSpec>
  temperature_k(lat, lon)  -> f64   // annual mean, exact per point
  moisture(lat, lon)       -> f64   // 0..1, bilinear from the moisture grid
  biome(lat, lon)          -> Biome // classification of (T, M, elevation)
  biome_grid(w, h)         -> Vec<u8>  // equirect class indices (texture path)
  info()                   -> ClimateInfo { mean_temp_k, ice_fraction, … }
```

- **Temperature** (exact per point):
  `T_eq` from stellar flux at the body's orbital distance (Bond albedo 0.3,
  greenhouse ΔT = 30 K × atmosphere density), shaped by mean-annual
  insolation vs latitude for the body's true axial tilt (closed-form
  approximation: `insol(φ) ∝ cos(max(0, |φ| − tilt·0.4))`, exact constants
  pinned in the plan), minus lapse `6.5 K/km × max(0, elevation_fine_m)`.
- **Moisture grid** (128×64 equirect, computed once in `for_body`):
  latitude bands `wet(0°) → dry(±25°±tilt shift) → wet(±55°) → dry(poles)`
  as a smooth closed-form curve; × rain shadow — integrate positive relief
  along the prevailing zonal wind (easterly below 30° latitude, westerly
  above) over 8 upwind samples spanning ~1200 km; × continentality — the
  underwater fraction of a ~500 km sampling ring around the point (from the
  elevation field, sea level 0). ~66k elevation samples once per body
  (≈0.3 s native, well under a second under wasm; lazy).
- **Biome classification** (pure function of T, M, elevation, world state):
  13 classes — DeepOcean, Shelf, Shore, IceCap, Tundra, BorealForest,
  TemperateForest, Grassland, Savanna, TropicalRainforest, HotDesert,
  ColdDesert, AlpineRock (Shore = |elevation| within a small band of 0).
  Thresholds Köppen-flavored, pinned in the plan. World-state handling:
  Living = full table; Doomed = same climate but classification biased one
  step toward the arid/barren neighbor (stressed biosphere); Dead = no
  ClimateSpec (None) — today's barren rendering is untouched.

### WASM boundary (gg-wasm `World`)

- `body_biome_grid(body_index, w, h) -> Uint8Array` (empty for
  non-climate bodies) — orrery texture path.
- `body_biomes(body_index, coords: &[f64]) -> Uint8Array` — batched
  class-per-lat/lon, one call per terrain tile build (parallel to
  `body_elevations`).
- `body_climate_info(body_index) -> Result<String, JsError>`.
- Reuses the per-body lazy cache pattern (`with_terrain` → `with_climate`,
  holding the TerrainSpec reference it needs).

### Rendering

- **Orrery textures** (`web/src/views/terrainTexture.ts`): the hypsometric
  ramp is replaced for climate bodies by a biome palette lookup (class →
  RGB) shaded by the existing slope/elevation shading; dead worlds keep the
  current dry ramp. Palette pinned in the plan as 13 RGB constants shared
  with the ground path (single source of truth in one TS module).
- **Ground tiles** (`tileMesh.ts`/`terrainGlobe.ts`): tile builds make one
  extra batched call (`body_biomes`) over the same grid coords; vertex
  colors come from the shared palette (biome base color modulated by the
  existing elevation shading). Water tiles unchanged.
- **Ice**: IceCap class renders white in both paths — polar caps and high
  peaks emerge from the same classification, no special-casing.

## Testing

- Rust property tests (multiple seeds): biome grid covers only valid
  classes; equator hotter than poles on low-tilt worlds; moisture higher on
  ocean-adjacent land than deep-continental land at equal latitude; rain
  shadow — lee side of a detected major relief ridge drier than windward at
  equal latitude; lapse — high-elevation points colder than sea-level
  points at the same latitude; Dead worlds → None; Doomed ≠ Living
  classification on some cells for the same fields.
- Biome goldens: FNV-1a hash of the 256×128 `biome_grid` for seeds
  1/42/123456789 per climate body, pinned natively AND under wasm32.
  Existing descriptor + terrain goldens byte-identical (regression gate).
- TS: palette completeness (13 classes ↔ 13 colors), texture path picks
  biome palette for living/doomed and hypsometric for dead, tile builder
  passes biome classes through to vertex colors, shared-palette module used
  by both paths (no duplicated tables).
- Live QA: seed 42 anchor from orbit (visible climate banding: polar caps,
  equatorial band), ground-level forest/desert transition walk, a doomed
  world's stressed palette, a dead world unchanged, IVa (airless moon —
  cold desert/rock, no vegetation).

## Open items flagged for Nathan (all recommended-path)

1. Physically-anchored heuristic (not full energy-balance simulation, not
   bare latitude bands).
2. New `gg-climate` crate rather than growing gg-terrain.
3. Static annual-mean climate; seasons (moving snowline etc.) deferred.
4. 13-class Köppen-flavored biome set; Doomed = one-step-arid bias; Dead
   untouched.
5. Palette direction: natural/earthy (swatches in the visual companion for
   review) — final RGBs pinned at plan time.

## Deferred

Seasonal variation, weather/clouds, rivers/lakes, erosion coupling, biome
detail textures at walking scale, named regions.
