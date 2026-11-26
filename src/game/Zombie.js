// 3D zombies cut from the user's turnaround sheets (tools/zombie_build.py).
// Every limb is its own piece: sword, bullets and the truck can take them apart, all the way.
import * as THREE from 'three';
import { probeDown } from './physics.js';
import { heightAt } from '../world/terrain.js';

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const rnd = (a, b) => a + Math.random() * (b - a);

const KINDS = [];   // loaded variants: { meta, map }
// which sheets are women (zombie1, zombie5, zombie6) — for their voice lines
const FEMALE = new Set([0, 4, 5]);
const LINES = { f: ['I will eat your head!'], m: ['Get to the chopper!', 'Show me the money, bitch!'] };
let lastLine = 0;

export async function loadZombies() {
  await Promise.all([1, 2, 3, 4, 5, 6].map(async (i) => {
    try {
      const [meta, map] = await Promise.all([
        fetch(`./models/zombie${i}.json`).then((r) => r.json()),
        new THREE.TextureLoader().loadAsync(`./models/zombie${i}.jpg`),
      ]);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      KINDS[i - 1] = { meta, map, geos: buildGeometries(meta) };
    } catch (e) { console.warn('zombie', i, e); }
  }));
}
export const zombiesReady = () => KINDS.some(Boolean);

function buildGeometries(meta) {
  const out = {};
  for (const p of meta.parts) {
    const rest = new Float32Array(p.pos);
    const pos = rest.slice();
    for (let i = 0; i < pos.length; i += 3) { pos[i] -= p.pivot[0]; pos[i + 1] -= p.pivot[1]; pos[i + 2] -= p.pivot[2]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('rest', new THREE.BufferAttribute(rest, 3));
    g.setIndex(p.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    out[p.name] = g;
  }
  return out;
}

/** Paints the parts by projecting the front, side and back drawings (blended by facing). */
function projectedMaterial(kind, u = kind.meta.uv, flash = { value: 0 }) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, envMapIntensity: 0.35 });
  m.userData.flash = flash;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tAtlas = { value: kind.map };
    sh.uniforms.uF = { value: new THREE.Vector4(...u.front) };
    sh.uniforms.uS = { value: new THREE.Vector4(...u.side) };
    sh.uniforms.uB = { value: new THREE.Vector4(...u.back) };
    sh.uniforms.uFlash = m.userData.flash;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 rest; varying vec3 vRest; varying vec3 vRestN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = rest; vRestN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tAtlas; uniform vec4 uF, uS, uB; uniform float uFlash; varying vec3 vRest; varying vec3 vRestN;
// fabric folds, seams and wounds from the painting's own light and shade
vec3 zPerturb(vec3 p, vec3 n, vec2 dH, float fd) {
  vec3 sx = dFdx(p), sy = dFdy(p);
  vec3 r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * fd;
  vec3 g = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * n - g);
}`)
      .replace('#include <map_fragment>', `
        vec3 rn = normalize(vRestN);
        vec3 bw = pow(abs(rn), vec3(9.0));   // sharp hand-over between views: no double images
        float wf = rn.z > 0.0 ? bw.z : 0.0, wb = rn.z > 0.0 ? 0.0 : bw.z, ws = bw.x + bw.y * 0.6;
        wf += bw.y * 0.2; wb += bw.y * 0.2;
        vec4 cF = texture2D(tAtlas, vec2(uF.x * vRest.x + uF.y, uF.z * vRest.y + uF.w));
        vec4 cS = texture2D(tAtlas, vec2(uS.x * vRest.z + uS.y, uS.z * vRest.y + uS.w));
        vec4 cB = texture2D(tAtlas, vec2(uB.x * vRest.x + uB.y, uB.z * vRest.y + uB.w));
        vec4 texel = (cF * wf + cS * ws + cB * wb) / max(wf + ws + wb, 1e-4);
        diffuseColor *= vec4(texel.rgb * 1.15, texel.a);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.12, 0.08), uFlash * 0.55);
        float zH = dot(texel.rgb, vec3(0.3, 0.59, 0.11));
        vec3 zGlow = texel.rgb * 0.32;   // the sheets are already lit: keep their look in shade`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = zPerturb(-vViewPosition, normal, vec2(dFdx(zH), dFdy(zH)) * 0.25, faceDirection);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += zGlow;`);
  };
  m.customProgramCacheKey = () => 'zombie-projected';
  return m;
}

