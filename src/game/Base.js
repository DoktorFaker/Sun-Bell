import * as THREE from 'three';
import { M } from '../world/materials.js';
import { heightAt, CAMP, HELIPAD, BRIDGE, BRIDGE_ENDS, bridgeLocal, deckHeight, deepWater } from '../world/terrain.js';
import { extraGround } from './physics.js';
import { TEX, triplanar } from '../world/textures.js';
import { Enemy } from './Enemy.js';
import { Zombie, zombiesReady } from './Zombie.js';

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export const BLUEPRINTS = {
  wall: { key: 1, name: 'Palisade', wood: 6, stone: 0, hp: 80 },
  stone: { key: 2, name: 'Stone wall', wood: 0, stone: 8, hp: 200 },
  trap: { key: 3, name: 'Spike trap', wood: 4, stone: 2, hp: 70, walkable: true },
  cannon: { key: 4, name: 'Cannon', wood: 8, stone: 10, hp: 140 },
  house: { key: 5, name: 'House', wood: 30, stone: 15, hp: 360 },
  bridge: { key: 6, name: 'Bridge', wood: 24, stone: 12, hp: 320, walkable: true, site: true },
};
const ORDER = ['wall', 'stone', 'trap', 'cannon', 'house', 'bridge'];
const BASE_RADIUS = 70;
const FIRST_RAID = 300;
const RAID_INTERVAL = 240;

const iron = new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.45, metalness: 0.85 });

// ---------------- structure meshes ----------------
function shadowed(g) { g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return g; }

function makeMesh(type) {
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
  };
  if (type === 'wall') {
    for (let i = 0; i < 8; i++) {
      const x = -1.75 + i * 0.5, h = 2.3 + ((i * 37) % 5) * 0.08;
      add(new THREE.CylinderGeometry(0.24, 0.27, h, 7), M.wood, x, h / 2, 0, 0, i, 0);
      add(new THREE.ConeGeometry(0.24, 0.45, 7), M.wood, x, h + 0.22, 0);
    }
    for (const y of [0.7, 1.7]) add(new THREE.BoxGeometry(4.1, 0.18, 0.14), M.wood, 0, y, -0.3);
  } else if (type === 'stone') {
    add(new THREE.BoxGeometry(4, 2.4, 0.9), M.stone, 0, 1.2, 0);
    add(new THREE.BoxGeometry(4.2, 0.25, 1.05), M.stoneDark, 0, 2.5, 0);
    for (const x of [-1.5, 0, 1.5]) add(new THREE.BoxGeometry(0.7, 0.55, 0.9), M.stone, x, 2.9, 0);
  } else if (type === 'trap') {
    add(new THREE.BoxGeometry(2, 0.12, 2), M.wood, 0, 0.06, 0);
    const spikes = new THREE.Group(); spikes.name = 'spikes'; g.add(spikes);
    for (let i = 0; i < 9; i++) add(new THREE.ConeGeometry(0.1, 0.6, 6), iron, -0.6 + (i % 3) * 0.6, 0.3, -0.6 + Math.floor(i / 3) * 0.6, 0, 0, 0, spikes);
    spikes.position.y = -0.45;
  } else if (type === 'cannon') {
    add(new THREE.BoxGeometry(1.4, 0.55, 1.9), M.wood, 0, 0.55, 0);
    for (const s of [-1, 1]) for (const z of [-0.6, 0.6]) add(new THREE.CylinderGeometry(0.38, 0.38, 0.14, 12), M.wood, s * 0.8, 0.38, z, 0, 0, Math.PI / 2);
    const turret = new THREE.Group(); turret.name = 'turret'; turret.position.y = 1.0; g.add(turret);
    const pitch = new THREE.Group(); pitch.name = 'pitch'; turret.add(pitch);
    add(new THREE.CylinderGeometry(0.22, 0.32, 1.9, 12), iron, 0, 0, 0.4, Math.PI / 2, 0, 0, pitch);
    add(new THREE.SphereGeometry(0.33, 10, 8), iron, 0, 0, -0.55, 0, 0, 0, pitch);
    const muzzle = new THREE.Object3D(); muzzle.name = 'muzzle'; muzzle.position.z = 1.4; pitch.add(muzzle);
  } else if (type === 'bridge') {
    // built in the bridge's own frame: group sits at the bridge centre (y = 0), deck follows the arch
    const L = BRIDGE.half, W = BRIDGE.width;
    for (let a = -L; a <= L; a += 0.55) {
      const p = add(new THREE.BoxGeometry(W, 0.16, 0.5), M.wood, 0, deckHeight(a) - 0.08, a);
      p.rotation.y = Math.sin(a * 13.1) * 0.02;
    }
    for (const s of [-1, 1]) {
      for (let a = -L; a <= L + 0.01; a += 2.2) add(new THREE.BoxGeometry(0.16, 1.0, 0.16), M.wood, s * (W / 2 - 0.1), deckHeight(a) + 0.45, a);
      for (let a = -L; a < L; a += 2.2) {
        const y0 = deckHeight(a) + 0.9, y1 = deckHeight(a + 2.2) + 0.9;
        const r = add(new THREE.BoxGeometry(0.12, 0.12, 2.25), M.wood, s * (W / 2 - 0.1), (y0 + y1) / 2, a + 1.1);
        r.rotation.x = -Math.atan2(y1 - y0, 2.2);
      }
      add(new THREE.BoxGeometry(0.3, 0.3, L * 2), M.bark, s * (W / 2 - 0.3), deckHeight(0) - 0.35, 0).rotation.x = 0;
    }
    for (const t of [-0.35, 0.35]) add(new THREE.BoxGeometry(W + 0.6, 0.6, 1.4), M.stone, 0, deckHeight(t * L * 2) - 0.45, t * L * 2);
  } else if (type === 'house') {
    add(new THREE.BoxGeometry(6, 3.2, 6), M.wood, 0, 1.6, 0);
    for (let y = 0.3; y < 3.2; y += 0.45) add(new THREE.BoxGeometry(6.1, 0.08, 6.1), M.bark, 0, y, 0); // log lines
    add(new THREE.BoxGeometry(1.3, 2.2, 0.12), M.bark, 0, 1.1, 3.02);
    add(new THREE.BoxGeometry(0.9, 0.8, 0.1), new THREE.MeshStandardMaterial({ color: 0x2a1a0c, emissive: 0xffa040, emissiveIntensity: 1.4 }), 1.8, 1.9, 3.02);
    for (const s of [-1, 1]) {
      const r = add(new THREE.BoxGeometry(6.8, 0.25, 4.4), M.roof || M.canvas.clone(), 0, 4.2, s * 1.55, s * 0.75, 0, 0);
      if (!M.roof) r.material.color.set(0x6b3a26);
    }
    add(new THREE.BoxGeometry(0.8, 2.2, 0.8), M.stone, 2.0, 4.5, -1.2);
  }
  return shadowed(g);
}

