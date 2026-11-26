// Guns, rockets, tracers, smoke and explosions — shared by the hero, the truck turret and the helicopter.
import * as THREE from 'three';
import { rayHit } from './physics.js';
import { heightAt } from '../world/terrain.js';
import { BLUEPRINT } from './blueprint.js';

const rnd = (a, b) => a + Math.random() * (b - a);

export const GUNS = {
  ak: { name: 'AK-47', rate: 10, dmg: 1.2, mag: 30, reload: 2.2, spread: 0.014, sever: 0.45, range: 240, zoom: 40, kick: 0.05 },
  sniper: { name: 'Sniper rifle', rate: 1 / 1.1, dmg: 9, mag: 5, reload: 2.8, spread: 0.0004, sever: 1, range: 700, zoom: 13, kick: 0.25, semi: true },
};

/** A gun mesh with the grip at the origin, muzzle towards +Z. userData.muzzle = muzzle point. */
export function makeGunMesh(kind) {
  const g = new THREE.Group();
  const bp = BLUEPRINT.ak;
  if (kind === 'ak' && bp) {
    // the user's AK-47 turnaround sheet, built like the vehicles
    const m = new THREE.Mesh(bp.geometry, new THREE.MeshStandardMaterial({ map: bp.map, roughness: 0.55, metalness: 0.35 }));
    m.position.set(0, -0.17, 0.17);
    m.castShadow = true;
    g.add(m);
    g.userData.muzzle = new THREE.Vector3(0, 0.035, 0.62);
    return g;
  }
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.45, metalness: 0.7 });
  const wood = new THREE.MeshStandardMaterial({ color: kind === 'ak' ? 0x6a2f17 : 0x3b3d33, roughness: 0.6, metalness: 0.1 });
  const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; g.add(m); return m; };
  if (kind === 'sniper') {
    add(new THREE.BoxGeometry(0.06, 0.1, 0.42), wood, 0, 0.01, -0.12);               // stock + body
    add(new THREE.BoxGeometry(0.045, 0.14, 0.05), wood, 0, -0.06, 0.0, 0.3);          // grip
    add(new THREE.BoxGeometry(0.06, 0.07, 0.36), dark, 0, 0.045, 0.2);                // receiver
    add(new THREE.CylinderGeometry(0.014, 0.018, 0.62, 10).rotateX(Math.PI / 2), dark, 0, 0.05, 0.68);  // barrel
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 12).rotateX(Math.PI / 2), dark, 0, 0.13, 0.2);       // scope
    add(new THREE.CylinderGeometry(0.038, 0.03, 0.05, 12).rotateX(Math.PI / 2), dark, 0, 0.13, 0.36);
    add(new THREE.CylinderGeometry(0.035, 0.03, 0.05, 12).rotateX(Math.PI / 2), dark, 0, 0.13, 0.04);
    add(new THREE.BoxGeometry(0.02, 0.05, 0.02), dark, 0, 0.09, 0.2);
    add(new THREE.BoxGeometry(0.05, 0.08, 0.04), dark, 0, -0.02, 0.18);               // magazine
    g.userData.muzzle = new THREE.Vector3(0, 0.05, 1.0);
  } else {
    add(new THREE.BoxGeometry(0.05, 0.1, 0.3), wood, 0, 0.0, -0.22);
    add(new THREE.BoxGeometry(0.05, 0.08, 0.36), dark, 0, 0.03, 0.1);
    add(new THREE.CylinderGeometry(0.012, 0.012, 0.36, 8).rotateX(Math.PI / 2), dark, 0, 0.04, 0.45);
    add(new THREE.BoxGeometry(0.04, 0.16, 0.06), dark, 0, -0.08, 0.12, -0.3);
    g.userData.muzzle = new THREE.Vector3(0, 0.04, 0.63);
  }
  return g;
}

const _ray = new THREE.Raycaster();
const _v = new THREE.Vector3();

/** First thing a shot hits: { enemy, part, point, dist } or { wall, point, normal, dist } or null. */
export function hitscan(origin, dir, range, enemies, collider, skip = null) {
  const wall = rayHit(collider, origin, dir, range);
  let maxD = wall ? wall.distance : range;
  let best = null;
  _ray.set(origin, dir); _ray.near = 0; _ray.far = maxD;
  for (const e of enemies) {
    if (!e.alive || e === skip) continue;
    const c = e.lockPoint;
    _v.subVectors(c, origin);
    const t = _v.dot(dir);
    if (t < -2 || t > maxD + 2) continue;
    const d2 = _v.lengthSq() - t * t;
    if (e.kind === 'zombie') {
      if (d2 > 2.2 * 2.2) continue;
      const hits = _ray.intersectObject(e.object, true);
      const h = hits.find((q) => q.object.visible && q.object.isMesh);
      if (h && h.distance < maxD) { maxD = h.distance; best = { enemy: e, part: h.object.parent?.userData?.name, point: h.point.clone(), dist: h.distance }; }
    } else {
      const r = (e.radius || 0.6) + (e.kind === 'boss' ? 1.2 : 0.4);
      if (d2 < r * r && t > 0 && t < maxD) { maxD = t; best = { enemy: e, point: origin.clone().addScaledVector(dir, t), dist: t }; }
    }
  }
  if (best) return best;
  if (wall) return { wall: true, point: wall.point.clone(), normal: wall.face ? wall.face.normal.clone() : new THREE.Vector3(0, 1, 0), dist: wall.distance };
  return null;
}