const FLESH = new THREE.MeshStandardMaterial({ color: 0x5c0b08, roughness: 0.35, metalness: 0, emissive: 0x200000 });
const STUMP_GEO = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);

// ---------------------------------------------------------------- blood & flying pieces (shared)
class Gore {
  constructor() { this.scene = null; this.gibs = []; this.collider = null; }
  init(scene) {
    if (this.scene) return;
    this.scene = scene;
    const N = 700;
    this.N = N; this.bp = new Float32Array(N * 3); this.bv = new Float32Array(N * 3); this.bl = new Float32Array(N); this.bi = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.bp, 3));
    this.drops = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5a0604, size: 0.07, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.drops.frustumCulled = false;
    scene.add(this.drops);
    for (let i = 0; i < N; i++) this.bp[i * 3 + 1] = -9999;
    // pooled ground splats
    const D = 260;
    this.decals = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3e0503, roughness: 0.3, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), D);
    this.decals.count = 0; this.di = 0; this.D = D;
    this.decals.frustumCulled = false;
    scene.add(this.decals);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
  }
  ground(x, y, z) {
    if (this.collider) {
      const h = probeDown(this.collider, this._p.set(x, y + 1.2, z), 6);
      if (h) return h.point.y;
    }
    return heightAt(x, z);
  }
  spray(pos, dir, n, speed = 4) {
    for (let k = 0; k < n; k++) {
      const i = this.bi = (this.bi + 1) % this.N;
      this.bp[i * 3] = pos.x; this.bp[i * 3 + 1] = pos.y; this.bp[i * 3 + 2] = pos.z;
      const s = speed * rnd(0.25, 1);
      this.bv[i * 3] = (dir.x + rnd(-0.6, 0.6)) * s;
      this.bv[i * 3 + 1] = (dir.y + rnd(0, 0.9)) * s;
      this.bv[i * 3 + 2] = (dir.z + rnd(-0.6, 0.6)) * s;
      this.bl[i] = rnd(0.6, 1.4);
    }
  }
  splat(x, y, z, r) {
    const i = this.di = (this.di + 1) % this.D;
    this._q.setFromAxisAngle(this._s.set(0, 1, 0), Math.random() * 6.28);
    this._m.compose(this._p.set(x, y + 0.02, z), this._q, this._s.set(r * rnd(0.8, 1.4), 1, r));
    this.decals.setMatrixAt(i, this._m);
    this.decals.count = Math.max(this.decals.count, i + 1);
    this.decals.instanceMatrix.needsUpdate = true;
  }
  addGib(obj, vel, spin, owner) {
    this.gibs.push({ obj, vel, spin, owner, t: 0, rest: false, bleed: 1.2 });
    if (this.gibs.length > 70) this.removeGib(this.gibs[0]);
  }
  removeGib(g) {
    g.obj.parent?.remove(g.obj);
    const i = this.gibs.indexOf(g); if (i >= 0) this.gibs.splice(i, 1);
  }
  clearOwner(owner) { for (const g of [...this.gibs]) if (g.owner === owner) this.removeGib(g); }
  update(dt) {
    if (!this.scene) return;
    // drops
    for (let i = 0; i < this.N; i++) {
      if (this.bl[i] <= 0) continue;
      this.bl[i] -= dt;
      const j = i * 3;
      this.bv[j + 1] -= 14 * dt;
      this.bp[j] += this.bv[j] * dt; this.bp[j + 1] += this.bv[j + 1] * dt; this.bp[j + 2] += this.bv[j + 2] * dt;
      if (this.bv[j + 1] < 0 && (i % 3 === 0)) {
        const gy = heightAt(this.bp[j], this.bp[j + 2]);
        if (this.bp[j + 1] < gy) { if (i % 9 === 0) this.splat(this.bp[j], gy, this.bp[j + 2], rnd(0.05, 0.16)); this.bl[i] = 0; }
      }
      if (this.bl[i] <= 0) this.bp[j + 1] = -9999;
    }
    this.drops.geometry.attributes.position.needsUpdate = true;
    // flying pieces
    const ax = new THREE.Vector3(), dq = new THREE.Quaternion();
    for (const g of [...this.gibs]) {
      g.t += dt;
      const o = g.obj;
      if (!g.rest) {
        g.vel.y -= 16 * dt;
        o.position.addScaledVector(g.vel, dt);
        const w = g.spin.length();
        if (w > 1e-3) { dq.setFromAxisAngle(ax.copy(g.spin).divideScalar(w), w * dt); o.quaternion.premultiply(dq); }
        if (g.bleed > 0) { g.bleed -= dt; if (Math.random() < 0.6) this.spray(o.position, g.vel.clone().normalize().multiplyScalar(-0.2), 1, 1); }
        const gy = this.ground(o.position.x, o.position.y, o.position.z) + 0.06;
        if (o.position.y < gy) {
          o.position.y = gy;
          if (g.vel.y < -3) this.splat(o.position.x, gy, o.position.z, rnd(0.18, 0.35));
          g.vel.y *= -0.25; g.vel.x *= 0.55; g.vel.z *= 0.55; g.spin.multiplyScalar(0.5);
          if (g.vel.lengthSq() < 0.3) { g.rest = true; g.restT = 0; }
        }
      }
      if (g.t > 30) {
        o.position.y -= dt * 0.15;      // sink away
        if (g.t > 34) this.removeGib(g);
      }
    }
  }
}
export const GORE = new Gore();

