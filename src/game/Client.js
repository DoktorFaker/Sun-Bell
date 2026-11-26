import * as THREE from 'three';
import { probeDown } from './physics.js';
import { SpriteBody, loadAtlas } from './sprites.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export const loadClientAtlas = () => loadAtlas('client');

// Sprite sheet poses (public/sprites/client.png)
const F = {
  walk: 0, run: 1, point: 2, watch: 3, wave: 4, shrug: 5, cheer: 6, sprint: 7,
  idle: 8, grab: 9, papers: 10, yell: 11, scared: 12, fall: 13, out: 14, throw: 15,
};

const LINES = {
  aggro: ['Hi! Quick question!', 'Warden! Just the person I need!', 'You there! Got a minute? Ten, tops!'],
  pitch: ['Ten euros. Massive visibility. Final offer!', 'I want the WHOLE valley to see my brand!', 'Ten euros — VAT included, obviously.'],
  nag: [
    'Why is this taking so long?!', 'I need results by yesterday!', 'My nephew could do this for free!',
    'Make it pop! Make it viral!', 'Is the Sun Bell available for sponsorship?', 'Can the sun be in my logo colours?',
    'Everything. I want everything. Ten euros.', 'Is there a discount for exposure?', 'Just one more tiny revision!',
  ],
  throw: ['Here\'s the brief!', 'Read my feedback!', 'Revision forty-two!', 'Invoice? THIS is my invoice!'],
  grab: ['YOU work for ME!', 'Come here, partner!', 'Let\'s circle back — on YOU!'],
  charge: ['THAT\'S IT!', 'I\'M CALLING YOUR MANAGER!', 'NOBODY SAYS NO TO ME!'],
  drink: ['Just something for the nerves…', '*glug* …okay. Okay!', 'Liquid lunch. Very productive.'],
  tipsy: ['*hic* …where was I. Visibility!', 'Ten *hic* euros!', 'You\'re my best agency, you know that?'],
  hurt: ['My lawyer will hear about this!', 'That\'s not in the brief!', 'Refund!', 'Ow! Unprofessional!'],
  win: ['Ha! Deal closed!', 'Invoice paid. By you.'],
  dead: ['Fine… I\'ll find someone cheaper…', 'I\'ll leave… a one-star review…'],
};

/**
 * The Client: a nervous, greedy businessman who wants massive visibility for a ten-euro budget.
 * Attacks: invoice toss (ranged), grab (lunge), tantrum charge (enraged). Sips from a hip flask
 * between attacks: heals a little and gets tipsy (wobbly, sloppier but more frantic throws).
 */
