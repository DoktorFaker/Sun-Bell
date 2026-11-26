import * as THREE from 'three';
import { probeDown, rayHit } from './physics.js';
import { M } from '../world/materials.js';
import { TEX, triplanar } from '../world/textures.js';
import { BLUEPRINT } from './blueprint.js';

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-k * dt));

export const TRUCK_CAPACITY = 60;
export const REPAIR_COST = { wood: 10, stone: 6 };

function buildModel() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x8a3b22, roughness: 0.6, metalness: 0.4 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.85, metalness: 0.3 });
  if (TEX.iron && TEX.iron.custom) { rust.color.set(0xd0c8c0); rust.metalness = 0.35; triplanar(rust, { tex: TEX.iron, scale: 0.9, normalScale: 1.2 }); }
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.6, metalness: 0.4 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.25, metalness: 1 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0f1a20, roughness: 0.05, metalness: 0.9 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xfff0c0, emissiveIntensity: 0 });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; parent.add(m); return m; };
  const bp = BLUEPRINT.truck;
  if (bp) return buildBlueprintModel(g, bp, add, chrome, lamp);
  // chassis (front towards +Z)
  add(new THREE.BoxGeometry(2.1, 0.35, 5.6), dark, 0, 0.75, 0);
  // cab and hood
  add(new THREE.BoxGeometry(2.1, 1.25, 1.7), paint, 0, 1.55, 0.95);
  add(new THREE.BoxGeometry(2.0, 0.75, 1.5), paint, 0, 1.3, 2.45);
  add(new THREE.BoxGeometry(1.9, 0.55, 0.06), glass, 0, 1.85, 1.81);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.06, 0.5, 1.1), glass, s * 1.06, 1.85, 0.95);
  add(new THREE.BoxGeometry(2.2, 0.25, 0.25), chrome, 0, 0.95, 3.25);
  for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 12), lamp, s * 0.7, 1.35, 3.21).rotation.x = Math.PI / 2;
  // bed
  add(new THREE.BoxGeometry(2.1, 0.15, 2.9), rust, 0, 1.0, -1.45);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.1, 0.55, 2.9), rust, s * 1.0, 1.35, -1.45);
  add(new THREE.BoxGeometry(2.1, 0.55, 0.1), rust, 0, 1.35, -2.85);
  // wheels
  const wheels = [];
  for (const [x, z] of [[-1.05, 2.1], [1.05, 2.1], [-1.05, -1.6], [1.05, -1.6]]) {
    const w = new THREE.Group(); w.position.set(x, 0.48, z); g.add(w);
    const spin = new THREE.Group(); w.add(spin);
    add(new THREE.CylinderGeometry(0.48, 0.48, 0.34, 16).rotateZ(Math.PI / 2), dark, 0, 0, 0, spin);
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.36, 10).rotateZ(Math.PI / 2), chrome, 0, 0, 0, spin);
    wheels.push({ group: w, spin, front: z > 0 });
  }
  const { logs, stones } = addCargo(g, add, { floor: 1.08, z0: -2.85, z1: -0.05, x0: -0.9, x1: 0.9 });
  return { group: g, wheels, logs, stones, lamp, paint, wheelPos: [[-1.05, 2.1], [1.05, 2.1], [-1.05, -1.6], [1.05, -1.6]], wheelR: 0.48 };
}

/** Logs and stones shown in the bed. */
function addCargo(g, add, bed) {
  const cargo = new THREE.Group(); g.add(cargo);
  const logs = [], stones = [];
  const zc = (bed.z0 + bed.z1) / 2, len = Math.min(2.6, bed.z1 - bed.z0 - 0.15);
  const w = bed.x1 - bed.x0, xc = (bed.x0 + bed.x1) / 2;
  for (let i = 0; i < 12; i++) {
    const l = add(new THREE.CylinderGeometry(0.13, 0.13, len, 7).rotateX(Math.PI / 2), M.wood, xc - w * 0.42 + (i % 6) * w * 0.168, bed.floor + 0.14 + Math.floor(i / 6) * 0.26, zc, cargo);
    l.visible = false; logs.push(l);
  }
  for (let i = 0; i < 10; i++) {
    const s = add(new THREE.DodecahedronGeometry(0.22, 0), M.rock, xc - w * 0.34 + (i % 5) * w * 0.17, bed.floor + 0.2 + Math.floor(i / 5) * 0.3, bed.z0 + 0.35 + (i % 2) * 0.25, cargo);
    s.visible = false; stones.push(s);
  }
  return { logs, stones };
}

