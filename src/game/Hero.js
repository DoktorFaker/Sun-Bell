import * as THREE from 'three';
import { buildHumanModel } from './HumanModel.js';
import { AVATAR, AvatarRig } from './Avatar.js';
import { resolveCapsule, probeDown, extraGround } from './physics.js';
import { slopeAt, heightAt } from '../world/terrain.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => t * t * (3 - 2 * t);

// Attack definitions: duration, hit window (normalized), damage, lunge, poses at windup and follow-through
const ATTACKS = [
  { dur: 0.52, hit: [0.30, 0.50], dmg: 1, lunge: 2.2, stamina: 14,
    wind: { rx: -1.35, ry: -1.5, re: -0.5, sw: 2.6, spy: -0.55, spx: 0.05 },
    end: { rx: -1.25, ry: 1.25, re: -0.15, sw: 2.6, spy: 0.6, spx: 0.12 } },
  { dur: 0.5, hit: [0.30, 0.50], dmg: 1, lunge: 2.0, stamina: 14,
    wind: { rx: -1.2, ry: 1.1, re: -0.9, sw: 2.6, spy: 0.6, spx: 0.05 },
    end: { rx: -1.3, ry: -1.4, re: -0.1, sw: 2.6, spy: -0.55, spx: 0.12 } },
  { dur: 0.74, hit: [0.42, 0.6], dmg: 1.8, lunge: 3.0, stamina: 20,
    wind: { rx: -3.0, ry: -0.25, re: -0.4, sw: 2.9, spy: -0.15, spx: -0.2 },
    end: { rx: -0.55, ry: -0.05, re: -0.1, sw: 2.2, spy: 0.0, spx: 0.45 } },
];
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3(), _pole = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _eul = new THREE.Euler();
const IDLE_R = { rx: -0.35, ry: -0.15, re: -0.85, sw: 1.9, spy: 0, spx: 0.04 };

export class Hero {
  constructor() {
    this.model = buildHumanModel();
    if (AVATAR.gltf) { try { this.avatar = new AvatarRig(AVATAR.gltf, this.model); } catch (e) { console.error('Avatar failed', e); } }
    this.gait = 0; this.moveBlend = 0; this.breath = 0; this.lookYaw = 0;
    this.feet = [{ side: 1, prevPhase: 0 }, { side: -1, prevPhase: 0.5 }];
    this.object = this.model.root;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();       // world velocity (y = vertical)
    this.yaw = 0;                          // facing (0 = +Z)
    this.radius = 0.36; this.height = 1.8;
    this.onGround = false;
    this.maxHP = 100; this.hp = 100;
    this.maxStamina = 100; this.stamina = 100; this.staminaDelay = 0;
    this.flasks = 3; this.maxFlasks = 3;
    this.state = 'move'; this.stateT = 0;
    this.attackIndex = 0; this.queuedAttack = false; this.attackHits = new Set();
    this.rollDir = new THREE.Vector3();
    this.blocking = false; this.blockT = 0;
    this.iframes = 0;
    this.runPhase = 0; this.speed = 0;
    this.hurtDir = new THREE.Vector3();
    this.healT = 0;
    this.pose = { ...IDLE_R, lx: -0.4, ly: 0.2, lz: -0.3, le: -1.2, shield: 0, crouch: 0, roll: 0, lean: 0, legAmt: 0 };
    this.tmp = new THREE.Vector3();
  }

  get alive() { return this.state !== 'dead'; }
  /** Enemies ignore the warden while they are flying the helicopter. */
  get targetable() { return this.state !== 'dead' && this.state !== 'pilot'; }
  get centre() { return this.tmp.set(this.pos.x, this.pos.y + 1.1, this.pos.z); }
  isAttackActive() {
    if (this.state !== 'attack') return false;
    const a = ATTACKS[this.attackIndex];
    const t = this.stateT / a.dur;
    return t >= a.hit[0] && t <= a.hit[1];
  }
  get attack() { return ATTACKS[this.attackIndex]; }

  spawn(p, yaw) {
    this.pos.copy(p); this.vel.set(0, 0, 0); this.yaw = yaw;
    this.hp = this.maxHP; this.stamina = this.maxStamina; this.flasks = this.maxFlasks;
    this.state = 'move'; this.stateT = 0; this.object.visible = true;
    this.model.cloak.reset();
  }

