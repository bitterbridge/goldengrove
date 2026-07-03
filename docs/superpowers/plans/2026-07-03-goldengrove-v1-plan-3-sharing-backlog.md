# Goldengrove v1 — Plan 3: URL Sharing + Backlog Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared links reproduce the exact moment (`#seed=…&t=…&view=…`), a date-jump control lands on any calendar date, and the Plan-2 backlog is retired — clearing the runway for Plan 4 (ground view).

**Architecture:** The host-origin convention collapses to ONE authority (`gg-wasm::host_origin_at`, pinned against gg-ephemeris; the TS reimplementation is deleted). App state gains a parse/serialize module over the URL hash; share writes the hash via `history.replaceState` (no reload) and copies to clipboard; date-jump inverts the calendar in pure TS math mirrored from the Rust leap rules. CI actions get supply-chain pins.

**Tech Stack:** existing stack; no new dependencies (Rust or JS).

## Global Constraints

- **No generation changes**: golden files must be byte-identical at the end of every task (`git diff --stat crates/gg-gen/tests/golden/` empty).
- The URL hash is the ONLY persistence. Ground-view fields (`view=ground`, `body`, `lat`, `lon`) are parsed, preserved, and re-serialized now; rendering them arrives in Plan 4 (this plan renders the space view regardless of `view`).
- Share must NOT trigger a reload: hash updates for sharing go through `history.replaceState` (never fires `hashchange`); only user-initiated seed changes (reroll, manual hash edit) reload.
- Seeds are canonical decimal u64 strings (leading zeros stripped: `007` → `7`).
- Every commit: `cargo test --workspace` green, `cd web && npx vitest run && npx tsc --noEmit` green, no warnings.

---

### Task 1: host_origin_at — single authority in gg-wasm

**Files:**
- Modify: `crates/gg-wasm/src/flatten.rs` (add `host_origin_at`)
- Modify: `crates/gg-wasm/src/lib.rs` (expose on `World`)
- Modify: `crates/gg-wasm/tests/flatten.rs` (new test)
- Modify: `crates/gg-wasm/tests/wasm_golden.rs` (boundary test extension)
- Modify: `web/src/sim/wasm.ts` (Sim gains `hostOriginAt`)
- Modify: `web/src/views/space.ts` (DELETE `hostOriginM`; `update()` takes `originM`)
- Modify: `web/src/main.ts` (pass origin per frame)
- Modify: `web/src/views/space.test.ts` (fakeSim + signature updates)

**Interfaces:**
- Consumes: `KeplerSecular::{states_at, desc, host_mass}`, `PlanetHost`.
- Produces: Rust `flatten::host_origin_at(eph: &KeplerSecular, t_s: f64) -> [f64; 3]`; JS `World.host_origin_at(t_s: number) -> Float64Array` (3 floats, meters); TS `Sim.hostOriginAt(tS: number): Float64Array`; `SpaceView.update(states: Float64Array, trueScale: boolean, originM: Float64Array): void` (breaking signature change, all call sites updated in this task).

- [ ] **Step 1: Write the failing Rust test**

Append to `crates/gg-wasm/tests/flatten.rs`:

```rust
#[test]
fn host_origin_matches_ephemeris_convention() {
    use gg_gen::descriptor::PlanetHost;
    let mut saw_barycenter = false;
    for seed in 0..120u64 {
        let desc = gg_gen::generate(seed);
        let host = desc.planet_host;
        let eph = KeplerSecular::new(desc);
        for &t in &[0.0, 1.0e7, 3.0e9] {
            let origin = gg_wasm::flatten::host_origin_at(&eph, t);
            let states = eph.states_at(t);
            let d = eph.desc();
            let expected = match host {
                PlanetHost::Primary => states[0].position_m,
                PlanetHost::Barycenter => {
                    let (m0, m1) = (d.stars[0].mass_kg, d.stars[1].mass_kg);
                    let (p0, p1) = (states[0].position_m, states[1].position_m);
                    let w = m0 + m1;
                    [
                        (m0 * p0[0] + m1 * p1[0]) / w,
                        (m0 * p0[1] + m1 * p1[1]) / w,
                        (m0 * p0[2] + m1 * p1[2]) / w,
                    ]
                }
            };
            assert_eq!(origin, expected, "seed {seed} t {t}");
        }
        if host == PlanetHost::Barycenter {
            saw_barycenter = true;
        }
    }
    assert!(saw_barycenter);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p gg-wasm --test flatten host_origin_matches_ephemeris_convention`