// ---------------------------------------------------------------- the zombie
const LIMB_CHAIN = { uarmR: ['uarmR', 'farmR'], farmR: ['farmR'], uarmL: ['uarmL', 'farmL'], farmL: ['farmL'],
  thighR: ['thighR', 'shinR'], shinR: ['shinR'], thighL: ['thighL', 'shinL'], shinL: ['shinL'], head: ['head'] };

export class Zombie {
  constructor(home, scene, variant) {
    GORE.init(scene);
    const avail = KINDS.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    this.variant = variant ?? avail[Math.floor(Math.random() * avail.length)];
    const kind = KINDS[this.variant];
    this.kind = 'zombie';
    this.home = home.clone();
    this.pos = home.clone();
    this.vel = new THREE.Vector3();
    this.yaw = Math.random() * 6.28;
    this.maxHP = 5; this.hp = 5;
    this.state = 'idle'; this.stateT = Math.random() * 3;
    this.wanderTarget = home.clone();
    this.attackCooldown = 1 + Math.random();
    this.radius = 0.4;
    this.phase = Math.random() * 10;
    this.speedMul = rnd(0.8, 1.35);
    this.runner = Math.random() < 0.25;
    this.female = FEMALE.has(this.variant ?? -1);
    this.lineT = 0;
    // every zombie moves a little differently
    const pickArm = () => [1, 1, 0.75, 0.4, 0.15][Math.floor(Math.random() * 5)];
    this.style = {
      reachR: pickArm(), reachL: pickArm(),            // how high each arm is held out
      lean: rnd(0.1, 0.42), headTilt: rnd(-0.35, 0.35), headDrop: rnd(-0.25, 0.2),
      stride: rnd(0.32, 0.6), stiff: Math.random() < 0.5 ? 'L' : 'R', sway: rnd(0.04, 0.14),
      twitch: rnd(0.04, 0.14), shoulder: rnd(0.05, 0.25), cadence: rnd(0.8, 1.2),
    };
    this.flash = 0;
    this.scene = scene;
    this.mat = projectedMaterial(kind);
    // the close-up head sheet, when there is one, paints the head
    this.headMat = kind.meta.headUV ? projectedMaterial(kind, kind.meta.headUV, this.mat.userData.flash) : this.mat;

    // build the body: root (pelvis) -> torso -> head/arms ; root -> legs
    const g = new THREE.Group();
    const meta = kind.meta;
    const P = {}; meta.parts.forEach((p) => { P[p.name] = p; });
    const root = new THREE.Group(); root.position.fromArray(meta.root); g.add(root);
    this.root = root; this.rootY = meta.root[1];
    this.g = { root };
    const pivotOf = (n) => (n === 'root' ? meta.root : P[n].pivot);
    const order = ['torso', 'head', 'uarmR', 'farmR', 'uarmL', 'farmL', 'thighR', 'shinR', 'thighL', 'shinL'];
    for (const n of order) {
      const p = P[n]; if (!p) continue;
      const parentName = p.parent || 'root';
      const parent = this.g[parentName] || root;
      const grp = new THREE.Group();
      const pp = pivotOf(parentName);
      grp.position.set(p.pivot[0] - pp[0], p.pivot[1] - pp[1], p.pivot[2] - pp[2]);
      const mesh = new THREE.Mesh(kind.geos[n], n === 'head' ? this.headMat : this.mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      grp.add(mesh);
      parent.add(grp);
      grp.userData = { home: parent, pos: grp.position.clone(), name: n };
      this.g[n] = grp;
      // stump shown on the parent where this piece comes off, and on the piece itself
      const size = kind.geos[n].boundingSphere.radius;
      const r = clamp(size * 0.22, 0.045, 0.12);
      const stump = new THREE.Mesh(STUMP_GEO, FLESH); stump.scale.set(r, r * 0.5, r);
      stump.position.copy(grp.position); stump.visible = false;
      if (n.startsWith('thigh') || n.startsWith('shin') || n.startsWith('farm') || n.startsWith('uarm')) stump.rotation.x = Math.PI;   // faces down along the limb
      parent.add(stump);
      grp.userData.stump = stump;
      const end = new THREE.Mesh(STUMP_GEO, FLESH); end.scale.set(r, r * 0.5, r); end.visible = false;
      if (n === 'head') end.rotation.x = Math.PI;
      grp.add(end); grp.userData.end = end;
    }
    this.attached = new Set(order.filter((n) => this.g[n]));
    // sheets differ (arms out in a T, angled in an A): measure each arm so "hanging" means straight down
    this.armRest = {};
    for (const sd of 'RL') {
      const a = P['uarm' + sd]?.pivot, b = P['farm' + sd]?.pivot;
      this.armRest[sd] = a && b ? Math.atan2(-(b[0] - a[0]), -(b[1] - a[1])) : (sd === 'R' ? 0.35 : -0.35);
    }
    this.object = g;
    this.object.scale.setScalar(rnd(0.95, 1.06));
    scene.add(g);
  }

  get alive() { return this.state !== 'dead'; }
  get crawling() { return this.legsLost >= 2; }
  get legsLost() {
    let n = 0;
    for (const s of 'RL') if (!this.attached.has('thigh' + s) || !this.attached.has('shin' + s)) n++;
    return n;
  }
  get lockPoint() { return new THREE.Vector3(this.pos.x, this.pos.y + (this.crawling ? 0.35 : 1.25), this.pos.z); }

  reset() {
    GORE.clearOwner(this);
    for (const [n, grp] of Object.entries(this.g)) {
      if (n === 'root') continue;
      const u = grp.userData;
      if (grp.parent !== u.home) { u.home.add(grp); }
      grp.position.copy(u.pos); grp.rotation.set(0, 0, 0); grp.scale.setScalar(1);
      u.stump.visible = false; u.end.visible = false;
      grp.visible = true;
    }
    this.attached = new Set(Object.keys(this.g).filter((n) => n !== 'root'));
    this.pos.copy(this.home); this.hp = this.maxHP; this.state = 'idle'; this.stateT = 0;
    this.object.visible = true; this.root.rotation.set(0, 0, 0); this.root.position.y = this.rootY;
  }

  /** Cut a piece (and everything hanging off it) loose and send it flying. */
  sever(name, away, events, force = 1) {
    if (!this.attached.has(name)) return false;
    const grp = this.g[name];
    const chain = LIMB_CHAIN[name] || [name];
    // everything below goes with it
    const goes = [name];
    if (name === 'torso') goes.push('head', 'uarmR', 'farmR', 'uarmL', 'farmL');
    else for (const c of chain) if (!goes.includes(c)) goes.push(c);
    for (const n of goes) this.attached.delete(n);
    const wp = new THREE.Vector3(); grp.getWorldPosition(wp);
    this.scene.attach(grp);
    grp.userData.stump.visible = grp.userData.home !== this.root || name.startsWith('thigh') || name === 'torso';
    grp.userData.end.visible = true;
    const vel = away.clone().multiplyScalar(rnd(2.5, 5.5) * force).add(new THREE.Vector3(rnd(-1.2, 1.2), rnd(2.5, 5) * force, rnd(-1.2, 1.2)));
    const spin = new THREE.Vector3(rnd(-9, 9), rnd(-9, 9), rnd(-9, 9)).multiplyScalar(force);
    GORE.addGib(grp, vel, spin, this);
    GORE.spray(wp, new THREE.Vector3(away.x, 0.5, away.z), 26, 4.5);
    events.push({ type: 'sever', enemy: this, part: name, pos: wp });
    return true;
  }

  /** Remaining pieces all come apart (head shot, finishing blow, explosion). */
  burst(away, events) {
    const order = ['head', 'farmR', 'farmL', 'uarmR', 'uarmL', 'shinR', 'shinL', 'thighR', 'thighL', 'torso'];
    for (const n of order) if (this.attached.has(n)) this.sever(n, away.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rnd(-0.8, 0.8)), events, 0.8);
    // what's left (pelvis) drops where it stood
    this.object.visible = false;
    GORE.spray(this.pos.clone().setY(this.pos.y + 0.9), new THREE.Vector3(0, 0.6, 0), 60, 5);
    for (let i = 0; i < 4; i++) GORE.splat(this.pos.x + rnd(-0.6, 0.6), heightAt(this.pos.x, this.pos.z), this.pos.z + rnd(-0.6, 0.6), rnd(0.25, 0.5));
  }