  useStamina(n) { this.stamina = Math.max(-10, this.stamina - n); this.staminaDelay = 0.7; }

  /**
   * @param input  polled input
   * @param camYaw camera yaw (for camera-relative movement)
   * @param target lock-on target (enemy) or null
   */
  update(dt, input, camYaw, target, collider, events) {
    this.stateT += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    if (this.staminaDelay > 0) this.staminaDelay -= dt;
    else if (this.state !== 'roll' && this.state !== 'attack') this.stamina = Math.min(this.maxStamina, this.stamina + (this.blocking ? 14 : 34) * dt);

    // movement intent (camera relative)
    const fwdX = Math.sin(camYaw), fwdZ = Math.cos(camYaw);
    const mx = input.moveX, my = input.moveY;
    const wish = new THREE.Vector3(fwdX * my - fwdZ * mx, 0, fwdZ * my + fwdX * mx);
    const wishLen = Math.min(1, wish.length());
    if (wishLen > 0.01) wish.normalize();

    const p = input.pressed;
    let hSpeed = 0;
    let faceYaw = null;
    this.blocking = false;

    switch (this.state) {
      case 'move': {
        if (p.has('roll') && this.stamina > 0 && this.onGround) { this.startRoll(wishLen > 0.1 ? wish : null); break; }
        if (p.has('attack') && this.stamina > 0) { this.startAttack(0, target); break; }
        if (p.has('heal') && this.flasks > 0 && this.hp < this.maxHP) { this.state = 'heal'; this.stateT = 0; this.flasks--; events.push({ type: 'heal-start' }); break; }
        this.blocking = input.block && this.stamina > 0;
        const sprint = input.sprint && !this.blocking && wishLen > 0.5 && this.stamina > 1 && !target;
        let spd = this.blocking ? 2.4 : sprint ? 8.2 : 5.0;
        if (target && !this.blocking) spd = 4.3;
        if (sprint) this.useStamina(16 * dt);
        hSpeed = spd * wishLen;
        if (target) {
          faceYaw = Math.atan2(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
        } else if (this.blocking) {
          faceYaw = camYaw;
        } else if (wishLen > 0.1) {
          faceYaw = Math.atan2(wish.x, wish.z);
        }
        this.sprinting = sprint;
        break;
      }
      case 'attack': {
        const a = ATTACKS[this.attackIndex];
        const t = this.stateT / a.dur;
        if (p.has('attack')) this.queuedAttack = true;
        if (p.has('roll') && t > 0.55 && this.stamina > 0) { this.startRoll(wishLen > 0.1 ? wish : null); break; }
        // lunge during the swing
        if (t > 0.2 && t < 0.5) hSpeed = a.lunge + this.lungeBoost;
        const aim = target || this.aimTarget;
        if (t < 0.32) {
          if (aim) faceYaw = Math.atan2(aim.pos.x - this.pos.x, aim.pos.z - this.pos.z);
          else if (wishLen > 0.1) faceYaw = Math.atan2(wish.x, wish.z);
        }
        if (t > 0.62 && this.queuedAttack && this.stamina > 0 && this.attackIndex < ATTACKS.length - 1) {
          this.startAttack(this.attackIndex + 1, target); break;
        }
        if (t >= 1) { this.state = 'move'; this.stateT = 0; }
        break;
      }
      case 'roll': {
        const dur = 0.62;
        const t = this.stateT / dur;
        hSpeed = t < 0.75 ? 9.5 * (1 - t * 0.6) : 3;
        if (t >= 1) { this.state = 'move'; this.stateT = 0; }
        break;
      }
      case 'hurt': {
        hSpeed = Math.max(0, 4 * (1 - this.stateT / 0.35));
        if (this.stateT > 0.42) { this.state = 'move'; this.stateT = 0; }
        break;
      }
      case 'heal': {
        hSpeed = 1.2 * wishLen;
        if (this.stateT > 0.5 && !this.healed) { this.healed = true; this.hp = Math.min(this.maxHP, this.hp + 55); events.push({ type: 'healed' }); }
        if (this.stateT > 1.1) { this.state = 'move'; this.stateT = 0; this.healed = false; }
        break;
      }
      case 'rest': hSpeed = 0; break;
      case 'dead': hSpeed = 0; break;
    }

    if (faceYaw !== null) this.yaw += angDiff(this.yaw, faceYaw) * (1 - Math.exp(-(this.state === 'attack' ? 20 : 14) * dt));

    // horizontal velocity
    let dirX, dirZ;
    if (this.state === 'roll') { dirX = this.rollDir.x; dirZ = this.rollDir.z; }
    else if (this.state === 'attack' || this.state === 'heal' && wishLen < 0.1) { dirX = Math.sin(this.yaw); dirZ = Math.cos(this.yaw); }
    else if (this.state === 'hurt') { dirX = this.hurtDir.x; dirZ = this.hurtDir.z; }
    else { dirX = wish.x; dirZ = wish.z; }
    const tx = dirX * hSpeed, tz = dirZ * hSpeed;
    const accel = this.onGround ? (this.state === 'move' ? 14 : 30) : 3;
    this.vel.x = damp(this.vel.x, tx, accel, dt);
    this.vel.z = damp(this.vel.z, tz, accel, dt);

    // steep slopes: no climbing
    const sl = slopeAt(this.pos.x, this.pos.z);
    if (sl.s > 1.05) {
      const gx = sl.gx / sl.s, gz = sl.gz / sl.s;
      const up = this.vel.x * gx + this.vel.z * gz;
      if (up > 0) { this.vel.x -= gx * up; this.vel.z -= gz * up; }
    }

    this.collider = collider;
    this.physics(dt, collider);
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.animate(dt);
  }

  physics(dt, collider) {
    const steps = 4;
    const h = dt / steps;
    const wasGround = this.onGround;
    for (let i = 0; i < steps; i++) {
      this.vel.y += -24 * h;
      this.pos.x += this.vel.x * h; this.pos.y += this.vel.y * h; this.pos.z += this.vel.z * h;
      const { delta, groundNormalY } = resolveCapsule(collider, this.pos, this.radius, this.height);
      if (this.extraCollide) this.extraCollide(this.pos, this.radius, this.height);
      const eg = extraGround.fn ? extraGround.fn(this.pos.x, this.pos.z) : null;
      if (eg !== null && this.pos.y < eg + 0.02 && this.pos.y > eg - 1.6) { this.pos.y = eg; if (this.vel.y < 0) this.vel.y = 0; delta.y = Math.max(delta.y, 0.01); }
      this.onGround = (groundNormalY > 0.55 && delta.y > Math.abs(h * this.vel.y * 0.25)) || (eg !== null && Math.abs(this.pos.y - eg) < 0.03);
      if (this.onGround) this.vel.y = Math.max(this.vel.y, 0) * 0;
      else if (delta.lengthSq() > 1e-10) {
        delta.normalize();
        const d = delta.dot(this.vel);
        if (d < 0) this.vel.addScaledVector(delta, -d);
      }
    }
    // stick to ground when walking down slopes / steps
    if (!this.onGround && wasGround && this.vel.y <= 0.5) {
      const hit = probeDown(collider, this.tmp.set(this.pos.x, this.pos.y + 0.3, this.pos.z), 0.95);
      if (hit && hit.face && hit.face.normal.y > 0.5) { this.pos.y = hit.point.y; this.vel.y = 0; this.onGround = true; }
    }
    // safety: never end up beneath the terrain surface
    const th = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < th - 0.7) { this.pos.y = th + 0.05; this.vel.y = 0; }
  }

