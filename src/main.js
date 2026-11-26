import * as THREE from 'three';
import { PRESETS, ORDER, detectTier } from './quality.js';
import { Input } from './input.js';
import { isTouch, goFullscreenLandscape } from './touch.js';
import { Pipeline } from './post/Pipeline.js';
import { World } from './world/World.js';
import { Game } from './game/Game.js';
import { generateTextures, loadTextureOverrides } from './world/textures.js';
import { loadBranchTextures } from './world/trees.js';
import { loadCartBotAtlas } from './game/CartBot.js';
import { loadClientAtlas } from './game/Client.js';
import { loadAvatar, avatarChoice } from './game/Avatar.js';
import { loadBlueprints } from './game/blueprint.js';
import { loadZombies } from './game/Zombie.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#c');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
if (!renderer.capabilities.isWebGL2) {
  document.body.innerHTML = '<p style="color:#eee;font:18px serif;padding:40px">This game needs WebGL 2.</p>';
  throw new Error('WebGL2 required');
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.autoClear = true;

// --- quality selection
const detected = detectTier(renderer);
const saved = (() => { try { return localStorage.getItem('sunbell.quality'); } catch { return null; } })();
const params = new URLSearchParams(location.search);
let tier = params.get('quality') || saved || detected.tier;
if (!PRESETS[tier]) tier = detected.tier;
let manual = !!(params.get('quality') || saved);
let quality = PRESETS[tier];

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1500);
const input = new Input(canvas);
const pipeline = new Pipeline(renderer);
generateTextures(quality.renderScale < 0.8 ? 256 : 512);
const [customTextures] = await Promise.all([loadTextureOverrides(quality.renderScale < 0.8 ? 512 : 1024), loadBranchTextures()]);
if (customTextures.length) console.info('Custom textures:', customTextures.join(', '));
await loadBlueprints();
const world = new World(renderer, quality);
await Promise.all([loadCartBotAtlas(), loadClientAtlas(), loadAvatar(), loadZombies()]);
world.camera = camera;
const game = new Game({ world, camera, input, pipeline });
window.__game = game; import('./game/Zombie.js').then((m) => { window.__gore = (dt) => m.GORE.update(dt); }); window.THREE = THREE; import('./world/terrain.js').then((t) => { window.__T = t.TEMPLE; }); window.__renderer = renderer; window.__pipeline = pipeline; // handy for debugging in the console

function applySize() {
  const dpr = Math.min(devicePixelRatio || 1, quality.maxDpr);
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  pipeline.configure(quality, Math.round(innerWidth * dpr), Math.round(innerHeight * dpr));
}
function applyQuality(name, why) {
  tier = name; quality = PRESETS[name];
  world.applyShadowQuality(quality);
  world.setGrass(quality.grass);
  applySize();
  renderPresetButtons();
  if (why) game.toast(why, true, 3);
}
applySize();
addEventListener('resize', applySize);

// --- UI wiring
$('#gpuline').textContent = `${detected.gpu} → ${PRESETS[detected.tier].name} preset (${detected.reason})`;
const startBtn = $('#start');
startBtn.disabled = false;
startBtn.textContent = 'Begin';
if (isTouch) document.body.classList.add('touch');
startBtn.addEventListener('click', () => {
  if (isTouch) goFullscreenLandscape();
  $('#title').classList.add('hidden');
  input.requestLock();
  game.start();
});
function renderPresetButtons() {
  const wrap = $('#presets');
  wrap.innerHTML = '';
  const mk = (label, on, fn) => { const b = document.createElement('button'); b.textContent = label; if (on) b.className = 'on'; b.onclick = fn; wrap.appendChild(b); };
  mk(`Auto (${PRESETS[detected.tier].name})`, !manual, () => { manual = false; try { localStorage.removeItem('sunbell.quality'); } catch {} applyQuality(detected.tier); });
  for (const k of ORDER) mk(PRESETS[k].name, manual && tier === k, () => { manual = true; try { localStorage.setItem('sunbell.quality', k); } catch {} applyQuality(k); });
  const cw = $('#herochoice');
  cw.innerHTML = '';
  for (const [k, label] of [['heroine', 'Heroine'], ['warden', 'Warden']]) {
    const b = document.createElement('button'); b.textContent = label; if (avatarChoice() === k) b.className = 'on';
    b.onclick = () => { try { localStorage.setItem('sunbell.hero', k); } catch {} location.reload(); };
    cw.appendChild(b);
  }
  $('#gpuinfo').textContent = `${detected.gpu} · detected ${PRESETS[detected.tier].name} · running ${quality.name} at ${pipeline.W}×${pipeline.H}`;
}
renderPresetButtons();

