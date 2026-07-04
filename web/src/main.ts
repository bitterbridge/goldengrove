import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadSim, WasmLoadError, type Sim } from './sim/wasm';
import { SimClock } from './time/clock';
import { buildSpaceScene, type SpaceView } from './views/space';
import { buildGroundScene, type GroundView } from './views/ground';
import { pointToLatLon, type Vec3 } from './views/observer';
import { bodyLayout, standableBody } from './sim/layout';
import { buildHud, formatDate } from './ui/hud';
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

  const renderer = new THREE.WebGLRenderer({ antialias: true });
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
  const groundCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  groundCamera.up.set(0, 0, 1);
  let yaw = 0; // 0 = north (+Y), positive east
  let pitch = 0.15;
  const ground: GroundView = buildGroundScene(sim);

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
    onTrueScale: (on) => { trueScale = on; },
    onReroll: () => { location.hash = `seed=${randomSeed()}`; },
    onShare: () => {
      const hash = serializeAppState({ ...current, t: clock.t, speed: clock.speed, body: focused });
      history.replaceState(null, '', hash);
      void navigator.clipboard.writeText(`${location.origin}${location.pathname}${hash}`);
      hud.flashShared();
    },
    onDateJump: (year, day) => { clock.t = timeAtDate(anchorCal, year, day); },
    onToggleView: () => {
      if (current.view === 'space') enterGround(focused ?? anchorBody, current.lat ?? 15, current.lon ?? 0);
      else exitGround();
    },
  });
  hud.setActiveSpeed(clock.speed);
  hud.setPaused(clock.paused);

  function refreshViewButton(): void {
    if (current.view === 'ground') {
      hud.setViewButton('◉ orrery', true);
    } else {
      const standable = focused !== null && standableBody(sim.descriptor, layout[focused]!);
      hud.setViewButton('⏚ stand here', standable);
    }
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
    refreshViewButton();
    if (clock.speed > 3600) { clock.speed = 3600; hud.setActiveSpeed(3600); }
    hud.setMaxSpeed(3600);
  }
  function exitGround(): void {
    hideAllLabels();
    current.view = 'space';
    refreshViewButton();
    hud.setMaxSpeed(null);
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
    pitch = Math.min(Math.PI / 2 - 0.01, Math.max(-0.45, pitch + e.movementY * 0.0032));
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
      ground.update(states, { body: current.body, latDeg: current.lat ?? 0, lonDeg: current.lon ?? 0 });
      groundCamera.position.set(0, 0, 0);
      groundCamera.lookAt(Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch));
      if (now - lastDateUpdate > 250) {
        lastDateUpdate = now;
        hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
      }
      renderer.render(ground.scene, groundCamera);
      labelRenderer.render(ground.scene, groundCamera);
    } else {
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
    if (standableBody(sim.descriptor, layout[body]!)) enterGround(body, current.lat ?? 15, current.lon ?? 0);
    else exitGround();
  }
}

void boot();
