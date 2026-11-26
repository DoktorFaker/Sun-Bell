import * as THREE from 'three';
import { probeDown, rayHit } from './physics.js';
import { heightAt } from '../world/terrain.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export const GUN_ALTITUDE = 15;   // the nose gun only fires at or below this height above ground
const FIRE_RATE = 14;             // rounds per second
const BULLET_SPEED = 320;
const BULLET_DMG = 2.5;

function buildModel() {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0x4d5a3a, roughness: 0.55, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.5, metalness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.35, metalness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1a22, roughness: 0.05, metalness: 0.9, envMapIntensity: 2 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xd8a640, roughness: 0.5, metalness: 0.3 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  // fuselage (nose towards +Z)
  const body = add(new THREE.SphereGeometry(1.0, 20, 14), paint, 0, 1.7, 0.6);
  body.scale.set(1.25, 1.1, 2.4);
  add(new THREE.SphereGeometry(0.98, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), glass, 0, 1.85, 1.7, -0.5).scale.set(1.12, 0.95, 1.3);
  add(new THREE.BoxGeometry(1.9, 0.12, 2.4), stripe, 0, 1.45, 0.4).scale.set(1.0, 1, 1);
  // engine housing
  add(new THREE.BoxGeometry(1.3, 0.6, 1.8), paint, 0, 2.75, -0.2);
  add(new THREE.CylinderGeometry(0.22, 0.28, 0.5, 10), dark, 0.45, 2.75, -1.2, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.22, 0.28, 0.5, 10), dark, -0.45, 2.75, -1.2, Math.PI / 2);
  // tail boom + fins
  add(new THREE.CylinderGeometry(0.18, 0.45, 5.6, 10), paint, 0, 2.05, -3.9, Math.PI / 2 - 0.06);
  add(new THREE.BoxGeometry(0.12, 1.5, 0.9), paint, 0, 2.75, -6.5, -0.25);
  add(new THREE.BoxGeometry(1.8, 0.08, 0.6), paint, 0, 2.15, -6.1);
  // skids
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.06, 0.06, 4.2, 8), steel, s * 1.1, 0.07, 0.4, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6), steel, s * 0.95, 0.55, 1.4, 0, 0, s * 0.35);
    add(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6), steel, s * 0.95, 0.55, -0.6, 0, 0, s * 0.35);
  }
  // nose gun
  const gun = new THREE.Group(); gun.position.set(0, 1.0, 2.6); g.add(gun);
  add(new THREE.SphereGeometry(0.28, 12, 8), dark, 0, 0, 0, 0, 0, 0, gun);
  for (const [x, y] of [[0.07, 0.04], [-0.07, 0.04], [0, -0.07]]) add(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6), dark, x, y, 0.55, Math.PI / 2, 0, 0, gun);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, 1.15); gun.add(muzzle);
  const flash = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 8, 3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  flash.visible = false; muzzle.add(flash);
  // main rotor
  const mast = add(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 8), dark, 0, 3.3, 0.1);
  const rotor = new THREE.Group(); rotor.position.set(0, 3.68, 0.1); g.add(rotor);
  add(new THREE.CylinderGeometry(0.25, 0.25, 0.18, 10), dark, 0, 0, 0, 0, 0, 0, rotor);
  for (let i = 0; i < 4; i++) {
    const b = add(new THREE.BoxGeometry(0.32, 0.05, 5.4), dark, 0, 0, 0, 0, i * Math.PI / 2, 0, rotor);
    b.geometry.translate(0, 0, 2.7);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.6, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x2a2a2a, transparent: true, opacity: 0, depthWrite: false }));
  disc.position.y = 3.7; disc.position.z = 0.1; g.add(disc);
  // tail rotor
  const tail = new THREE.Group(); tail.position.set(0.12, 2.75, -6.6); g.add(tail);
  for (let i = 0; i < 2; i++) add(new THREE.BoxGeometry(0.03, 1.3, 0.14), dark, 0, 0, 0, i * Math.PI / 2, 0, 0, tail);
  // nav lights
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.3, 0.2) }));
  red.position.set(-0.9, 2.15, -6.1); g.add(red);
  const grn = red.clone(); grn.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 8, 0.6) }); grn.position.x = 0.9; g.add(grn);
  return { group: g, rotor, tail, disc, gun, muzzle, flash, mast };
}

