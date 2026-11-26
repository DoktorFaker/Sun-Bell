import * as THREE from 'three';
import { heightAt } from './terrain.js';
import { gustAt, WIND } from './wind.js';

/**
 * Autumn leaves shaken loose by the wind: they spiral down, drift with gusts,
 * settle on the ground for a while, then recycle near the camera.
 */
export class FallingLeaves {
  constructor(scene, sources, count = 260) {
    this.sources = sources;          // array of Vector3 (broadleaf tree positions)
    this.count = count;
    const geo = new THREE.PlaneGeometry(0.11, 0.08);
    geo.translate(0.03, 0, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.p = [];
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      c.setHSL(0.04 + Math.random() * 0.09, 0.8, 0.35 + Math.random() * 0.2);
      this.mesh.setColorAt(i, c);
      this.p.push({ pos: new THREE.Vector3(0, -999, 0), vel: new THREE.Vector3(), axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), ang: Math.random() * 6, spin: 2 + Math.random() * 5, rest: Math.random() * 6, landed: true, phase: Math.random() * 10 });
    }
    scene.add(this.mesh);
    this.near = [];
    this.nearT = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(1, 1, 1);
  }

  update(dt, cam) {
    this.nearT -= dt;
    if (this.nearT <= 0) {
      this.nearT = 1.5;
      this.near = this.sources.filter((s) => Math.abs(s.x - cam.x) < 45 && Math.abs(s.z - cam.z) < 45);
    }
    const wd = WIND.uWindDir.value;
    const m = this._m, q = this._q;
    for (let i = 0; i < this.count; i++) {
      const L = this.p[i];
      if (L.landed) {
        L.rest -= dt;
        if (L.rest <= 0 && this.near.length) {
          const t = this.near[(Math.random() * this.near.length) | 0];
          const g = gustAt(t.x, t.z);
          if (Math.random() < 0.25 + g) {
            L.pos.set(t.x + (Math.random() - 0.5) * 4, t.y + 4 + Math.random() * 3.5, t.z + (Math.random() - 0.5) * 4);
            L.vel.set(0, 0, 0); L.landed = false;
          } else L.rest = 0.5;
        }
      } else {
        const g = gustAt(L.pos.x, L.pos.z);
        L.phase += dt;
        const flutter = Math.sin(L.phase * 3.3) * 0.9;
        const tx = wd.x * g * 3.2 + Math.cos(L.phase * 2.1) * 0.5, tz = wd.y * g * 3.2 + Math.sin(L.phase * 1.7) * 0.5;
        const ty = -0.75 + flutter * 0.35;
        L.vel.x += (tx - L.vel.x) * Math.min(1, dt * 2); L.vel.y += (ty - L.vel.y) * Math.min(1, dt * 3); L.vel.z += (tz - L.vel.z) * Math.min(1, dt * 2);
        L.pos.addScaledVector(L.vel, dt);
        L.ang += L.spin * dt * (0.6 + g);
        const gy = heightAt(L.pos.x, L.pos.z) + 0.02;
        if (L.pos.y <= gy) { L.pos.y = gy; L.landed = true; L.rest = 4 + Math.random() * 6; L.ang = Math.random() * 6; L.axis.set(0, 1, 0); }
        if (Math.abs(L.pos.x - cam.x) > 70 || Math.abs(L.pos.z - cam.z) > 70) { L.landed = true; L.rest = 0; L.pos.y = -999; }
      }
      if (L.landed && L.rest > 0 && L.pos.y > -900) {
        q.setFromEuler(new THREE.Euler(-Math.PI / 2, L.ang, 0));
      } else q.setFromAxisAngle(L.axis, L.ang);
      m.compose(L.pos, q, this._s);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