/** Smoke puffs (normal blending, they drift up and spread). */
export class Smoke {
  constructor(scene, max = 500) {
    this.max = max; this.i = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.life = new Float32Array(max); this.age = new Float32Array(max);
    this.col = new Float32Array(max * 3); this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, vertexColors: true,
      vertexShader: 'attribute float size; varying vec3 vC; varying float vA; void main(){ vC = color; vA = clamp(size, 0.0, 1.0); vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = 420.0*max(size,0.0)/-mv.z; gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'varying vec3 vC; varying float vA; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor = vec4(vC, (1.0-d*2.0)*0.55); }',
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    for (let k = 0; k < max; k++) this.p[k * 3 + 1] = -9999;
    scene.add(this.points);
  }
  puff(pos, n = 1, dark = 0.25, spread = 0.4, up = 1.2, life = 2.2) {
    for (let k = 0; k < n; k++) {
      const i = this.i = (this.i + 1) % this.max;
      this.p[i * 3] = pos.x + rnd(-spread, spread) * 0.3; this.p[i * 3 + 1] = pos.y; this.p[i * 3 + 2] = pos.z + rnd(-spread, spread) * 0.3;
      this.v[i * 3] = rnd(-spread, spread); this.v[i * 3 + 1] = up * rnd(0.5, 1.2); this.v[i * 3 + 2] = rnd(-spread, spread);
      this.life[i] = life * rnd(0.7, 1.2); this.age[i] = 0;
      const c = dark * rnd(0.85, 1.15);
      this.col[i * 3] = c; this.col[i * 3 + 1] = c * 0.97; this.col[i * 3 + 2] = c * 0.94;
    }
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) { this.size[i] = 0; continue; }
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      this.v[i * 3] *= 0.98; this.v[i * 3 + 2] *= 0.98;
      this.size[i] = (0.4 + k * 1.8) * (1 - k * k);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.size.needsUpdate = true; g.attributes.color.needsUpdate = true;
  }
}

/** Bullet tracers (instant hits, the streak is just for show). */
export class Tracers {
  constructor(scene, n = 60) {
    this.list = [];
    const geo = new THREE.CylinderGeometry(0.018, 0.018, 1, 4).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat); m.visible = false; m.frustumCulled = false; scene.add(m);
      this.list.push({ m, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3() });
    }
    this.i = 0;
  }
  add(from, to) {
    const tr = this.list[this.i = (this.i + 1) % this.list.length];
    tr.from.copy(from); tr.to.copy(to); tr.t = 0; tr.m.visible = true;
  }
  update(dt) {
    for (const tr of this.list) {
      if (!tr.m.visible) continue;
      tr.t += dt;
      // a short streak racing from the muzzle to the hit
      const L = tr.from.distanceTo(tr.to);
      const head = Math.min(1, tr.t * 600 / Math.max(L, 1));
      const tail = Math.max(0, head - 6 / Math.max(L, 1));
      const a = tr.from.clone().lerp(tr.to, tail), b = tr.from.clone().lerp(tr.to, head);
      tr.m.position.copy(a); tr.m.lookAt(b); tr.m.scale.set(1, 1, Math.max(0.01, a.distanceTo(b)));
      if (head >= 1 && tr.t > 0.05) tr.m.visible = false;
    }
  }
}

/** Rockets: fly straight, trail smoke, burst on anything. */
export class Rockets {
  constructor(scene, smoke) {
    this.smoke = smoke;
    this.list = [];
    const body = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8).rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4d5440, roughness: 0.5, metalness: 0.5 });
    const fire = new THREE.MeshBasicMaterial({ color: new THREE.Color(12, 6, 1.5) });
    for (let i = 0; i < 24; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(body, mat));
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), fire); f.position.z = -0.45; g.add(f);
      g.visible = false; scene.add(g);
      this.list.push({ g, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0 });
    }
  }
  launch(from, dir, speed = 75) {
    const r = this.list.find((q) => q.life <= 0);
    if (!r) return;
    r.pos.copy(from); r.vel.copy(dir).multiplyScalar(speed); r.life = 4; r.g.visible = true;
  }
  update(dt, enemies, collider, events) {
    for (const r of this.list) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const step = r.vel.length() * dt;
      const dir = r.vel.clone().normalize();
      let boom = null;
      const wall = rayHit(collider, r.pos, dir, step);
      if (wall) boom = wall.point.clone().addScaledVector(dir, -0.3);
      if (!boom) for (const e of enemies) {
        if (e.alive && e.lockPoint.distanceTo(r.pos) < (e.kind === 'boss' ? 3 : 1.6)) { boom = r.pos.clone(); break; }
      }
      r.pos.addScaledVector(r.vel, dt);
      if (!boom && r.pos.y < heightAt(r.pos.x, r.pos.z) + 0.1) boom = r.pos.clone().setY(heightAt(r.pos.x, r.pos.z) + 0.2);
      if (!boom && r.life <= 0) boom = r.pos.clone();
      if (boom) { r.life = 0; r.g.visible = false; events.push({ type: 'explosion', pos: boom, radius: 6.5, dmg: 6 }); continue; }
      r.g.position.copy(r.pos); r.g.lookAt(r.pos.clone().add(dir));
      this.smoke.puff(r.pos, 1, 0.55, 0.15, 0.3, 1.6);
    }
  }
}