const pauseEl = $('#pause');
function setPaused(p) {
  if (game.mode === 'title') return;
  if (p) { game.prevMode = game.mode === 'paused' ? game.prevMode : game.mode; game.mode = 'paused'; pauseEl.classList.remove('hidden'); renderPresetButtons(); }
  else { pauseEl.classList.add('hidden'); game.mode = game.prevMode || 'play'; input.requestLock(); }
}
input.onLockChange = (locked) => { if (!locked && game.mode !== 'title') setPaused(true); };
$('#resume').onclick = () => { if (isTouch) goFullscreenLandscape(); setPaused(false); };
// phones: pause when the app goes to the background
document.addEventListener('visibilitychange', () => { if (document.hidden && isTouch && game.mode !== 'title') setPaused(true); });
canvas.addEventListener('click', () => { if (game.mode === 'paused') setPaused(false); });
$('#sens').oninput = (e) => { input.sensitivity = 0.0022 * parseFloat(e.target.value); };
const fpsEl = $('#fps');
$('#showfps').onchange = (e) => fpsEl.classList.toggle('hidden', !e.target.checked);
input.onToast = (t) => game.toast(t, true);

// --- adaptive safety net: step down once or twice if the detected preset is too heavy
const perf = { t: 0, frames: 0, acc: 0, warm: 6, steps: 0 };
function perfWatch(dt) {
  if (game.mode !== 'play') return;
  perf.t += dt;
  if (perf.t < perf.warm) return;
  perf.frames++; perf.acc += dt;
  if (perf.acc >= 4) {
    const fps = perf.frames / perf.acc;
    perf.frames = 0; perf.acc = 0;
    const i = ORDER.indexOf(tier);
    if (!manual && fps < 36 && i > 0 && perf.steps < 2) {
      perf.steps++;
      applyQuality(ORDER[i - 1], `Graphics lowered to ${PRESETS[ORDER[i - 1]].name} to keep things smooth`);
      perf.t = perf.warm - 3;
    }
  }
}

// --- main loop
const clock = new THREE.Timer();
let fpsAcc = 0, fpsN = 0, elapsed = 0;
function frame() {
  clock.update(); const dt = Math.min(clock.getDelta(), 1 / 20);
  elapsed += dt;
  if (game.input.pressed.has('pause')) {
    if (game.mode === 'paused') setPaused(false);
    else if (game.mode !== 'title') { document.exitPointerLock?.(); setPaused(true); }
  }
  if (game.input.pressed.has('fps')) { fpsEl.classList.toggle('hidden'); $('#showfps').checked = !fpsEl.classList.contains('hidden'); }
  if (input.touch) input.touch.setVisible(game.mode !== 'title' && game.mode !== 'paused');
  if (game.mode !== 'paused') {
    game.update(dt, elapsed);
    world.update(dt, elapsed);
  } else game.input.endFrame();
  pipeline.render(world.scene, camera, world.sunInfo, dt);
  perfWatch(dt);
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fpsEl.textContent = `${Math.round(fpsN / fpsAcc)} fps · ${quality.name} · ${pipeline.W}×${pipeline.H}`; fpsAcc = 0; fpsN = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
