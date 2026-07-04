# Goldengrove Roadmap

The long arc: physically-grounded solar systems → living worlds → an
immersive, MUD-like experience on their surfaces. Everything derives from a
single u64 seed — no editing, ever. Each new generation stage forks new RNG
child streams so existing worlds never reshuffle and shared links never break.

Status legend: items are unordered within sections; sections are roughly in
dependency order. Completed work lives in `docs/superpowers/plans/` and the
git history, not here.

## Near-term polish (Plan 5)

1. Twin-lens orrery inset — system overview + zoomed lens simultaneously
   (fast-follow from the v1 spec).
2. System-tree drawer — click-to-navigate body hierarchy.
3. Doomed/dead-planet badges in the HUD.
4. Dusk light-ramp fix — sun light cuts off at a different threshold than the
   sky shader, so twilight pops instead of fading.
5. Moon-texture upgrade in ground view — sky moons still use procedural
   blotches; parent planets already got tectonic textures.
6. Ground-view phase-lighting fix — waxing/waning illumination of large sky
   bodies snaps (crescent → new → crescent → new → full) instead of growing
   smoothly. Reported on seed 3630539713810705175, standing on IVa watching IV.

## Terrain (finishing what tectonics started)

7. Triple-junction fade tuning — the 0.4 rad fade width thins mountain belts
   near plate corners; aesthetic pass.
8. Trench/ridge window retuning at higher texture resolutions.
9. **Ground-view 3D terrain** — the big one. `elevation(lat, lon)` already
   exists; the ground view doesn't consume it yet. Real horizons, standing on
   a mountain, coastlines you can walk to.
10. Texture seam & pole polish — equirect artifacts at lon ±180° and the poles.
11. Terrain-aware stand-here — spawn on land; show elevation in the HUD.
12. Erosion pass — fluvial/thermal; softens the tectonic skeleton.
13. Rivers and lakes — flow-routing over the heightmap.

## Climate & life (the next big generation stage)

14. Climate model — insolation from the actual orbit (axial tilt,
    eccentricity → real seasons), latitude bands, rain shadow from the
    mountains we already generate.
15. Biome palettes — climate × elevation → tundra/desert/forest coloring;
    dead and doomed worlds get their own looks.
16. Ocean currents & wind — named in the v1 spec's future list; feeds climate.
17. Weather in ground view — clouds and haze tied to atmosphere density.
18. Seasonal rendering — same world, different date, different snowline.

## Deep-time & astronomy upgrades

19. Galactic context — simulate (in broad strokes) the galaxy the system sits
    in: seeded distance from the galactic core, a Milky-Way-like band in the
    sky when appropriate, richer star-density gradients; possibly a rendered
    supermassive black hole for systems seeded near the core.
20. `CompiledNBody` ephemeris provider — integrate once at generation,
    compress to Chebyshev segments; the pluggable ephemeris slot was designed
    for exactly this.
21. Asteroid belts, comets, rings — giants are visually bare without rings.
22. Eclipse/transit prediction — a "next interesting event" button; the dome
    ranking already produces eclipses.
23. Axial-tilt seasons surfaced in calendars — solstice/equinox markers.

## The MUD-shaped horizon

24. Named places — procedural naming for continents, seas, ranges
    (seed-derived, honors the no-editing rule).
25. Flora/fauna generation — per-biome, seed-derived.
26. Resources & civilizations — explicitly out-of-scoped in v1, still the
    destination.
27. Points of interest + efficient travel between them.

## Infrastructure & sharing

28. CI supply-chain hardening — pin binaryen or set wasm-opt=false; the one
    flaky download left in CI.
29. Sea-level bracket headroom `debug_assert` — empirical raw max 4.97 vs the
    ±6 bisection bracket; cheap insurance.
30. Seed gallery — a separate static page of curated seeds (e.g. the
    emergent-libration world 3630539713810705175).
31. Screenshot/postcard export — the share button, but for images, with
    seed + URL baked into a caption.
