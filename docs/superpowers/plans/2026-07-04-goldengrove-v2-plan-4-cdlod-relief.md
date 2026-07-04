# Goldengrove v2 Plan 4 — CDLOD Geomorphing + Relief Exaggeration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LOD seams and pops vanish via vertex geomorphing; relief reads from the air via a ×3 render-side exaggeration with a true-relief toggle.

**Architecture:** tileMesh emits an `aParentPos` attribute (parent-grid decimation, computed from the tile's own positions) and gains a `verticalScale` input (displacement scaled, colors physical). terrainGlobe clones its material per tile, injects a morph mix into MeshStandardMaterial's vertex shader via onBeforeCompile, and drives a per-tile `uMorph` uniform from the SAME LOD distance the tree splits on. main.ts repurposes the true-scale button in ground view and scales the render eye height.

**Tech Stack:** TypeScript + three.js (+ GLSL chunk replacement) + vitest. **No Rust, no goldens.**

## Global Constraints

- Render-side only; `elevation_fine` stays the truth; HUD ⛰ always TRUE elevation; URL unchanged (toggle is session-local).
- Morph band: `uMorph = smoothstep(d, 0.7·splitDist, 0.95·splitDist)`, `splitDist = splitK·tileEdgeLenM(level)`, `d` measured with the tree's LOD camera point (radiusM + aboveTerrainM — NOT the render eye).
- Default `reliefScale = 3`; toggle to 1 rebuilds the standing globe; water stays at true sea-level radius; skirts remain.
- Grid is 65×65 (TILE_QUADS=64), row-major `r*65+c`; rows/cols 0 and 64 are even — tile borders always have proper parent decimation.
- Gates per commit: `cd web && npx vitest run` green + `npx tsc --noEmit` clean.

---

### Task 1: tileMesh — `aParentPos` + `verticalScale`

**Files:** Modify `web/src/views/tileMesh.ts`, `web/src/views/tileMesh.test.ts`; touch call sites in `web/src/views/terrainGlobe.ts` only as far as tsc requires (full wiring is Task 2).

**Interfaces (Task 2 relies on these exactly):**
- `TileMeshInputs` gains `verticalScale: number` (required — update existing call sites/tests to pass 1).
- `TileMeshData` gains `parentPositions: Float32Array` (xyz per vertex, same layout/origin as `positions`).
- Displacement radius becomes `R + e·verticalScale`; `hypsometricColor` keeps using UNSCALED `e / reliefM`.

Parent decimation rule (per grid vertex (r, c), n=65):
- r even, c even → own (scaled) position.
- r even, c odd → midpoint of (r, c−1) and (r, c+1).
- r odd, c even → midpoint of (r−1, c) and (r+1, c).
- r odd, c odd → midpoint of (r−1, c−1) and (r+1, c+1).
- Skirt vertices → copy their source grid vertex's parent position (same ring mapping as positions).
Compute from the already-built scaled `positions` array (plus originBf-relative — parentPositions share the same origin, no re-anchoring).

- [ ] **Step 1: Failing tests** (append to tileMesh.test.ts; update ALL existing `buildTileMesh` calls to add `verticalScale: 1` in inputs):

```ts
  it('verticalScale scales displacement but not colors', () => {
    const e = new Float32Array(gridCount).fill(1000);
    const flatIn = { ...inputs, verticalScale: 1 };
    const tallIn = { ...inputs, verticalScale: 3 };
    const m1 = buildTileMesh(t, e, flatIn);
    const m3 = buildTileMesh(t, e, tallIn);
    const o = m3.originBf;
    const r3 = Math.hypot(o[0] + m3.positions[0]!, o[1] + m3.positions[1]!, o[2] + m3.positions[2]!);
    expect(r3).toBeCloseTo(R + 3000, 3);
    // colors identical: physical palette, not exaggerated
    expect(Array.from(m3.colors.slice(0, 12))).toEqual(Array.from(m1.colors.slice(0, 12)));
  });

  it('aParentPos: even-even vertices equal their own position', () => {
    const e = new Float32Array(gridCount).map(() => Math.random() * 2000);
    const m = buildTileMesh(t, e, { ...inputs, verticalScale: 1 });
    const n = TILE_QUADS + 1;
    for (const [r, c] of [[0, 0], [2, 4], [64, 64], [32, 0]] as const) {
      const i = r * n + c;
      expect(m.parentPositions[3 * i]).toBe(m.positions[3 * i]);
      expect(m.parentPositions[3 * i + 1]).toBe(m.positions[3 * i + 1]);
      expect(m.parentPositions[3 * i + 2]).toBe(m.positions[3 * i + 2]);
    }
  });

  it('aParentPos: odd vertices are midpoints of their even neighbors', () => {
    const e = new Float32Array(gridCount).map(() => Math.random() * 2000);
    const m = buildTileMesh(t, e, { ...inputs, verticalScale: 1 });
    const n = TILE_QUADS + 1;
    const at = (i: number, k: number) => m.positions[3 * i + k]!;
    // even row, odd col
    let i = 2 * n + 5;
    for (let k = 0; k < 3; k++) {
      expect(m.parentPositions[3 * i + k]).toBeCloseTo((at(2 * n + 4, k) + at(2 * n + 6, k)) / 2, 4);
    }
    // odd row, odd col: diagonal midpoint
    i = 3 * n + 5;
    for (let k = 0; k < 3; k++) {
      expect(m.parentPositions[3 * i + k]).toBeCloseTo((at(2 * n + 4, k) + at(4 * n + 6, k)) / 2, 4);
    }
  });

  it('skirt vertices copy their source parent position', () => {
    const e = new Float32Array(gridCount).fill(500);
    const m = buildTileMesh(t, e, { ...inputs, verticalScale: 1 });
    // first skirt vertex sources grid vertex 0 (ring starts at row 0, col 0)
    const s = gridCount;
    expect(m.parentPositions[3 * s]).toBe(m.parentPositions[0]);
  });
```

(`Math.random` in tests is fine — assertions are relational, not golden.)

- [ ] **Step 2: RED** — `npx vitest run src/views/tileMesh.test.ts`.
- [ ] **Step 3: Implement.** Scale displacement in `writeVertex` (`R + elevationsM[gi]·inputs.verticalScale + radialOffset`); after positions are built, allocate `parentPositions` (same length), fill per the decimation rule reading from `positions` (grid part), then the skirt copies; note the skirt's parent copy must be the SOURCE GRID vertex's parentPositions entry (not its own dropped position — the morph must not re-raise skirts).
- [ ] **Step 4: GREEN full suite + tsc** (terrainGlobe call sites: add `verticalScale: 1` literals for now).
- [ ] **Step 5: Commit** — `"feat: parent-grid morph attribute + vertical scale in tile meshes"`

---

### Task 2: terrainGlobe — shader morph + reliefScale

**Files:** Modify `web/src/views/terrainGlobe.ts`, `web/src/views/terrainGlobe.test.ts`.

**Interfaces:** `buildTerrainGlobe(sim, bodyIndex, reliefScale = 3)` (main.ts passes its toggle state in Task 3). Behavior:
- buildTile passes `verticalScale: reliefScale` for TERRAIN tiles and keeps water at scale 1 with zero elevations (water needs NO morph: skip attribute/uniform, keep the shared water material).
- Terrain tiles get a CLONED material each: `const mat = baseMaterial.clone()` + `mat.onBeforeCompile = (shader) => { shader.uniforms.uMorph = tileUniform; ... }` where `tileUniform = { value: 0 }` is stored per tile (e.g. `mesh.userData.uMorph = tileUniform`). GLSL: replace `#include <common>` with `#include <common>\nattribute vec3 aParentPos;\nuniform float uMorph;` and replace `#include <begin_vertex>` with `vec3 transformed = mix(vec3(position), aParentPos, uMorph);`. Set the geometry attribute `aParentPos` from `data.parentPositions`. Cloned materials are disposed on evict AND in dispose().
- Per-frame, for each VISIBLE tile: `d = |lodCamBf − center·R|` (the LOD camera point — `radiusM + aboveTerrainM` — same as what tree.update received), `splitDist = splitK·tileEdgeLenM(level)` (splitK must therefore be readable — lift it to a module const shared with the TileTree config), `uMorph.value = smoothstep(d, 0.7·splitDist, 0.95·splitDist)` (THREE.MathUtils.smoothstep argument order: (x, min, max)). Tiles at maxLevel never merge upward but morphing is still correct (they morph toward parent shape at range — harmless and seam-healing).

- [ ] **Step 1: Failing tests** (terrainGlobe.test.ts):

```ts
  it('terrain tiles carry aParentPos and a per-tile morph uniform', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 40; f++) g.update(15, 30, 252, 2, suns, 8);
    let checked = 0;
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.visible || (m.material as THREE.Material).transparent) return;
      expect(m.geometry.getAttribute('aParentPos')).toBeTruthy();
      expect(m.userData.uMorph).toBeTruthy();
      checked++;
    });
    expect(checked).toBeGreaterThan(3);
  });

  it('uMorph rises with distance: far tiles morph toward the parent shape', () => {
    const g = buildTerrainGlobe(fakeSim(), anchorBody)!;
    for (let f = 0; f < 60; f++) g.update(15, 30, 252, 2, suns, 8);
    const morphs: number[] = [];
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && m.userData.uMorph) morphs.push(m.userData.uMorph.value as number);
    });
    expect(Math.max(...morphs)).toBeGreaterThan(0.5); // outer-band tiles well into their morph
    expect(Math.min(...morphs)).toBeLessThan(0.5);    // underfoot tiles barely morphed
  });

  it('reliefScale=3 raises the rendered surface but not water', () => {
    // fakeSim variant returning constant +1000 elevations; compare a built
    // terrain vertex radius at scale 3 (R + 3000) vs the water mesh at R.
  });
```

Write the third test concretely against the fixture (constant-elevation fake, ocean world) — assert one terrain grid vertex radius ≈ R+3000 (positions + originBf) and one water vertex ≈ R.

NOTE: `update`'s signature in these tests — check the CURRENT signature in the file first (post-Plan-2b it is `update(latDeg, lonDeg, terrainM, aboveTerrainM, suns, buildBudget?, atmDensity?, dayFactor?)`) and write test calls to match it exactly; the snippets above abbreviate.

- [ ] **Step 2: RED.** **Step 3: Implement** per the interface block. **Step 4: GREEN full suite + tsc.**
- [ ] **Step 5: Commit** — `"feat: CDLOD geomorphing + relief exaggeration in the terrain globe"`

---

### Task 3: main.ts + HUD toggle

**Files:** Modify `web/src/main.ts`, `web/src/ui/hud.ts`, `web/src/ui/hud.test.ts` (if the button label is testable there — read the file; hud has unit tests for other controls).

Wiring:
1. `let reliefScale = 3;` module state; `setStandingGlobe` passes it: `buildTerrainGlobe(sim, body, reliefScale)`.
2. The HUD true-scale button in GROUND view: repurpose — read hud.ts for how the button's label/handler are built; add a way to set its label (e.g. `hud.setTrueScaleLabel(text)`), and in main.ts's `onTrueScale` handler: if `current.view === 'ground'`, toggle `reliefScale` 3↔1, call `setStandingGlobe(current.body)`, set label `⛰ true relief`/`⛰ ×3 relief`; else keep the orrery behavior (and restore the orrery label on view switches — set labels in enterGround/exitGround).
3. Render eye height: where `terrainM` feeds the globe/obsWorld (`eyeTerrainM(...)`), multiply by `reliefScale` for the RENDER path only: `const terrainRenderM = eyeTerrainM(currentElevationM ?? 0, standingOcean) * reliefScale;` — used for obsWorld and terrainGlobe.update's terrainM; HUD ⛰ keeps `currentElevationM` (true); flightStep/decoupling/URL untouched.
4. Tests: hud label setter if cheap; main.ts wiring is glue (structural comments + the Task 4 live QA carry it).

- [ ] Steps: failing hud test (if applicable) → implement → **GREEN full suite + tsc** → commit `"feat: ×3 relief default with true-relief toggle in ground view"`.

---

### Task 4: Ship + live QA

(Controller-level: final whole-branch review; merge from PRIMARY; push; **watch the deploy run selected by pushed SHA** (`gh run list --json headSha` filter — never `--limit 1` right after push); live QA: Nathan's seed 4440133640782079914 body 12 link (square-behind-sun already fixed — verify), border-seam check at a known LOD boundary while flying slowly, ×3 vs true toggle screenshot pair from ~50 km, walking/eye on the seed-42 peak at ×3, pops check on slow ascent.)

## Self-Review Notes (applied)

- Spec coverage: aParentPos+scale (T1), shader+uniform+reliefScale (T2), toggle+eye (T3), QA (T4). Water exempt from morph ✓, colors physical ✓, HUD true ✓, skirts kept ✓.
- Type consistency: `verticalScale` in TileMeshInputs (T1) consumed in T2; `buildTerrainGlobe(sim, body, reliefScale=3)` (T2) called in T3; `parentPositions` (T1) → `aParentPos` attribute (T2).
- Known reconciliation: terrainGlobe.update signature drift (T2 note), hud button API discovery (T3), splitK lifted to shared const (T2).