/** A flyable helicopter with a nose gun that only works when flying low. */
export class Helicopter {
  constructor(scene, pos, yaw) {
    this.scene = scene;
    this.m = buildModel();
    this.object = new THREE.Group();
    this.tilt = new THREE.Group();
    this.tilt.add(this.m.group);
    this.object.add(this.tilt);
    scene.add(this.object);
    this.pos = pos.clone();
    this.home = pos.clone(); this.homeYaw = yaw;
    this.vel = new THREE.Vector3();
    this.yaw = yaw;
    this.spool = 0;
    this.rotorAngle = 0;
    this.piloted = false;
    this.agl = 0;
    this.fireT = 0;
    this.flashT = 0;
    this.light = new THREE.PointLight(new THREE.Color(1, 0.7, 0.35), 0, 14, 2);
    this.m.muzzle.add(this.light);
    this.aimPoint = new THREE.Vector3();
    // bullets: pooled tracers
    this.bullets = [];
    const tracerGeo = new THREE.CylinderGeometry(0.025, 0.025, 2.2, 4).rotateX(Math.PI / 2);
    const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(10, 6, 2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 80; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false; mesh.frustumCulled = false;
      scene.add(mesh);
      this.bullets.push({ mesh, pos: new THREE.Vector3(), dir: new THREE.Vector3(), life: 0 });
    }
    this.place();
  }

  get gunsReady() { return this.piloted && this.spool > 0.85 && this.agl <= GUN_ALTITUDE; }
  get speed() { return Math.hypot(this.vel.x, this.vel.z); }

  groundAt(collider, x, z, fromY) {
    const hit = probeDown(collider, new THREE.Vector3(x, fromY, z), 400);
    const h = heightAt(x, z);
    return hit ? Math.max(hit.point.y, h - 0.5) : h;
  }

  place() {
    this.object.position.copy(this.pos);
    this.object.rotation.y = this.yaw;
  }

  /**
   * @param ctl { moveX, moveY, up, down, fire, lookYaw } (lookYaw = camera yaw the nose follows)
   */
  update(dt, ctl, collider, enemies, events) {
    const piloted = this.piloted;
    this.spool = clamp(this.spool + (piloted ? dt / 2.2 : -dt / 4), 0, 1);
    const ground = this.groundAt(collider, this.pos.x, this.pos.z, this.pos.y + 1.5);
    this.agl = this.pos.y - ground;

    let ax = 0, az = 0, vy = 0;
    if (piloted && this.spool > 0.8) {
      // nose follows the camera, controls are nose-relative
      this.yaw += angDiff(this.yaw, ctl.lookYaw) * (1 - Math.exp(-2.6 * dt));
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const rx = -fz, rz = fx;
      const max = 30;
      ax = (fx * ctl.moveY + rx * ctl.moveX) * max;
      az = (fz * ctl.moveY + rz * ctl.moveX) * max;
      vy = (ctl.up ? 9 : 0) - (ctl.down ? 8 : 0);
    }
    const airborne = this.agl > 0.15;
    const k = airborne ? 1.6 : 6;
    this.vel.x = damp(this.vel.x, ax, k, dt);
    this.vel.z = damp(this.vel.z, az, k, dt);
    // gravity when unpowered, otherwise hover
    const lift = this.spool > 0.8 && piloted;
    this.vel.y = lift ? damp(this.vel.y, vy, 3, dt) : this.vel.y - 9.8 * dt;

    // obstacle check (temple walls, tower, big rocks)
    const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
    const hs = hv.length();
    if (hs > 0.1) {
      const dir = hv.clone().divideScalar(hs);
      for (const y of [0.6, 1.8, 3.4]) {
        const hit = rayHit(collider, new THREE.Vector3(this.pos.x, this.pos.y + y, this.pos.z), dir, 3 + hs * dt);
        if (hit && hit.face && Math.abs(hit.face.normal.y) < 0.7) {
          const n = hit.face.normal.clone().setY(0).normalize();
          const into = this.vel.x * n.x + this.vel.z * n.z;
          if (into < 0) { this.vel.x -= n.x * into * 1.2; this.vel.z -= n.z * into * 1.2; }
        }
      }
    }
    this.pos.addScaledVector(this.vel, dt);
    // ground & ceiling
    const g2 = this.groundAt(collider, this.pos.x, this.pos.z, this.pos.y + 1.5);
    if (this.pos.y < g2) { this.pos.y = g2; if (this.vel.y < 0) this.vel.y = 0; this.vel.x *= Math.exp(-6 * dt); this.vel.z *= Math.exp(-6 * dt); }
    const ceiling = g2 + 110;
    if (this.pos.y > ceiling) { this.pos.y = ceiling; this.vel.y = Math.min(this.vel.y, 0); }
    this.pos.x = clamp(this.pos.x, -290, 290);
    this.pos.z = clamp(this.pos.z, -420, 200);
    this.agl = this.pos.y - g2;

    // visuals: bank and pitch with acceleration
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const fwd = this.vel.x * fx + this.vel.z * fz;
    const side = this.vel.x * -fz + this.vel.z * fx;
    this.tilt.rotation.x = damp(this.tilt.rotation.x, airborne ? clamp(fwd / 30, -1, 1) * 0.32 : 0, 4, dt);
    this.tilt.rotation.z = damp(this.tilt.rotation.z, airborne ? clamp(side / 30, -1, 1) * 0.35 : 0, 4, dt);
    this.object.position.copy(this.pos);
    if (airborne) this.object.position.y += Math.sin(performance.now() * 0.002) * 0.08 * this.spool;
    this.object.rotation.y = this.yaw;
    this.rotorAngle += dt * this.spool * 42;
    this.m.rotor.rotation.y = this.rotorAngle;
    this.m.tail.rotation.x = this.rotorAngle * 1.6;
    this.m.disc.material.opacity = Math.max(0, this.spool - 0.5) * 0.35;

    // downwash dust when low
    if (this.spool > 0.6 && this.agl < 10 && Math.random() < dt * 30) {
      const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 4;
      events.push({ type: 'sparks', pos: new THREE.Vector3(this.pos.x + Math.cos(a) * r, g2 + 0.2, this.pos.z + Math.sin(a) * r), n: 2, color: [0.5, 0.42, 0.3], speed: 3 });
    }

    // guns
    this.fireT -= dt;
    this.flashT -= dt;
    if (ctl.fire && piloted) {
      if (!this.gunsReady) {
        if (!this._warned || performance.now() - this._warned > 1500) { this._warned = performance.now(); events.push({ type: 'heli-too-high' }); }
      } else if (this.fireT <= 0) {
        this.fireT = 1 / FIRE_RATE;
        this.fire(events);
      }
    }
    this.m.flash.visible = this.flashT > 0;
    if (this.m.flash.visible) this.m.flash.scale.setScalar(0.7 + Math.random() * 0.6);
    this.light.intensity = this.flashT > 0 ? 40 : 0;
    // aim the gun turret at the aim point
    if (piloted) {
      const local = this.m.gun.parent.worldToLocal(this.aimPoint.clone());
      const want = local.sub(this.m.gun.position);
      this.m.gun.rotation.y = clamp(Math.atan2(want.x, want.z), -1.2, 1.2);
      this.m.gun.rotation.x = clamp(-Math.atan2(want.y, Math.hypot(want.x, want.z)), -0.3, 1.3);
    }
    this.updateBullets(dt, collider, enemies, events);
  }

