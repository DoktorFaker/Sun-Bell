import * as THREE from 'three';
import { probeDown } from './physics.js';
import { Cloak } from './HumanModel.js';
import { TEX } from '../world/textures.js';
import { TEMPLE } from '../world/terrain.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => t * t * (3 - 2 * t);
const SCALE = 1.6; // ~3 m tall

/** Glowing ember cracks painted on a canvas: used as the armour's emissive map. */
function crackTexture() {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  let seed = 7; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const crack = (x, y, a, len, w, depth) => {
    g.beginPath(); g.moveTo(x, y);
    for (let i = 0; i < len; i++) {
      a += (R() - 0.5) * 0.9; x += Math.cos(a) * 9; y += Math.sin(a) * 9;
      g.lineTo(x, y);
      if (depth < 2 && R() < 0.09) { g.stroke(); crack(x, y, a + (R() < 0.5 ? 1 : -1) * (0.6 + R()), len * 0.5, w * 0.6, depth + 1); g.beginPath(); g.moveTo(x, y); }
    }
    g.lineWidth = w; g.stroke();
  };
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.shadowColor = '#ff6a10'; g.shadowBlur = 6; g.strokeStyle = '#ffb040';
  for (let i = 0; i < 9; i++) crack(R() * S, R() * S, R() * 6.28, 8 + R() * 12, 1.5 + R() * 1.8, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildModel() {
  const ember = { value: 3 };
  const armour = new THREE.MeshStandardMaterial({ color: 0x6a5848, metalness: 0.7, roughness: 0.58 });
  if (TEX.iron && TEX.iron.custom) {
    armour.map = TEX.iron.map.clone(); armour.map.repeat.set(1.5, 1.5); armour.map.needsUpdate = true;
    armour.normalMap = TEX.iron.normal.clone(); armour.normalMap.repeat.set(1.5, 1.5); armour.normalMap.needsUpdate = true;
    armour.color.set(0x8a7868);
  }
  const cracks = crackTexture();
  cracks.repeat.set(1.2, 1.2);
  armour.emissive = new THREE.Color(1, 0.32, 0.06); armour.emissiveMap = cracks; armour.emissiveIntensity = 3;
  const plain = armour.clone(); plain.emissiveIntensity = 0; // plates without cracks
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.35 });
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 2.2, 0.4) });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0806, roughness: 1 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0x8a6a48, metalness: 0.85, roughness: 0.5, emissive: new THREE.Color(1, 0.35, 0.08), emissiveMap: cracks, emissiveIntensity: 1.5 });
  if (armour.map) { bronze.map = armour.map; bronze.normalMap = armour.normalMap; }

  const mk = (geo, mat, parent, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const grp = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
  const root = new THREE.Group();
  const body = grp(root, 0, 0, 0); body.scale.setScalar(SCALE);
  const hips = grp(body, 0, 1.0, 0);
  const spine = grp(hips, 0, 0.1, 0);
  const chest = grp(spine, 0, 0.3, 0);
  // torso
  mk(new THREE.CylinderGeometry(0.2, 0.22, 0.22, 12), armour, hips, 0, 0, 0);
  const cuirass = mk(new THREE.CylinderGeometry(0.33, 0.25, 0.58, 14), armour, chest, 0, 0.02, 0); cuirass.scale.z = 0.72;
  mk(new THREE.BoxGeometry(0.05, 0.46, 0.06), plain, chest, 0, 0.04, 0.22, -0.08);                       // ridge
  mk(new THREE.TorusGeometry(0.2, 0.05, 8, 18), plain, chest, 0, 0.33, 0, Math.PI / 2);                 // gorget
  mk(new THREE.SphereGeometry(0.12, 10, 8), glow, chest, 0, 0.34, 0.02);                                 // ember at the neck
  mk(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 14), plain, spine, 0, 0.02, 0).scale.z = 0.75;           // belt
  // tassets
  for (let i = 0; i < 7; i++) {
    const a = -1.2 + i * 0.4;
    mk(new THREE.BoxGeometry(0.17, 0.32, 0.03), i % 2 ? plain : armour, hips, Math.sin(a) * 0.27, -0.2, Math.cos(a) * 0.2, 0.18, a, 0);
  }
  // head
  const neck = grp(chest, 0, 0.38, 0);
  const head = grp(neck, 0, 0.14, 0.01);
  mk(new THREE.SphereGeometry(0.16, 16, 12), armour, head, 0, 0.05, 0).scale.set(0.95, 1.18, 1.05);
  mk(new THREE.BoxGeometry(0.2, 0.26, 0.05), plain, head, 0, 0.0, 0.14, -0.05);                          // face plate
  for (const s of [-1, 1]) mk(new THREE.SphereGeometry(0.025, 8, 6), glow, head, s * 0.05, 0.06, 0.165);
  mk(new THREE.BoxGeometry(0.05, 0.1, 0.02), dark, head, 0, -0.05, 0.168);                                // mouth slit
  // crown with broken, uneven spikes
  mk(new THREE.CylinderGeometry(0.17, 0.165, 0.06, 18, 1, true), gold, head, 0, 0.19, 0);
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2, h = [0.2, 0.12, 0.26, 0.1, 0.17, 0.08, 0.22, 0.14, 0.11][i];
    mk(new THREE.ConeGeometry(0.03, h, 5), gold, head, Math.sin(a) * 0.165, 0.22 + h / 2, Math.cos(a) * 0.165, Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12);
  }
  // arms
  const arm = (s) => {
    const sh = grp(chest, s * 0.36, 0.2, 0); sh.rotation.order = 'YXZ';
    const pd = mk(new THREE.SphereGeometry(0.2, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), armour, sh, s * 0.02, 0.04, 0); pd.scale.set(1.1, 0.9, 1);
    mk(new THREE.SphereGeometry(0.21, 14, 6, 0, Math.PI * 2, Math.PI * 0.4, Math.PI * 0.2), plain, sh, s * 0.02, 0.02, 0);
    mk(new THREE.CylinderGeometry(0.11, 0.1, 0.34, 10), armour, sh, 0, -0.2, 0);
    const el = grp(sh, 0, -0.4, 0);
    mk(new THREE.SphereGeometry(0.1, 10, 8), plain, el, 0, 0, 0);
    mk(new THREE.CylinderGeometry(0.12, 0.09, 0.32, 10), armour, el, 0, -0.18, 0);
    const hand = grp(el, 0, -0.38, 0);
    mk(new THREE.BoxGeometry(0.11, 0.14, 0.14), plain, hand, 0, -0.02, 0);
    return { sh, el, hand };
  };
  const armR = arm(-1), armL = arm(1);
  // legs
  const leg = (s) => {
    const th = grp(hips, s * 0.15, -0.06, 0);
    mk(new THREE.CylinderGeometry(0.13, 0.11, 0.42, 10), armour, th, 0, -0.22, 0);
    const kn = grp(th, 0, -0.46, 0);
    mk(new THREE.SphereGeometry(0.11, 10, 8), plain, kn, 0, 0, 0.03);
    mk(new THREE.CylinderGeometry(0.11, 0.09, 0.4, 10), armour, kn, 0, -0.22, 0);
    mk(new THREE.BoxGeometry(0.15, 0.09, 0.3), plain, kn, 0, -0.46, 0.06);
    return { th, kn };
  };
  const legR = leg(-1), legL = leg(1);
  // the stolen clapper of the Sun Bell, made into a mace: a shaft with a small bell at its head
  const mace = grp(armR.hand, 0, -0.04, 0);
  mk(new THREE.CylinderGeometry(0.035, 0.04, 1.25, 8), bronze, mace, 0, -0.55, 0);
  mk(new THREE.SphereGeometry(0.06, 8, 6), bronze, mace, 0, 0.08, 0);
  const prof = [];
  for (let i = 0; i <= 14; i++) { const t = i / 14; prof.push(new THREE.Vector2(0.08 + Math.pow(t, 1.6) * 0.34 + (t > 0.9 ? (t - 0.9) * 0.6 : 0), -t * 0.62)); }
  mk(new THREE.LatheGeometry(prof, 22), bronze, mace, 0, -1.15, 0).material.side = THREE.DoubleSide;
  mk(new THREE.TorusGeometry(0.06, 0.02, 6, 12), bronze, mace, 0, -1.17, 0);
  const maceHead = new THREE.Object3D(); maceHead.position.y = -1.5; mace.add(maceHead);

  // torn royal cloak (cloth simulation, scaled up from the warden's)
  const cloak = new Cloak(chest, root);
  cloak.W = 9; cloak.H = 14; cloak.width = 0.72 * SCALE; cloak.height = 1.55 * SCALE;
  const n = cloak.W * cloak.H;
  cloak.p = new Float32Array(n * 3); cloak.q = new Float32Array(n * 3);
  cloak.anchorsLocal = [];
  for (let i = 0; i < cloak.W; i++) {
    const u = i / (cloak.W - 1) - 0.5;
    cloak.anchorsLocal.push(new THREE.Vector3(u * 0.66, 0.3 - Math.abs(u) * 0.06, -0.2 + Math.abs(u) * 0.06));
  }
  cloak.mesh.geometry.dispose();
  cloak.geo = new THREE.PlaneGeometry(1, 1, cloak.W - 1, cloak.H - 1);
  cloak.mesh.geometry = cloak.geo;
  const cm = cloak.mesh.material; cm.color.set(0x6b2420);
  if (TEX.cloth) { cm.map = TEX.cloth.map; cm.color.set(0x7a2a24); }
  // ragged hem: an alpha-tested mask of torn holes and a jagged edge
  {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); g.fillStyle = '#000';
    for (let x = 0; x < S; x += 6) { const h = 10 + Math.random() * 46; g.fillRect(x, 0, 7, h * (0.4 + 0.6 * Math.random())); }
    for (let i = 0; i < 22; i++) { g.beginPath(); g.ellipse(Math.random() * S, 30 + Math.random() * (S - 60), 2 + Math.random() * 7, 4 + Math.random() * 12, 0, 0, 6.28); g.fill(); }
    cm.alphaMap = new THREE.CanvasTexture(c); cm.alphaTest = 0.5;
  }

  return { root, body, hips, spine, chest, neck, head, armR, armL, legR, legL, mace, maceHead, cloak, armour, bronze, ember, glow };
}