  takeHit(dmg, fromPos, events, opts = {}) {
    if (!this.alive) return false;
    this.hp -= dmg;
    this.flash = 1;
    const away = new THREE.Vector3(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z);
    if (away.lengthSq() < 1e-6) away.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).negate();
    away.normalize();
    this.vel.addScaledVector(away, 2 + dmg);
    GORE.spray(this.lockPoint, new THREE.Vector3(away.x, 0.3, away.z), 14, 3.5);
    // chop something off: a shot takes the piece it hit, a blade or blast picks one
    const chance = opts.sever ?? (dmg >= 1.8 ? 1 : 0.62);
    if (opts.part && LIMB_CHAIN[opts.part]) {
      if (Math.random() < chance) this.sever(opts.part, away, events, opts.part === 'head' ? 1.3 : 1);
    } else if (opts.part === 'torso') {
      /* body shot: no limb comes off */
    } else if (Math.random() < chance) {
      const w = [];
      const add = (n, k) => { if (this.attached.has(n)) w.push([n, k]); };
      add('farmR', 3); add('farmL', 3); add('uarmR', 1.6); add('uarmL', 1.6);
      add('shinR', 1.8); add('shinL', 1.8); add('thighR', 1.2); add('thighL', 1.2);
      add('head', this.hp <= 2 ? 3 : 0.7);
      const tot = w.reduce((a, b) => a + b[1], 0);
      let r = Math.random() * tot;
      for (const [n, k] of w) { r -= k; if (r <= 0) { this.sever(n, away, events); break; } }
    }
    if (this.hp <= 0 || !this.attached.has('head')) {
      this.state = 'dead'; this.stateT = 0;
      this.burst(away, events);
      events.push({ type: 'kill', enemy: this, zombie: true });
    } else if (this.state !== 'strike') {
      this.state = 'stagger'; this.stateT = 0;
      this.attackCooldown = Math.max(this.attackCooldown, 0.6);
    }
    return true;
  }

  /** Now and then a zombie shouts its line (one voice at a time across the valley). */
  speak(events, chance) {
    const now = performance.now() / 1000;
    if (now - lastLine < 5 || now - this.lineT < 14 || Math.random() > chance) return;
    if (!this.attached.has('head')) return;
    lastLine = now; this.lineT = now;
    const L = LINES[this.female ? 'f' : 'm'];
    events.push({ type: 'zombie-say', enemy: this, text: L[Math.floor(Math.random() * L.length)], female: this.female });
  }

  update(dt, hero, others, collider, events) {
    GORE.collider = collider;
    this.stateT += dt;
    this.phase += dt;
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.state === 'dead') { this.mat.userData.flash.value = this.flash; return; }
    const toHero = new THREE.Vector3(hero.pos.x - this.pos.x, 0, hero.pos.z - this.pos.z);
    const dist = toHero.length();
    const heroYaw = Math.atan2(toHero.x, toHero.z);
    const crawl = this.crawling, limp = this.legsLost === 1;
    const walk = (this.runner ? 3.4 : 1.25) * this.speedMul * (crawl ? 0.45 : limp ? 0.55 : 1);
    const reach = crawl ? 1.3 : 1.55;
    let speed = 0, dir = null, face = null, turnK = 3.5;
    this.attackCooldown -= dt;
    switch (this.state) {
      case 'idle': {
        if (this.stateT > 4) { this.stateT = 0; this.wanderTarget.set(this.home.x + rnd(-5, 5), 0, this.home.z + rnd(-5, 5)); }
        const w = new THREE.Vector3(this.wanderTarget.x - this.pos.x, 0, this.wanderTarget.z - this.pos.z);
        if (w.length() > 0.6) { dir = w.normalize(); speed = walk * 0.45; face = Math.atan2(dir.x, dir.z); }
        if (hero.targetable && dist < 17) { this.state = 'chase'; this.stateT = 0; events.push({ type: 'zombie-groan', enemy: this }); this.speak(events, 0.7); }
        break;
      }
      case 'chase': {
        if (!hero.targetable || dist > 34 || (!this.raider && this.pos.distanceTo(this.home) > 50)) { this.state = 'return'; break; }
        face = heroYaw;
        if (dist > reach * 0.8) { dir = toHero.clone().normalize(); speed = walk; }
        if (dist < reach + 0.4 && this.attackCooldown <= 0 && Math.abs(angDiff(this.yaw, heroYaw)) < 0.7) {
          this.state = 'windup'; this.stateT = 0; events.push({ type: 'zombie-groan', enemy: this }); this.speak(events, 0.3);
        }
        if (Math.random() < dt * 0.08) events.push({ type: 'zombie-groan', enemy: this, quiet: true });
        break;
      }
      case 'return': {
        const w = new THREE.Vector3(this.home.x - this.pos.x, 0, this.home.z - this.pos.z);
        if (w.length() < 1) { this.state = 'idle'; this.stateT = 0; break; }
        dir = w.normalize(); speed = walk * 0.8; face = Math.atan2(dir.x, dir.z);
        if (hero.targetable && dist < 12) { this.state = 'chase'; this.stateT = 0; }
        break;
      }
      case 'windup': {
        face = heroYaw; turnK = 3;
        if (this.stateT > 0.55) { this.state = 'strike'; this.stateT = 0; this.hitThisSwing = false; }
        break;
      }
      case 'strike': {
        dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        speed = this.stateT < 0.2 ? (dist > 1.1 ? 4.5 : 0) : 0;
        if (!this.hitThisSwing && this.stateT > 0.12 && this.stateT < 0.3) {
          const armsLeft = ['farmR', 'farmL', 'uarmR', 'uarmL'].some((n) => this.attached.has(n));
          if (dist < reach + 0.25 && Math.abs(angDiff(this.yaw, heroYaw)) < 1.0 && Math.abs(hero.pos.y - this.pos.y) < 1.4) {
            this.hitThisSwing = true;
            const r = hero.takeHit(armsLeft ? 16 : 11, this.pos, events);   // no arms left: it can still bite
            if (r === 'blocked') { this.state = 'stagger'; this.stateT = 0; }
            else events.push({ type: 'zombie-bite', enemy: this });
          }
        }
        if (this.stateT > 0.5) { this.state = 'recover'; this.stateT = 0; }
        break;
      }
      case 'recover': if (this.stateT > 0.7) { this.state = 'chase'; this.stateT = 0; this.attackCooldown = rnd(0.8, 1.8); } break;
      case 'stagger': if (this.stateT > 0.5) { this.state = 'chase'; this.stateT = 0; } break;
    }
    if (face !== null) this.yaw += angDiff(this.yaw, face) * (1 - Math.exp(-turnK * dt));
    const tx = dir ? dir.x * speed : 0, tz = dir ? dir.z * speed : 0;
    this.vel.x = damp(this.vel.x, tx, 6, dt);
    this.vel.z = damp(this.vel.z, tz, 6, dt);
    for (const o of others) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.9 && d > 1e-4) { this.pos.x += dx / d * (0.9 - d) * 0.5; this.pos.z += dz / d * (0.9 - d) * 0.5; }
    }
    if (hero.targetable && dist < 0.75 && dist > 1e-4) { this.pos.x -= toHero.x / dist * (0.75 - dist); this.pos.z -= toHero.z / dist * (0.75 - dist); }
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    const hit = probeDown(collider, new THREE.Vector3(this.pos.x, this.pos.y + 1.6, this.pos.z), 4);
    if (hit) this.pos.y = damp(this.pos.y, hit.point.y, 20, dt);
    // far away: cheaper (no shadows, animate at a lower rate)
    const far = dist > 45;
    if (far !== this._far) { this._far = far; this.object.traverse((m) => { if (m.isMesh) m.castShadow = !far; }); }
    this._animAcc = (this._animAcc || 0) + dt;
    if (dist < 70 || this._animAcc > 0.1) { this.animate(this._animAcc); this._animAcc = 0; }
    else { this.object.position.copy(this.pos); this.object.rotation.y = this.yaw; }
  }

  animate(dt) {
    const o = this.object;
    o.position.copy(this.pos);
    o.rotation.y = this.yaw;
    this.mat.userData.flash.value = this.flash;
    const G = this.g, S = this.style;
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const la = clamp(spd / 1.4, 0, 1.3);
    const ph = this.phase * (this.runner ? 7.5 : 4.2) * S.cadence * (0.6 + 0.4 * la);
    const t = this.stateT;
    const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
    // every joint eases toward its target, so poses blend into each other smoothly
    let K = this.state === 'strike' ? 16 : this.state === 'windup' ? 10 : 7;
    const T = {};
    const set = (n, x, y, z) => { T[n] = [x, y, z]; };
    const twitch = (Math.sin(this.phase * 13.7) * Math.sin(this.phase * 3.1) + Math.sin(this.phase * 23.3) * 0.3) * S.twitch;
    let rootY = this.rootY - 0.03, rootX = 0, rootZ = 0;

    if (this.crawling) {
      // dragging itself along by the arms
      rootX = 1.35; rootY = 0.22;
      const pull = Math.sin(ph);
      set('torso', 0.05, pull * 0.18, pull * 0.12);
      set('head', -1.0 + twitch, Math.sin(ph * 0.5) * 0.25, 0);
      set('uarmR', -2.6 + pull * 0.7, 0, this.armRest.R + 0.1); set('uarmL', -2.6 - pull * 0.7, 0, this.armRest.L - 0.1);
      set('farmR', -0.3 - Math.max(0, -pull) * 0.9, 0, 0); set('farmL', -0.3 - Math.max(0, pull) * 0.9, 0, 0);
      if (this.state === 'windup') set('head', -1.3, 0, 0);
      if (this.state === 'strike') { set('head', -0.5, Math.sin(t * 40) * 0.2, 0); set('uarmR', -3.0, 0, this.armRest.R); set('uarmL', -3.0, 0, this.armRest.L); }
    } else {
      const limp = this.legsLost === 1;
      const sw = Math.sin(ph) * S.stride * la;
      rootY += Math.abs(Math.cos(ph)) * 0.045 * la;
      if (limp) {
        const good = this.attached.has('thighR') && this.attached.has('shinR') ? 'R' : 'L';
        const bad = good === 'R' ? 'L' : 'R';
        set('thigh' + good, -0.15 + sw * 0.3, 0, 0); set('shin' + good, 0.25 + Math.max(0, Math.sin(ph * 2)) * 0.45, 0, 0);
        set('thigh' + bad, -0.4 + sw, 0, 0); set('shin' + bad, 0.3, 0, 0);
        rootY -= 0.08 - Math.abs(Math.sin(ph * 2)) * 0.07 * la;
        rootZ = good === 'R' ? 0.13 : -0.13;
      } else {
        rootZ = Math.sin(ph) * S.sway * la;
        // one leg drags stiffly, the other shambles
        const kneeR = S.stiff === 'R' ? 0.35 : 0.75, kneeL = S.stiff === 'L' ? 0.35 : 0.75;
        set('thighR', -sw - 0.05, 0.05, 0.03); set('thighL', sw - 0.05, -0.05, -0.03);
        set('shinR', 0.12 + Math.max(0, Math.sin(ph + 1.3)) * kneeR * la, 0, 0);
        set('shinL', 0.12 + Math.max(0, Math.sin(ph + 1.3 + Math.PI)) * kneeL * la, 0, 0);
      }
      // upper body: each zombie holds its arms its own way
      const reach = (r) => lerp(-0.25, -1.25, r);
      let armR = reach(S.reachR) + Math.sin(ph) * 0.12 * la, armL = reach(S.reachL) - Math.sin(ph) * 0.12 * la;
      let inR = lerp(0.08, 0.4, S.reachR), inL = lerp(0.08, 0.4, S.reachL);
      let elR = lerp(-0.05, -0.4, S.reachR), elL = lerp(-0.05, -0.4, S.reachL);
      let lean = S.lean + twitch * 0.5, headX = S.headDrop + twitch * 2, headZ = S.headTilt + twitch, headY = Math.sin(this.phase * 0.9) * 0.25;
      let torsoY = Math.sin(ph) * S.shoulder * la, torsoZ = Math.sin(this.phase * 0.7) * 0.06;
      if (this.state === 'idle' && la < 0.2) {
        // swaying on the spot
        armR = -0.2 + Math.sin(this.phase * 1.1) * 0.06; armL = -0.2 - Math.sin(this.phase * 1.3) * 0.06; inR = inL = 0.08; elR = elL = -0.12;
        lean = S.lean * 0.6; headX = 0.3 + twitch * 2; torsoZ = Math.sin(this.phase * 0.6) * 0.1;
      }
      if (this.state === 'windup') {
        // rear back, arms up, head thrown back
        const k = ease(t / 0.5);
        armR = lerp(armR, -2.3, k); armL = lerp(armL, -2.2, k); inR = inL = lerp(0.3, 0.05, k);
        elR = elL = lerp(-0.3, -0.9, k); lean = lerp(lean, -0.25, k); headX = lerp(headX, -0.55, k); torsoY = 0.15 * k;
        rootY -= 0.05 * k;
      }
      if (this.state === 'strike') {
        // lunge: arms rake down and in, the body throws itself forward, then the bite
        const k1 = ease(t / 0.16), k2 = ease((t - 0.14) / 0.14);
        armR = lerp(-2.3, -1.0, k1); armL = lerp(-2.2, -0.95, k1); inR = inL = lerp(0.05, 0.65, k1);
        elR = elL = lerp(-0.9, -0.15, k1);
        lean = lerp(-0.25, 0.7, k1); torsoY = lerp(0.15, -0.2, k1);
        headX = lerp(-0.55, 0.35, k2) + (t > 0.18 && t < 0.4 ? Math.sin(t * 55) * 0.12 : 0);   // the bite, with a shake
        headY = t > 0.18 && t < 0.4 ? Math.sin(t * 38) * 0.25 : 0;
        rootY -= 0.08 * k1;
      }
      if (this.state === 'recover') {
        const k = ease(t / 0.7);
        lean = lerp(0.7, lean, k); armR = lerp(-1.0, armR, k); armL = lerp(-0.95, armL, k); inR = lerp(0.65, inR, k); inL = lerp(0.65, inL, k);
        headX = lerp(0.35, headX, k);
      }
      if (this.state === 'stagger') {
        const k = Math.sin(clamp(t / 0.5, 0, 1) * Math.PI);
        lean = lerp(lean, -0.45, k); headX = lerp(headX, -0.7, k); armR = lerp(armR, -0.6, k); armL = lerp(armL, -0.4, k); torsoY = 0.3 * k;
        K = 12;
      }
      set('torso', lean, torsoY, torsoZ);
      set('head', headX, headY, headZ);
      // inR/inL: 0 = hanging straight down, more = brought in toward the chest
      set('uarmR', armR, 0, this.armRest.R - 0.12 + inR * 0.55); set('uarmL', armL, 0, this.armRest.L + 0.12 - inL * 0.55);
      set('farmR', elR, 0, 0); set('farmL', elL, 0, 0);
    }
    const k = 1 - Math.exp(-K * dt);
    for (const n in T) {
      const p = G[n]; if (!p || !this.attached.has(n)) continue;
      const [x, y, z] = T[n];
      p.rotation.x += (x - p.rotation.x) * k; p.rotation.y += (y - p.rotation.y) * k; p.rotation.z += (z - p.rotation.z) * k;
    }
    const kr = 1 - Math.exp(-6 * dt);
    this.root.rotation.x += (rootX - this.root.rotation.x) * kr;
    this.root.rotation.z += (rootZ - this.root.rotation.z) * kr;
    this.root.position.y += (rootY - this.root.position.y) * (1 - Math.exp(-10 * dt));
  }
}