/** Remap a cylinder's UVs: side -> atlas rect `side`, caps -> atlas rect `cap`. */
function wheelUV(geo, rects, side, cap) {
  const uv = geo.attributes.uv, groups = geo.groups;
  const map = (r, u, v) => [r[0] + u * r[2], 1 - (r[1] + (1 - v) * r[3])];
  for (const gr of groups) {
    const r = gr.materialIndex === 0 ? rects[side] : rects[cap];
    for (let i = gr.start; i < gr.start + gr.count; i++) {
      const k = geo.index.getX(i);
      if (uv._done?.[k]) continue;
      // tyre side: drawing runs across the tread horizontally, round the tyre vertically
      const [u, v] = gr.materialIndex === 0 ? map(r, uv.getY(k), uv.getX(k)) : map(r, uv.getX(k), uv.getY(k));
      uv.setXY(k, u, v);
      (uv._done ||= {})[k] = true;
    }
  }
  delete uv._done;
  return geo;
}

/** The truck exactly as drawn on the user's blueprint sheet. */
function buildBlueprintModel(g, bp, add, chrome, lamp) {
  const meta = bp.meta;
  const paint = new THREE.MeshStandardMaterial({ map: bp.map, roughness: 0.72, metalness: 0.05 });
  lamp.color.set(0x2a2a26);   // glass when off, glows when driving
  add(bp.geometry, paint, 0, 0, 0);
  // headlights sit on the drawn ones (front view: 11% and 89% across, 56% down)
  const pos = bp.geometry.attributes.position;
  const ly = meta.H * 0.44;
  let zf = -1e9;
  for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i) - ly) < 0.15 && Math.abs(pos.getX(i)) < 0.9) zf = Math.max(zf, pos.getZ(i));
  for (const s of [-1, 1]) {
    const l = add(new THREE.CircleGeometry(0.1, 14), lamp, s * meta.W * 0.38, ly, zf + 0.01);
    l.castShadow = false;
  }
  // wheels from the drawing's tyre + rim
  const wheelMat = new THREE.MeshStandardMaterial({ map: bp.map, roughness: 0.9, metalness: 0.05 });
  const wheels = [], wheelPos = [];
  const tx = meta.W / 2 - 0.36;
  for (const wd of meta.wheels) {
    for (const s of [-1, 1]) {
      const w = new THREE.Group(); w.position.set(s * tx, wd.y, wd.z); g.add(w);
      const spin = new THREE.Group(); w.add(spin);
      const geo = wheelUV(new THREE.CylinderGeometry(wd.r, wd.r, 0.42, 28, 1), meta.rects, 'tread', 'wheel').rotateZ(Math.PI / 2);
      add(geo, wheelMat, 0, 0, 0, spin);
      wheels.push({ group: w, spin, front: wd.z > 0 });
      wheelPos.push([s * tx, wd.z]);
    }
  }
  const { logs, stones } = addCargo(g, add, meta.bed);
  return { group: g, wheels, logs, stones, lamp, paint, wheelPos, wheelR: meta.wheels[0].r, tinted: true };
}

/** A beaten-up truck: repair it, drive it, haul supplies, and flatten anything in the way. */
export class Truck {
  constructor(scene, spot) {
    this.m = buildModel();
    this.object = new THREE.Group();
    this.body = new THREE.Group();
    this.body.add(this.m.group);
    this.object.add(this.body);
    scene.add(this.object);
    this.pos = new THREE.Vector3(spot.x, spot.y, spot.z);
    this.yaw = spot.yaw;
    this.speed = 0;       // signed, along heading
    this.steer = 0;
    this.vy = 0;
    this.broken = true;
    this.driven = false;
    this.cargo = { wood: 0, stone: 0 };
    this.lastSafe = this.pos.clone();
    this.wheelSpin = 0;
    this.m.paint.color.set(this.m.tinted ? 0x8f8a80 : 0x6b4a3a);   // dusty until repaired
    this.place();
  }

  get cargoTotal() { return this.cargo.wood + this.cargo.stone; }

  repair() {
    this.broken = false;
    this.m.paint.color.set(this.m.tinted ? 0xffffff : 0x8a3b22);
  }

  place() {
    this.object.position.copy(this.pos);
    this.object.rotation.y = this.yaw;
  }

