import * as THREE from 'three';
import { probeDown } from './physics.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

const shared = {};
function materials() {
  if (shared.body) return shared;
  shared.body = new THREE.MeshStandardMaterial({ color: 0x1b1a1f, roughness: 0.75, metalness: 0.1 });
  shared.rag = new THREE.MeshStandardMaterial({ color: 0x2e2622, roughness: 0.95, side: THREE.DoubleSide });
  shared.iron = new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 0.55, metalness: 0.8 });
  return shared;
}

/** A Hollow: a husk of the old temple guard, hollowed out when the bell fell silent. */
export class Enemy {
  constructor(home, scene) {
    const S = materials();
    this.home = home.clone();
    this.pos = home.clone();
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * 6.28;
    this.maxHP = 4; this.hp = 4;
    this.state = 'idle'; this.stateT = Math.random() * 2;
    this.wanderTarget = home.clone();
    this.attackCooldown = 1 + Math.random();
    this.circleDir = Math.random() < 0.5 ? 1 : -1;
    this.hitThisSwing = false;
    this.flash = 0;
    this.phase = Math.random() * 10;
    this.radius = 0.45;

    // model
    const g = new THREE.Group();
    const mk = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m; };
    this.eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 2.2, 0.6) });
    this.crackMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 0.7, 0.15) });
    const hips = new THREE.Group(); hips.position.y = 1.0; g.add(hips);
    const spine = new THREE.Group(); spine.position.y = 0.05; hips.add(spine);
    spine.add(mk(new THREE.CapsuleGeometry(0.24, 0.42, 3, 8), S.body, 0, 0.32, 0));
    spine.add(mk(new THREE.CylinderGeometry(0.2, 0.36, 0.7, 8, 1, true), S.rag, 0, 0.0, 0));
    for (let i = 0; i < 4; i++) {
      const c = mk(new THREE.BoxGeometry(0.03, 0.18 + i * 0.03, 0.02), this.crackMat, (i - 1.5) * 0.08, 0.3 + (i % 2) * 0.1, 0.235);
      c.rotation.z = (i - 1.5) * 0.4; c.castShadow = false;
      spine.add(c);
    }
    const head = new THREE.Group(); head.position.set(0, 0.68, 0.06); spine.add(head);
    head.add(mk(new THREE.SphereGeometry(0.17, 10, 8), S.body, 0, 0.05, 0));
    head.add(mk(new THREE.ConeGeometry(0.22, 0.32, 8, 1, true), S.rag, 0, 0.14, -0.02)); // hood
    for (const s of [-1, 1]) { const e = mk(new THREE.SphereGeometry(0.03, 6, 4), this.eyeMat, s * 0.06, 0.06, 0.15); e.castShadow = false; head.add(e); }
    const arm = (side) => {
      const sh = new THREE.Group(); sh.position.set(side * 0.3, 0.5, 0); spine.add(sh);
      sh.add(mk(new THREE.CapsuleGeometry(0.06, 0.4, 2, 6), S.body, 0, -0.25, 0));
      const el = new THREE.Group(); el.position.y = -0.5; sh.add(el);
      el.add(mk(new THREE.CapsuleGeometry(0.05, 0.42, 2, 6), S.body, 0, -0.24, 0));
      const hand = new THREE.Group(); hand.position.y = -0.5; el.add(hand);
      sh.rotation.order = 'YXZ';
      return { sh, el, hand };
    };
    this.armR = arm(-1); this.armL = arm(1);
    // jagged blade
    const blade = new THREE.Group();
    blade.add(mk(new THREE.BoxGeometry(0.09, 1.0, 0.03), S.iron, 0, 0.55, 0));
    blade.add(mk(new THREE.BoxGeometry(0.2, 0.05, 0.06), S.iron, 0, 0.05, 0));
    blade.rotation.x = Math.PI / 2;
    this.armR.hand.add(blade);
    const leg = (side) => {
      const hp = new THREE.Group(); hp.position.set(side * 0.13, -0.05, 0); hips.add(hp);
      hp.add(mk(new THREE.CapsuleGeometry(0.075, 0.36, 2, 6), S.body, 0, -0.24, 0));
      const kn = new THREE.Group(); kn.position.y = -0.48; hp.add(kn);
      kn.add(mk(new THREE.CapsuleGeometry(0.065, 0.34, 2, 6), S.body, 0, -0.22, 0));
      return { hp, kn };
    };
    this.legR = leg(-1); this.legL = leg(1);
    this.parts = { hips, spine, head };
    this.object = g;
    g.scale.setScalar(1.08);
    scene.add(g);
  }

  get alive() { return this.state !== 'dead'; }
  get lockPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.3, this.pos.z); }

  reset() {
    this.pos.copy(this.home); this.hp = this.maxHP; this.state = 'idle'; this.stateT = 0;
    this.object.visible = true; this.object.scale.setScalar(1.08); this.deathT = 0;
    this.eyeMat.color.setRGB(6, 2.2, 0.6);
  }

  takeHit(dmg, fromPos, events) {
    if (!this.alive) return false;
    this.hp -= dmg;
    this.flash = 1;
    const away = new THREE.Vector3(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z).normalize();
    this.vel.addScaledVector(away, 4 + dmg * 2);
    if (this.hp <= 0) {
      this.state = 'dead'; this.stateT = 0;
      events.push({ type: 'kill', enemy: this });
    } else if (this.state !== 'strike' || dmg > 1.5) {
      this.state = 'stagger'; this.stateT = 0;
      this.attackCooldown = Math.max(this.attackCooldown, 0.5);
    }
    return true;
  }

  update(dt, hero, others, collider, events) {
    this.stateT += dt;
    this.phase += dt;
    this.flash = Math.max(0, this.flash - dt * 5);
    const toHero = new THREE.Vector3(hero.pos.x - this.pos.x, 0, hero.pos.z - this.pos.z);
    const dist = toHero.length();
    const heroYaw = Math.atan2(toHero.x, toHero.z);
    let speed = 0, dir = null, face = null, turnK = 6;
    this.attackCooldown -= dt;

    switch (this.state) {
      case 'idle': {
        if (this.stateT > 3) { this.stateT = 0; this.wanderTarget.set(this.home.x + (Math.random() - 0.5) * 6, 0, this.home.z + (Math.random() - 0.5) * 6); }
        const w = new THREE.Vector3(this.wanderTarget.x - this.pos.x, 0, this.wanderTarget.z - this.pos.z);
        if (w.length() > 0.6) { dir = w.normalize(); speed = 0.9; face = Math.atan2(dir.x, dir.z); }
        if (hero.targetable && dist < 15) { this.state = 'chase'; this.stateT = 0; events.push({ type: 'aggro', enemy: this }); }
        break;
      }
      case 'chase': {
        if (!hero.targetable || dist > 32 || this.pos.distanceTo(this.home) > 45) { this.state = 'return'; break; }
        face = heroYaw;
        if (dist > 2.7) { dir = toHero.clone().normalize(); speed = dist > 7 ? 4.6 : 3.2; }
        else {
          // circle and look for an opening
          dir = new THREE.Vector3(toHero.z, 0, -toHero.x).normalize().multiplyScalar(this.circleDir);
          if (dist < 1.8) dir.addScaledVector(toHero.clone().normalize(), -1).normalize();
          speed = 1.4;
          if (Math.random() < dt * 0.3) this.circleDir *= -1;
        }
        if (dist < 3.0 && this.attackCooldown <= 0 && Math.abs(angDiff(this.yaw, heroYaw)) < 0.6) {
          this.state = 'windup'; this.stateT = 0; events.push({ type: 'windup', enemy: this });
        }
        break;
      }
      case 'return': {
        const w = new THREE.Vector3(this.home.x - this.pos.x, 0, this.home.z - this.pos.z);
        if (w.length() < 1) { this.state = 'idle'; this.stateT = 0; this.hp = this.maxHP; break; }
        dir = w.normalize(); speed = 3; face = Math.atan2(dir.x, dir.z);
        if (hero.targetable && dist < 10) { this.state = 'chase'; this.stateT = 0; }
        break;
      }
      case 'windup': {
        face = heroYaw; turnK = 4;
        if (this.stateT > 0.7) { this.state = 'strike'; this.stateT = 0; this.hitThisSwing = false; events.push({ type: 'enemy-swing', enemy: this }); }
        break;
      }
      case 'strike': {
        dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        speed = this.stateT < 0.16 ? (dist > 1.6 ? 7 : 0) : 0;
        if (!this.hitThisSwing && this.stateT > 0.06 && this.stateT < 0.2) {
          const ang = Math.abs(angDiff(this.yaw, heroYaw));
          if (dist < 2.6 && ang < 1.1 && Math.abs(hero.pos.y - this.pos.y) < 1.5) {
            this.hitThisSwing = true;
            const r = hero.takeHit(22, this.pos, events);
            if (r === 'blocked') { this.state = 'recoil'; this.stateT = 0; }
          }
        }
        if (this.stateT > 0.3) { this.state = 'recover'; this.stateT = 0; }
        break;
      }
      case 'recoil': {
        if (this.stateT > 0.6) { this.state = 'chase'; this.stateT = 0; this.attackCooldown = 0.6 + Math.random(); }
        break;
      }
      case 'recover': {
        if (this.stateT > 0.75) { this.state = 'chase'; this.stateT = 0; this.attackCooldown = 0.9 + Math.random() * 1.4; }
        break;
      }
      case 'stagger': {
        if (this.stateT > 0.45) { this.state = 'chase'; this.stateT = 0; }
        break;
      }
      case 'dead': break;
    }

    if (face !== null) this.yaw += angDiff(this.yaw, face) * (1 - Math.exp(-turnK * dt));
    if (this.state !== 'dead') {
      const tx = dir ? dir.x * speed : 0, tz = dir ? dir.z * speed : 0;
      this.vel.x = damp(this.vel.x, tx, 8, dt);
      this.vel.z = damp(this.vel.z, tz, 8, dt);
      // separation
      for (const o of others) {
        if (o === this || !o.alive) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.2 && d > 1e-4) { this.pos.x += dx / d * (1.2 - d) * 0.5; this.pos.z += dz / d * (1.2 - d) * 0.5; }
      }
      if (hero.targetable) {
        const d = dist;
        if (d < 0.9 && d > 1e-4) { this.pos.x -= toHero.x / d * (0.9 - d); this.pos.z -= toHero.z / d * (0.9 - d); }
      }
      this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
      const hit = probeDown(collider, new THREE.Vector3(this.pos.x, this.pos.y + 1.6, this.pos.z), 4);
      if (hit) this.pos.y = damp(this.pos.y, hit.point.y, 20, dt);
    }
    this.animate(dt, dist);
  }

  animate(dt, dist) {
    const o = this.object;
    o.position.copy(this.pos);
    o.rotation.y = this.yaw;
    const { hips, spine, head } = this.parts;
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const la = clamp(spd / 3.5, 0, 1.2);
    const ph = this.phase * (3 + spd * 1.6);
    const swing = Math.sin(ph) * 0.7 * la;
    this.legR.hp.rotation.x = -swing - 0.25; this.legL.hp.rotation.x = swing - 0.25;
    this.legR.kn.rotation.x = Math.max(0, Math.sin(ph + 1.2)) * la + 0.35; this.legL.kn.rotation.x = Math.max(0, Math.sin(ph + 1.2 + Math.PI)) * la + 0.35;
    hips.position.y = 0.92 + Math.abs(Math.cos(ph)) * 0.05 * la;
    let sx = 0.45 + Math.sin(this.phase * 1.3) * 0.04; // hunched
    let rx = -0.4, ry = -0.2, re = -0.6, lx = Math.sin(ph) * 0.4 * la - 0.1, le = -0.3;
    let headX = -0.2;
    const t = this.stateT;
    if (this.state === 'windup') { const k = clamp(t / 0.5, 0, 1); rx = lerp(-0.4, -2.8, k); ry = -0.5 * k; re = -0.8; sx = 0.45 - 0.5 * k; headX = 0.1; }
    if (this.state === 'strike') { const k = clamp(t / 0.14, 0, 1); rx = lerp(-2.8, -0.4, k); ry = lerp(-0.5, 0.6, k); re = -0.1; sx = lerp(-0.05, 0.7, k); }
    if (this.state === 'recover') { const k = clamp(t / 0.75, 0, 1); rx = lerp(-0.4, -0.4, k); sx = lerp(0.7, 0.45, k); ry = lerp(0.6, -0.2, k); }
    if (this.state === 'recoil') { rx = -1.8; sx = -0.1; }
    if (this.state === 'stagger') { sx = -0.25 + t; headX = -0.5; }
    spine.rotation.x = sx;
    head.rotation.x = headX;
    this.armR.sh.rotation.set(rx, ry, 0.15); this.armR.el.rotation.x = re;
    this.armL.sh.rotation.set(lx, 0.2, -0.2); this.armL.el.rotation.x = le;
    // telegraph: eyes flare during windup
    const flare = this.state === 'windup' ? 1 + clamp(t / 0.5, 0, 1) * 4 : 1;
    if (this.state !== 'dead') this.eyeMat.color.setRGB(6 * flare + this.flash * 10, 2.2 * flare + this.flash * 8, 0.6 * flare + this.flash * 6);
    this.crackMat.color.setRGB(2.5 + this.flash * 20, 0.7 + this.flash * 12, 0.15 + this.flash * 8);
    if (this.state === 'dead') {
      const k = clamp(t / 1.4, 0, 1);
      spine.rotation.x = lerp(spine.rotation.x, 1.3, k);
      hips.position.y = lerp(0.92, 0.3, k);
      o.scale.set(1.08 * (1 - k * 0.3), 1.08 * (1 - k * 0.95), 1.08 * (1 - k * 0.3));
      this.eyeMat.color.setRGB(6 * (1 - k), 2.2 * (1 - k), 0.6 * (1 - k));
      if (k >= 1) o.visible = false;
    }
  }
}