Expected: FAIL to compile — `host_origin_at` doesn't exist.

- [ ] **Step 3: Implement Rust side**

Append to `crates/gg-wasm/src/flatten.rs`:

```rust
/// Host origin (the point planets orbit) at time t, meters.
/// THE single authority for this convention — the web layer must consume
/// this value, never reimplement it (it drifted once already).
pub fn host_origin_at(eph: &KeplerSecular, t_s: f64) -> [f64; 3] {
    let states = eph.states_at(t_s);
    let desc = eph.desc();
    match desc.planet_host {
        PlanetHost::Primary => states[0].position_m,
        PlanetHost::Barycenter => {
            let (m0, m1) = (desc.stars[0].mass_kg, desc.stars[1].mass_kg);
            let (p0, p1) = (states[0].position_m, states[1].position_m);
            let w = m0 + m1;
            [
                (m0 * p0[0] + m1 * p1[0]) / w,
                (m0 * p0[1] + m1 * p1[1]) / w,
                (m0 * p0[2] + m1 * p1[2]) / w,
            ]
        }
    }
}
```

Append inside `#[wasm_bindgen] impl World` in `crates/gg-wasm/src/lib.rs`:

```rust
    /// [x, y, z] of the point planets orbit, meters.
    pub fn host_origin_at(&self, t_s: f64) -> js_sys::Float64Array {
        js_sys::Float64Array::from(flatten::host_origin_at(&self.eph, t_s).as_slice())
    }
```

Extend `world_boundary_marshals_correctly` in `crates/gg-wasm/tests/wasm_golden.rs` — append at the end of the function:

```rust
    let origin = w.host_origin_at(1.0e7);
    assert_eq!(origin.length(), 3);
    assert!(origin.to_vec().iter().all(|v| v.is_finite()));
```

- [ ] **Step 4: Run Rust suites**

Run: `cargo test -p gg-wasm && wasm-pack test --node crates/gg-wasm` (Node >= 20; `nvm use 22` if default is 18)
Expected: PASS (new native test + extended wasm boundary test).

- [ ] **Step 5: Consume it in TS; delete the reimplementation**

`web/src/sim/wasm.ts` — add to the `Sim` interface and the returned object:

```ts
  hostOriginAt(tS: number): Float64Array;
```
```ts
    hostOriginAt: (tS) => world.host_origin_at(tS),
```

`web/src/views/space.ts`:
- DELETE the `hostOriginM` function entirely.
- Change `update(states: Float64Array, trueScale: boolean)` to `update(states: Float64Array, trueScale: boolean, originM: Float64Array)` (and the `SpaceView` interface accordingly). Everywhere the body used `hostOriginM(states)`, use the `originM` parameter (indices `originM[0]!`, `originM[1]!`, `originM[2]!`).

`web/src/main.ts` — the priming call and the frame loop become:

```ts
  view.update(sim.statesAt(0), trueScale, sim.hostOriginAt(0));
```
```ts
    const states = sim.statesAt(clock.t);
    view.update(states, trueScale, sim.hostOriginAt(clock.t));
```

`web/src/views/space.test.ts` — `fakeSim()` gains a consistent fake:

```ts
    hostOriginAt: (tS) => {
      const s = fake.statesAt(tS); // restructure fakeSim to build an object `fake` first so this can self-reference, or compute inline from the same formula statesAt uses
      const m0 = golden.stars[0]!.mass_kg;
      const m1 = golden.stars[1]?.mass_kg ?? 0;
      const w = m0 + m1;
      return new Float64Array([
        (m0 * s[0]! + m1 * (s[7] ?? 0) * Math.sign(m1)) / w,
        (m0 * s[1]! + m1 * (s[8] ?? 0) * Math.sign(m1)) / w,
        (m0 * s[2]! + m1 * (s[9] ?? 0) * Math.sign(m1)) / w,
      ]);
    },
```