export class Client {
  constructor(home, scene) {
    this.kind = 'client';
    this.scene = scene;
    this.home = home.clone();
    this.pos = home.clone();
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * 6.28;
    this.maxHP = 7; this.hp = 7;
    this.radius = 0.45;
    this.state = 'idle'; this.stateT = Math.random() * 2;
    this.cooldown = 1.2;
    this.sips = 3;
    this.tipsy = 0;
    this.enraged = false;
    this.nagT = 3 + Math.random() * 3;
    this.lastAttack = '';

    this.body = new SpriteBody('client', { ppm: 255, glowCyan: 0, glowHot: 0 });
    this.object = this.body.object;
    scene.add(this.object);

    // hip flask, held at the raised wrist in the watch pose
    const flask = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 1, roughness: 0.25 });
    flask.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.04), metal));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.04, 8), metal);
    cap.position.y = 0.09; flask.add(cap);
    flask.position.copy(this.body.local(F.watch, 175, 140));
    flask.rotation.z = 2.3;
    flask.visible = false;
    this.flask = flask;
    this.body.mesh.add(flask);

    // crumpled invoices (pooled)
    this.papers = [];
    const paperGeo = new THREE.IcosahedronGeometry(0.13, 0);
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(paperGeo, paperMat);
      m.castShadow = true; m.visible = false;
      scene.add(m);
      this.papers.push({ mesh: m, flight: null });
    }
  }

  get alive() { return this.state !== 'dead'; }
  get lockPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.25, this.pos.z); }

  go(s) { this.state = s; this.stateT = 0; }
  say(events, list, prob = 1) { if (Math.random() < prob) events.push({ type: 'say', enemy: this, text: pick(LINES[list]) }); }

  reset() {
    this.pos.copy(this.home); this.hp = this.maxHP; this.vel.set(0, 0, 0);
    this.go('idle'); this.sips = 3; this.tipsy = 0; this.enraged = false; this.cooldown = 1.2;
    this.object.visible = true; this.flask.visible = false;
    for (const p of this.papers) { p.mesh.visible = false; p.flight = null; }
  }

  takeHit(dmg, fromPos, events) {
    if (!this.alive) return false;
    this.hp -= dmg;
    this.body.flash = 1;
    this.flask.visible = false;
    const away = new THREE.Vector3(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z).normalize();
    this.vel.addScaledVector(away, 3 + dmg * 2);
    if (this.hp <= 0) {
      this.go('dead');
      this.say(events, 'dead');
      events.push({ type: 'kill', enemy: this, client: true });
      return true;
    }
    this.say(events, 'hurt', 0.6);
    if (!this.enraged && this.hp <= this.maxHP * 0.5) { this.enraged = true; this.go('tantrumWind'); this.say(events, 'charge'); return true; }
    if (this.state !== 'tantrum') this.go(dmg > 1.5 ? 'fall' : 'flinch');
    return true;
  }

  update(dt, hero, others, collider, events) {
    this.stateT += dt;
    this.cooldown -= dt;
    this.tipsy = Math.max(0, this.tipsy - dt);
    this.body.flash = Math.max(0, this.body.flash - dt * 6);
    const toHero = new THREE.Vector3(hero.pos.x - this.pos.x, 0, hero.pos.z - this.pos.z);
    const dist = toHero.length();
    const heroYaw = Math.atan2(toHero.x, toHero.z);
    const t = this.stateT;
    let speed = 0, dir = null, face = null, frame = F.idle;
    const nervous = this.enraged ? 1.25 : 1;

    switch (this.state) {
      case 'idle':
        frame = (t % 5) > 3.6 ? F.watch : F.idle;
        if (hero.targetable && dist < 16) { this.go('hail'); this.say(events, 'aggro'); events.push({ type: 'client-aggro', enemy: this }); }
        break;
      case 'hail':
        frame = t < 1.0 ? F.wave : F.shrug; face = heroYaw;
        if (t > 1.0 && !this.pitched) { this.pitched = true; this.say(events, 'pitch'); }
        if (t > 2.2) this.go('chase');
        break;
      case 'chase': {
        if (!hero.targetable) { if (hero.state === 'dead') { this.go('gloat'); this.say(events, 'win'); } else this.go('return'); break; }
        if (dist > 32 || this.pos.distanceTo(this.home) > 45) { this.go('return'); break; }
        face = heroYaw;
        frame = dist > 7 ? F.run : F.walk;
        if (dist > 3.5) { dir = toHero.clone().normalize(); speed = (dist > 7 ? 4.2 : 2.6) * nervous; }
        else { dir = new THREE.Vector3(toHero.z, 0, -toHero.x).normalize(); speed = 1.5; }
        this.nagT -= dt;
        if (this.nagT <= 0) { this.nagT = 4 + Math.random() * 4; this.say(events, this.tipsy > 0 ? 'tipsy' : 'nag'); }
        if (this.cooldown <= 0) this.chooseAction(dist, events);
        break;
      }
      case 'return': {
        const w = new THREE.Vector3(this.home.x - this.pos.x, 0, this.home.z - this.pos.z);
        frame = F.walk;
        if (w.length() < 1) { this.hp = this.maxHP; this.enraged = false; this.go('idle'); break; }
        dir = w.normalize(); speed = 2.4; face = Math.atan2(dir.x, dir.z);
        if (hero.targetable && dist < 12) this.go('chase');
        break;
      }
      case 'gloat':
        frame = F.cheer;
        if (t > 3) this.go('return');
        break;

      // --- invoice toss
      case 'throwWind':
        frame = F.papers; face = heroYaw;
        if (t > (this.tipsy > 0 ? 0.35 : 0.55)) {
          const n = this.tipsy > 0 || this.enraged ? 3 : 1;
          for (let i = 0; i < n; i++) this.launchPaper(hero, i, n);
          this.go('throw');
          events.push({ type: 'client-throw', enemy: this });
        }
        break;
      case 'throw':
        frame = F.throw; face = heroYaw;
        if (t > 0.5) this.endAction();
        break;

      // --- grab lunge
      case 'grabWind':
        frame = F.point; face = heroYaw;
        if (t > 0.45) { this.go('grab'); this.grabbed = false; }
        break;
      case 'grab':
        frame = F.grab;
        dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); speed = t < 0.25 ? 7.5 : 0;
        if (!this.grabbed && t > 0.08 && t < 0.3 && dist < 1.7 && Math.abs(angDiff(this.yaw, heroYaw)) < 1.1 && Math.abs(hero.pos.y - this.pos.y) < 1.5) {
          this.grabbed = true;
          hero.takeHit(14, this.pos, events, { knock: 3 });
        }
        if (t > 0.6) this.endAction();
        break;

      // --- tantrum charge (enraged)
      case 'tantrumWind':
        frame = F.yell; face = heroYaw;
        if (t > 0.75) { this.go('tantrum'); this.chargeDir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.hitHero = false; }
        break;
      case 'tantrum':
        frame = F.sprint; dir = this.chargeDir; speed = 9;
        if (!this.hitHero && dist < 1.3 && Math.abs(hero.pos.y - this.pos.y) < 1.5) {
          this.hitHero = true;
          hero.takeHit(20, this.pos, events, { knock: 6 });
        }
        if (t > 0.8) { this.go('fall'); }
        break;

      // --- a sip from the flask
      case 'drink':
        frame = F.watch; face = heroYaw;
        this.flask.visible = true;
        this.flask.rotation.z = 2.3 + Math.sin(t * 6) * 0.15;
        if (t > 1.4) {
          this.flask.visible = false;
          this.hp = Math.min(this.maxHP, this.hp + 1.5);
          this.tipsy = 12;
          this.sips--;
          events.push({ type: 'client-drink', enemy: this });
          this.endAction();
        }
        break;

      case 'flinch':
        frame = F.scared;
        if (t > 0.35) this.go('chase');
        break;
      case 'fall':
        frame = F.fall;
        if (t > 1.2) { this.go('chase'); this.cooldown = 0.8; }
        break;
      case 'dead':
        frame = t < 0.45 ? F.fall : F.out;
        this.flask.visible = false;
        if (t > 9) this.object.visible = false;
        break;
    }
    this.body.setFrame(frame);
    this.updatePapers(dt, hero, events);

    if (face !== null) this.yaw += angDiff(this.yaw, face) * (1 - Math.exp(-((this.state === 'tantrum' || this.state === 'grab') ? 0 : 8) * dt));
    if (this.state !== 'dead') {
      const k = this.state === 'grab' || this.state === 'tantrum' ? 18 : 7;
      this.vel.x = damp(this.vel.x, dir ? dir.x * speed : 0, k, dt);
      this.vel.z = damp(this.vel.z, dir ? dir.z * speed : 0, k, dt);
      // stagger a little when tipsy
      if (this.tipsy > 0 && dir) { this.vel.x += Math.sin(this.stateT * 3.1) * 0.8 * dt * 10; this.vel.z += Math.cos(this.stateT * 2.3) * 0.8 * dt * 10; }
      for (const o of others) {
        if (o === this || !o.alive) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        const d = Math.hypot(dx, dz), min = this.radius + (o.radius || 0.45);
        if (d < min && d > 1e-4) { this.pos.x += dx / d * (min - d) * 0.5; this.pos.z += dz / d * (min - d) * 0.5; }
      }
      if (hero.targetable && dist < 0.85 && dist > 1e-4) { this.pos.x -= toHero.x / dist * (0.85 - dist); this.pos.z -= toHero.z / dist * (0.85 - dist); }
    } else this.vel.multiplyScalar(Math.exp(-5 * dt));
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const hit = probeDown(collider, new THREE.Vector3(this.pos.x, this.pos.y + 1.6, this.pos.z), 4);
    if (hit) this.pos.y = damp(this.pos.y, hit.point.y, 20, dt);
    this.body.update(dt, this.pos, this.yaw, { speed: Math.hypot(this.vel.x, this.vel.z), wobble: this.tipsy > 0 ? 0.06 : 0 });
  }

  chooseAction(dist, events) {
    const opts = [];
    if (this.sips > 0 && (this.hp < this.maxHP * 0.7 || Math.random() < 0.25)) opts.push('drink');
    if (dist < 3.6) opts.push('grab', 'grab');
    if (dist > 4 && dist < 15) opts.push('throw', 'throw');
    if (this.enraged && dist < 10) opts.push('tantrum');
    if (!opts.length) return;
    let a = pick(opts);
    if (a === this.lastAttack && opts.length > 1) a = opts.find((o) => o !== a);
    this.lastAttack = a;
    if (a === 'drink') { this.go('drink'); this.say(events, 'drink'); }
    if (a === 'grab') { this.go('grabWind'); this.say(events, 'grab', 0.7); }
    if (a === 'throw') { this.go('throwWind'); this.say(events, 'throw', 0.5); }
    if (a === 'tantrum') { this.go('tantrumWind'); this.say(events, 'charge'); }
  }

  endAction() {
    this.go('chase');
    this.cooldown = (this.enraged ? 0.9 : 1.6) * (this.tipsy > 0 ? 0.7 : 1) + Math.random() * 0.9;
  }

  launchPaper(hero, i, n) {
    const p = this.papers.find((q) => !q.flight);
    if (!p) return;
    const spread = (i - (n - 1) / 2) * 1.6 + (this.tipsy > 0 ? (Math.random() - 0.5) * 2.5 : 0);
    const to = hero.pos.clone().addScaledVector(hero.vel.clone().setY(0), 0.45);
    const side = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    to.addScaledVector(side, spread);
    const from = this.pos.clone().add(new THREE.Vector3(0, 1.5, 0));
    const d = from.distanceTo(to);
    p.flight = { from, to, t: -i * 0.12, dur: clamp(d / 13, 0.45, 1.1) };
  }

  updatePapers(dt, hero, events) {
    for (const p of this.papers) {
      const f = p.flight;
      if (!f) continue;
      f.t += dt;
      if (f.t < 0) continue;
      const k = Math.min(1, f.t / f.dur);
      p.mesh.visible = true;
      p.mesh.position.lerpVectors(f.from, f.to, k);
      p.mesh.position.y += Math.sin(k * Math.PI) * 1.6;
      p.mesh.rotation.set(k * 9, k * 6, 0);
      // hits the warden in flight or on landing
      const hp = hero.centre;
      if (hero.targetable && p.mesh.position.distanceTo(hp) < 0.8) {
        hero.takeHit(12, f.from, events, {});
        events.push({ type: 'sparks', pos: p.mesh.position.clone(), n: 14, color: [3, 3, 2.6], speed: 3 });
        p.flight = null; p.mesh.visible = false; continue;
      }
      if (k >= 1) { p.flight = null; p.mesh.visible = false; events.push({ type: 'sparks', pos: f.to.clone().add(new THREE.Vector3(0, 0.2, 0)), n: 8, color: [2.5, 2.5, 2.2], speed: 2 }); }
    }
  }
}
