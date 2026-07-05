import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadSim, WasmLoadError, type Sim } from './sim/wasm';
import { SimClock } from './time/clock';
import { buildSpaceScene, type SpaceView } from './views/space';
import { buildGroundScene, type GroundView } from './views/ground';
import { buildLocalBodies } from './views/localBodies';
import { buildTerrainGlobe, type TerrainGlobe } from './views/terrainGlobe';
import { observerFrame, pointToLatLon, type Vec3 } from './views/observer';
import { decoupleWeight, eyeTerrainM, flightStep, groundSpeedMps, lonSlipDeg, spinRateRadPerS, stepLatLon } from './views/walk';
import { atmosphereDensityFor, bodyLayout, bodyRadiusM, parentIndex, standableBody } from './sim/layout';
import { buildHud, formatDate } from './ui/hud';
import { buildCompass } from './ui/compass';
import { randomSeed } from './ui/seed';
import { defaultAppState, parseAppState, serializeAppState, type AppState } from './state/url';
import { timeAtDate } from './sim/calendar';
import './styles.css';

const app = document.getElementById('app')!;

// Full reload on seed change: tearing down renderer/loop/listeners by hand
// buys nothing at this app size and invites leaks.
addEventListener('hashchange', () => location.reload());

async function boot(): Promise<void> {
  const current: AppState = parseAppState(location.hash) ?? defaultAppState(randomSeed());
  history.replaceState(null, '', serializeAppState(current)); // canonicalize without firing hashchange
  app.replaceChildren();

  let sim: Sim;
  try {
    sim = await loadSim(current.seed);
  } catch (err) {
    const card = document.createElement('div');
    card.className = 'hud hud-top-left';
    card.textContent =
      err instanceof WasmLoadError
        ? 'Goldengrove failed to load its simulation engine — check your connection and reload.'
        : `This seed found a bug — please report it. (${String(err)})`;
    if (!(err instanceof WasmLoadError)) {
      const reroll = document.createElement('button');
      reroll.textContent = '⟲ try another world';
      reroll.addEventListener('click', () => {
        location.hash = `seed=${randomSeed()}`;
      });
      card.append(document.createElement('br'), reroll);
    }
    app.append(card);
    return;
  }

  const layout = bodyLayout(sim.descriptor);
  const anchorBody = sim.descriptor.stars.length + sim.descriptor.anchor_planet;

  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  app.append(renderer.domElement, labelRenderer.domElement);

  // --- space view ---
  const spaceCamera = new THREE.PerspectiveCamera(50, 1, 0.001, 20000);
  spaceCamera.up.set(0, 0, 1); // +Z is system north (sim frame convention)
  const controls = new OrbitControls(spaceCamera, renderer.domElement);
  controls.enableDamping = true;
  const view: SpaceView = buildSpaceScene(sim);

  // --- ground view ---
  const groundCamera = new THREE.PerspectiveCamera(60, 1, 0.3, 1e13);
  groundCamera.up.set(0, 0, 1);
  let yaw = 0; // 0 = north (+Y), positive east
  let pitch = 0.15;
  const PITCH_LIMIT = (89 * Math.PI) / 180;
  const ground: GroundView = buildGroundScene(sim);
  // True-scale local space: every non-standing body at real distance/size,
  // camera-relative in the observer's ENU frame. Built once — only the
  // terrain globe (below) is per-standing-body and gets rebuilt.
  const localBodies = buildLocalBodies(sim);
  const localSpace = new THREE.Scene();
  localSpace.add(localBodies.group);

  // The ground scene is built once at boot, but the standing body can change
  // at runtime (stand-here on another body) — main.ts owns the terrain globe
  // lifecycle and rebuilds it whenever the standing body changes.
  let terrainGlobe: TerrainGlobe | null = null;
  let standingOcean = false;
  // Vertical exaggeration applied to the terrain globe and the observer's eye
  // height in ground view: 3× makes relief legible at a glance; the ground
  // view's true-scale button toggles this down to 1 (true relief). Fully
  // independent of the orrery's `trueScale` flag below — they share a button
  // but never a state variable.
  let reliefScale = 3;
  function setStandingGlobe(body: number | null): void {
    terrainGlobe?.dispose();
    terrainGlobe = body !== null ? buildTerrainGlobe(sim, body, reliefScale) : null;
    standingOcean = body !== null && (sim.bodyTerrainInfo(body)?.ocean_fraction ?? 0) > 0;
    ground.setDiscVisible(terrainGlobe === null);
  }

  // Terrain elevation at the observer's current standing lat/lon; kept fresh
  // by refreshElevation() so the ground camera's eye height rides the terrain.
  let currentElevationM: number | null = null;
  // Free-flight altitude above the terrain eye height; 0 = on foot. Written
  // only by flightStep() and the ground-entry/exit resets (never negative —
  // the sky-density clamp depends on that).
  let flightAltM = 0;
  // Rotational decoupling: how fast the standing body's surface spins under a
  // hovering observer. Recomputed once per enterGround() from two ephemeris
  // samples 60s apart; only used while flightAltM > 0.
  let standingSpinRate = 0;
  function wrapLon(lonDeg: number): number {
    return ((lonDeg + 540) % 360) - 180;
  }
  function refreshElevation(): void {
    currentElevationM =
      current.body !== null && current.lat !== null && current.lon !== null
        ? sim.bodyElevation(current.body, current.lat, current.lon)
        : null;
  }

  const clock = new SimClock();
  clock.t = current.t;
  clock.speed = current.speed;
  if (current.t > 0) {
    // A shared moment should hold until the viewer presses play.
    clock.paused = true;
  }
  let trueScale = false;
  let focused: number | null = null;
  if (current.body !== null && current.body < sim.bodyCount) focused = current.body;

  const anchorCal = sim.descriptor.planets[sim.descriptor.anchor_planet]!.calendar!;
  const hud = buildHud(app, current.seed, {
    onPlayPause: () => { clock.paused = !clock.paused; hud.setPaused(clock.paused); },
    onSpeed: (m) => { clock.speed = m; },
    onTrueScale: () => {
      // hud's button is stateless — it just reports a click. main owns which
      // of the two independent toggles (orrery trueScale vs. ground
      // reliefScale) that click means, and drives the button's active class
      // back explicitly so it can never desync from either.
      if (current.view === 'ground') {
        reliefScale = reliefScale === 3 ? 1 : 3;
        setStandingGlobe(current.body);
        hud.setTrueScaleLabel(reliefScale === 3 ? '⛰ ×3 relief' : '⛰ true relief');
        hud.setTrueScaleActive(reliefScale !== 1);
      } else {
        trueScale = !trueScale;
        hud.setTrueScaleActive(trueScale);
      }
    },
    onReroll: () => { location.hash = `seed=${randomSeed()}`; },
    onShare: () => {
      syncUrl();
      void navigator.clipboard.writeText(`${location.origin}${location.pathname}${location.hash}`);
      hud.flashShared();
    },
    onDateJump: (year, day) => { clock.t = timeAtDate(anchorCal, year, day); },
    onToggleView: () => {
      if (current.view === 'space') {
        const body = focused ?? anchorBody;
        const d = defaultStandPoint(body);
        enterGround(body, d.latDeg, d.lonDeg);
      } else exitGround();
    },
  });
  hud.setActiveSpeed(clock.speed);
  hud.setPaused(clock.paused);
  const compass = buildCompass(app);

  function refreshViewButton(): void {
    if (current.view === 'ground') {
      hud.setViewButton('◉ orrery', true);
    } else {
      const standable = focused !== null && standableBody(sim.descriptor, layout[focused]!);
      hud.setViewButton('⏚ stand here', standable);
    }
  }

  function syncUrl(): void {
    // Keep the address bar shareable at all times (replaceState never fires
    // hashchange, so this can't trigger the reload listener). The share
    // button remains the way to capture the exact MOMENT (current t).
    history.replaceState(null, '', serializeAppState({ ...current, t: clock.t, speed: clock.speed, body: focused, alt: flightAltM }));
  }

  function defaultStandPoint(body: number): { latDeg: number; lonDeg: number } {
    const ref = layout[body]!;
    if (ref.kind !== 'moon') return { latDeg: 15, lonDeg: 0 };
    // Stand at the sub-parent point: the spot where the planet hangs at the
    // zenith (for locked moons it stays there — the natural balcony).
    const st = sim.statesAt(clock.t);
    const p = parentIndex(layout, sim.descriptor, body)!;
    const dir: Vec3 = [
      st[p * 7]! - st[body * 7]!,
      st[p * 7 + 1]! - st[body * 7 + 1]!,
      st[p * 7 + 2]! - st[body * 7 + 2]!,
    ];
    const axis: Vec3 = [st[body * 7 + 3]!, st[body * 7 + 4]!, st[body * 7 + 5]!];
    return pointToLatLon(dir, axis, st[body * 7 + 6]!);
  }

  function hideAllLabels(): void {
    // The shared CSS2DRenderer only refreshes labels of the scene it renders;
    // hide everything on a view switch so the inactive view's labels can't
    // linger — the active scene re-shows its own on the next frame.
    document.querySelectorAll<HTMLElement>('.body-label').forEach((el) => { el.style.display = 'none'; });
  }

  function enterGround(body: number, latDeg: number, lonDeg: number): void {
    hideAllLabels();
    if (!standableBody(sim.descriptor, layout[body]!)) return;
    current.view = 'ground';
    current.body = body;
    current.lat = latDeg;
    current.lon = lonDeg;
    focused = body;
    yaw = 0;
    pitch = 0.15;
    flightAltM = Math.max(0, current.alt ?? 0);
    // consume-once: later ground entries start on foot. current.alt only ever
    // carries a value parsed from a shared URL at boot; without clearing it
    // here, every later stand-here / view toggle would re-teleport back to
    // that boot-time altitude. syncUrl() below writes flightAltM back out for
    // sharing, so the URL round-trip stays intact.
    current.alt = null;
    const states0 = sim.statesAt(clock.t);
    const states60 = sim.statesAt(clock.t + 60);
    standingSpinRate = spinRateRadPerS(states0[body * 7 + 6]!, states60[body * 7 + 6]!, 60);
    refreshViewButton();
    compass.setVisible(true);
    if (clock.speed > 3600) { clock.speed = 3600; hud.setActiveSpeed(3600); }
    hud.setMaxSpeed(3600);
    setStandingGlobe(body);
    hud.setTrueScaleLabel(reliefScale === 3 ? '⛰ ×3 relief' : '⛰ true relief');
    hud.setTrueScaleActive(reliefScale !== 1);
    refreshElevation();
    syncUrl();
  }
  function exitGround(): void {
    hideAllLabels();
    compass.setVisible(false);
    current.view = 'space';
    flightAltM = 0;
    refreshViewButton();
    hud.setMaxSpeed(null);
    hud.setTrueScaleLabel('true scale');
    hud.setTrueScaleActive(trueScale);
    setStandingGlobe(null);
    syncUrl();
  }

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = app;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    for (const cam of [spaceCamera, groundCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }
  addEventListener('resize', resize);
  resize();

  // pointer: space = click-to-focus / stand-here via raycast; ground = look around
  const down = new THREE.Vector2();
  let dragging = false;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    down.set(e.clientX, e.clientY);
    dragging = true;
  });
  addEventListener('pointerup', () => { dragging = false; });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (current.view !== 'ground' || !dragging) return;
    yaw -= e.movementX * 0.0032;
    pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pitch + e.movementY * 0.0032));
    compass.setHeading(yaw, pitch, { latDeg: current.lat ?? 0, lonDeg: current.lon ?? 0 }, currentElevationM, flightAltM);
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (current.view !== 'space') return;
    if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
    const ndc = new THREE.Vector2(
      (e.clientX / renderer.domElement.clientWidth) * 2 - 1,
      -(e.clientY / renderer.domElement.clientHeight) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, spaceCamera);
    const hit = ray.intersectObjects(view.bodies, false)[0];
    if (!hit) return;
    const idx = view.bodyIndexOf(hit.object);
    if (idx === null) return;
    if (focused === idx && standableBody(sim.descriptor, layout[idx]!)) {
      // second click on an already-focused standable body: stand at the hit point
      const center = hit.object.position;
      const dir: Vec3 = [hit.point.x - center.x, hit.point.y - center.y, hit.point.z - center.z];
      const s = sim.statesAt(clock.t);
      const axis: Vec3 = [s[idx * 7 + 3]!, s[idx * 7 + 4]!, s[idx * 7 + 5]!];
      const { latDeg, lonDeg } = pointToLatLon(dir, axis, s[idx * 7 + 6]!);
      enterGround(idx, latDeg, lonDeg);
    } else {
      focused = idx;
      refreshViewButton();
    }
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (current.view !== 'ground') return;
    groundCamera.fov = Math.min(75, Math.max(20, groundCamera.fov + e.deltaY * 0.02));
    groundCamera.updateProjectionMatrix();
  }, { passive: true });
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (current.view === 'ground') exitGround();
    else { focused = null; refreshViewButton(); }
  });

  // Surface walking: W/↑ forward, S/↓ backward, A/← strafe left, D/→ strafe
  // right, along the current compass heading; Shift for a 5x sprint.
  // Hold R/F to ascend/descend into free flight; speed on both axes scales
  // with altitude (walk.ts's flightStep/groundSpeedMps) so leaving the
  // ground and reaching limb view both feel responsive.
  const WALK_KEY: Record<string, 'w' | 'a' | 's' | 'd'> = {
    w: 'w', a: 'a', s: 's', d: 'd',
    arrowup: 'w', arrowleft: 'a', arrowdown: 's', arrowright: 'd',
  };
  const heldKeys = new Set<'w' | 'a' | 's' | 'd'>();
  let shiftHeld = false;
  const flightKeys = new Set<'r' | 'f'>();
  addEventListener('keydown', (e) => {
    if (document.activeElement instanceof HTMLInputElement) return;
    // never swallow browser chords (Cmd/Ctrl+R reload, Cmd/Ctrl+F find, …)
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Shift') shiftHeld = true;
    const mapped = WALK_KEY[e.key.toLowerCase()];
    if (mapped) {
      heldKeys.add(mapped);
      e.preventDefault();
    }
    const key = e.key.toLowerCase();
    if (key === 'r' || key === 'f') {
      flightKeys.add(key);
      e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => {
    if (document.activeElement instanceof HTMLInputElement) return;
    if (e.key === 'Shift') shiftHeld = false;
    const mapped = WALK_KEY[e.key.toLowerCase()];
    if (mapped && heldKeys.delete(mapped) && current.view === 'ground') syncUrl();
    const key = e.key.toLowerCase();
    if ((key === 'r' || key === 'f') && flightKeys.delete(key) && current.view === 'ground') syncUrl();
  });
  addEventListener('blur', () => { heldKeys.clear(); shiftHeld = false; flightKeys.clear(); });

  refreshViewButton();
  // Prime the view once so the host origin is known, then frame the camera
  // on it (trinary systems can have the planet host far from world origin).
  view.update(sim.statesAt(0), trueScale, sim.hostOriginAt(0), 0);
  const [ox, oy, oz] = view.hostOriginView();
  controls.target.set(ox, oy, oz);
  spaceCamera.position.set(ox, oy - 28, oz + 16);

  let lastWall = performance.now();
  let lastDateUpdate = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - lastWall) / 1000, 0.1); // clamp tab-switch jumps
    lastWall = now;
    clock.tick(dt);
    const states = sim.statesAt(clock.t);

    if (current.view === 'ground' && current.body !== null) {
      const rM = bodyRadiusM(sim.descriptor, layout[current.body]!);
      const dUp = (flightKeys.has('r') ? 1 : 0) - (flightKeys.has('f') ? 1 : 0);
      if (dUp !== 0) {
        // Height above terrain is flight altitude plus eye height — terrain
        // elevation itself is not altitude.
        flightAltM = flightStep(flightAltM, dUp, dt, rM, flightAltM + 1.7);
      }
      if (heldKeys.size > 0 && current.lat !== null && current.lon !== null) {
        const speedMps = groundSpeedMps(flightAltM, shiftHeld);
        const degPerMeter = 180 / (Math.PI * rM);
        const step = speedMps * dt * degPerMeter;
        let dF = 0, dR = 0; // forward, rightward relative to the compass heading
        if (heldKeys.has('w')) dF += 1;
        if (heldKeys.has('s')) dF -= 1;
        if (heldKeys.has('d')) dR += 1;
        if (heldKeys.has('a')) dR -= 1;
        if (dF !== 0 || dR !== 0) {
          const { latDeg, lonDeg } = stepLatLon(current.lat, current.lon, yaw, dF, dR, step);
          current.lat = latDeg;
          current.lon = lonDeg;
          refreshElevation();
        }
      }
      // Rotational decoupling: while hovering, the planet spins beneath the
      // observer rather than carrying them along — their body-frame longitude
      // slips west. w === 1 (walking/low flight) means fully coupled, no slip.
      if (flightAltM > 0 && current.lat !== null && current.lon !== null) {
        const w = decoupleWeight(flightAltM, rM);
        if (w < 1) {
          current.lon = wrapLon(current.lon + lonSlipDeg(flightAltM, rM, standingSpinRate, dt));
          refreshElevation();
        }
      }
      renderer.autoClear = false;
      renderer.clear();
      const suns = ground.update(states, { body: current.body, latDeg: current.lat ?? 0, lonDeg: current.lon ?? 0 }, flightAltM);
      groundCamera.position.set(0, 0, 0);
      groundCamera.lookAt(Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch));
      if (now - lastDateUpdate > 250) {
        lastDateUpdate = now;
        hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
        compass.setHeading(yaw, pitch, { latDeg: current.lat ?? 0, lonDeg: current.lon ?? 0 }, currentElevationM, flightAltM);
      }
      renderer.render(ground.scene, groundCamera);
      renderer.clearDepth();

      // Local space: every other body at true distance/scale, camera-relative
      // in the observer's ENU frame. Same depth buffer as the terrain pass
      // below — no second clear — so terrain occludes bodies below the
      // horizon and bodies occlude each other correctly.
      // Render-only: exaggerate the eye's terrain-following height by the
      // same reliefScale as the terrain globe's geometry, so the camera sits
      // on the exaggerated surface instead of floating above/sinking below
      // it. currentElevationM itself (HUD, flightStep, decoupling, URL)
      // stays true-scale — only this derived value is scaled.
      const terrainRenderM = eyeTerrainM(currentElevationM ?? 0, standingOcean) * reliefScale;
      const aboveTerrainM = 1.7 + flightAltM;
      const frame = observerFrame(states, sim.descriptor, current.body, current.lat ?? 0, current.lon ?? 0);
      const eyeAboveCenterM = terrainRenderM + aboveTerrainM;
      const obsWorld: Vec3 = [
        frame.positionM[0] + frame.up[0] * eyeAboveCenterM,
        frame.positionM[1] + frame.up[1] * eyeAboveCenterM,
        frame.positionM[2] + frame.up[2] * eyeAboveCenterM,
      ];
      localBodies.update(states, obsWorld, frame, current.body, groundCamera, renderer.domElement.clientHeight);
      renderer.render(localSpace, groundCamera);

      if (terrainGlobe) {
        // LOD refinement must use height above the LOCAL terrain, not above
        // sea level — folding terrain elevation into the LOD altitude
        // stalls refinement early exactly underfoot (see terrainGlobe.ts).
        const atmDensity = atmosphereDensityFor(sim.descriptor, layout[current.body]!);
        terrainGlobe.update(current.lat ?? 0, current.lon ?? 0, terrainRenderM, aboveTerrainM, suns, 2, atmDensity, ground.dayFactor());
        renderer.render(terrainGlobe.scene, groundCamera);
      }
      labelRenderer.render(localSpace, groundCamera);
    } else {
      renderer.autoClear = true;
      view.update(states, trueScale, sim.hostOriginAt(clock.t), clock.t);
      if (focused !== null) controls.target.lerp(view.bodies[focused]!.position, 0.15);
      controls.update();
      if (now - lastDateUpdate > 250) {
        lastDateUpdate = now;
        hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
      }
      renderer.render(view.scene, spaceCamera);
      labelRenderer.render(view.scene, spaceCamera);
    }
  });

  // deep link straight into the ground view
  if (current.view === 'ground') {
    const body = current.body !== null && current.body < sim.bodyCount ? current.body : anchorBody;
    if (standableBody(sim.descriptor, layout[body]!)) {
      const d = defaultStandPoint(body);
      enterGround(body, current.lat ?? d.latDeg, current.lon ?? d.lonDeg);
    } else exitGround();
  }
}

void boot();