(Implementation latitude: the exact fake shape is yours — the CONTRACT is that the fake's `hostOriginAt` computes the mass-weighted pair barycenter from the same states its `statesAt` returns, so existing displaced-system assertions keep their meaning. `Math.sign(m1)` guards the single-star case where indices 7-9 don't exist; if `golden` seed-42 has 2 stars — it does — simplify accordingly.) Update every `view.update(...)` call in the test file to pass `sim.hostOriginAt(t)` as the third argument.

- [ ] **Step 6: Run web suite + typecheck**

Run: `cd web && npm run build:wasm && npx vitest run && npx tsc --noEmit`
Expected: PASS (build:wasm first — the .d.ts must include the new method).

- [ ] **Step 7: Verify goldens untouched and commit**

```bash
git diff --stat crates/gg-gen/tests/golden/   # expect empty
git add crates/gg-wasm web/src
git commit -m "refactor: host-origin convention has one authority (gg-wasm), TS copy deleted"
```

---

### Task 2: Web hardening + CI supply-chain pinning

**Files:**
- Modify: `web/src/ui/seed.ts` (canonicalize; export `parseSeedValue`)
- Modify: `web/src/ui/seed.test.ts`
- Modify: `web/src/sim/parse.ts` (Barycenter ⇒ ≥2 stars)
- Modify: `web/src/sim/parse.test.ts`
- Modify: `web/src/main.ts` (camera.far; remove dead raycaster Line param)
- Modify: `web/src/views/space.ts` (userData instead of `__` cast property-bags)
- Modify: `web/src/views/space.test.ts` (userData; moon vertex-rescale probe)
- Modify: `web/package.json` (@types/node pin `^22.0.0`) + `web/package-lock.json` (via npm install)
- Modify: `.github/workflows/ci.yml` (SHA-pin all actions; replace curl|sh wasm-pack install)

**Interfaces:**
- Consumes: Task 1's merged state.
- Produces: `parseSeedValue(s: string): string | null` in `web/src/ui/seed.ts` (validates a bare decimal-u64 string, returns CANONICAL form; Task 3 consumes it).

- [ ] **Step 1: Write the failing tests**

`web/src/ui/seed.test.ts` — add:

```ts
describe('parseSeedValue', () => {
  it('canonicalizes leading zeros', () => {
    expect(parseSeedValue('007')).toBe('7');
    expect(parseSeedValue('42')).toBe('42');
  });
  it('rejects junk', () => {
    expect(parseSeedValue('')).toBeNull();
    expect(parseSeedValue('-1')).toBeNull();
    expect(parseSeedValue('18446744073709551616')).toBeNull();
  });
});
```

and change the existing hash test's expectation: `parseSeedFromHash('#seed=007')` → `'7'` (add that assertion).

`web/src/sim/parse.test.ts` — add:

```ts
  it('rejects Barycenter host with fewer than 2 stars', () => {
    const d = JSON.parse(goldenJson);
    d.planet_host = 'Barycenter';
    d.stars = [d.stars[0]];
    expect(() => parseDescriptor(JSON.stringify(d))).toThrow(/planet_host/);
  });
```

`web/src/views/space.test.ts` — in the trueScale-flip test, add a moon-line vertex probe (after the existing planet-line probes):

```ts
    // moon orbit-line VERTICES also rescale on flips (previously unprobed)
    const layoutForMoon = bodyLayout(golden);
    const moonIdx2 = layoutForMoon.findIndex((r) => r.kind === 'moon');
    if (moonIdx2 >= 0) {
      const moonLine = lines.children.find((c) => c.name === `orbit-${moonIdx2}`)! as THREE.LineLoop;
      const mAttr = (moonLine.geometry as THREE.BufferGeometry).getAttribute('position');
      const compressedMX = mAttr.getX(1);
      view.update(states, true, sim.hostOriginAt(0));
      expect(mAttr.getX(1)).not.toBeCloseTo(compressedMX, 6);
      view.update(states, false, sim.hostOriginAt(0));
      expect(mAttr.getX(1)).toBeCloseTo(compressedMX, 6);
    }
```

