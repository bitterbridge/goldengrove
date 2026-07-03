import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadSim, WasmLoadError, type Sim } from './sim/wasm';
import { SimClock } from './time/clock';
import { buildSpaceScene, type SpaceView } from './views/space';
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
  const state: AppState = parseAppState(location.hash) ?? defaultAppState(randomSeed());
  history.replaceState(null, '', serializeAppState(state)); // canonicalize without firing hashchange
  const seed = state.seed;
  app.replaceChildren();

  let sim: Sim;
  try {
    sim = await loadSim(seed);
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

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  app.append(renderer.domElement, labelRenderer.domElement);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 20000);
  camera.position.set(0, -28, 16);
  camera.up.set(0, 0, 1); // +Z is system north (sim frame convention)
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const view: SpaceView = buildSpaceScene(sim);
  const clock = new SimClock();
  clock.t = state.t;
  clock.speed = state.speed;
  let trueScale = false;
  let focused: number | null = null;
  if (state.body !== null && state.body < sim.bodyCount) focused = state.body;

  // Prime the view once so the host origin is known, then frame the camera
  // on it (trinary systems can have the planet host far from world origin).
  view.update(sim.statesAt(0), trueScale, sim.hostOriginAt(0));
  const [ox, oy, oz] = view.hostOriginView();
  controls.target.set(ox, oy, oz);
  camera.position.set(ox, oy - 28, oz + 16);

  const anchorCal = sim.descriptor.planets[sim.descriptor.anchor_planet]!.calendar!;
  const hud = buildHud(app, seed, {
    onPlayPause: () => { clock.paused = !clock.paused; hud.setPaused(clock.paused); },
    onSpeed: (m) => { clock.speed = m; },
    onTrueScale: (on) => { trueScale = on; },
    onReroll: () => { location.hash = `seed=${randomSeed()}`; },
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
  });
  hud.setActiveSpeed(clock.speed);

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = app;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  // click-to-focus (ignore drags)
  const down = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 4) return;
    const ndc = new THREE.Vector2(
      (e.clientX / renderer.domElement.clientWidth) * 2 - 1,
      -(e.clientY / renderer.domElement.clientHeight) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(view.bodies, false)[0];
    focused = hit ? view.bodyIndexOf(hit.object) : focused;
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') focused = null;
  });

  let lastWall = performance.now();
  let lastDateUpdate = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - lastWall) / 1000, 0.1); // clamp tab-switch jumps
    lastWall = now;
    clock.tick(dt);

    view.update(sim.statesAt(clock.t), trueScale, sim.hostOriginAt(clock.t));
    if (focused !== null) {
      controls.target.lerp(view.bodies[focused]!.position, 0.15);
    }
    controls.update();

    if (now - lastDateUpdate > 250) {
      lastDateUpdate = now;
      hud.setDate(formatDate(sim.anchorDate(clock.t), anchorCal));
    }
    renderer.render(view.scene, camera);
    labelRenderer.render(view.scene, camera);
  });
}

void boot();
