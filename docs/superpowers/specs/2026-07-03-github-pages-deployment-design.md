# Goldengrove — GitHub Pages Deployment Design

**Date:** 2026-07-03
**Status:** Approved (brainstorming session with Nathan)

## Goal

Every change merged to `main` that passes CI automatically deploys the web app
to **https://bitterbridge.github.io/goldengrove/**. Broken builds never ship.

## Facts This Design Rests On

- Repo `bitterbridge/goldengrove` is public (Pages free tier applies); default
  branch `main`; `gh` CLI authenticated with admin access.
- GitHub Pages is not yet enabled (API returns 404).
- The app is already subpath-safe: `web/vite.config.ts` sets `base: './'`
  (all assets relative, including the Vite-hashed WASM binary) and all app
  state lives in the URL hash — no server-side routing.
- Deploying implies pushing `main` (currently ahead of origin) to the public
  repo.

## Design

### 1. Deploy job in the existing CI workflow

Extend `.github/workflows/ci.yml` (keep the `test` job untouched) with:

- `deploy` job: `needs: test`, gated
  `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` —
  pull requests run CI only; pushes to main deploy after CI passes.
- Rebuilds the site from scratch (Rust toolchain + wasm32 target →
  wasm-pack build → Node 22 → `npm ci` → `npx vite build`) rather than
  passing artifacts from the `test` job. Trade-off accepted: a few duplicated
  CI minutes for much simpler wiring (the test job also runs on PRs, where no
  artifact should exist).
- Publishes `web/dist` via `actions/configure-pages`,
  `actions/upload-pages-artifact`, and `actions/deploy-pages` — the official
  workflow-artifact path; no `gh-pages` branch.
- Job-level `permissions: pages: write, id-token: write`; `environment:
  github-pages` with the deployed URL surfaced; `concurrency: group: pages`
  with `cancel-in-progress: false` so deploys queue rather than cancel
  mid-publish.

### 2. One-time Pages enablement

`gh api -X POST repos/bitterbridge/goldengrove/pages -f build_type=workflow`
(idempotence: if it already exists, `PUT` with the same body). This is a
console action recorded here, not workflow code.

### 3. App changes

None required. A README build badge
(`[![CI](…/actions/workflows/ci.yml/badge.svg)](…)`) is the only repo-content
change beyond the workflow.

### 4. Error handling & verification

- A failed deploy leaves the previous deployment live (Pages semantics); no
  rollback machinery needed.
- Acceptance: after pushing, the Actions run goes green end-to-end
  (test → deploy), and a headless-browser drive of the LIVE URL
  `https://bitterbridge.github.io/goldengrove/#seed=42` renders body labels
  with zero console errors and loads the WASM binary from the subpath.

## Out of Scope

Custom domains, preview deploys for PRs, release tagging, analytics.