(Adjust variable names to avoid collisions with the existing test body.)

- [ ] **Step 2: Run to verify failures**

Run: `cd web && npx vitest run src/ui src/sim/parse.test.ts`
Expected: FAIL — `parseSeedValue` not exported; Barycenter case not rejected.

- [ ] **Step 3: Implement the web changes**

`web/src/ui/seed.ts` — full new content:

```ts
const U64_MAX = 0xffffffffffffffffn;

/** Validate a bare decimal-u64 string; return its CANONICAL form (leading
 * zeros stripped) or null. The canonical form is what Rust emits back in
 * descriptor JSON, so URLs stay stable round-trip. */
export function parseSeedValue(s: string): string | null {
  if (!/^\d+$/.test(s)) return null;
  const v = BigInt(s); // cannot throw: regex guarantees digits
  return v <= U64_MAX ? v.toString() : null;
}

/** Extract a seed from a legacy `#seed=42`-style hash. */
export function parseSeedFromHash(hash: string): string | null {
  const m = /^#seed=(\d+)$/.exec(hash);
  return m ? parseSeedValue(m[1]!) : null;
}

export function randomSeed(): string {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!.toString();
}
```

`web/src/sim/parse.ts` — right after the `planet_host` variant check, add:

```ts
  if (d.planet_host === 'Barycenter' && (d.stars as unknown[]).length < 2) {
    fail('$.planet_host', 'Barycenter requires at least 2 stars');
  }
```

(Place it after `d.stars` has been validated as an array — reorder the host check below the stars block if needed; keep error path `$.planet_host`.)

`web/src/main.ts`: change `new THREE.PerspectiveCamera(50, 1, 0.001, 5000)` far plane to `20000` (true-scale wide binaries reach ~5600 view units); delete the `ray.params.Line = { threshold: 0.05 };` line (we only raycast meshes).

`web/src/views/space.ts`: replace the `(obj as X & { __followsBody?: number }).__followsBody` pattern with `obj.userData.followsBody` (plain assignment `light.userData.followsBody = i;` and reads `o.userData.followsBody as number | undefined`); replace `__rawPath` with `line.userData.rawPath as Float64Array`. Update the corresponding read in `web/src/views/space.test.ts` (the light-follow traversal).

`web/package.json`: change `"@types/node": "^26.1.0"` to `"@types/node": "^22.0.0"`, then `cd web && npm install` (updates the lockfile).

- [ ] **Step 4: Pin the CI supply chain**

In `.github/workflows/ci.yml`, for BOTH jobs:
- Resolve each action tag to a full commit SHA: `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` (e.g. `gh api repos/actions/checkout/commits/v4 --jq .sha`). Rewrite every `uses:` as `uses: owner/repo@<full-sha> # vN` (keep the human-readable tag as a trailing comment). Actions: actions/checkout@v4, dtolnay/rust-toolchain@stable, Swatinem/rust-cache@v2, actions/setup-node@v4, actions/configure-pages@v5, actions/upload-pages-artifact@v3, actions/deploy-pages@v4. For dtolnay/rust-toolchain, pin the SHA of the `stable` ref and add `toolchain: stable` under its `with:` (the moving ref doubles as the toolchain selector, so pinning requires stating it explicitly).
- Replace both `curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh` steps with the pinned installer action:

```yaml
      - name: Install wasm-pack
        uses: taiki-e/install-action@<full-sha> # v2
        with:
          tool: wasm-pack
```

(resolve `gh api repos/taiki-e/install-action/commits/v2 --jq .sha`).
- Validate: `yq eval '.jobs.test.steps[].uses // .jobs.test.steps[].name' .github/workflows/ci.yml` and same for deploy — every `uses:` line contains a 40-hex SHA; step ORDER unchanged from before this task (compare `yq eval '.jobs.*.steps[].name'` before/after — paste both in the report).

- [ ] **Step 5: Run everything**

