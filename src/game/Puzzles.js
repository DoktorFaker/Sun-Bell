import * as THREE from 'three';
import { M } from '../world/materials.js';
import { Fire } from '../world/fx.js';
import { TEMPLE } from '../world/terrain.js';

const PH = 3; // temple platform height
const W = (x, y, z) => new THREE.Vector3(TEMPLE.x + x, TEMPLE.y + y, TEMPLE.z + z);
const glowMat = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
const BEAM_Y = PH + 1.25;

/**
 * The three trials of the temple. Each one rekindles a sun-mark on the sealed doors.
 *  1. Mirrors — guide the sun crystal's beam to the pedestal by turning bronze mirrors.
 *  2. Bells   — listen to the hymn, then strike the four bells in the same order.
 *  3. Embers  — light all three ember bowls before the first one burns out.
 */
export class TemplePuzzles {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.temple = game.world.temple;
    this.solved = [false, false, false];
    this.hinted = [false, false, false];
    const bronze = M.bronzeDull, stone = M.stone;
    const mk = (geo, mat, pos, parent = this.scene) => { const m = new THREE.Mesh(geo, mat); m.position.copy(pos); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
    // each pedestal top gets its own material so it can light up
    this.pedTops = this.temple.pedestals.map((p) => { p.material = p.material.clone(); return p; });
    this.temple.sockets.forEach((s) => { s.material = s.material.clone(); });

    // ---------- 1. mirrors ----------
    this.emitter = { pos: W(-21.5, BEAM_Y, 11), dir: new THREE.Vector2(1, 0) };
    mk(new THREE.CylinderGeometry(0.35, 0.45, 1.0, 8), stone, W(-21.5, PH + 0.5, 11));
    mk(new THREE.OctahedronGeometry(0.28, 0), glowMat(9, 6, 2.5), W(-21.5, BEAM_Y, 11));
    this.mirrors = [
      { x: -18, z: 11, k: 3 }, { x: -18, z: 17, k: 1 }, { x: -14, z: 17, k: 0 },
    ];
    for (const m of this.mirrors) {
      mk(new THREE.CylinderGeometry(0.3, 0.38, 0.9, 8), stone, W(m.x, PH + 0.45, m.z));
      const g = new THREE.Group(); g.position.copy(W(m.x, BEAM_Y, m.z)); this.scene.add(g);
      const face = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 24), new THREE.MeshStandardMaterial({ color: 0xe8d8b0, metalness: 1, roughness: 0.12 }));
      face.rotation.x = Math.PI / 2; face.castShadow = true; g.add(face);
      const back = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.05, 24), bronze);
      back.rotation.x = Math.PI / 2; back.position.z = -0.05; g.add(back);
      m.group = g; m.angle = this.mirrorAngle(m.k);
      g.rotation.y = Math.PI / 2 - m.angle;
      game.world.interactables.push({ type: 'puzzle', position: W(m.x, PH, m.z), radius: 1.6, prompt: 'Turn the mirror', onUse: () => this.turnMirror(m) });
    }
    this.beams = [];
    const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(10, 6.5, 2.4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 8; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), beamMat);
      b.visible = false; b.frustumCulled = false; this.scene.add(b); this.beams.push(b);
    }
    this.beamHit = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), glowMat(12, 8, 3));
    this.scene.add(this.beamHit);

    // ---------- 2. bells ----------
    this.bells = [[9.5, 9.6], [12.2, 8.6], [15.8, 8.6], [18.5, 9.6]].map(([x, z], i) => {
      mk(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 6), M.wood, W(x - 0.6, PH + 1.3, z));
      mk(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 6), M.wood, W(x + 0.6, PH + 1.3, z));
      mk(new THREE.BoxGeometry(1.5, 0.12, 0.12), M.wood, W(x, PH + 2.55, z));
      const pivot = new THREE.Group(); pivot.position.copy(W(x, PH + 2.5, z)); this.scene.add(pivot);
      const prof = []; for (let k = 0; k <= 10; k++) { const t = k / 10; prof.push(new THREE.Vector2(0.06 + Math.pow(t, 1.7) * (0.3 - i * 0.03) + (t > 0.9 ? (t - 0.9) * 0.4 : 0), -t * (0.62 - i * 0.05))); }
      const mat = new THREE.MeshStandardMaterial({ color: 0xa07a3a, metalness: 1, roughness: 0.4, side: THREE.DoubleSide, emissive: new THREE.Color(1, 0.6, 0.2), emissiveIntensity: 0 });
      const bell = new THREE.Mesh(new THREE.LatheGeometry(prof, 20), mat); bell.castShadow = true; pivot.add(bell);
      return { x, z, pivot, mat, freq: [392, 494, 587, 784][i], glow: 0, swing: 0 };
    });
    this.song = []; this.songPos = 0; this.playing = null;
    game.world.interactables.push({ type: 'puzzle', position: W(14, PH, 14), radius: 2.2, prompt: 'Listen to the hymn', onUse: () => this.playSong() });

    // ---------- 3. ember bowls ----------
    this.bowls = [[-20.5, -16], [20.5, -16], [21, 17.5]].map(([x, z]) => {
      mk(new THREE.CylinderGeometry(0.4, 0.5, 1.1, 8), stone, W(x, PH + 0.55, z));
      mk(new THREE.CylinderGeometry(0.6, 0.35, 0.4, 14, 1, true), bronze, W(x, PH + 1.3, z)).material.side = THREE.DoubleSide;
      const coal = mk(new THREE.CircleGeometry(0.5, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1a1410, emissive: new THREE.Color(1, 0.3, 0.05), emissiveIntensity: 0 }), W(x, PH + 1.32, z));
      const fire = new Fire(0.75, 12, 16);
      fire.group.position.copy(W(x, PH + 1.3, z)); fire.group.visible = false; this.scene.add(fire.group);
      return { x, z, fire, coal, t: 0 };
    });
    this.burn = 16;

    this.hintSpots = [W(-17, PH, 14), W(14, PH, 12), W(20.5, PH, -10)];
    this.traceBeam();
  }

  mirrorAngle(k) { return Math.PI / 4 + k * Math.PI / 2; }

  turnMirror(m) {
    if (this.solved[0]) return;
    m.k = (m.k + 1) % 4;
    m.target = this.mirrorAngle(m.k);
    this.game.sfx.clank();
  }

  /** Follow the beam from the crystal across the mirrors. */
  traceBeam() {
    let p = new THREE.Vector2(-21.5, 11), d = this.emitter.dir.clone();
    const pts = [p.clone()];
    let hitTarget = false;
    for (let seg = 0; seg < 7; seg++) {
      let best = null, bestT = 1e9;
      for (const m of this.mirrors) {
        const v = new THREE.Vector2(m.x - p.x, m.z - p.y);
        const t = v.dot(d);
        if (t < 0.3) continue;
        const perp = Math.abs(v.x * d.y - v.y * d.x);
        if (perp < 0.45 && t < bestT) { bestT = t; best = m; }
      }
      // target pedestal
      const tv = new THREE.Vector2(-14 - p.x, 14 - p.y), tt = tv.dot(d);
      if (tt > 0.3 && Math.abs(tv.x * d.y - tv.y * d.x) < 0.6 && tt < bestT) { pts.push(p.clone().addScaledVector(d, tt)); hitTarget = true; break; }
      // walls: platform edge and the hall
      let wallT = 1e9;
      const edge = (lo, hi, o, dd) => (dd > 0 ? (hi - o) / dd : dd < 0 ? (lo - o) / dd : 1e9);
      wallT = Math.min(edge(-23, 23, p.x, d.x), edge(-19, 19, p.y, d.y));
      if (p.x < -13.6 && d.x > 0 && p.y > -14.6 && p.y < 6.6) wallT = Math.min(wallT, (-13.6 - p.x) / d.x);
      if (!best || bestT > wallT) { pts.push(p.clone().addScaledVector(d, wallT)); break; }
      p = new THREE.Vector2(best.x, best.z);
      pts.push(p.clone());
      const a = this.mirrorAngle(best.k), n = new THREE.Vector2(Math.cos(a), Math.sin(a));
      const dn = d.dot(n);
      if (dn >= -0.01) break; // struck the back of the mirror
      d = d.clone().addScaledVector(n, -2 * dn).normalize();
      d.set(Math.round(d.x), Math.round(d.y));
    }
    this.beamPts = pts;
    return hitTarget;
  }

  drawBeam() {
    const pts = this.beamPts;
    this.beams.forEach((b, i) => {
      if (i >= pts.length - 1) { b.visible = false; return; }
      const a = W(pts[i].x, BEAM_Y, pts[i].y), c = W(pts[i + 1].x, BEAM_Y, pts[i + 1].y);
      b.visible = true; b.position.copy(a); b.lookAt(c); b.scale.set(1, 1, a.distanceTo(c));
    });
    const last = pts[pts.length - 1];
    this.beamHit.position.copy(W(last.x, BEAM_Y, last.y));
  }

  // ---------- bells ----------
  ring(i, strength = 1) {
    const b = this.bells[i];
    b.glow = 1; b.swing = 0.5 * strength;
    const s = this.game.sfx;
    s._tone(b.freq, 2.2, 0.16 * strength); s._tone(b.freq * 2.01, 1.2, 0.05 * strength);
  }

  playSong() {
    if (this.solved[1] || this.playing) return;
    if (!this.song.length) {
      this.song = []; for (let i = 0; i < 5; i++) { let n; do { n = Math.floor(Math.random() * 4); } while (n === this.song[i - 1]); this.song.push(n); }
    }
    this.songPos = 0;
    this.playing = { i: 0, t: 0.4 };
  }

  strikeBell(i) {
    if (this.solved[1]) { this.ring(i, 0.6); return; }
    this.ring(i);
    if (this.playing) return;
    if (!this.song.length) { this.playSong(); return; }
    if (this.song[this.songPos] === i) {
      this.songPos++;
      if (this.songPos >= this.song.length) this.solve(1);
    } else {
      this.songPos = 0;
      const s = this.game.sfx; s._tone(110, 0.6, 0.2, 'sawtooth', 70);
      this.game.toast('The bells fall out of tune — listen again', true, 1.8);
      setTimeout(() => this.playSong(), 1600);
    }
  }

  // ---------- embers ----------
  lightBowl(b) {
    if (this.solved[2]) return;
    b.t = this.burn;
    b.fire.group.visible = true;
    this.game.sfx.place(); this.game.sfx._noise(0.5, 'lowpass', 900, 0.7, 0.4, 2000);
    if (this.bowls.every((q) => q.t > 0)) this.solve(2);
  }

  /** Sword swing: strikes a bell or an ember bowl in front of the warden. */
  trySwing(hero) {
    const fx = Math.sin(hero.yaw), fz = Math.cos(hero.yaw);
    const near = (x, z, r) => {
      const p = W(x, 0, z), dx = p.x - hero.pos.x, dz = p.z - hero.pos.z;
      return Math.hypot(dx, dz) < r && dx * fx + dz * fz > 0 && Math.abs(hero.pos.y - (TEMPLE.y + PH)) < 1.5;
    };
    for (let i = 0; i < 4; i++) if (near(this.bells[i].x, this.bells[i].z, 2.3)) { this.strikeBell(i); return true; }
    for (const b of this.bowls) if (near(b.x, b.z, 2.2)) { this.lightBowl(b); return true; }
    return false;
  }

  solve(i) {
    if (this.solved[i]) return;
    this.solved[i] = true;
    const g = this.game;
    this.pedTops[i].material.emissiveIntensity = 5;
    this.temple.sockets[i].material.emissiveIntensity = 7;
    g.sfx.heal(); g.sfx.bell();
    g.sparks.burst(this.pedTops[i].getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.4, 0)), 50, new THREE.Color(6, 4, 1.5), 3, 3);
    const n = this.solved.filter(Boolean).length;
    g.toast(`Sun-mark rekindled (${n}/3)`, false, 2.6);
    if (n < 3) g.setObjective(`Rekindle the three sun-marks on the temple platform (${n}/3)`);
    else this.complete();
  }

  complete() {
    const g = this.game;
    this.temple.seal.children.forEach((c) => { if (c.material) { c.material = c.material.clone(); c.material.emissiveIntensity = 8; } });
    g.rig.addShake(0.5);
    setTimeout(() => {
      g.toast('The seal is broken', false, 3);
      g.queueSubs([['The doors shudder. Behind you, armour grinds against stone — something kneeling there begins to rise.', 5]]);
      g.boss.sealOpen = true;
    }, 1800);
    g.setObjective('The seal is broken. Something stirs on the temple steps…');
  }

  update(dt, hero) {
    // mirrors ease to their new angle; the beam follows
    let moving = false;
    for (const m of this.mirrors) {
      if (m.target === undefined) continue;
      let d = m.target - m.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > 0.01) { m.angle += d * Math.min(1, dt * 8); moving = true; } else { m.angle = m.target; m.target = undefined; }
      m.group.rotation.y = -m.angle + Math.PI / 2;
    }
    if (!this.solved[0]) {
      const hit = this.traceBeam();
      if (hit && !moving) this.solve(0);
    }
    this.drawBeam();
    // bells
    if (this.playing) {
      const P = this.playing;
      P.t -= dt;
      if (P.t <= 0) {
        if (P.i < this.song.length) { this.ring(this.song[P.i]); P.i++; P.t = 0.75; } else this.playing = null;
      }
    }
    for (const b of this.bells) {
      b.glow = Math.max(this.solved[1] ? 0.35 : 0, b.glow - dt * 1.6);
      b.mat.emissiveIntensity = b.glow * 3;
      b.swing *= Math.exp(-dt * 1.5);
      b.pivot.rotation.x = Math.sin(performance.now() * 0.009) * b.swing;
    }
    // embers burn down
    for (const b of this.bowls) {
      if (this.solved[2]) { b.fire.update(dt, performance.now() * 0.001); b.coal.material.emissiveIntensity = 2; continue; }
      if (b.t > 0) {
        b.t -= dt;
        const k = Math.max(0, b.t / this.burn);
        b.fire.group.scale.setScalar(0.35 + 0.65 * k);
        b.fire.update(dt, performance.now() * 0.001);
        b.coal.material.emissiveIntensity = 1 + 2 * k;
        if (b.t <= 0) { b.fire.group.visible = false; b.coal.material.emissiveIntensity = 0; this.game.sfx._noise(0.6, 'highpass', 1500, 0.7, 0.15); }
      }
    }
    // hints on first approach
    const hints = [
      'A sun crystal still burns here. Turn the bronze mirrors (E) to guide its light onto the pedestal.',
      'Four temple bells. Examine the pedestal (E) to hear the old hymn, then strike the bells with your sword in the same order.',
      'Three cold ember bowls on the corners of the platform. Strike one to light it — light all three before the first burns out.',
    ];
    this.hintSpots.forEach((p, i) => {
      if (!this.hinted[i] && !this.solved[i] && hero.pos.distanceTo(p) < 7) { this.hinted[i] = true; this.game.queueSubs([[hints[i], 5.5]]); }
    });
  }
}