  startAttack(i, target) {
    this.state = 'attack'; this.stateT = 0; this.attackIndex = i; this.queuedAttack = false;
    // close the gap towards the locked / soft target so swings connect
    const aim = target || this.softTarget;
    this.aimTarget = aim || null;
    this.lungeBoost = 0;
    if (aim) {
      const d = Math.hypot(aim.pos.x - this.pos.x, aim.pos.z - this.pos.z);
      const dur = ATTACKS[i].dur * 0.3;
      this.lungeBoost = THREE.MathUtils.clamp((d - 1.6) / dur - ATTACKS[i].lunge, 0, 14);
    }
    this.attackHits = new Set();
    this.useStamina(ATTACKS[i].stamina);
    this.swingSoundPlayed = false;
  }

  startRoll(dir) {
    this.state = 'roll'; this.stateT = 0;
    if (dir) this.rollDir.copy(dir);
    else this.rollDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); // backstep-roll
    this.yaw = Math.atan2(this.rollDir.x, this.rollDir.z);
    this.iframes = 0.42;
    this.useStamina(24);
  }

  /** Returns 'blocked' | 'hit' | 'ignored' */
  takeHit(dmg, fromPos, events, opts = {}) {
    if (this.state === 'dead' || this.state === 'rest' || this.state === 'pilot') return 'ignored';
    if (this.iframes > 0) { events.push({ type: 'dodge' }); return 'ignored'; }
    const toAttacker = Math.atan2(fromPos.x - this.pos.x, fromPos.z - this.pos.z);
    const facing = Math.abs(angDiff(this.yaw, toAttacker)) < 1.2;
    if (this.blocking && facing && this.stamina > 0 && !opts.unblockable) {
      this.useStamina(dmg * 1.1 * (opts.staminaMul || 1));
      this.hurtDir.set(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z).normalize();
      this.vel.addScaledVector(this.hurtDir, 3.5);
      this.blockT = 0.25;
      if (this.stamina <= 0) { // guard break
        this.state = 'hurt'; this.stateT = -0.4; this.hp -= dmg * 0.4;
        events.push({ type: 'guardbreak' });
      } else events.push({ type: 'block' });
      return 'blocked';
    }
    this.hp -= dmg;
    this.hurtDir.set(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z);
    if (this.hurtDir.lengthSq() < 1e-6) this.hurtDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.hurtDir.normalize();
    if (opts.knock) this.vel.addScaledVector(this.hurtDir, opts.knock);
    events.push({ type: 'hurt', dmg });
    if (this.hp <= 0) { this.hp = 0; this.state = 'dead'; this.stateT = 0; events.push({ type: 'death' }); }
    else { this.state = 'hurt'; this.stateT = 0; this.iframes = 0.3; }
    return 'hit';
  }

  groundAt(x, z, fromY) {
    if (this.collider) {
      const hit = probeDown(this.collider, _v.set(x, fromY + 0.7, z), 2.2);
      if (hit) return hit.point.y;
    }
    return heightAt(x, z);
  }

  /** Two-bone IK: place the ankle of thigh->shin->foot at target (world), knee bending forward. */
  solveLeg(thigh, shin, foot, target, footPitch, footRoll) {
    const parent = thigh.parent;
    _m.copy(parent.matrixWorld).invert();
    const t = _a.copy(target).applyMatrix4(_m);
    const h = thigh.position;
    const L1 = shin.position.length(), L2 = foot.position.length();
    const d = _b.copy(t).sub(h);
    const dist = THREE.MathUtils.clamp(d.length(), 0.05, L1 + L2 - 0.002);
    const dn = d.normalize();
    const axis = _c.crossVectors(dn, _pole);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
    const cosA = THREE.MathUtils.clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const thighDir = _d.copy(dn).applyAxisAngle(axis, Math.acos(cosA));
    thigh.quaternion.setFromUnitVectors(_e.copy(shin.position).normalize(), thighDir);
    const knee = _f.copy(h).addScaledVector(thighDir, L1);
    const shinDir = _g.copy(t).sub(knee).normalize().applyQuaternion(_q1.copy(thigh.quaternion).invert());
    shin.quaternion.setFromUnitVectors(_e.copy(foot.position).normalize(), shinDir);
    // foot: level with the ground (plus pitch for heel/toe), facing the body's heading
    shin.updateWorldMatrix(true, false);
    shin.getWorldQuaternion(_q1);
    _q2.setFromEuler(_eul.set(-footPitch, this.yaw, footRoll, 'YXZ'));
    foot.quaternion.copy(_q1.invert()).multiply(_q2);
  }

  animate(dt) {
    const m = this.model, Bn = m.B;
    const P = this.pose;
    const k = 16;
    m.root.position.copy(this.pos);
    m.root.rotation.y = this.yaw;

    // ---------- upper-body pose targets (attacks, block, heal, hurt) ----------
    let T = { ...IDLE_R, lx: -0.45, ly: 0.25, lz: -0.25, le: -1.3, shield: 0, crouch: 0, lean: 0 };
    const sp = this.onGround ? this.speed : 0;
    const run = clamp(sp / 5, 0, 1.7);
    if (this.state === 'move' || this.state === 'heal' || this.state === 'hurt') {
      T.lean = this.sprinting ? 0.26 : run * 0.08;
      T.rx = IDLE_R.rx - run * 0.1; T.re = IDLE_R.re - run * 0.25;
    }
    if (this.blocking) {
      T.lx = -1.45; T.ly = 0.0; T.lz = -0.45; T.le = -0.15; T.shield = 1; T.crouch = 0.06;
      T.rx = -0.2; T.ry = -0.35; T.re = -0.5;
    }
    if (this.state === 'heal') { const t = this.stateT; T.rx = -0.2; T.lx = -1.9 * Math.sin(Math.min(1, t / 0.5) * Math.PI); T.le = -1.4; T.lz = -0.5; }
    if (this.state === 'hurt') { T.lean = -0.3; T.crouch = 0.08; }
    let attackPose = null;
    if (this.state === 'attack') {
      const a = ATTACKS[this.attackIndex];
      const t = clamp(this.stateT / a.dur, 0, 1);
      const W = a.wind, E = a.end;
      const mixP = (A, Bp, s) => { const o = {}; for (const key in A) o[key] = lerp(A[key], Bp[key], s); return o; };
      if (t < a.hit[0]) attackPose = mixP(IDLE_R, W, easeInOut(t / a.hit[0]));
      else if (t < a.hit[1]) attackPose = mixP(W, E, easeOut((t - a.hit[0]) / (a.hit[1] - a.hit[0])));
      else attackPose = mixP(E, IDLE_R, easeInOut((t - a.hit[1]) / (1 - a.hit[1])));
      T.crouch = 0.07; T.lx = -0.6; T.ly = 0.5; T.le = -1.4;
    }
    for (const key of ['lx', 'ly', 'lz', 'le', 'shield', 'crouch', 'lean']) P[key] = damp(P[key], T[key], key === 'shield' ? 22 : k, dt);
    if (attackPose) Object.assign(P, attackPose);
    else for (const key of ['rx', 'ry', 're', 'sw', 'spy', 'spx']) P[key] = damp(P[key], T[key], k, dt);

    // ---------- gait ----------
    const locomote = this.onGround && ['move', 'heal', 'hurt', 'attack'].includes(this.state);
    const moving = locomote && sp > 0.25;
    this.moveBlend = damp(this.moveBlend, moving ? 1 : 0, 7, dt);
    const freq = 0.8 + sp * 0.16;
    this.gait = (this.gait + freq * dt * (moving ? 1 : 0.0)) % 1;
    const stride = Math.min(1.15, sp * 0.5 / freq);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    let lx = this.vel.x * cy - this.vel.z * sy, lz = this.vel.x * sy + this.vel.z * cy;
    const ll = Math.hypot(lx, lz);
    if (ll > 0.05) { lx /= ll; lz /= ll; } else { lx = 0; lz = 1; }
    const mb = this.moveBlend;
    this.breath += dt * (1.1 + run * 1.2);
    const breath = Math.sin(this.breath * Math.PI * 2 * 0.25);
    const g2 = this.gait * Math.PI * 2;

    // feet targets
    const feetT = [];
    let minGround = Infinity;
    for (const f of this.feet) {
      const phase = (this.gait + (f.side === 1 ? 0 : 0.5)) % 1;
      let off, lift = 0, pitch = 0;
      if (phase < 0.5) { const u = phase / 0.5; off = stride * (0.5 - u); pitch = -0.45 * sstep(0.7, 1, u) * run; }
      else { const u = (phase - 0.5) / 0.5; off = stride * (-0.5 + sstep(0, 1, u)); lift = Math.sin(u * Math.PI) * (0.06 + 0.08 * run); pitch = u < 0.5 ? -0.5 * (1 - u * 2) * run : 0.3 * sstep(0.6, 1, u) * run; }
      // idle stance: a natural, slightly staggered stance
      const idleZ = f.side === 1 ? 0.06 : -0.04;
      const localX = f.side * (0.1 + 0.02 * (1 - mb)) + lx * off * mb;
      const localZ = lz * off * mb + idleZ * (1 - mb) + 0.02;
      const wx = this.pos.x + localX * cy + localZ * sy, wz = this.pos.z - localX * sy + localZ * cy;
      const gy = this.groundAt(wx, wz, this.pos.y);
      minGround = Math.min(minGround, gy);
      // slope under the foot for pitch alignment
      const gF = this.groundAt(wx + sy * 0.12, wz + cy * 0.12, this.pos.y), gB = this.groundAt(wx - sy * 0.12, wz - cy * 0.12, this.pos.y);
      const slopePitch = Math.atan2(gF - gB, 0.24);
      feetT.push({ f, phase, pos: new THREE.Vector3(wx, gy + m.legLen.ankle + lift * mb, wz), pitch: pitch * mb + slopePitch, ground: gy });
      // footstep event at heel strike
      if (moving && sp > 0.8 && f.prevPhase > 0.9 && phase < 0.1) this.onFootstep?.(new THREE.Vector3(wx, gy, wz), sp);
      f.prevPhase = phase;
    }

    // pelvis
    const bob = mb * (0.015 + 0.03 * run) * (0.5 - 0.5 * Math.cos(g2 * 2));
    const groundRef = Number.isFinite(minGround) ? Math.min(minGround, this.pos.y + 0.05) : this.pos.y;
    let hipsY = groundRef - this.pos.y + 0.925 - bob - P.crouch * 0.45 - run * 0.03;
    const hips = Bn.hips, spine = Bn.spine, chest = Bn.chest, neck = Bn.neck, head = Bn.head;
    hips.position.set(Math.sin(g2) * 0.022 * mb + Math.sin(this.breath * 0.6) * 0.012 * (1 - mb), hipsY, -P.lean * 0.05);
    const twist = Math.sin(g2) * (0.1 + 0.08 * run) * mb;
    hips.rotation.set(P.lean * 0.35, twist, Math.sin(g2) * 0.035 * mb, 'YXZ');
    spine.rotation.set(P.lean * 0.4 + P.spx + 0.015 * breath, -twist * 0.75 + P.spy * 0.6, -Math.sin(g2) * 0.02 * mb, 'YXZ');
    chest.rotation.set(P.lean * 0.25 + 0.025 * breath, -twist * 0.45 + P.spy * 0.4, 0, 'YXZ');
    // keep the head steady and looking ahead (towards the camera direction when standing still)
    const bodyTwist = twist - twist * 0.75 - twist * 0.45 + P.spy;
    this.lookYaw = damp(this.lookYaw, clamp(this.lookTarget || 0, -0.9, 0.9) * (1 - mb * 0.6), 4, dt);
    neck.rotation.set(-P.lean * 0.4 - P.spx * 0.5, (-bodyTwist + this.lookYaw) * 0.45, 0, 'YXZ');
    head.rotation.set(-P.lean * 0.3 + Math.sin(g2 * 2) * 0.02 * mb, (-bodyTwist + this.lookYaw) * 0.55, 0, 'YXZ');

    // ---------- arms ----------
    const swing = Math.cos(g2) * mb * (0.32 + 0.22 * run);
    const R = { u: Bn.upperR, f: Bn.foreR, h: Bn.handR, c: Bn.clavR }, L = { u: Bn.upperL, f: Bn.foreL, h: Bn.handL, c: Bn.clavL };
    R.u.rotation.set(P.rx - (this.state === 'attack' ? 0 : swing * 0.55), P.ry, 0.1, 'YXZ');
    R.f.rotation.set(P.re - (this.state === 'attack' ? 0 : (0.1 + 0.25 * run) * mb), 0, 0);
    L.u.rotation.set(P.lx + swing * (1 - P.shield) * 0.8, P.ly * (1 - P.shield), P.lz, 'YXZ');
    L.f.rotation.set(P.le - (0.1 + 0.3 * run) * mb * (1 - P.shield), 0, 0);
    R.c.rotation.set(0, 0, -0.03 * breath - (P.rx < -1.6 ? 0.12 : 0));
    L.c.rotation.set(0, 0, 0.03 * breath + P.shield * 0.08);
    R.h.rotation.set(0, 0, 0); L.h.rotation.set(0, 0, 0.1);
    // grips: right hand round the sword, left hand round the shield straps
    for (const [side, k2, curl] of [[-1, 'R', 1.35], [1, 'L', 1.15]]) {
      Bn['fing1' + k2].rotation.set(0, 0, -side * curl);
      Bn['fing2' + k2].rotation.set(0, 0, -side * curl * 0.9);
      Bn['thumb' + k2].rotation.set(0.6, 0, -side * 0.5);
    }
    m.sword.rotation.x = P.sw;
    m.shield.rotation.set(P.shield * Math.PI / 2, (1 - P.shield) * Math.PI / 2, 0);
    m.shield.position.set(0.07 * (1 - P.shield), -0.14 - P.shield * 0.02, 0.02 + P.shield * 0.1);

    // ---------- legs ----------
    const special = ['roll', 'dead', 'rest'].includes(this.state) || !this.onGround;
    m.root.updateMatrixWorld(true);
    if (!special) {
      for (const ft of feetT) {
        const k2 = ft.f.side === 1 ? 'L' : 'R';
        this.solveLeg(Bn['thigh' + k2], Bn['shin' + k2], Bn['foot' + k2], ft.pos, ft.pitch, 0);
        Bn['toe' + k2].rotation.set(ft.phase < 0.5 ? sstep(0.7, 1, ft.phase / 0.5) * 0.5 * mb : 0, 0, 0);
      }
    } else {
      const set = (k2, th, sh, ft) => {
        Bn['thigh' + k2].quaternion.setFromEuler(_eul.set(th, 0, 0, 'XYZ'));
        Bn['shin' + k2].quaternion.setFromEuler(_eul.set(sh, 0, 0, 'XYZ'));
        Bn['foot' + k2].quaternion.setFromEuler(_eul.set(ft, 0, 0, 'XYZ'));
      };
      if (this.state === 'roll') {
        const t = clamp(this.stateT / 0.62, 0, 1);
        const r = easeInOut(clamp(t / 0.85, 0, 1));
        const tuck = Math.sin(Math.min(1, t / 0.85) * Math.PI);
        hips.rotation.x = r * Math.PI * 2;
        hips.position.y = lerp(0.9, 0.48, tuck);
        set('L', -1.8 * tuck, 2.3 * tuck, 0.3 * tuck); set('R', -1.6 * tuck, 2.2 * tuck, 0.3 * tuck);
        spine.rotation.x = 0.6 * tuck; chest.rotation.x = 0.3 * tuck; neck.rotation.x = 0.4 * tuck;
        R.u.rotation.x = -0.8 * tuck + P.rx * (1 - tuck); L.u.rotation.x = -0.9 * tuck - 0.4;
      } else if (this.state === 'dead') {
        const t = clamp(this.stateT / 0.8, 0, 1);
        hips.rotation.x = -easeOut(t) * 1.45;
        hips.position.y = lerp(0.9, 0.22, easeOut(t));
        set('L', -0.3 * t, 0.4 * t, 0.2); set('R', -0.1 * t, 0.2 * t, 0.2);
        L.u.rotation.set(-0.3, 0, 0.6 * t, 'YXZ'); R.u.rotation.set(-0.2, 0, -0.7 * t, 'YXZ');
      } else if (this.state === 'rest') {
        hips.position.y = 0.42; hips.rotation.set(0, 0, 0);
        set('L', -1.5, 1.9, -0.3); set('R', -1.45, 1.85, -0.3);
        spine.rotation.x = 0.28; chest.rotation.x = 0.08 + 0.02 * breath;
        L.u.rotation.set(-0.9, 0.3, 0, 'YXZ'); L.f.rotation.x = -0.9;
        R.u.rotation.set(-0.8, -0.2, 0, 'YXZ'); R.f.rotation.x = -0.9;
        head.rotation.x = 0.15;
      } else {
        // airborne: knees drawn up a little, trailing leg
        const v = clamp(this.vel.y / 6, -1, 1);
        set('L', -0.55 + v * 0.2, 0.9, 0.2); set('R', -0.15, 0.5 - v * 0.2, 0.25);
      }
    }

    // ---------- cloak cloth ----------
    m.root.updateMatrixWorld(true);
    const sp1 = new THREE.Vector3(0, 0.02, 0.02).applyMatrix4(chest.matrixWorld);
    const sp2 = new THREE.Vector3(0, 0.0, 0.0).applyMatrix4(hips.matrixWorld);
    const sp3 = new THREE.Vector3(0, -0.18, 0.0).applyMatrix4(Bn.thighL.matrixWorld);
    const sp4 = new THREE.Vector3(0, -0.18, 0.0).applyMatrix4(Bn.thighR.matrixWorld);
    m.cloak.update(dt, [
      { x: sp1.x, y: sp1.y, z: sp1.z, r: 0.16 }, { x: sp2.x, y: sp2.y, z: sp2.z, r: 0.18 },
      { x: sp3.x, y: sp3.y, z: sp3.z, r: 0.1 }, { x: sp4.x, y: sp4.y, z: sp4.z, r: 0.1 },
    ]);
    if (this.avatar) this.avatar.update();
  }
}