const ghostOk = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.6, 0.5), transparent: true, opacity: 0.35, depthWrite: false });
const ghostBad = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.25, 0.2), transparent: true, opacity: 0.35, depthWrite: false });

/**
 * The warden's fort: gathering, carrying, building and raid defence around the camp.
 */
export class Base {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.world = game.world;
    if (TEX.iron && TEX.iron.custom && !iron.userData.textured) {
      iron.userData.textured = true;
      iron.color.set(0xb8b0a8); iron.metalness = 0.45; iron.roughness = 0.7;
      triplanar(iron, { tex: TEX.iron, scale: 1.4, normalScale: 1.2 });
    }
    this.carried = { wood: 0, stone: 0 };
    this.stored = { wood: 30, stone: 20 };
    this.capacity = 60;
    this.structures = [];
    this.building = false;
    this.type = 'wall';
    this.rot = 0;
    this.ghost = null;
    this.valid = false;
    this.balls = [];
    this.raid = { timer: FIRST_RAID, active: false, wave: 0, raiders: [] };
    const fy = heightAt(CAMP.x, CAMP.z);
    this.hearth = { pos: new THREE.Vector3(CAMP.x, fy, CAMP.z), hp: 200, max: 200 };

    // stockpile (where supplies are carried to) and the war drum
    const sp = new THREE.Vector3(CAMP.x + 5.8, 0, CAMP.z + 1.2);
    sp.y = heightAt(sp.x, sp.z);
    const pile = new THREE.Group(); pile.position.copy(sp);
    for (let i = 0; i < 5; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.8, 7).rotateZ(Math.PI / 2), M.wood);
      log.position.set(-1.2, 0.16 + Math.floor(i / 3) * 0.3, -0.5 + (i % 3) * 0.34 + (i >= 3 ? 0.17 : 0));
      pile.add(log);
    }
    this.scene.add(shadowed(pile));
    this.world.interactables.push({ type: 'stockpile', position: sp, radius: 2.4, prompt: 'Store your supplies' });
    this.stockpile = sp;
    const dp = new THREE.Vector3(CAMP.x - 4.2, 0, CAMP.z + 3.6); dp.y = heightAt(dp.x, dp.z);
    const drum = new THREE.Group(); drum.position.copy(dp);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.5, 0.8, 16), M.wood); shell.position.y = 0.45; drum.add(shell);
    const skin = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.04, 16), M.canvas); skin.position.y = 0.86; drum.add(skin);
    this.scene.add(shadowed(drum));
    this.world.interactables.push({ type: 'drum', position: dp, radius: 1.8, prompt: 'Beat the war drum — call the raid now' });

    this.ui = {
      res: document.querySelector('#res'), bar: document.querySelector('#buildbar'),
      raid: document.querySelector('#raid'), hint: document.querySelector('#buildhint'),
    };
    this.ui.bar.innerHTML = ORDER.map((k) => {
      const b = BLUEPRINTS[k];
      return `<div class="slot" data-k="${k}"><kbd>${b.key}</kbd><b>${b.name}</b><span>${b.wood ? `${b.wood} wood` : ''}${b.wood && b.stone ? ' · ' : ''}${b.stone ? `${b.stone} stone` : ''}</span></div>`;
    }).join('');
  }

  get carriedTotal() { return this.carried.wood + this.carried.stone; }

  // ---------------- gathering ----------------
  /** Called once per sword swing while the blade is live. Returns true if it struck a tree or rock. */
  tryHarvest(hero, events, anyFacing = false) {
    const fx = Math.sin(hero.yaw), fz = Math.cos(hero.yaw);
    let best = null, bestD = 2.6;
    for (const h of this.world.harvest) {
      if (h.left <= 0) continue;
      const dx = h.pos.x - hero.pos.x, dz = h.pos.z - hero.pos.z;
      if (Math.abs(dx) > 4 || Math.abs(dz) > 4) continue;
      const reach = h.kind === 'rock' ? 1.0 + h.size * 0.9 : 1.5;
      const d = Math.hypot(dx, dz) - reach + 1.2;
      if (d > bestD) continue;
      if (!anyFacing && (dx * fx + dz * fz) < 0) continue;
      best = h; bestD = d;
    }
    if (!best) return false;
    if (this.carriedTotal >= this.capacity) {
      this.game.toast('Backpack full — build with B, or walk back to camp to store it', true, 1.8);
      return true;
    }
    const h = best;
    h.left--;
    const hitPos = h.pos.clone().setY(h.pos.y + (h.kind === 'tree' ? 1.2 : h.size * 0.5));
    if (h.kind === 'tree') {
      const n = Math.min(5, this.capacity - this.carriedTotal);
      this.carried.wood += n;
      events.push({ type: 'sparks', pos: hitPos, n: 14, color: [0.9, 0.6, 0.3], speed: 3 });
      this.game.sfx.chop();
      this.game.floatText(`+${n} wood`, hitPos);
      h.shake = 1;
      if (h.left <= 0) this.fell(h);
    } else {
      const n = Math.min(4, this.capacity - this.carriedTotal);
      this.carried.stone += n;
      events.push({ type: 'sparks', pos: hitPos, n: 12, color: [3, 2.8, 2.4], speed: 4 });
      this.game.sfx.clink();
      this.game.floatText(`+${n} stone`, hitPos);
      if (h.left <= 0) {
        const m = h.matrix.clone().multiply(new THREE.Matrix4().makeScale(0.55, 0.45, 0.55));
        h.mesh.setMatrixAt(h.idx, m); h.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (!this.game.flags.gatherHelp) {
      this.game.flags.gatherHelp = true;
      this.game.queueSubs([['Good timber. Press B to build right away — your backpack counts. Walk back into camp and it is stored by itself.', 5]]);
    }
    return true;
  }

  fell(h) {
    const stump = h.matrix.clone().multiply(new THREE.Matrix4().makeScale(1.25, 0.7 / (h.trunkH || 5), 1.25));
    h.trunk.setMatrixAt(h.idx, stump); h.trunk.instanceMatrix.needsUpdate = true;
    h.fol.setMatrixAt(h.idx, new THREE.Matrix4().makeScale(0, 0, 0)); h.fol.instanceMatrix.needsUpdate = true;
    this.game.sfx.crumble();
    this.game.rig.addShake(0.15);
  }

  deposit() {
    if (!this.carriedTotal) { this.game.toast('Nothing to store — cut trees and break rocks with your sword', true, 2); return; }
    this.stored.wood += this.carried.wood; this.stored.stone += this.carried.stone;
    this.game.toast(`Stored ${this.carried.wood} wood, ${this.carried.stone} stone`, true, 1.8);
    this.carried.wood = this.carried.stone = 0;
    this.game.sfx.place();
  }

  // ---------------- building ----------------
  toggleBuild(on = !this.building) {
    this.building = on;
    document.body.classList.toggle('building', on);
    this.ui.bar.classList.toggle('hidden', !on);
    this.ui.hint.classList.toggle('hidden', !on);
    if (!on && this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
    if (on) this.setType(this.type);
  }

  setType(t) {
    this.type = t;
    if (this.ghost) this.scene.remove(this.ghost);
    this.ghost = makeMesh(t);
    this.ghost.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.material = ghostOk; } });
    this.scene.add(this.ghost);
    for (const el of this.ui.bar.children) el.classList.toggle('on', el.dataset.k === t);
  }

  ghostPlacement(hero, camYaw) {
    const size = this.type === 'house' ? 6 : this.type === 'wall' || this.type === 'stone' ? 1 : 2;
    const dist = this.type === 'house' ? 6 : 3;
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    const x = Math.round((hero.pos.x + fx * dist) * 2) / 2, z = Math.round((hero.pos.z + fz * dist) * 2) / 2;
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]].map(([a, b]) => heightAt(x + a * size, z + b * size));
    const y = Math.min(...corners) - 0.05;
    const slope = Math.max(...corners) - Math.min(...corners);
    return { x, y, z, slope };
  }

  boxFor(type, x, y, z, rot) {
    const g = makeMesh(type);
    g.position.set(x, y, z); g.rotation.y = rot * Math.PI / 2; g.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(g);
  }

  /** Everything you have counts: what is stored at camp plus what is in the backpack. */
  canAfford(t) { const b = BLUEPRINTS[t] || t; return this.stored.wood + this.carried.wood >= b.wood && this.stored.stone + this.carried.stone >= b.stone; }
  spend(b) {
    for (const k of ['wood', 'stone']) {
      const fromStore = Math.min(this.stored[k], b[k]);
      this.stored[k] -= fromStore; this.carried[k] -= b[k] - fromStore;
    }
  }

  updateBuild(dt, input, hero, camYaw) {
    const p = input.pressed;
    for (const k of ORDER) if (p.has(`slot${BLUEPRINTS[k].key}`)) this.setType(k);
    if (p.has('switchNext') || p.has('switchPrev')) {
      const i = ORDER.indexOf(this.type) + (p.has('switchNext') ? 1 : -1);
      this.setType(ORDER[(i + ORDER.length) % ORDER.length]);
    }
    if (p.has('heal')) this.rot = (this.rot + 1) % 4;
    if (this.type === 'bridge') { this.updateBridgeGhost(hero, p); return; }
    const g = this.ghostPlacement(hero, camYaw);
    this.ghost.position.set(g.x, g.y, g.z);
    this.ghost.rotation.y = this.rot * Math.PI / 2;
    // validity
    this.ghost.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.ghost).expandByScalar(-0.08);
    let reason = '';
    if (Math.hypot(g.x - CAMP.x, g.z - CAMP.z) > BASE_RADIUS) reason = 'Too far from camp';
    else if (g.slope > (this.type === 'house' ? 1.6 : 1.3)) reason = 'Ground too steep';
    else if (Math.hypot(g.x - CAMP.x, g.z - CAMP.z) < (this.type === 'house' ? 7 : 3.2)) reason = 'Too close to the fire';
    else if (Math.hypot(g.x - HELIPAD.x, g.z - HELIPAD.z) < (this.type === 'house' ? 10 : 7)) reason = 'Keep the helipad clear';
    else if (this.structures.some((s) => s.box.intersectsBox(box))) reason = 'Something is in the way';
    else if (!this.canAfford(this.type)) reason = 'Not enough stored supplies';
    const heroBox = new THREE.Box3(new THREE.Vector3(hero.pos.x - 0.4, hero.pos.y, hero.pos.z - 0.4), new THREE.Vector3(hero.pos.x + 0.4, hero.pos.y + 1.8, hero.pos.z + 0.4));
    if (!reason && !BLUEPRINTS[this.type].walkable && heroBox.intersectsBox(box)) reason = 'Step back';
    this.valid = !reason;
    const mat = this.valid ? ghostOk : ghostBad;
    this.ghost.traverse((o) => { if (o.isMesh) o.material = mat; });
    const b = BLUEPRINTS[this.type];
    this.ui.hint.textContent = reason || `${b.name} — click to build · R rotate · 1-5 or wheel to choose · B to close`;
    this.ui.hint.classList.toggle('bad', !!reason);
    if (p.has('attack')) {
      if (this.valid) this.place(this.type, g.x, g.y, g.z, this.rot);
      else this.game.sfx.ui();
    }
  }

  updateBridgeGhost(hero, p) {
    this.ghost.position.set(BRIDGE.x, 0, BRIDGE.z);
    this.ghost.rotation.y = BRIDGE.yaw;
    let reason = '';
    if (this.bridge) reason = 'The bridge is already built';
    else if (Math.hypot(hero.pos.x - BRIDGE.x, hero.pos.z - BRIDGE.z) > 32) reason = 'Go to the river crossing to build the bridge';
    else if (!this.canAfford('bridge')) reason = 'Not enough stored supplies (24 wood, 12 stone)';
    this.valid = !reason;
    this.ghost.visible = !this.bridge;
    const mat = this.valid ? ghostOk : ghostBad;
    this.ghost.traverse((o) => { if (o.isMesh) o.material = mat; });
    this.ui.hint.textContent = reason || 'Bridge — click to build across the river · B to close';
    this.ui.hint.classList.toggle('bad', !!reason);
    if (p.has('attack')) {
      if (this.valid) this.placeBridge(); else this.game.sfx.ui();
    }
  }

  placeBridge() {
    const b = BLUEPRINTS.bridge;
    this.spend(b);
    const mesh = makeMesh('bridge');
    mesh.position.set(BRIDGE.x, 0, BRIDGE.z);
    mesh.rotation.y = BRIDGE.yaw;
    this.scene.add(mesh);
    mesh.updateMatrixWorld(true);
    const s = { type: 'bridge', mesh, box: new THREE.Box3().setFromObject(mesh), hp: b.hp, max: b.hp, cool: 0, shake: 0, pos: new THREE.Vector3(BRIDGE.x, deckHeight(0), BRIDGE.z) };
    this.structures.push(s);
    this.bridge = s;
    extraGround.fn = (x, z) => (this.onBridge(x, z) ? deckHeight(bridgeLocal(x, z).along) : null);
    this.game.sfx.place();
    this.game.sparks.burst(s.pos.clone(), 40, new THREE.Color(0.7, 0.55, 0.35), 4, 2);
    this.game.toast('Bridge built — the north road is open', false, 2.6);
    this.toggleBuild(false);
    if (!this.game.flags.bridgeHelp) {
      this.game.flags.bridgeHelp = true;
      this.game.queueSubs([['Raiders from the north will cross here now — and some will try to tear it down. Guard the bridge.', 4.5]]);
    }
  }

  onBridge(x, z) {
    if (!this.bridge) return false;
    const l = bridgeLocal(x, z);
    return Math.abs(l.along) < BRIDGE.half + 0.4 && Math.abs(l.side) < BRIDGE.width / 2 + 0.1;
  }

  /** Too deep to wade and not on the bridge. */
  blocked(x, z) { return deepWater(x, z) && !this.onBridge(x, z); }

  place(type, x, y, z, rot) {
    const b = BLUEPRINTS[type];
    this.spend(b);
    const mesh = makeMesh(type);
    mesh.position.set(x, y, z); mesh.rotation.y = rot * Math.PI / 2;
    this.scene.add(mesh);
    mesh.updateMatrixWorld(true);
    const s = { type, mesh, box: new THREE.Box3().setFromObject(mesh), hp: b.hp, max: b.hp, cool: 0, shake: 0, pos: new THREE.Vector3(x, y, z) };
    if (type === 'cannon') { s.turret = mesh.getObjectByName('turret'); s.pitch = mesh.getObjectByName('pitch'); s.muzzle = mesh.getObjectByName('muzzle'); }
    if (type === 'trap') s.spikes = mesh.getObjectByName('spikes');
    if (type === 'house') { this.capacity += 30; this.hearth.max += 100; this.hearth.hp += 100; this.game.toast('House built · backpack +30 · hearth stronger', true, 2.4); }
    this.structures.push(s);
    this.game.sfx.place();
    this.game.sparks.burst(new THREE.Vector3(x, y + 0.3, z), 20, new THREE.Color(0.6, 0.5, 0.35), 3, 1);
  }

  damageStructure(s, dmg) {
    if (s.hp <= 0) return;
    s.hp -= dmg;
    s.shake = 1;
    if (Math.random() < 0.3) this.game.sparks.burst(s.box.getCenter(new THREE.Vector3()), 4, new THREE.Color(0.8, 0.6, 0.4), 2.5, 1);
    if (s.hp <= 0) {
      this.scene.remove(s.mesh);
      this.structures.splice(this.structures.indexOf(s), 1);
      this.game.sparks.burst(s.box.getCenter(new THREE.Vector3()), 50, new THREE.Color(1.2, 0.9, 0.6), 5, 2);
      this.game.sfx.crumble();
      if (s.type === 'bridge') {
        this.bridge = null;
        extraGround.fn = null;
        // anything standing on it falls into the river
        for (const e of this.game.enemies) if (e.alive && deepWater(e.pos.x, e.pos.z)) e.takeHit(99, e.pos.clone().setY(e.pos.y + 1), this.game.events);
        this.game.queueSubs([['The bridge is down! Rebuild it at the crossing (B, then 6).', 3.5]]);
      }
      if (s.type === 'house') { this.capacity -= 30; this.hearth.max -= 100; this.hearth.hp = Math.min(this.hearth.hp, this.hearth.max); }
      this.game.toast(`${BLUEPRINTS[s.type].name} destroyed!`, true, 1.6);
    }
  }

  /** Push a body (feet at pos) out of solid structures; returns the structure it was pressed against. */
  pushOut(pos, radius, height = 1.8) {
    let hit = null;
    for (const s of this.structures) {
      if (BLUEPRINTS[s.type].walkable) continue;
      const b = s.box;
      if (pos.y > b.max.y - 0.3 || pos.y + height < b.min.y) continue;
      const minX = b.min.x - radius, maxX = b.max.x + radius, minZ = b.min.z - radius, maxZ = b.max.z + radius;
      if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;
      const dl = pos.x - minX, dr = maxX - pos.x, db = pos.z - minZ, df = maxZ - pos.z;
      const m = Math.min(dl, dr, db, df);
      if (m === dl) pos.x = minX; else if (m === dr) pos.x = maxX; else if (m === db) pos.z = minZ; else pos.z = maxZ;
      hit = s;
    }
    return hit;
  }

  // ---------------- raids ----------------
  startRaid() {
    const r = this.raid;
    if (r.active) return;
    r.active = true; r.wave++;
    const w = r.wave;
    const list = [];
    const kindOf = zombiesReady() ? 'zombie' : 'hollow';
    for (let i = 0; i < 4 + w * 2; i++) list.push(kindOf);
    const centre = new THREE.Vector3().copy(this.hearth.pos);
    const f = new THREE.Vector3(Math.sin(BRIDGE.yaw), 0, Math.cos(BRIDGE.yaw));
    const at = (pt, along) => new THREE.Vector3(pt.x + f.x * along, 0, pt.z + f.z * along);
    const north = this.bridge ? Math.ceil(list.length / 2) : 0;
    let saboteurs = 0;
    list.forEach((kind, i) => {
      const fromNorth = i < north;
      // north raiders come down the road beyond the river; the rest from the southern woods
      const a = fromNorth ? Math.PI + (Math.random() - 0.5) * 0.7 : (Math.random() - 0.5) * 3.0;
      const R = fromNorth ? 62 : 56;
      const x = centre.x + Math.sin(a) * R, z = centre.z + Math.cos(a) * R;
      const p = new THREE.Vector3(x, heightAt(x, z), z);
      const e = kind === 'zombie' ? new Zombie(p, this.scene) : new Enemy(p, this.scene);
      e.raider = true;
      const toward = new THREE.Vector3(x - centre.x, 0, z - centre.z).normalize();
      const hearthStop = centre.clone().addScaledVector(toward, 2.4);
      if (fromNorth) {
        const sab = saboteurs < Math.ceil(w / 2) + 1;
        if (sab) { saboteurs++; e.saboteur = true; e.route = [at(BRIDGE_ENDS.b, 4), at(BRIDGE, (Math.random() - 0.5) * 8)]; }
        else e.route = [at(BRIDGE_ENDS.b, 4), at(BRIDGE_ENDS.a, -4), hearthStop];
      } else e.route = [hearthStop];
      e.route.forEach((q) => { q.y = heightAt(q.x, q.z); });
      e.home = e.route[0].clone();
      e.state = 'return'; e.stateT = 0;
      e._safe = p.clone();
      this.game.enemies.push(e);
      r.raiders.push(e);
    });
    this.game.sfx.horn();
    this.game.toast(`Raid! Wave ${w}`, false, 2.4);
    if (w === 1) this.game.queueSubs([['They come from the treeline. Hold the camp — guard the hearth.', 4]]);
  }

  endRaid(won) {
    const r = this.raid;
    r.active = false;
    r.timer = RAID_INTERVAL;
    if (won) {
      if (r.wave === 1) this.game.setObjective('Keep the fort standing — and follow the north road to the Temple of the Sun Bell');
      const wood = 6 * r.wave, stone = 4 * r.wave;
      this.stored.wood += wood; this.stored.stone += stone;
      this.game.toast(`Raid repelled! +${wood} wood, +${stone} stone`, false, 3);
    } else {
      this.stored.wood = Math.floor(this.stored.wood / 2); this.stored.stone = Math.floor(this.stored.stone / 2);
      for (const e of r.raiders) this.removeEnemy(e);
      r.raiders = [];
      this.hearth.hp = this.hearth.max;
      this.game.toast('The camp has fallen — half the supplies are lost', false, 3.2);
    }
  }

  removeEnemy(e) {
    this.scene.remove(e.object);
    if (e.ring) this.scene.remove(e.ring, e.beam, e.crate);
    if (e.papers) e.papers.forEach((p) => this.scene.remove(p.mesh));
    const i = this.game.enemies.indexOf(e);
    if (i >= 0) this.game.enemies.splice(i, 1);
    if (this.game.target === e) this.game.target = null;
  }

  // ---------------- per-frame ----------------
  /** Before enemy updates (so raiders don't heal on arrival). */
  preEnemies() { for (const e of this.raid.raiders) e._hp = e.hp; }

  postEnemies(dt, events) {
    const r = this.raid;
    // structures block everyone; raiders that are held up bash what's in their way
    for (const e of this.game.enemies) {
      if (!e.alive) continue;
      // nobody wades the deep river; the bridge is the only way across
      if (this.blocked(e.pos.x, e.pos.z)) { if (e._safe) e.pos.copy(e._safe); }
      else e._safe = (e._safe || new THREE.Vector3()).copy(e.pos);
      if (e.route && e.route.length > 1 && Math.hypot(e.pos.x - e.route[0].x, e.pos.z - e.route[0].z) < 2.6) {
        e.route.shift();
        e.home.copy(e.route[0]);
        if (e.state === 'idle') e.state = 'return';
      }
      const s = this.pushOut(e.pos, e.radius || 0.45);
      if (e.raider) {
        if (e.hp > e._hp) e.hp = e._hp;
        const marching = ['return', 'idle', 'chase'].includes(e.state);
        if (s && marching) {
          e.siegeT = (e.siegeT || 0) + dt;
          if (e.siegeT > 0.5) this.damageStructure(s, 12 * dt);
        } else e.siegeT = 0;
        if (e.saboteur && this.bridge && this.onBridge(e.pos.x, e.pos.z) && marching) {
          e.sabT = (e.sabT || 0) + dt;
          if (e.sabT > 0.6) {
            this.damageStructure(this.bridge, 12 * dt);
            if (Math.random() < dt * 2 && this.bridge) this.game.sparks.burst(e.pos.clone().setY(e.pos.y + 0.3), 6, new THREE.Color(0.8, 0.6, 0.4), 3, 1);
          }
        } else e.sabT = 0;
        const dh = Math.hypot(e.pos.x - this.hearth.pos.x, e.pos.z - this.hearth.pos.z);
        if (dh < 3.4 && marching) {
          this.hearth.hp -= 5 * dt;
          if (Math.random() < dt * 3) this.game.sparks.burst(this.hearth.pos.clone().setY(this.hearth.pos.y + 0.6), 5, new THREE.Color(4, 1.4, 0.3), 2, 1);
        }
        if (e.saboteur && !this.bridge) e.saboteur = false;
        if ((e.state === 'idle') && this.hearth.hp > 0) { e.state = 'return'; } // keep pressing on
      }
    }
    // traps
    for (const s of [...this.structures]) {
      s.cool -= dt;
      if (s.shake > 0) { s.shake = Math.max(0, s.shake - dt * 5); s.mesh.position.x = s.pos.x + Math.sin(performance.now() * 0.08) * 0.04 * s.shake; }
      if (s.type === 'trap') {
        s.spikes.position.y = damp(s.spikes.position.y, s.cool > 0.9 ? 0.1 : -0.45, s.cool > 0.9 ? 30 : 4, dt);
        if (s.cool <= 0) {
          const victims = this.game.enemies.filter((e) => e.alive && Math.abs(e.pos.x - s.pos.x) < 1.2 && Math.abs(e.pos.z - s.pos.z) < 1.2);
          if (victims.length) {
            s.cool = 1.4;
            for (const e of victims) e.takeHit(1.5, s.pos.clone().setY(s.pos.y - 1), events);
            this.game.sfx.clink();
            this.damageStructure(s, 6);
          }
        }
      }
      if (s.type === 'cannon') this.updateCannon(s, dt, events);
    }
    this.updateBalls(dt, events);
    // raid flow
    if (r.active) {
      r.raiders = r.raiders.filter((e) => {
        if (!e.alive && e.stateT > 10) { this.removeEnemy(e); return false; }
        return true;
      });
      if (r.raiders.every((e) => !e.alive)) this.endRaid(true);
      else if (this.hearth.hp <= 0) this.endRaid(false);
    } else if (this.game.mode === 'play') {
      r.timer -= dt;
      if (r.timer <= 0) this.startRaid();
    }
  }

  updateCannon(s, dt, events) {
    let best = null, bestD = 28;
    for (const e of this.game.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - s.pos.x, e.pos.z - s.pos.z);
      if (d < bestD && d > 3) { bestD = d; best = e; }
    }
    if (!best) return;
    const want = Math.atan2(best.pos.x - s.pos.x, best.pos.z - s.pos.z) - s.mesh.rotation.y;
    s.turret.rotation.y += angDiff(s.turret.rotation.y, want) * (1 - Math.exp(-5 * dt));
    s.pitch.rotation.x = damp(s.pitch.rotation.x, -clamp(bestD / 60, 0.08, 0.5), 5, dt);
    if (s.cool <= 0 && Math.abs(angDiff(s.turret.rotation.y, want)) < 0.12) {
      s.cool = 2.4;
      const from = new THREE.Vector3(); s.muzzle.getWorldPosition(from);
      const flight = clamp(bestD / 20, 0.5, 1.5);
      const to = best.pos.clone().addScaledVector(best.vel || new THREE.Vector3(), flight * 0.8);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), iron);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.balls.push({ mesh, from, to, t: 0, dur: flight });
      this.game.sfx.cannon();
      events.push({ type: 'sparks', pos: from, n: 16, color: [6, 3, 1], speed: 4 });
    }
  }

  updateBalls(dt, events) {
    for (const b of [...this.balls]) {
      b.t += dt;
      const k = Math.min(1, b.t / b.dur);
      b.mesh.position.lerpVectors(b.from, b.to, k);
      b.mesh.position.y += Math.sin(k * Math.PI) * b.dur * 4;
      if (k >= 1) {
        this.scene.remove(b.mesh);
        this.balls.splice(this.balls.indexOf(b), 1);
        events.push({ type: 'sparks', pos: b.to.clone().setY(b.to.y + 0.4), n: 40, color: [6, 2.5, 0.8], speed: 6 });
        this.game.sfx.boom();
        for (const e of this.game.enemies) {
          if (!e.alive) continue;
          if (Math.hypot(e.pos.x - b.to.x, e.pos.z - b.to.z) < 2.8 && Math.abs(e.pos.y - b.to.y) < 2.5) e.takeHit(2.5, b.to.clone().setY(b.to.y - 1), events);
        }
      }
    }
  }

  updateHUD() {
    const c = this.carried, s = this.stored;
    this.ui.res.innerHTML = `<div><i class="wood"></i>${c.wood}<i class="stone"></i>${c.stone}<em>carried ${this.carriedTotal}/${this.capacity}</em></div>`
      + `<div class="stored"><i class="wood"></i>${s.wood}<i class="stone"></i>${s.stone}<em>stored at camp</em></div>`;
    const r = this.raid;
    if (r.active) {
      const left = r.raiders.filter((e) => e.alive).length;
      const hp = Math.max(0, this.hearth.hp / this.hearth.max);
      this.ui.raid.innerHTML = `<b>Raid · wave ${r.wave}</b> · ${left} left<div class="hearth"><div style="transform:scaleX(${hp})"></div></div>`;
      this.ui.raid.classList.add('active');
    } else {
      const t = Math.max(0, Math.ceil(r.timer));
      this.ui.raid.innerHTML = `Next raid in ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      this.ui.raid.classList.remove('active');
    }
  }

  reset() {
    // called on death/rest: clear raiders, keep the fort
    if (this.raid.active) { for (const e of this.raid.raiders) this.removeEnemy(e); this.raid.raiders = []; this.raid.active = false; this.raid.timer = RAID_INTERVAL; }
    this.hearth.hp = this.hearth.max;
  }
}
