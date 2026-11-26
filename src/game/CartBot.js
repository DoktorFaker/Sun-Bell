import * as THREE from 'three';
import { probeDown, rayHit } from './physics.js';
import { SpriteBody, loadAtlas } from './sprites.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

// Sprite sheet poses (public/sprites/rustcart.png)
const F = {
  idle: 0, drive: 1, point: 2, laser: 3, wave: 4, worried: 5, cheer: 6, charge: 7,
  idle2: 8, grab: 9, holdBox: 10, alarm: 11, glitch: 12, tipping: 13, broken: 14, smirk: 15,
};
export const loadCartBotAtlas = () => loadAtlas('rustcart');

/**
 * Rustcart: a scavenger automaton that went rogue when the Bell fell silent.
 * Billboard sprite enemy with three telegraphed attacks:
 *   ram (alarm → charge), laser mark (point → beam on a ground circle), crate toss (hold → throw).
 */
export class CartBot {
  constructor(home, scene) {
    this.kind = 'cartbot';
    this.scene = scene;
    this.home = home.clone();
    this.pos = home.clone();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.maxHP = 12; this.hp = 12;
    this.radius = 0.75;
    this.state = 'idle'; this.stateT = Math.random();
    this.cooldown = 1.5;
    this.frame = -1;
    this.flip = 1;
    this.bob = 0;
    this.enraged = false;
    this.lastAttack = '';

    // sprite
    this.body = new SpriteBody('rustcart', { ppm: 235, glowCyan: 5, glowHot: 3 });
    this.object = this.body.object;
    scene.add(this.object);

    // telegraph ring for the laser
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 1.6, 40, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.3, 0.15), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.ring.visible = false;
    scene.add(this.ring);
    // laser beam
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.07, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(12, 1.2, 0.5), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.beam.visible = false;
    scene.add(this.beam);
    // thrown crate
    this.crate = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.38, 0.45), new THREE.MeshStandardMaterial({
      color: 0xc89a5a, roughness: 0.6, emissive: new THREE.Color(0.4, 0.8, 1.6), emissiveIntensity: 1.5,
    }));
    this.crate.castShadow = true;
    this.crate.visible = false;
    scene.add(this.crate);
    this.crateFlight = null;
    this.target = new THREE.Vector3();
  }

  get alive() { return this.state !== 'dead'; }
  get lockPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.15, this.pos.z); }

  setFrame(i) { this.body.setFrame(i); }

  reset() {
    this.pos.copy(this.home); this.hp = this.maxHP; this.state = 'idle'; this.stateT = 0;
    this.vel.set(0, 0, 0); this.object.visible = true; this.enraged = false; this.cooldown = 1.5;
    this.ring.visible = this.beam.visible = this.crate.visible = false; this.crateFlight = null;
    this.body.glow = 1;
  }

  go(state) { this.state = state; this.stateT = 0; }

  takeHit(dmg, fromPos, events) {
    if (!this.alive) return false;
    this.hp -= dmg;
    this.body.flash = 1;
    const away = new THREE.Vector3(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z).normalize();
    this.vel.addScaledVector(away, 1.5 + dmg);
    events.push({ type: 'robot-hit', enemy: this });
    if (this.hp <= 0) {
      this.go('dead');
      this.ring.visible = this.beam.visible = false;
      events.push({ type: 'kill', enemy: this, robot: true });
      return true;
    }
    if (!this.enraged && this.hp < this.maxHP * 0.4) {
      this.enraged = true; this.go('enrage'); events.push({ type: 'robot-alarm', enemy: this });
      return true;
    }
    // poise: stunned and windup states flinch, charges and lasers do not
    if (this.state === 'stunned') this.stateT = Math.min(this.stateT, 0.3);
    else if (['idle', 'chase', 'strafe', 'taunt', 'recover'].includes(this.state)) this.go('flinch');
    return true;
  }

  update(dt, hero, others, collider, events) {
    this.stateT += dt;
    this.cooldown -= dt;
    this.body.flash = Math.max(0, this.body.flash - dt * 6);
    const toHero = new THREE.Vector3(hero.pos.x - this.pos.x, 0, hero.pos.z - this.pos.z);
    const dist = toHero.length();
    const heroYaw = Math.atan2(toHero.x, toHero.z);
    const speedMul = this.enraged ? 1.3 : 1;
    let speed = 0, dir = null, face = null, frame = F.idle;
    const t = this.stateT;

    switch (this.state) {
      case 'idle':
        frame = Math.floor(t / 1.4) % 3 === 2 ? F.idle2 : F.idle;
        if (hero.targetable && dist < 18) { this.go('taunt'); events.push({ type: 'robot-beep', enemy: this }); }
        break;
      case 'taunt':
        frame = t < 0.9 ? F.wave : F.smirk; face = heroYaw;
        if (t > 1.5) this.go('chase');
        break;
      case 'chase': {
        if (!hero.targetable) { this.go(hero.state === 'dead' ? 'gloat' : 'return'); break; }
        if (dist > 34 || this.pos.distanceTo(this.home) > 50) { this.go('return'); break; }
        face = heroYaw; frame = F.drive;
        if (dist > 4) { dir = toHero.clone().normalize(); speed = 3.6 * speedMul; }
        else { dir = new THREE.Vector3(toHero.z, 0, -toHero.x).normalize(); speed = 1.6; }
        if (this.cooldown <= 0) this.pickAttack(dist, events);
        break;
      }
      case 'return': {
        const w = new THREE.Vector3(this.home.x - this.pos.x, 0, this.home.z - this.pos.z);
        frame = F.worried;
        if (w.length() < 1) { this.hp = this.maxHP; this.enraged = false; this.go('idle'); break; }
        dir = w.normalize(); speed = 3; face = Math.atan2(dir.x, dir.z);
        if (hero.targetable && dist < 12) this.go('chase');
        break;
      }
      case 'gloat':
        frame = F.cheer;
        if (t > 3) this.go('return');
        break;

      // --- Ram: alarm lights, then a straight charge. Crashes into walls and is left stunned.
      case 'ramWind':
        frame = F.alarm; face = heroYaw;
        this.bob = Math.sin(t * 40) * 0.03;
        if (t > (this.enraged ? 0.55 : 0.8)) {
          this.go('ram');
          this.chargeDir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
          this.rammed = false;
          events.push({ type: 'robot-charge', enemy: this });
        }
        break;
      case 'ram': {
        frame = F.charge;
        dir = this.chargeDir; speed = 11.5 * speedMul;
        if (Math.random() < dt * 30) events.push({ type: 'sparks', pos: this.pos.clone().add(new THREE.Vector3(0, 0.15, 0)), n: 3, color: [5, 3.5, 1], speed: 3 });
        if (!this.rammed && dist < 1.5 && Math.abs(hero.pos.y - this.pos.y) < 1.6) {
          this.rammed = true;
          const r = hero.takeHit(this.enraged ? 32 : 26, this.pos, events, { knock: 9, staminaMul: 1.6 });
          if (r === 'blocked') { this.go('stunned'); events.push({ type: 'robot-crash', enemy: this }); break; }
        }
        const wall = rayHit(collider, new THREE.Vector3(this.pos.x, this.pos.y + 0.7, this.pos.z), this.chargeDir, 1.1);
        if (wall && wall.face && Math.abs(wall.face.normal.y) < 0.6) { this.go('stunned'); this.vel.set(0, 0, 0); events.push({ type: 'robot-crash', enemy: this }); break; }
        if (t > 0.85) this.go(this.rammed ? 'smug' : 'recover');
        break;
      }
      case 'stunned':
        frame = t < 0.35 ? F.glitch : F.tipping;
        if (t > 1.8) this.go('recover');
        break;

      // --- Laser mark: points, then burns a circle on the ground where the warden stood.
      case 'laserWind':
        frame = F.point; face = heroYaw;
        if (t < 0.05) this.target.copy(hero.pos);
        this.target.lerp(hero.pos, 1 - Math.exp(-3.5 * dt)); // tracks, then commits
        this.showRing(t / 0.9, false);
        if (t > (this.enraged ? 0.7 : 0.9)) { this.go('laser'); events.push({ type: 'robot-laser', enemy: this }); }
        break;
      case 'laser': {
        frame = F.laser; face = heroYaw;
        this.showRing(1, true);
        this.showBeam(true);
        if (!this.burned && t > 0.12) {
          this.burned = true;
          const d = Math.hypot(hero.pos.x - this.target.x, hero.pos.z - this.target.z);
          if (d < 1.6 && Math.abs(hero.pos.y - this.target.y) < 1.5) hero.takeHit(20, this.target, events, { unblockable: true });
          events.push({ type: 'sparks', pos: this.target.clone().add(new THREE.Vector3(0, 0.2, 0)), n: 40, color: [8, 1.2, 0.4], speed: 5 });
        }
        if (t > 0.45) { this.ring.visible = false; this.beam.visible = false; this.go('recover'); }
        break;
      }

      // --- Crate toss: holds a glowing crate, lobs it at the warden, it bursts on landing.
      case 'tossWind':
        frame = F.holdBox; face = heroYaw;
        if (t > 0.75) {
          const lead = hero.vel.clone().setY(0).multiplyScalar(0.5);
          const to = hero.pos.clone().add(lead);
          const from = this.pos.clone().add(new THREE.Vector3(0, 1.1, 0));
          this.crateFlight = { from, to, t: 0, dur: clamp(dist / 11, 0.6, 1.2) };
          this.crate.visible = true;
          this.go('toss');
          events.push({ type: 'robot-toss', enemy: this });
        }
        break;
      case 'toss':
        frame = F.grab; face = heroYaw;
        if (t > 0.5) this.go('recover');
        break;

      case 'smug':
        frame = F.smirk;
        if (t > 0.9) this.go('chase');
        break;
      case 'recover':
        frame = F.worried;
        if (t > (this.enraged ? 0.45 : 0.75)) { this.go('chase'); this.cooldown = (this.enraged ? 0.8 : 1.4) + Math.random() * 0.8; }
        break;
      case 'flinch':
        frame = F.glitch;
        if (t > 0.3) this.go('chase');
        break;
      case 'enrage':
        frame = F.alarm;
        this.bob = Math.sin(t * 50) * 0.04;
        if (t > 1.1) { this.go('chase'); this.cooldown = 0.3; }
        break;
      case 'dead':
        frame = t < 0.5 ? F.tipping : F.broken;
        if (t > 0.5 && Math.random() < dt * 4 && t < 6) events.push({ type: 'sparks', pos: this.pos.clone().add(new THREE.Vector3((Math.random() - 0.5), 0.4, (Math.random() - 0.5))), n: 6, color: [2, 4, 8], speed: 2.5 });
        this.body.glow = Math.max(0.15, 1 - t * 0.3);
        if (t > 9) this.object.visible = false;
        break;
    }
    this.setFrame(frame);

    // crate flight
    if (this.crateFlight) {
      const c = this.crateFlight;
      c.t += dt;
      const k = Math.min(1, c.t / c.dur);
      this.crate.position.lerpVectors(c.from, c.to, k);
      this.crate.position.y += Math.sin(k * Math.PI) * (2 + c.dur * 2) - k * 0.2;
      this.crate.rotation.set(k * 7, k * 5, 0);
      if (k >= 1) {
        this.crate.visible = false;
        this.crateFlight = null;
        events.push({ type: 'sparks', pos: c.to.clone().add(new THREE.Vector3(0, 0.3, 0)), n: 50, color: [2.5, 5, 9], speed: 6 });
        events.push({ type: 'robot-boom', enemy: this });
        const d = Math.hypot(hero.pos.x - c.to.x, hero.pos.z - c.to.z);
        if (d < 1.9 && Math.abs(hero.pos.y - c.to.y) < 2) hero.takeHit(20, c.to, events, {});
      }
    }

    if (face !== null) this.yaw += angDiff(this.yaw, face) * (1 - Math.exp(-(this.state === 'ram' ? 0 : 7) * dt));
    if (this.state !== 'dead') {
      const tx = dir ? dir.x * speed : 0, tz = dir ? dir.z * speed : 0;
      const k = this.state === 'ram' ? 20 : 6;
      this.vel.x = damp(this.vel.x, tx, k, dt);
      this.vel.z = damp(this.vel.z, tz, k, dt);
      for (const o of others) {
        if (o === this || !o.alive) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        const d = Math.hypot(dx, dz), min = this.radius + (o.radius || 0.45);
        if (d < min && d > 1e-4) { this.pos.x += dx / d * (min - d) * 0.5; this.pos.z += dz / d * (min - d) * 0.5; }
      }
      if (hero.targetable && this.state !== 'ram') {
        const min = this.radius + 0.4;
        if (dist < min && dist > 1e-4) { this.pos.x -= toHero.x / dist * (min - dist); this.pos.z -= toHero.z / dist * (min - dist); }
      }
    } else {
      this.vel.multiplyScalar(Math.exp(-4 * dt));
    }
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const hit = probeDown(collider, new THREE.Vector3(this.pos.x, this.pos.y + 1.6, this.pos.z), 4);
    if (hit) this.pos.y = damp(this.pos.y, hit.point.y, 20, dt);
    this.animate(dt);
  }

  pickAttack(dist, events) {
    const options = [];
    if (dist < 9) options.push('ram');
    if (dist < 14) options.push('laser');
    if (dist > 5 && dist < 16) options.push('toss');
    if (!options.length) return;
    let pick = options[Math.floor(Math.random() * options.length)];
    if (pick === this.lastAttack && options.length > 1) pick = options.find((o) => o !== pick);
    this.lastAttack = pick;
    if (pick === 'ram') { this.go('ramWind'); events.push({ type: 'robot-alarm', enemy: this }); }
    if (pick === 'laser') { this.go('laserWind'); this.burned = false; events.push({ type: 'robot-laser-charge', enemy: this }); }
    if (pick === 'toss') this.go('tossWind');
  }

  showRing(k, fire) {
    this.ring.visible = true;
    this.ring.position.set(this.target.x, this.target.y + 0.06, this.target.z);
    const s = fire ? 1 : 0.5 + 0.5 * clamp(k, 0, 1);
    this.ring.scale.setScalar(s);
    this.ring.material.opacity = fire ? 1 : 0.25 + 0.5 * clamp(k, 0, 1) * (0.6 + 0.4 * Math.sin(k * 40));
    this.ring.material.color.setRGB(fire ? 14 : 4, fire ? 2 : 0.3, fire ? 0.8 : 0.15);
  }

  showBeam(on) {
    this.beam.visible = on;
    if (!on) return;
    const eye = new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z);
    const to = this.target.clone().add(new THREE.Vector3(0, 0.05, 0));
    this.beam.position.copy(eye);
    this.beam.lookAt(to);
    this.beam.scale.set(1, 1, eye.distanceTo(to));
  }

  animate(dt) {
    this.body.update(dt, this.pos, this.yaw, { lift: this.state === 'dead' ? 0 : this.bob, speed: Math.hypot(this.vel.x, this.vel.z) });
    this.bob = damp(this.bob, 0, 10, dt);
  }
}