Run: `cd web && npx vitest run && npx tsc --noEmit && cargo test --workspace`
Expected: all PASS; goldens untouched (`git diff --stat crates/gg-gen/tests/golden/` empty).

- [ ] **Step 6: Commit**

```bash
git add web .github/workflows/ci.yml
git commit -m "chore: web hardening (canonical seeds, invariants, userData) + CI supply-chain pins"
```

---

### Task 3: App-state URL module

**Files:**
- Create: `web/src/state/url.ts`
- Test: `web/src/state/url.test.ts`

**Interfaces:**
- Consumes: `parseSeedValue` from `web/src/ui/seed.ts` (Task 2).
- Produces (Task 4/5 and Plan 4 rely on these exactly):

```ts
export interface AppState {
  seed: string;                 // canonical decimal u64
  view: 'space' | 'ground';     // ground renders as space until Plan 4
  t: number;                    // sim seconds, >= 0
  speed: number;                // clock multiplier, > 0
  body: number | null;          // focused body index
  lat: number | null;           // degrees, [-90, 90] (ground view, Plan 4)
  lon: number | null;           // degrees, [-180, 180]
}
export function parseAppState(hash: string): AppState | null; // null unless a valid seed present
export function serializeAppState(s: AppState): string;        // '#seed=…&…', defaults omitted
export function defaultAppState(seed: string): AppState;       // space view, t 0, speed 1, nulls
```

- [ ] **Step 1: Write the failing tests**

`web/src/state/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultAppState, parseAppState, serializeAppState, type AppState } from './url';

describe('parseAppState', () => {
  it('parses a full state', () => {
    const s = parseAppState('#seed=42&view=ground&t=86400&speed=3600&body=3&lat=12.5&lon=-47.25');
    expect(s).toEqual({ seed: '42', view: 'ground', t: 86400, speed: 3600, body: 3, lat: 12.5, lon: -47.25 });
  });
  it('defaults everything but the seed', () => {
    expect(parseAppState('#seed=42')).toEqual(defaultAppState('42'));
  });
  it('canonicalizes the seed', () => {
    expect(parseAppState('#seed=007')!.seed).toBe('7');
  });
  it('returns null without a valid seed', () => {
    expect(parseAppState('')).toBeNull();
    expect(parseAppState('#view=ground&t=5')).toBeNull();
    expect(parseAppState('#seed=18446744073709551616')).toBeNull();
  });
  it('sanitizes bad optional values instead of failing', () => {
    const s = parseAppState('#seed=1&t=-5&speed=0&body=-2&lat=999&lon=abc&view=sideways')!;
    expect(s).toEqual(defaultAppState('1'));
  });
});

describe('serializeAppState', () => {
  it('omits defaults', () => {
    expect(serializeAppState(defaultAppState('42'))).toBe('#seed=42');
  });
  it('round-trips a full state', () => {
    const full: AppState = { seed: '42', view: 'ground', t: 123457, speed: 86400, body: 2, lat: 31.21, lon: -47.85 };
    expect(parseAppState(serializeAppState(full))).toEqual(full);
  });
  it('rounds t to whole seconds and coords to 2 decimals', () => {
    const s: AppState = { ...defaultAppState('1'), t: 12.7, lat: 1.23456, lon: 2.34567, view: 'ground' };
    expect(serializeAppState(s)).toBe('#seed=1&view=ground&t=13&lat=1.23&lon=2.35');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/state`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement url.ts**

`web/src/state/url.ts`:

