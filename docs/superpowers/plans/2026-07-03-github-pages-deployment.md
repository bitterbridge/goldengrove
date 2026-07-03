# GitHub Pages Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CI-green push to `main` auto-deploys the web app to https://bitterbridge.github.io/goldengrove/.

**Architecture:** One new `deploy` job appended to the existing `.github/workflows/ci.yml`, gated on `needs: test` + push-to-main, publishing `web/dist` through the official Pages workflow-artifact actions. One-time Pages enablement and the first push are operations (Task 2), run by the controller.

**Tech Stack:** GitHub Actions (configure-pages@v5, upload-pages-artifact@v3, deploy-pages@v4), gh CLI.

## Global Constraints

- The `test` job in ci.yml is UNTOUCHED — the deploy job is purely additive.
- Deploy gate exactly: `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`.
- Job permissions exactly `pages: write` + `id-token: write`; environment `github-pages` with `url: ${{ steps.deployment.outputs.page_url }}`; concurrency group `pages` with `cancel-in-progress: false`.
- Site artifact path: `web/dist`. Node 22. Same wasm-pack build line as the test job.

---

### Task 1: Deploy job + README badge

**Files:**
- Modify: `.github/workflows/ci.yml` (append `deploy` job after the `test` job)
- Modify: `README.md` (badge + live link)

**Interfaces:**
- Consumes: existing `test` job id (`test`) in ci.yml.
- Produces: `deploy` job publishing Pages artifact; Task 2 relies on the workflow being valid and the gate condition exact.

- [ ] **Step 1: Append the deploy job**

Append to `.github/workflows/ci.yml` (top-level `jobs:` map, after `test`), indented to match:

```yaml
  deploy:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    concurrency:
      group: pages
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown
      - uses: Swatinem/rust-cache@v2
      - name: Install wasm-pack
        run: curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
      - name: Build WASM package
        run: wasm-pack build crates/gg-wasm --target web --out-dir ../../web/src/wasm/pkg
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - name: Build site
        working-directory: web
        run: |
          npm ci
          npx vite build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: web/dist
      - uses: actions/deploy-pages@v4
        id: deployment
```

- [ ] **Step 2: Validate the workflow structurally**

```bash
yq eval '.jobs | keys' .github/workflows/ci.yml
yq eval '.jobs.deploy.needs, .jobs.deploy.if, .jobs.deploy.permissions, .jobs.deploy.concurrency.group' .github/workflows/ci.yml
yq eval '.jobs.deploy.steps | length' .github/workflows/ci.yml
git diff .github/workflows/ci.yml | grep -c "^-[^-]"
```

Expected: jobs `[test, deploy]`; needs `test`; the exact gate string; permissions map with pages/id-token write; group `pages`; 11 steps; and the last command outputs `0` — no existing line was removed or modified (purely additive; `^-[^-]` skips the `---` diff header).

- [ ] **Step 3: Add README badge and live link**

Replace `README.md`'s contents with:

```markdown
# goldengrove

[![CI](https://github.com/bitterbridge/goldengrove/actions/workflows/ci.yml/badge.svg)](https://github.com/bitterbridge/goldengrove/actions/workflows/ci.yml)

A tool for creating and exploring fantastic planets.

**Live:** https://bitterbridge.github.io/goldengrove/
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: deploy to GitHub Pages on CI-green pushes to main"
```

---

### Task 2: Deployment operations (controller-run)

**Files:** none (repo-external operations + verification).

**Interfaces:**
- Consumes: Task 1's workflow, merged to main.

- [ ] **Step 1: Enable Pages for workflow deploys (one-time)**

```bash
gh api -X POST repos/bitterbridge/goldengrove/pages -f build_type=workflow \
  || gh api -X PUT repos/bitterbridge/goldengrove/pages -f build_type=workflow
```

Expected: JSON response with `"build_type": "workflow"`.

- [ ] **Step 2: Push main**

```bash
git push origin main
```

- [ ] **Step 3: Watch the run to completion**

```bash
gh run watch $(gh run list --branch main --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Expected: exit 0 with both `test` and `deploy` jobs green. If `test` fails on the runner (first-ever CI run — environment differences are possible), treat it as a bug to diagnose from the run logs, not to bypass.

- [ ] **Step 4: Verify the live site**

Headless-browser drive of `https://bitterbridge.github.io/goldengrove/#seed=42` (reuse the session's scratchpad Playwright harness): body labels render (`★A`, `★B` present), the WASM binary loads from the subpath (no 4xx), zero console/page errors. Screenshot for the record. Pages DNS/CDN can take ~a minute after the first deploy — poll with a few retries before concluding failure.

## Definition of Done

- Actions run green end-to-end (test → deploy) on the pushed main.
- Live URL renders seed 42 with zero console errors.
- README badge renders (shows after first run completes).