  /**
   * ctl: { throttle -1..1, steer -1..1, brake bool }
   * isBlocked(x, z): true where the truck may not go (deep water)
   */
  update(dt, ctl, collider, events, isBlocked, pushOut) {
    const driving = this.driven && !this.broken;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const throttle = driving ? ctl.throttle : 0;
    // engine & drag
    const maxF = 21, maxR = -7;
    if (throttle > 0) this.speed += (this.speed < 0 ? 22 : 9) * throttle * dt;
    else if (throttle < 0) this.speed += (this.speed > 0 ? 20 : 6) * throttle * dt;
    else this.speed = damp(this.speed, 0, 0.9, dt);
    if (driving && ctl.brake) this.speed = damp(this.speed, 0, 5, dt);
    this.speed = clamp(this.speed, maxR, maxF);
    // steering (less at speed)
    this.steer = damp(this.steer, driving ? ctl.steer : 0, 6, dt);
    const turn = this.steer * clamp(Math.abs(this.speed) / 4, 0, 1) * (1.2 - Math.min(0.6, Math.abs(this.speed) / 35));
    this.yaw -= turn * Math.sign(this.speed) * dt * 1.0;

    // move with obstacle check
    const step = this.speed * dt;
    if (Math.abs(step) > 1e-4) {
      const dir = fwd.clone().multiplyScalar(Math.sign(step));
      let blocked = false;
      for (const side of [-0.8, 0, 0.8]) {
        const o = this.pos.clone().add(new THREE.Vector3(Math.cos(this.yaw) * side, 1.0, -Math.sin(this.yaw) * side));
        const hit = rayHit(collider, o, dir, 3.1 + Math.abs(step));
        if (hit && hit.face && Math.abs(hit.face.normal.y) < 0.6) { blocked = true; break; }
      }
      if (blocked) {
        if (Math.abs(this.speed) > 8) { events.push({ type: 'truck-crash' }); }
        this.speed *= -0.25;
      } else {
        const nx = this.pos.x + fwd.x * step, nz = this.pos.z + fwd.z * step;
        const ahead = { x: nx + fwd.x * 2.6 * Math.sign(step), z: nz + fwd.z * 2.6 * Math.sign(step) };
        if (isBlocked(ahead.x, ahead.z)) {
          if (Math.abs(this.speed) > 3) events.push({ type: 'truck-water' });
          this.speed = 0;
        } else { this.pos.x = nx; this.pos.z = nz; }
      }
    }
    if (pushOut) {
      const before = this.pos.clone();
      if (pushOut(this.pos, 1.5, 2)) { if (Math.abs(this.speed) > 6) events.push({ type: 'truck-bump' }); this.speed *= 0.5; }
      if (isBlocked(this.pos.x, this.pos.z)) this.pos.copy(before);
    }

    // follow the ground on four wheels: height, pitch, roll
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const wheelH = (lx, lz) => {
      const x = this.pos.x + c * lx + s * lz, z = this.pos.z - s * lx + c * lz;
      const hit = probeDown(collider, new THREE.Vector3(x, this.pos.y + 2.5, z), 8);
      return hit ? hit.point.y : this.pos.y;
    };
    const wp = this.m.wheelPos;
    const front = wp.filter((p) => p[1] > 0), rear = wp.filter((p) => p[1] <= 0);
    const fl = wheelH(...front[0]), fr = wheelH(...front[1]), rl = wheelH(...rear[0]), rr = wheelH(...rear[1]);
    const groundY = (fl + fr + rl + rr) / 4;
    if (this.pos.y > groundY + 0.05) { this.vy -= 20 * dt; this.pos.y = Math.max(groundY, this.pos.y + this.vy * dt); }
    else { this.pos.y = damp(this.pos.y, groundY, 25, dt); this.vy = 0; }
    const pitch = Math.atan2(((fl + fr) - (rl + rr)) / 2, 3.7);
    const roll = Math.atan2(((fl + rl) - (fr + rr)) / 2, 2.1);
    this.body.rotation.x = damp(this.body.rotation.x, -pitch, 12, dt);
    this.body.rotation.z = damp(this.body.rotation.z, roll, 12, dt);
    this.place();

    // wheels & lights
    this.wheelSpin += this.speed * dt / this.m.wheelR;
    for (const w of this.m.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      if (w.front) w.group.rotation.y = -this.steer * 0.5;
    }
    this.m.lamp.emissiveIntensity = driving ? 6 : 0;
    if (driving && Math.abs(this.speed) > 6 && Math.random() < dt * 25) {
      events.push({ type: 'sparks', pos: this.pos.clone().addScaledVector(fwd, -2.6).setY(this.pos.y + 0.2), n: 2, color: [0.5, 0.4, 0.28], speed: 2 });
    }
    // cargo display
    const logs = Math.ceil(this.cargo.wood / 5), stones = Math.ceil(this.cargo.stone / 4);
    this.m.logs.forEach((l, i) => { l.visible = i < logs; });
    this.m.stones.forEach((st, i) => { st.visible = i < stones; });
    if (!isBlocked(this.pos.x, this.pos.z)) this.lastSafe.copy(this.pos);
  }

  /** Run over enemies when moving fast. */
  ram(enemies, events) {
    const spd = Math.abs(this.speed);
    if (spd < 5) return;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      if (Math.hypot(dx, dz) > 2.6 || Math.abs(e.pos.y - this.pos.y) > 2) continue;
      if (e._ramT && performance.now() - e._ramT < 600) continue;
      e._ramT = performance.now();
      e.takeHit(spd > 12 ? 4 : 2, this.pos, events);
      events.push({ type: 'truck-hit', enemy: e });
      this.speed *= 0.8;
    }
  }
}