  fire(events) {
    const b = this.bullets.find((q) => q.life <= 0);
    if (!b) return;
    this.m.muzzle.getWorldPosition(b.pos);
    b.dir.subVectors(this.aimPoint, b.pos).normalize();
    b.dir.x += (Math.random() - 0.5) * 0.02; b.dir.y += (Math.random() - 0.5) * 0.02; b.dir.z += (Math.random() - 0.5) * 0.02;
    b.dir.normalize();
    b.life = 1.2;
    b.mesh.visible = true;
    this.flashT = 0.035;
    events.push({ type: 'heli-shot' });
  }

  updateBullets(dt, collider, enemies, events) {
    const seg = new THREE.Vector3();
    for (const b of this.bullets) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const step = BULLET_SPEED * dt;
      // enemies: closest sphere hit along this step
      let hitEnemy = null, hitT = step;
      for (const e of enemies) {
        if (!e.alive) continue;
        const c = e.lockPoint; c.y -= 0.25;
        seg.subVectors(c, b.pos);
        const t = seg.dot(b.dir);
        if (t < 0 || t > hitT) continue;
        const d2 = seg.lengthSq() - t * t;
        const r = (e.radius || 0.45) + 0.55;
        if (d2 < r * r) { hitEnemy = e; hitT = t; }
      }
      const wall = rayHit(collider, b.pos, b.dir, hitT);
      if (wall && wall.distance < hitT) {
        events.push({ type: 'sparks', pos: wall.point.clone().addScaledVector(b.dir, -0.1), n: 5, color: [4, 3, 1.6], speed: 4 });
        events.push({ type: 'heli-impact', pos: wall.point });
        b.life = 0; b.mesh.visible = false; continue;
      }
      if (hitEnemy) {
        const p = b.pos.clone().addScaledVector(b.dir, hitT);
        hitEnemy.takeHit(BULLET_DMG, p.clone().addScaledVector(b.dir, -3), events);
        events.push({ type: 'heli-hit', pos: p, enemy: hitEnemy });
        b.life = 0; b.mesh.visible = false; continue;
      }
      b.pos.addScaledVector(b.dir, step);
      b.mesh.position.copy(b.pos);
      b.mesh.lookAt(b.pos.clone().add(b.dir));
      if (b.life <= 0) b.mesh.visible = false;
    }
  }
}