```ts
import { parseSeedValue } from '../ui/seed';

/** Everything a shared link reproduces. The URL hash is the only persistence. */
export interface AppState {
  seed: string;
  view: 'space' | 'ground';
  t: number;
  speed: number;
  body: number | null;
  lat: number | null;
  lon: number | null;
}

export function defaultAppState(seed: string): AppState {
  return { seed, view: 'space', t: 0, speed: 1, body: null, lat: null, lon: null };
}

function finiteInRange(v: string | null, lo: number, hi: number): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
}

/** Tolerant parse: a valid seed is required; every other field falls back to
 * its default rather than failing — a mangled link still opens the world. */
export function parseAppState(hash: string): AppState | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const seed = parseSeedValue(params.get('seed') ?? '');
  if (seed === null) return null;
  const s = defaultAppState(seed);
  if (params.get('view') === 'ground') s.view = 'ground';
  s.t = finiteInRange(params.get('t'), 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const speed = finiteInRange(params.get('speed'), 1e-6, 1e12);
  if (speed !== null && speed > 0) s.speed = speed;
  const body = finiteInRange(params.get('body'), 0, 10_000);
  if (body !== null && Number.isInteger(body)) s.body = body;
  s.lat = finiteInRange(params.get('lat'), -90, 90);
  s.lon = finiteInRange(params.get('lon'), -180, 180);
  return s;
}

/** Fixed key order; defaults omitted so simple links stay simple. */
export function serializeAppState(s: AppState): string {
  const parts = [`seed=${s.seed}`];
  if (s.view !== 'space') parts.push(`view=${s.view}`);
  const t = Math.round(s.t);
  if (t !== 0) parts.push(`t=${t}`);
  if (s.speed !== 1) parts.push(`speed=${s.speed}`);
  if (s.body !== null) parts.push(`body=${s.body}`);
  if (s.lat !== null) parts.push(`lat=${s.lat.toFixed(2).replace(/\.?0+$/, '')}`);
  if (s.lon !== null) parts.push(`lon=${s.lon.toFixed(2).replace(/\.?0+$/, '')}`);
  return `#${parts.join('&')}`;
}
```

Note: the trailing-zero strip means `lat=1.23456` → `1.23` and `lat=1.20` → `1.2`; the round-trip test's expectations (`31.21`, `-47.85`, `1.23`, `2.35`) must hold — if the regex mangles a value like `2.00` → `2`, that still round-trips (parse yields 2). If a test expectation conflicts with the strip behavior, the TEST values above are the contract; adjust the implementation, not the tests.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/state && npx tsc --noEmit`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/state
git commit -m "feat: app-state URL module — parse/serialize the shareable hash"
```

---

### Task 4: Share button, date-jump, boot-from-state

**Files:**
- Create: `web/src/sim/calendar.ts` + `web/src/sim/calendar.test.ts`
- Modify: `web/src/ui/hud.ts` (share button, date-jump form, setActiveSpeed)
- Modify: `web/src/ui/hud.test.ts`
- Modify: `web/src/main.ts` (boot from AppState; share/jump wiring)

**Interfaces:**
- Consumes: `AppState`/`parseAppState`/`serializeAppState`/`defaultAppState` (Task 3); `randomSeed` (Task 2); descriptor `Calendar`/`LeapRule` types.
- Produces:
  - `calendar.ts`: `daysBeforeYear(rule: LeapRule, year: number): number`, `timeAtDate(cal: Calendar, year: number, dayOfYear: number): number` (both 0-based; seconds).
  - `hud.ts`: `HudCallbacks` gains `onShare(): void` and `onDateJump(year: number, dayOfYear: number): void` (0-based); `Hud` gains `flashShared(): void` and `setActiveSpeed(mult: number): void`.

- [ ] **Step 1: Write the failing calendar tests**

`web/src/sim/calendar.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Calendar } from './types';
import { daysBeforeYear, timeAtDate } from './calendar';

const earth: Calendar = {
  solar_day_s: 86400,
  year_solar_days: 365.2422,
  leap: { base_days: 365, terms: [{ every_years: 4, add_days: 1 }, { every_years: 128, add_days: -1 }] },
  months: [],
};

describe('daysBeforeYear', () => {
  it('reproduces the Gregorian-style rule (mirrors Rust days_before_year)', () => {
    expect(daysBeforeYear(earth.leap, 0)).toBe(0);
    expect(daysBeforeYear(earth.leap, 1)).toBe(365);
    expect(daysBeforeYear(earth.leap, 4)).toBe(1461); // year 3's leap day is before year 4
    expect(daysBeforeYear(earth.leap, 10000)).toBe(3652422);
  });
});

