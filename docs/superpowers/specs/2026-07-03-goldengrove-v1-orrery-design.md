# Goldengrove v1 — Orrery Design

**Date:** 2026-07-03
**Status:** Approved (brainstorming session with Nathan)

## Vision

Goldengrove is a browser tool for creating and exploring realistic fantasy solar
systems. Worlds are **purely procedural from a single 64-bit seed** — there is no
editing, in v1 or ever. The seed *is* the world: sharing a world means sharing a
URL, and every system anyone finds is permanently reproducible.

The long arc adds pluggable generation stages on top of this foundation —
tectonics, ocean currents, wind, biomes, mineral deposits, civilizations. Each
stage is a pure function consuming the previous stage's output. **V1 is the
orrery**: the star system itself, experienced from space and from the ground,
with real calendars.

## V1 Scope

In scope:

- Procedural generation of a full star system from a seed (stars, planets,
  moons, derived calendars), physically grounded.
- **Space view**: navigable 3D orrery with time control.
- **Ground view**: stand at a point on a planet and watch its sky — sunrises,
  moonrises and phases, eclipses, stars — computed from the same ephemeris.
- **Derived calendars** per anchor planet, with the current local date shown as
  time runs.
- **Sharing** via URL (seed + optional time/camera state). No backend.

Out of scope for v1 (future stages): terrain/tectonics, ocean currents, wind,
biomes, resources, civilizations, N-body evolution, any server or gallery.

## Architecture

Layered deterministic pipeline. Generation is a pure function of the seed;
positions come from closed-form evaluation at any timestamp. No ticking, no
drift, no server.

```
seed: u64 ──▶ generate() ──▶ SystemDescriptor (plain data)
SystemDescriptor + t ──▶ ephemeris(t) ──▶ body positions/orientations
SystemDescriptor + body + t ──▶ calendar date
```

### Repo layout

```
goldengrove/
├── crates/
│   ├── gg-core/        # Pure Rust: seeded RNG, units, orbital math. No wasm deps.
│   ├── gg-gen/         # seed → SystemDescriptor
│   ├── gg-ephemeris/   # SystemDescriptor + t → body states
│   └── gg-wasm/        # thin wasm-bindgen wrapper
├── web/                # Vite + TypeScript + three.js
│   └── src/
│       ├── sim/        # typed wrapper around the WASM module
│       ├── views/      # space view, ground view
│       └── ui/         # time controls, panels, seed/share
└── docs/
```

`gg-core`, `gg-gen`, and `gg-ephemeris` are plain Rust crates with zero browser
dependencies — testable with `cargo test`, runnable natively, reusable outside
the web app.

### WASM boundary

Coarse and data-oriented — three calls, no chatty per-object traffic:

- `generate(seed: u64) → SystemDescriptor` (JSON; once per world)
- `ephemeris(t: f64) → Float64Array` (positions + orientations for all bodies;
  once per frame)
- `calendar(body_id, t) → date info`

The TS side treats the sim as a black box that answers "where is everything at
time *t*?" and owns everything visual.

### Determinism contract

Same seed → bit-identical `SystemDescriptor`, everywhere, forever. This is what
makes shared links eternal, so it is a hard contract:

- Seeded PRNG (PCG or ChaCha family) — never environment entropy or time.
- Samples drawn in fixed order. New features fork **child RNG streams** rather
  than adding draws to existing streams, so future versions don't reshuffle
  existing worlds.
- No iteration-order-dependent collections in generation paths.
- Golden-file tests pin descriptor bytes for known seeds; an intentional break
  requires a schema version bump.

## Generation Model

Hierarchical; each level constrains the next. All physically grounded: real
relationships enforced, no long-term N-body integration.

1. **Stars.** Sampled from an initial-mass-function-weighted population, biased
   toward interesting F/G/K stars (every seed should be worth visiting). Mass →
   luminosity, temperature, color, radius via main-sequence relations.
   Binary/trinary systems at realistic rates with hierarchical orbits (close
   pair + circumbinary planets, or wide separation with per-star systems).
2. **Planets.** Orbits spaced by mutual-Hill-radius stability criteria
   (stability enforced analytically, not simulated). Mass, radius, and density
   consistent with composition class (rocky / ice giant / gas giant relative to
   the frost line); axial tilt, rotation period, eccentricity. Habitable zone
   computed from stellar luminosity.
3. **Anchor planet guarantee.** Every system contains at least one terrestrial
   planet in or near the HZ — the default ground-view target. *Usually alive,
   occasionally doomed or dead*: a moon spiraling toward Roche breakup, a star
   leaving the main sequence, a runaway greenhouse. Rare enough to feel like a
   discovery. This is a deliberate thumb on the scale versus pure realism.
4. **Moons.** Sampled within each planet's Hill sphere (inner/outer bounds
   enforced), plausible masses, tidal locking applied where timescales dictate.
   Moon synodic periods drive months.
5. **Derived quantities** stored in the descriptor: solar vs sidereal day,
   year length in local days, synodic periods of moons as seen from the
   planet, relative tidal ranges, calendar structure, and doom dates where
   applicable.

## Time, Ephemeris & Calendars

**Time model.** One global sim time `t`: f64 seconds from a per-seed epoch. The
UI maps wall time → sim time with a speed multiplier (pause, 1× … ~10⁶×) plus
direct date jumps. Closed-form ephemeris makes jumping free.

