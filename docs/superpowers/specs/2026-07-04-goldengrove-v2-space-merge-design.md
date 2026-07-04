# Goldengrove v2 — Space-View Merge Design (Local Space, True Sky)

**Date:** 2026-07-04
**Status:** Approved (brainstorming with Nathan; scope = option A "local space,
true sky"; hover frame = "blend to inertial at altitude" — his call, planet
turns beneath you).

## Goal

One continuous true-scale scene from footsteps to high orbit around the
standing body: the sky-dome projection dies, every body renders at its true
position and radius, and hovering high decouples you from the planet's
rotation so the world turns below. The asinh orrery remains as the map view;
travel to other bodies remains orrery-click / stand-here. Interplanetary
cruising, orbital mechanics, and other-body terrain-from-orbit are later
stages.

## Constraints Inherited

- Determinism contract untouched: this is pure render/UX work — no gg-gen /
  gg-terrain changes, no golden churn.
- Log depth buffer + camera-relative f64 (RTC) already shipped in Plan 2a/2b
  and are the enabling substrate.
- URL sharing: `view=ground` gains `alt=` (meters, omitted when 0). Existing
  links unchanged in meaning. `view=space` (orrery map) untouched.

## Architecture

### The local-space scene (replaces the ground view's sky-body handling)

The terrain pass becomes the local-space scene; the sky pass shrinks to
starfield + atmosphere dome only.

- **True-position bodies**: each frame, every body's ephemeris position is
  taken relative to the OBSERVER's world position (f64 subtraction before
  f32 assignment — same RTC discipline as terrain tiles) and rendered at
  true radius. Meshes reuse the orrery's textured spheres
  (terrainCache/proceduralBodyTexture); the standing body itself is the
  quadtree globe, as today.
- **Dot floor**: bodies whose true angular size falls below ~2 px render as
  unlit screen-space sprite dots (suns keep a glow sprite) so the sky stays
  readable at real angular scales. Threshold in pixels, derived from camera
  fov + viewport height.
- **Lighting**: one directional light per star, aimed from its true
  direction, lighting ALL lit meshes in the scene. The per-body phase-light
  hack, the dome distance ranking (850–950), and its eclipse ordering are
  deleted — phases, eclipses, and occultations emerge from geometry + depth.
- **Atmosphere/stars**: sky dome (with its altitude falloff) and starfield
  stay in the first pass. Fog unchanged.
- **Labels**: CSS2D labels attach to true-position meshes/dots; the existing
  hide-on-view-switch lifecycle is preserved.

### Rotational decoupling (hover frame)

Observer state remains `(lat, lon, alt)` in the body frame. Each frame:

```
w = 1 − smoothstep(alt, 0.05·R, 0.5·R)      // 1 = carried by ground, 0 = inertial
lonDeg -= (1 − w) · spinRateRadPerS · dt · 180/π
```

`spinRateRadPerS` is derived TS-side from two ephemeris samples
(`(rot(t+Δ) − rot(t)) / Δ` with Δ = 60 s, unwrapped mod 2π) — no WASM API
change; the rate is effectively constant per body at render timescales. On the ground nothing
changes; high up, the planet turns beneath you; descending, you land where
the planet has carried the ground. Poles: lon slip is a no-op at |lat| 89
(already clamped). The URL shares `(lat, lon, alt)` at the shared `t` —
exact moment reproduction, no schema ambiguity.

### Camera & movement

- Pitch clamp widens to ±89° (look straight down past your feet).
- Descent brake: vertical rate = `max(2, min(alt/3, aboveTerrainM/2))` when
  descending; ascent stays `max(2, alt/2)`. Flare onto mountains instead of
  slamming; the 2 m/s floor preserves fine landing control.
- Horizontal speed unchanged (`groundSpeedMps`).
- `alt` participates in eye/LOD exactly as `flightAltM` does today (it IS
  flightAltM, now URL-shareable).

## What is deleted

`ground.ts` dome-projection block (ranked dome distances, MIN_APPARENT_RAD
scaling against dome units, per-body phase lights), `DOME_NEAR/DOME_FAR`.
The moon-at-night regression test is REPLACED by a true-scale equivalent:
a body opposite the sun from the observer at night must still be lit by the
star's directional light (same physical assertion, new mechanism).

## Testing

- **Unit (TS)**: decoupling — w curve endpoints and monotonicity, longitude
  slip integrates spin rate, zero slip on the ground, URL round-trip with
  `alt`; true placement — a fixture moon's rendered direction from the
  observer matches the ephemeris direction (dot > 0.9999), its angular size
  matches radius/distance; dot floor — sub-threshold bodies are sprites,
  super-threshold are meshes; descent brake curve values; pitch clamp.
- **Scene tests**: no dome constants remain; per-star directional lights
  exist and are ungated by observer horizon (the moon-at-night successor).
- **Live QA**: watch a moon transit at true scale from a 5,000 km hover;
  hover high on a fast-spinning body and confirm ground drift; descend and
  land off-target; eclipse pass on seed 3630539713810705175; orrery map
  untouched.

## Deferred

Interplanetary free cruise (warp/autopilot design), orbital mechanics and
momentum, other bodies' quadtree terrain seen from orbit (textured spheres
suffice until approach is possible), underwater, starfield wide-FOV
distortion investigation (roadmap #12 — likely fov/projection, orthogonal
to this stage).
