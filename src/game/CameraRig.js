import * as THREE from 'three';
import { rayHit } from './physics.js';

const damp = (a, b, k, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

/** Third-person orbit camera with lock-on framing, collision and trauma shake. */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;          // yaw of camera "forward" (0 = looking towards +Z)
    this.pitch = 0.18;     // positive = looking down
    this.dist = 4.6;
    this.curDist = 4.6;
    this.pivot = new THREE.Vector3();
    this.trauma = 0;
    this.lookAt = new THREE.Vector3();
    this.fov = 55;
    this.cinematic = null; // { from, to, t, dur, look }
  }

  addShake(a) { this.trauma = Math.min(1, this.trauma + a); }

  update(dt, input, hero, target, collider) {
    const cam = this.camera;
    // free look
    if (!target) {
      this.yaw -= input.lookX;
      this.pitch += input.lookY;
    } else {
      // frame hero and target
      const lp = target.lockPoint;
      const want = Math.atan2(lp.x - hero.pos.x, lp.z - hero.pos.z);
      this.yaw += angDiff(this.yaw, want) * (1 - Math.exp(-7 * dt));
      const d = Math.hypot(lp.x - hero.pos.x, lp.z - hero.pos.z);
      const wantPitch = 0.22 + Math.atan2(hero.pos.y + 1.4 - lp.y, Math.max(d, 1)) * 0.6;
      this.pitch = damp(this.pitch, wantPitch, 4, dt);
      this.yaw -= input.lookX * 0.15;
    }
    this.pitch = THREE.MathUtils.clamp(this.pitch, -0.6, 1.2);

    // pivot follows hero smoothly (faster vertically when falling)
    const targetPivot = new THREE.Vector3(hero.pos.x, hero.pos.y + 1.55, hero.pos.z);
    if (hero.state === 'roll') targetPivot.y -= 0.25;
    this.pivot.x = damp(this.pivot.x, targetPivot.x, 14, dt);
    this.pivot.z = damp(this.pivot.z, targetPivot.z, 14, dt);
    this.pivot.y = damp(this.pivot.y, targetPivot.y, 9, dt);

    const wantDist = target ? 5.3 : (hero.sprinting ? 5.0 : this.dist);
    const back = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    // shoulder offset
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const pivot = this.pivot.clone().addScaledVector(right, 0.42);
    // collision
    const hit = rayHit(collider, pivot, back, wantDist + 0.3);
    let d = wantDist;
    if (hit) d = Math.max(0.6, hit.distance - 0.3);
    this.curDist = d < this.curDist ? d : damp(this.curDist, d, 4, dt);
    const pos = pivot.clone().addScaledVector(back, this.curDist);

    // shake
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const s = this.trauma * this.trauma;
    const t = performance.now() * 0.001;
    cam.position.copy(pos);
    let look = pivot.clone();
    if (target) look.lerp(target.lockPoint, 0.35);
    this.lookAt.lerp(look, 1 - Math.exp(-18 * dt));
    if (this.lookAt.distanceToSquared(look) > 25) this.lookAt.copy(look);
    cam.lookAt(this.lookAt);
    cam.rotateZ(Math.sin(t * 37) * 0.02 * s);
    cam.rotateX(Math.sin(t * 41 + 1) * 0.015 * s);
    cam.rotateY(Math.sin(t * 29 + 2) * 0.015 * s);

    const wantFov = hero.sprinting ? 60 : 55;
    this.fov = damp(this.fov, wantFov, 4, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  /** Chase camera for the helicopter; the screen centre is the gun's aim. */
  updateHeli(dt, input, heli, collider) {
    const cam = this.camera;
    this.yaw -= input.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.lookY, -0.45, 1.25);
    const target = new THREE.Vector3(heli.pos.x, heli.pos.y + 5.5, heli.pos.z);
    this.pivot.x = damp(this.pivot.x, target.x, 10, dt);
    this.pivot.y = damp(this.pivot.y, target.y, 10, dt);
    this.pivot.z = damp(this.pivot.z, target.z, 10, dt);
    const back = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const want = 15 + heli.speed * 0.12;
    const hit = rayHit(collider, this.pivot, back, want + 0.5);
    const d = hit ? Math.max(2, hit.distance - 0.5) : want;
    this.curDist = d < this.curDist ? d : damp(this.curDist, d, 3, dt);
    cam.position.copy(this.pivot).addScaledVector(back, this.curDist);
    const look = this.pivot.clone().addScaledVector(back, -30);
    this.lookAt.copy(look);
    cam.lookAt(look);
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const s = this.trauma * this.trauma, t = performance.now() * 0.001;
    cam.rotateZ(Math.sin(t * 37) * 0.02 * s);
    cam.rotateX(Math.sin(t * 41 + 1) * 0.015 * s);
    this.fov = damp(this.fov, 62 + heli.speed * 0.25, 3, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  /** Chase camera for the truck: free orbit with the mouse, drifts back behind the truck while driving. */
  updateTruck(dt, input, truck, collider) {
    const cam = this.camera;
    const looking = Math.abs(input.lookX) + Math.abs(input.lookY) > 0.0005;
    this.yaw -= input.lookX;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.lookY, -0.2, 1.1);
    this.idleLook = looking ? 0 : (this.idleLook || 0) + dt;
    if (this.idleLook > 1.2 && Math.abs(truck.speed) > 2) {
      const behind = truck.speed >= 0 ? truck.yaw : truck.yaw + Math.PI;
      let d = (behind - this.yaw) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * (1 - Math.exp(-2.5 * dt));
      this.pitch = damp(this.pitch, 0.28, 2, dt);
    }
    const target = new THREE.Vector3(truck.pos.x, truck.pos.y + 2.4, truck.pos.z);
    this.pivot.lerp(target, 1 - Math.exp(-12 * dt));
    const back = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const want = 8.5 + Math.abs(truck.speed) * 0.12;
    const hit = rayHit(collider, this.pivot, back, want + 0.4);
    const d = hit ? Math.max(1.5, hit.distance - 0.4) : want;
    this.curDist = d < this.curDist ? d : damp(this.curDist, d, 3, dt);
    cam.position.copy(this.pivot).addScaledVector(back, this.curDist);
    const look = this.pivot.clone().addScaledVector(back, -6);
    this.lookAt.copy(look);
    cam.lookAt(look);
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const s = this.trauma * this.trauma, t = performance.now() * 0.001;
    cam.rotateZ(Math.sin(t * 37) * 0.02 * s);
    this.fov = damp(this.fov, 58 + Math.abs(truck.speed) * 0.4, 3, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  /** Cinematic: orbit around a point (used for intro and the temple reveal). */
  updateCinematic(dt, c) {
    c.t += dt;
    const k = Math.min(1, c.t / c.dur);
    const e = k * k * (3 - 2 * k);
    this.camera.position.lerpVectors(c.from, c.to, e);
    this.camera.lookAt(new THREE.Vector3().lerpVectors(c.lookFrom || c.look, c.look, e));
    return k >= 1;
  }
}