describe('timeAtDate', () => {
  it('converts a date to sim seconds', () => {
    expect(timeAtDate(earth, 0, 0)).toBe(0);
    expect(timeAtDate(earth, 1, 0)).toBe(365 * 86400);
    expect(timeAtDate(earth, 1, 13)).toBe((365 + 13) * 86400);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement calendar.ts**

Run: `cd web && npx vitest run src/sim/calendar.test.ts` — FAIL (module missing). Then `web/src/sim/calendar.ts`:

```ts
import type { Calendar, LeapRule } from './types';

/** Mirrors gg-gen's days_before_year exactly (crates/gg-gen/src/calendar.rs). */
export function daysBeforeYear(rule: LeapRule, year: number): number {
  let d = rule.base_days * year;
  for (const t of rule.terms) d += t.add_days * Math.floor(year / t.every_years);
  return d;
}

/** Sim seconds at the start of (0-based) year/dayOfYear. Inverse of date_at
 * up to the intra-day fraction. */
export function timeAtDate(cal: Calendar, year: number, dayOfYear: number): number {
  return (daysBeforeYear(cal.leap, year) + dayOfYear) * cal.solar_day_s;
}
```

Run again: PASS (5 tests).

- [ ] **Step 3: Write the failing HUD test additions**

`web/src/ui/hud.test.ts` — add (happy-dom provides document):

```ts
import { buildHud, SPEED_STEPS } from './hud';

describe('buildHud interactions', () => {
  const noop = { onPlayPause() {}, onSpeed(_: number) {}, onTrueScale(_: boolean) {}, onReroll() {}, onShare() {}, onDateJump(_: number, __: number) {} };

  it('share button fires onShare and flashes', () => {
    const root = document.createElement('div');
    let shared = 0;
    const hud = buildHud(root, '42', { ...noop, onShare: () => { shared++; } });
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'share')!;
    btn.click();
    expect(shared).toBe(1);
    hud.flashShared();
    expect(btn.textContent).toBe('copied ✓');
  });

  it('date-jump submits 0-based year and day', () => {
    const root = document.createElement('div');
    let got: [number, number] | null = null;
    buildHud(root, '42', { ...noop, onDateJump: (y, d) => { got = [y, d]; } });
    (root.querySelector('input[name="jump-year"]') as HTMLInputElement).value = '412';
    (root.querySelector('input[name="jump-day"]') as HTMLInputElement).value = '14';
    (root.querySelector('button[name="jump-go"]') as HTMLButtonElement).click();
    expect(got).toEqual([411, 13]); // UI is 1-based, engine is 0-based
  });

  it('setActiveSpeed highlights the matching step', () => {
    const root = document.createElement('div');
    const hud = buildHud(root, '42', noop);
    hud.setActiveSpeed(86400);
    const active = [...root.querySelectorAll('.hud-bottom button.active')];
    expect(active.length).toBe(1);
    expect(active[0]!.textContent).toBe(SPEED_STEPS.find((s) => s.mult === 86400)!.label);
  });
});
```

- [ ] **Step 4: Run to verify failure, then implement the HUD changes**

Run: `cd web && npx vitest run src/ui/hud.test.ts` — FAIL. Then in `web/src/ui/hud.ts`:

- Extend `HudCallbacks` with `onShare(): void; onDateJump(year: number, dayOfYear: number): void;` and `Hud` with `flashShared(): void; setActiveSpeed(mult: number): void;`.
- In the top-left group, after the true-scale button:

```ts
  const share = el('button', '', 'share');
  share.addEventListener('click', () => cb.onShare());
  topLeft.append(share);
```

- In the top-right group, after the date span, a compact jump form:

```ts
  const jumpYear = document.createElement('input');
  jumpYear.name = 'jump-year';
  jumpYear.placeholder = 'Y';
  jumpYear.style.width = '4.5em';
  const jumpDay = document.createElement('input');
  jumpDay.name = 'jump-day';
  jumpDay.placeholder = 'day';
  jumpDay.style.width = '3.5em';
  const jumpGo = el('button', '', 'jump');
  (jumpGo as HTMLButtonElement).name = 'jump-go';
  jumpGo.addEventListener('click', () => {
    const y = Math.max(1, Math.floor(Number(jumpYear.value)));
    const d = Math.max(1, Math.floor(Number(jumpDay.value) || 1));
    if (Number.isFinite(y)) cb.onDateJump(y - 1, d - 1);
  });
  topRight.append(jumpYear, jumpDay, jumpGo);
```

- Track the speed buttons array (already local) and return:

```ts
    flashShared: () => {
      share.textContent = 'copied ✓';
      setTimeout(() => { share.textContent = 'share'; }, 1500);
    },
    setActiveSpeed: (mult) => {
      speedButtons.forEach((b, i) => b.classList.toggle('active', SPEED_STEPS[i]!.mult === mult));
    },
```

(Also remove the hardcoded `if (s.mult === 1) b.classList.add('active')` in favor of calling `setActiveSpeed(1)` once before returning — single source of truth.)
- Add to `web/src/styles.css`: `.hud input { background: #10182e; color: inherit; border: 1px solid #2a3350; border-radius: 5px; padding: 0.15rem 0.35rem; font: inherit; }`

- [ ] **Step 5: Wire main.ts to AppState**

In `web/src/main.ts`:
- Replace the seed bootstrap with:

```ts
import { defaultAppState, parseAppState, serializeAppState, type AppState } from './state/url';
import { timeAtDate } from './sim/calendar';
```
```ts
  const state: AppState = parseAppState(location.hash) ?? defaultAppState(randomSeed());
  history.replaceState(null, '', serializeAppState(state)); // canonicalize without firing hashchange
  const seed = state.seed;
```

- After the clock is created: `clock.t = state.t; clock.speed = state.speed;` and after `buildHud`: `hud.setActiveSpeed(clock.speed);` — plus `if (state.body !== null && state.body < sim.bodyCount) focused = state.body;`
- Extend the `buildHud` callbacks:

```ts
    onShare: () => {
      const now: AppState = { ...state, t: clock.t, speed: clock.speed, body: focused };
      const hash = serializeAppState(now);
      history.replaceState(null, '', hash);
      void navigator.clipboard.writeText(`${location.origin}${location.pathname}${hash}`);
      hud.flashShared();
    },
    onDateJump: (year, day) => {
      clock.t = timeAtDate(anchorCal, year, day);
    },
```

(`state.view`/`lat`/`lon` ride along untouched — ground rendering is Plan 4; the spread preserves them in shared links.)

- [ ] **Step 6: Run the full web suite**

Run: `cd web && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src web/package.json
git commit -m "feat: share button, date-jump, boot from URL app-state"
```

---

### Task 5: Ship + live verification (controller-run)

**Files:** none (operations).

- [ ] **Step 1: Merge to main and push** (finishing flow; CI auto-deploys on push).

- [ ] **Step 2: Watch the run**

```bash
gh run watch $(gh run list --repo bitterbridge/goldengrove --branch main --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId') --repo bitterbridge/goldengrove --exit-status --interval 30
```

Expected: test + deploy green (first run with SHA-pinned actions — a typo'd SHA fails here loudly; fix from logs, don't bypass).

- [ ] **Step 3: Verify live**

Headless drive of the live site: (a) open `#seed=42&t=31558000&speed=86400` → date readout shows year 2 (t ≈ one anchor year), speed button `1 day/s` active; (b) click share (grant clipboard perms) → clipboard contains a URL with `t=` near current sim time; open that URL in a new page → date matches; (c) date-jump to year 100 day 1 → readout `Y100 · Day 1`; (d) zero console errors throughout. Screenshot for the record.

## Definition of Done

- All suites green; goldens byte-identical; clippy clean.
- Live site: shared URLs reproduce time/speed/focus; date-jump lands exactly; CI runs on pinned SHAs.
- Plan 4 (ground view) can consume: `AppState.view/lat/lon`, `Sim.hostOriginAt`, `timeAtDate`.

**Explicitly deferred to Plan 4** (not dropped): orbit-line regeneration under secular drift (epoch-frozen paths visibly diverge at high speeds); the gg-wasm `expect()` error-surface story; `date_at` negative-t policy if rewind ever ships.