**Ephemeris.** Keplerian elements evaluated at `t` (Newton's method on Kepler's
equation), transformed through the orbital hierarchy (moon → planet →
barycenter → star). Rotation is a phase from spin period + axial tilt. Output
is one flat typed array per call. ~50 bodies max; microseconds per frame.

**Secular rates (in v1).** Elements carry linear drift rates — ω(t) = ω₀ + ω̇·t
— evaluated closed-form, preserving instant time-jumps and determinism:

- **Apsidal precession**, including the GR contribution (a single analytic term).
- **Nodal regression** of moon orbits → real eclipse cycles (saros-like rhythms).
- **Axial precession** → pole stars change over millennia; calendars drift
  against the seasons.
- **Tidal migration** → slow drift of moon semi-major axis and planet spin
  period; a doomed moon's Roche-crossing date is computable and scrubbable.

**Pluggable ephemeris.** `Ephemeris` is a trait: anything mapping
`(descriptor, t) → body states`. V1 ships `KeplerSecular`. A future
`CompiledNBody` provider (integrate once at generation, compress to Chebyshev
segments, evaluate closed-form within a bounded time range) can slot in behind
the same WASM API. All four secular rates above are populated by the v1 generator;
the schema principle is broader — reserve fields for foreseeable physics from
day one so later features never reshuffle the schema or RNG draws.

**Calendars.** Derived per anchor planet at generation time:

- **Day** = solar day (calendars care about sunrises, not sidereal rotation).
- **Year** = orbital period in local days; the fractional remainder yields a
  natural leap rule via continued-fraction expansion (e.g. "+1 day every 4th
  year, skip every 128th"). Unique leap-year drama per world.
- **Months** from the synodic period of the dominant moon; multi-moon worlds
  get competing cycles; moonless worlds get a purely solar calendar.
- The UI shows the current local date as time runs; the ground view lets you
  verify the calendar against the sky (the full moon is full on day 1).

Deliberate simplifications: no relativistic effects beyond the GR precession
term, no orbital chaos, no true N-body evolution in v1.

## Rendering & Views

**Space view.** three.js scene fed by the per-frame ephemeris array. Physics is
true-scale internally; the renderer applies view-space compression (gently
log-compressed distances, minimum apparent body size) with a "true scale"
toggle. Orbit lines, labels, click-to-focus (focusing a planet zooms to its
moon system). Orbit-style camera (drag-rotate, wheel-zoom); no free flight.

**Ground view.** Click a spot on a planet → "stand here" (default: equatorial
site on the anchor planet). Everything in the sky is computed, not painted:
sun(s) at true positions with an atmospheric-scattering sky shader (binary
suns produce genuinely strange twilights), moons at correct angular size,
phase, and position (procedurally textured from seed), and a seed-derived
starfield. Ground is a flat horizon in v1 — terrain is a later stage.

**Layout: "Cinematic".** Full-bleed 3D with a floating HUD: time controls
(bottom center), calendar/date readout (top right), seed + share (top left),
selected-body info panel (right, on selection). The system tree lives in a
slide-out drawer, not a fixed sidebar. Fast-follow after v1: a "twin lens"
picture-in-picture orrery inset while in ground view, click to swap.

## Sharing

The URL is the save file:

```
…/#seed=7F3A11&t=13042992000&view=ground&body=2&lat=31.2&lon=-47.8
```

Seed plus optional time/camera state; a shared link reproduces the exact
moment and vantage. Static hosting suffices (e.g. GitHub Pages). Any future
gallery/community is a separate project that stores seeds.

## Testing

- **Determinism**: golden-file tests assert `generate(seed)` is byte-identical
  for pinned seeds. Breaking changes require a schema version bump.
- **Physics property tests** over thousands of random seeds: orbits within
  parent Hill spheres; Kepler's third law consistency; HZ math matches
  published values for Sun-like inputs; leap rules keep calendars aligned over
  10,000 simulated years; ephemeris at `t` and `t + period` agree to tolerance.
- **Cross-boundary**: TS wrapper round-trips a descriptor against Rust-side
  JSON so the WASM boundary can't silently drift.
- **Rendering**: smoke tests only in v1 (scene builds for N seeds); visual
  correctness by eyeball.

## Error Handling

Any u64 is a valid seed, so generation cannot fail from user input. Policy:

- **Generator bugs fail loudly.** A rejection-sampling loop that can't satisfy
  constraints after N retries panics with seed + stage; the WASM boundary
  catches it and shows a "this seed found a bug — please report it" card.
  Never silently emit a degenerate system.
- **WASM load failure** → plain-HTML fallback message.

## Decisions Log

| Decision | Choice |
|---|---|
| V1 target | Orrery (system + ground sky view), terrain later |
| Authoring | Purely procedural from a single seed; no editing, ever |
| Perspective | Space view + ground view both in v1 |
| Stack | Rust→WASM sim core; TypeScript + three.js frontend; no server |
| Realism | Physically grounded (relations enforced; no N-body integration) |
| Calendars | In v1, derived from orbital data |
| Core shape | Layered deterministic pipeline + closed-form ephemeris (over ECS / GPU-first) |
| Secular effects | In v1 as linear element drift; ephemeris pluggable for future N-body provider |
| Layout | Cinematic full-bleed HUD; system-tree drawer; twin-lens inset as fast-follow |
| Anchor planet | Guaranteed terrestrial in/near HZ; occasionally doomed or dead |