/**
 * The Hollow King: final boss. Kneels dormant before the temple doors and rises when the warden
 * climbs the platform. Attacks: overhead slam (shockwave), wide sweep, and in the second phase
 * the bell toll — an expanding ring of sound you must roll through.
 */
export class HollowKing {
  constructor(scene) {
    this.kind = 'boss';
    this.scene = scene;
    this.home = new THREE.Vector3(TEMPLE.x, TEMPLE.y + 3, TEMPLE.z + 14);
    this.pos = this.home.clone();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.maxHP = 70; this.hp = 70;
    this.radius = 1.15;
    this.m = buildModel();
    this.object = this.m.root;
    scene.add(this.object);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.2, 0.6), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.ring.visible = false; scene.add(this.ring);
    this.pose = { lean: 0, rx: -0.15, ry: 0, re: -0.2, lx: -0.1, le: -0.3, crouch: 0, twist: 0 };
    this.phaseT = 0;
    this.reset();
  }

  get alive() { return this.state !== 'dead'; }
  get awake() { return !['dormant', 'dead'].includes(this.state); }
  get lockPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + 2.5, this.pos.z); }

  reset() {
    this.pos.copy(this.home); this.vel.set(0, 0, 0); this.yaw = 0;
    this.hp = this.maxHP; this.phase2 = false; this.poise = 0; this.cooldown = 1.5;
    this.state = 'dormant'; this.stateT = 0; this.object.visible = true; this.ring.visible = false;
    this.m.cloak.reset();
  }

  go(s) { this.state = s; this.stateT = 0; this.hitDone = false; }

  takeHit(dmg, fromPos, events) {
    if (!this.alive) return false;
    if (this.state === 'dormant' && !this.sealOpen) return false; // a sleeping statue until the seal breaks
    if (this.state === 'dormant') { this.go('rise'); events.push({ type: 'boss-wake', enemy: this }); }
    this.hp -= dmg;
    this.poise += dmg;
    this.m.ember.flash = 1;
    events.push({ type: 'boss-hit', enemy: this });
    if (this.hp <= 0) { this.hp = 0; this.go('dead'); events.push({ type: 'kill', enemy: this, boss: true }); return true; }
    if (!this.phase2 && this.hp < this.maxHP * 0.5) { this.phase2 = true; this.go('roar'); events.push({ type: 'boss-phase2', enemy: this }); return true; }
    if (this.poise >= 7 && !['slamWind', 'sweepWind', 'tollWind', 'roar'].includes(this.state)) { this.poise = 0; this.go('stagger'); events.push({ type: 'boss-stagger', enemy: this }); }
    return true;
  }

  update(dt, hero, others, collider, events) {
    this.stateT += dt; this.phaseT += dt;
    this.cooldown -= dt;
    const t = this.stateT;
    const toHero = new THREE.Vector3(hero.pos.x - this.pos.x, 0, hero.pos.z - this.pos.z);
    const dist = toHero.length();
    const heroYaw = Math.atan2(toHero.x, toHero.z);
    const fast = this.phase2 ? 1.25 : 1;
    let speed = 0, face = null, turnK = 2.6;

    switch (this.state) {
      case 'dormant':
        if (this.sealOpen && hero.targetable && dist < 17 && hero.pos.y > TEMPLE.y + 2) { this.go('rise'); events.push({ type: 'boss-wake', enemy: this }); }
        break;
      case 'rise':
        face = heroYaw; turnK = 1.5;
        if (t > 2.6) { this.go('chase'); this.cooldown = 0.6; }
        break;
      case 'chase': {
        if (!hero.targetable || dist > 48) { this.go('return'); break; }
        face = heroYaw;
        if (dist > 3.6) speed = (dist > 9 ? 3.4 : 2.4) * fast;
        if (this.cooldown <= 0 && Math.abs(angDiff(this.yaw, heroYaw)) < 0.7) {
          const opts = [];
          if (dist < 5.2) opts.push('sweep', 'slam');
          if (dist < 7.5) opts.push('slam');
          if (dist < 11 && (this.phase2 || dist > 6)) opts.push('toll');
          if (opts.length) {
            let a = opts[Math.floor(Math.random() * opts.length)];
            if (a === this.last && opts.length > 1) a = opts.find((o) => o !== a);
            this.last = a;
            this.go(a + 'Wind');
            events.push({ type: 'boss-windup', enemy: this, attack: a });
          }
        }
        break;
      }
      case 'return': {
        const w = new THREE.Vector3(this.home.x - this.pos.x, 0, this.home.z - this.pos.z);
        if (w.length() < 1) { this.hp = this.maxHP; this.phase2 = false; this.go('dormant'); this.yaw = 0; events.push({ type: 'boss-leash', enemy: this }); break; }
        speed = 3; face = Math.atan2(w.x, w.z);
        if (hero.targetable && dist < 14) this.go('chase');
        break;
      }
      // --- overhead slam: big telegraph, shockwave where the bell lands
      case 'slamWind':
        face = heroYaw; turnK = 2;
        if (t > 1.0 / fast) this.go('slam');
        break;
      case 'slam':
        speed = t < 0.15 ? 3.5 : 0;
        if (!this.hitDone && t > 0.22) {
          this.hitDone = true;
          const p = new THREE.Vector3(); this.m.maceHead.getWorldPosition(p); p.y = this.pos.y;
          this.shock(p, 3.4, 0.45);
          events.push({ type: 'boss-slam', pos: p });
          const d = Math.hypot(hero.pos.x - p.x, hero.pos.z - p.z);
          if (d < 3.4 && Math.abs(hero.pos.y - p.y) < 2) hero.takeHit(this.phase2 ? 40 : 32, p, events, { knock: 7, staminaMul: 1.5 });
        }
        if (t > 1.3) { this.go('chase'); this.cooldown = (this.phase2 ? 0.9 : 1.5) + Math.random(); }
        break;
      // --- wide sweep
      case 'sweepWind':
        face = heroYaw; turnK = 3;
        if (t > 0.75 / fast) this.go('sweep');
        break;
      case 'sweep':
        speed = t < 0.3 ? 2.5 : 0;
        if (!this.hitDone && t > 0.08 && t < 0.3 && dist < 5.0 && Math.abs(angDiff(this.yaw, heroYaw)) < 1.7) {
          this.hitDone = true;
          hero.takeHit(this.phase2 ? 30 : 24, this.pos, events, { knock: 9 });
        }
        if (t > 1.0) { this.go('chase'); this.cooldown = (this.phase2 ? 0.7 : 1.2) + Math.random() * 0.8; }
        break;
      // --- bell toll: a ring of sound expands from the king; roll through it
      case 'tollWind':
        face = heroYaw;
        if (t > 0.9) { this.go('toll'); this.tollR = 1; events.push({ type: 'boss-toll', pos: this.pos.clone() }); }
        break;
      case 'toll': {
        const prev = this.tollR;
        this.tollR = 1 + t * 13;
        this.ring.visible = true;
        this.ring.position.set(this.pos.x, this.pos.y + 0.15, this.pos.z);
        this.ring.scale.set(this.tollR, 1, this.tollR);
        this.ring.material.opacity = clamp(1 - t / 0.85, 0, 1);
        if (!this.hitDone && dist > prev - 0.6 && dist < this.tollR + 0.6 && Math.abs(hero.pos.y - this.pos.y) < 1.5) {
          this.hitDone = true;
          hero.takeHit(22, this.pos, events, { unblockable: true, knock: 11 });
        }
        if (t > 0.85) { this.ring.visible = false; this.go('chase'); this.cooldown = 1.4 + Math.random(); }
        break;
      }
      case 'roar':
        if (t > 2.0) { this.go('chase'); this.cooldown = 0.3; }
        break;
      case 'stagger':
        if (t > 1.6) { this.go('chase'); this.cooldown = 0.5; }
        break;
      case 'dead': break;
    }

    if (face !== null) this.yaw += angDiff(this.yaw, face) * (1 - Math.exp(-turnK * dt));
    if (this.state !== 'dead' && this.state !== 'dormant') {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.vel.x = damp(this.vel.x, fx * speed, 5, dt);
      this.vel.z = damp(this.vel.z, fz * speed, 5, dt);
      this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
      // stay on the temple platform
      this.pos.x = clamp(this.pos.x, TEMPLE.x - 21, TEMPLE.x + 21);
      if (this.pos.z > TEMPLE.z + 18.5 && this.pos.z < TEMPLE.z + 27) this.pos.x = clamp(this.pos.x, TEMPLE.x - 6, TEMPLE.x + 6); // the stairs
      this.pos.z = clamp(this.pos.z, TEMPLE.z + 7.5, TEMPLE.z + 36);
      // the warden can't walk through him
      if (hero.targetable && dist < this.radius + 0.4 && dist > 1e-3) {
        const k = (this.radius + 0.4 - dist) / dist;
        hero.pos.x += toHero.x * k; hero.pos.z += toHero.z * k;
      }
      const hit = probeDown(collider, new THREE.Vector3(this.pos.x, this.pos.y + 3, this.pos.z), 6);
      if (hit) this.pos.y = damp(this.pos.y, hit.point.y, 15, dt);
    }
    this.animate(dt);
  }

  shock(p, r, life) {
    this.ring.visible = true;
    this.ring.position.set(p.x, p.y + 0.12, p.z);
    this.ring.scale.set(0.5, 1, 0.5);
    this.shockFx = { t: 0, r, life };
  }

  animate(dt) {
    const m = this.m, P = this.pose, t = this.stateT;
    m.root.position.copy(this.pos);
    m.root.rotation.y = this.yaw;
    // embers breathe; brighter and faster in phase two, flash when hit
    m.ember.flash = Math.max(0, (m.ember.flash || 0) - dt * 4);
    const base = this.state === 'dead' ? Math.max(0, 3 - t * 0.8) : this.state === 'dormant' ? 0.8 : this.phase2 ? 3.6 : 2;
    const pulse = 0.75 + 0.25 * Math.sin(this.phaseT * (this.phase2 ? 7 : 3.5)) + 0.1 * Math.sin(this.phaseT * 17);
    m.armour.emissiveIntensity = base * pulse + m.ember.flash * 8;
    m.bronze.emissiveIntensity = base * 0.5 * pulse;
    const eye = this.state === 'dead' ? Math.max(0, 1 - t * 0.5) : this.state === 'dormant' ? 0.35 : 1;
    m.glow.color.setRGB(9 * eye, 2.2 * eye, 0.4 * eye);

    // shock ring for slams
    if (this.shockFx) {
      const s = this.shockFx; s.t += dt;
      const k = s.t / s.life;
      this.ring.scale.set(0.5 + k * s.r * 1.6, 1, 0.5 + k * s.r * 1.6);
      this.ring.material.opacity = Math.max(0, 1 - k);
      if (k >= 1) { this.shockFx = null; if (this.state !== 'toll') this.ring.visible = false; }
    }

    // target pose
    const T = { lean: 0.08, rx: -0.15, ry: 0, re: -0.25, lx: -0.12, le: -0.35, crouch: 0, twist: 0 };
    const spd = Math.hypot(this.vel.x, this.vel.z);
    let mix = null;
    const k = (a, b, s) => { const o = {}; for (const key in a) o[key] = lerp(a[key], b[key] ?? a[key], s); return o; };
    switch (this.state) {
      case 'dormant': Object.assign(T, { lean: 0.55, crouch: 0.55, rx: -0.5, re: -0.6, lx: -0.7, le: -1.1 }); break;
      case 'rise': {
        const u = easeInOut(clamp(t / 2.4, 0, 1));
        Object.assign(T, { lean: lerp(0.55, -0.15, u), crouch: lerp(0.55, 0, u), rx: lerp(-0.5, -0.3, u), lx: lerp(-0.7, -0.9, u), le: lerp(-1.1, -1.6, u) });
        if (t > 1.9) Object.assign(T, { lean: -0.25, lx: -1.4, le: -0.4 });
        break;
      }
      case 'slamWind': mix = k(P, { rx: -3.0, re: -0.4, ry: -0.2, lean: -0.15, lx: -1.0, le: -1.2, crouch: 0.05, twist: -0.15 }, easeInOut(clamp(t / 0.8, 0, 1))); break;
      case 'slam': mix = { ...P, ...k({ rx: -3.0, re: -0.4, lean: -0.15, crouch: 0.05, ry: -0.2, twist: -0.15 }, { rx: -0.55, re: -0.05, lean: 0.5, crouch: 0.3, ry: 0, twist: 0 }, easeOut(clamp(t / 0.22, 0, 1))) }; if (t > 0.5) mix = null, Object.assign(T, { lean: 0.45, crouch: 0.25, rx: -0.6, re: -0.05 }); break;
      case 'sweepWind': mix = k(P, { rx: -1.3, ry: -1.4, re: -0.3, twist: -0.6, lean: 0.05, crouch: 0.1 }, easeInOut(clamp(t / 0.6, 0, 1))); break;
      case 'sweep': mix = { ...P, ...k({ rx: -1.3, ry: -1.4, twist: -0.6 }, { rx: -1.2, ry: 1.3, twist: 0.7 }, easeOut(clamp(t / 0.28, 0, 1))) }; if (t > 0.45) mix = null, Object.assign(T, { twist: 0.4 }); break;
      case 'tollWind': mix = k(P, { rx: -2.2, re: -0.2, lean: -0.3, crouch: 0.0, lx: -2.0, le: -0.8 }, easeInOut(clamp(t / 0.8, 0, 1))); break;
      case 'toll': Object.assign(T, { rx: -0.3, lean: 0.4, crouch: 0.35, lx: -0.4 }); break;
      case 'roar': Object.assign(T, { lean: -0.45, lx: -0.8, le: -0.3, rx: -0.6, re: -0.2, crouch: 0.1 }); break;
      case 'stagger': Object.assign(T, { lean: 0.7, crouch: 0.6, rx: -0.2, lx: -1.2, le: -0.4 }); break;
      case 'dead': {
        const u = easeOut(clamp(t / 2.5, 0, 1));
        Object.assign(T, { lean: 0.6 + u * 0.4, crouch: 0.6 + u * 0.25, rx: -0.1, lx: -0.2, le: -0.1, re: -0.1 });
        break;
      }
    }
    if (mix) Object.assign(P, mix);
    else for (const key in T) P[key] = damp(P[key], T[key], key === 'crouch' || key === 'lean' ? 4 : 8, dt);

    // walk cycle
    this.gait = (this.gait || 0) + dt * (0.6 + spd * 0.28);
    const g = this.gait * Math.PI * 2;
    const la = clamp(spd / 2.5, 0, 1);
    const sw = Math.sin(g) * 0.5 * la;
    m.legR.th.rotation.x = -sw - P.crouch * 1.4; m.legL.th.rotation.x = sw - P.crouch * 1.4;
    m.legR.kn.rotation.x = Math.max(0, Math.sin(g + 1.3)) * 0.9 * la + P.crouch * 2.2;
    m.legL.kn.rotation.x = Math.max(0, Math.sin(g + 1.3 + Math.PI)) * 0.9 * la + P.crouch * 2.2;
    if (this.state === 'dormant' || this.state === 'dead') { m.legR.th.rotation.x = -1.5 * Math.min(1, P.crouch / 0.55); m.legR.kn.rotation.x = 2.3 * Math.min(1, P.crouch / 0.55); m.legL.th.rotation.x = -0.2; m.legL.kn.rotation.x = 1.6 * Math.min(1, P.crouch / 0.55); }
    m.hips.position.y = 1.0 - P.crouch * 0.5 + Math.abs(Math.cos(g)) * 0.03 * la;
    m.hips.rotation.y = Math.sin(g) * 0.08 * la + P.twist * 0.4;
    m.spine.rotation.set(P.lean * 0.6, P.twist * 0.6, 0);
    m.chest.rotation.set(P.lean * 0.4 + Math.sin(this.phaseT * 1.3) * 0.02, P.twist * 0.4, 0);
    m.head.rotation.x = -P.lean * 0.5 + (this.state === 'roar' ? -0.4 : 0);
    m.armR.sh.rotation.set(P.rx + (mix ? 0 : sw * 0.3), P.ry, 0.12);
    m.armR.el.rotation.x = P.re;
    m.armL.sh.rotation.set(P.lx - sw * 0.4, 0.15, -0.15);
    m.armL.el.rotation.x = P.le;
    // the mace hangs from the hand and drags behind the swing
    m.mace.rotation.x = damp(m.mace.rotation.x, (mix && this.state.endsWith('Wind')) ? 0.25 : 0.05 - la * 0.15, 6, dt);
    // cloak
    m.root.updateMatrixWorld(true);
    const c1 = new THREE.Vector3(0, 0.0, 0).applyMatrix4(m.chest.matrixWorld);
    const c2 = new THREE.Vector3(0, -0.1, 0).applyMatrix4(m.hips.matrixWorld);
    const c3 = new THREE.Vector3(0, -0.25, 0).applyMatrix4(m.legL.th.matrixWorld);
    const c4 = new THREE.Vector3(0, -0.25, 0).applyMatrix4(m.legR.th.matrixWorld);
    m.cloak.update(dt, [
      { x: c1.x, y: c1.y, z: c1.z, r: 0.52 }, { x: c2.x, y: c2.y, z: c2.z, r: 0.5 },
      { x: c3.x, y: c3.y, z: c3.z, r: 0.24 }, { x: c4.x, y: c4.y, z: c4.z, r: 0.24 },
    ]);
  }
}
