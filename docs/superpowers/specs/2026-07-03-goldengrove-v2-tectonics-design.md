# Goldengrove v2 — Tectonics Design

**Date:** 2026-07-03
**Status:** Approved (brainstorming session with Nathan)

## Goal

Rocky worlds get deterministic, kinematically consistent plate-tectonic
terrain, surfacing first as real continent/ocean/mountain textures in the
orrery. First stage of the long arc's pluggable generation pipeline.

## Constraints Inherited From v1

- **Determinism**: same seed → identical terrain, everywhere, forever. All
  randomness through `RngStream` child streams; all transcendentals through
  `gg_core::math` (libm); wasm32 is the canonical target.
- **No descriptor change**: terrain derives on demand from
  `(seed, &SystemDescriptor, planet_index)`. `SCHEMA_VERSION` stays 2;
  existing descriptor goldens stay byte-identical.
- Lat/lon convention identical to `observer.ts` (planet basis from spin axis
  + rotation; lat from pole, lon from the world-X-projected prime meridian)
  so later stages consume elevation without translation.

## Architecture

New pure crate `gg-terrain` (deps: gg-core, gg-gen types). Entry:

```
TerrainSpec::for_body(seed: u64, desc: &SystemDescriptor, body: BodyIndexing) -> TerrainSpec
elevation(&self, lat_deg: f64, lon_deg: f64) -> f64      // sea level = 0
heightmap(&self, width, height) -> Vec<f32>               // equirect, row-major
info(&self) -> TerrainInfo { sea_level, ocean_fraction, relief_m, plate_count, … }
```

Applies to rocky planets AND moons (standable bodies). Giants have no terrain.

## Generation Model (kinematic plates)

1. **Plates**: 8–16 seeded points on the sphere (count scales with body
   radius); spherical Voronoi by geodesic distance. Each plate: oceanic or
   continental (weighted by a per-body land-fraction draw), an Euler pole
   (random unit vector), and an angular rate.
2. **Boundaries from motion**: at a surface point, the nearest two plates
   define the boundary; relative velocity Δv = ω₁(P₁×p) − ω₂(P₂×p) decomposed
   against the boundary normal/tangent classifies it. Convergent
   continent-continent → mountain belts; ocean-continent → coastal cordillera
   + offshore trench; divergent → mid-ocean ridge / rift valley; transform →
   fault ridging. Feature amplitude scales with closing speed; falls off with
   geodesic distance from the boundary.
3. **Detail**: domain-warped fBm noise between boundaries; occasional hotspot
   chains. All amplitudes in relative units, scaled to a per-body relief
   figure (smaller bodies → proportionally rougher, absolute relief lower).
4. **Sea level**: solved (bisection over the heightmap distribution) so ocean
   coverage matches a seeded draw — Living/Doomed: 0.20–0.85;
   Dead: 0.00–0.15 (dry basins). Elevation output is relative to it (0 = shore).

## WASM Boundary

- `planet_heightmap(body_index: usize, width: usize, height: usize) -> Float32Array`
  — equirect, row 0 = lat +90°, elevations with sea level at 0.
- `planet_terrain_info(body_index: usize) -> String` (JSON: `sea_level`,
  `ocean_fraction`, `relief_m`, `plate_count`).
- Non-terrain bodies (stars, giants): empty array / error JSON — renderer skips.
- Lazy: computed on first call; JS caches per body.

## Orrery Surfacing

Pure TS module `terrainTexture(heightmap, info, classHex, worldState)`:
hypsometric ramp (abyss→shelf blues below 0; coast/lowland/upland/peak above),
slope shading from finite-difference normals, tinted toward the body's class
palette. Dead worlds: dry-basin browns, no blues. Applied as the `map` of
rocky planets' and moons' space-view materials (giants keep procedural
blotches). Ground view untouched this plan — except moons' parent planets
render with their new textures for free. 512×256 default resolution.

## Testing

- **Rust property tests** (many seeds): full plate coverage; Δv antisymmetry
  across boundaries; bounded elevation; solved ocean fraction within ±0.03 of
  its draw; convergent continent-continent boundary elevations exceed plate
  interiors on average.
- **Terrain goldens**: FNV-1a hash of the quantized (i16) 256×128 heightmap
  per terrain body for seeds 1, 42, 123456789 — pinned natively and in the
  wasm32 parity gate.
- **TS**: hypsometric mapper + normal shading unit tests; scene test (rocky
  bodies textured, giants not). All existing suites and descriptor goldens
  pass unchanged.

## Deferred (later stages)

Ground-view 3D terrain (consumes `elevation(lat, lon)`); climate/biome
palettes; erosion; rivers; terrain-aware stand-here UI.
