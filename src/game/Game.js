import * as THREE from 'three';
import { Hero } from './Hero.js';
import { Enemy } from './Enemy.js';
import { Zombie, GORE, zombiesReady } from './Zombie.js';
import { Helicopter, GUN_ALTITUDE } from './Helicopter.js';
import { Base } from './Base.js';
import { HollowKing } from './HollowKing.js';
import { TemplePuzzles } from './Puzzles.js';
import { Truck, TRUCK_CAPACITY, REPAIR_COST } from './Truck.js';
import { TRUCK as TRUCK_SPOT, BRIDGE_ENDS, heightAt as groundHeight, WATER, riverZ, roadDist } from '../world/terrain.js';
import { setPushers, gustAt } from '../world/wind.js';
import { CameraRig } from './CameraRig.js';
import { Smoke, Tracers, Rockets, hitscan, GUNS, makeGunMesh } from './Weapons.js';
import { SwordTrail, Sparks, Sfx } from './fx.js';
import { roadX, CAMP, TEMPLE } from '../world/terrain.js';

const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const $ = (s) => document.querySelector(s);

const STORY_INTRO = [
  ['The Sun Bell has been silent for nine winters.', 4.2],
  ['Without its song the valley cooled, and the old temple guard went hollow.', 5.0],
  ['Warden — follow the north road to the temple. Make the Bell ring again.', 5.2],
];

export class Game {
  constructor({ world, camera, input, pipeline }) {
    this.world = world; this.camera = camera; this.input = input; this.pipeline = pipeline;
    this.scene = world.scene;
    this.hero = new Hero();
    this.scene.add(this.hero.object);
    this.rig = new CameraRig(camera);
    this.trail = new SwordTrail(this.scene);
    this.sparks = new Sparks(this.scene);
    this.sfx = new Sfx();
    // the only enemies on the road are the user's zombies (plus the Hollow King in the temple)
    if (zombiesReady()) {
      world.buildZombieSpawns(world.quality.grass < 10000 ? 9 : 14);
      this.zombies = [...world.enemySpawns, ...world.zombieSpawns].map((p) => new Zombie(p, this.scene));
      this.enemies = [...this.zombies];
    } else {
      this.zombies = [];
      this.enemies = world.enemySpawns.map((p) => new Enemy(p, this.scene));
    }
    this.boss = new HollowKing(this.scene);
    this.enemies.push(this.boss);
    this.puzzles = new TemplePuzzles(this);
    // helicopter parked by the camp
    this.heli = new Helicopter(this.scene, world.heliSpawn, world.heliYaw);
    this.inHeli = false;
    const heli0 = this.heli;
    world.interactables.push({ type: 'heli', position: this.heli.pos, radius: 4.2,
      get prompt() { return heli0.disabled ? `Repair the helicopter (${REPAIR_COST.wood} wood, ${REPAIR_COST.stone} stone stored)` : 'Board the helicopter'; } });
    this.bubbles = new Map();
    this.floats = [];
    this.base = new Base(this);
    this.hero.extraCollide = (pos, r, h) => this.base.pushOut(pos, r, h);
    // the abandoned truck in the shed south of camp
    this.truck = new Truck(this.scene, { x: TRUCK_SPOT.x, y: groundHeight(TRUCK_SPOT.x, TRUCK_SPOT.z), z: TRUCK_SPOT.z, yaw: TRUCK_SPOT.yaw });
    this.inTruck = false;
    const truck = this.truck;
    world.interactables.push({
      type: 'truck', position: truck.pos, radius: 3.6,
      get prompt() { return truck.broken ? `Repair the truck (${REPAIR_COST.wood} wood, ${REPAIR_COST.stone} stone stored)` : 'Drive the truck'; },
    });
    this.heroSafe = this.hero.pos.clone();
    // weapons: smoke, tracers, rockets; guns to find on the road
    this.smoke = new Smoke(this.scene);
    this.tracers = new Tracers(this.scene);
    this.rocketSys = new Rockets(this.scene, this.smoke);
    this.heli.smoke = this.smoke; this.heli.rocketSys = this.rocketSys; this.truck.smoke = this.smoke;
    this.gunState = { ak: { ammo: GUNS.ak.mag, reloadT: 0 }, sniper: { ammo: GUNS.sniper.mag, reloadT: 0 } };
    this.gunFireT = 0; this.turretT = 0;
    this.boomLight = new THREE.PointLight(new THREE.Color(1, 0.6, 0.25), 0, 30, 2); this.scene.add(this.boomLight);
    this.flashLight = new THREE.PointLight(new THREE.Color(1, 0.72, 0.35), 0, 12, 2); this.scene.add(this.flashLight);
    this.spawnPickups();
    // footsteps: dust on dry ground, splashes and ripples in the shallows
    this.ripples = [];
    const ringGeo = new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < 16; i++) {
      const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 1.3, 1.35), transparent: true, opacity: 0, depthWrite: false }));
      r.visible = false; this.scene.add(r);
      this.ripples.push({ mesh: r, t: 1 });
    }
    this.hero.onFootstep = (p, speed) => this.footstep(p, speed);
    this.target = null;
    this.events = [];
    this.hitstop = 0;
    this.mode = 'title';           // title | play | paused | dead
    this.flags = { templeSeen: false, firstRest: false, firstKill: false };
    this.objective = '';
    this.checkpoint = { pos: world.camp.spawn.clone(), yaw: world.camp.spawnYaw };
    this.hero.spawn(this.checkpoint.pos, this.checkpoint.yaw);
    this.rig.yaw = this.checkpoint.yaw;
    this.rig.pivot.set(this.hero.pos.x, this.hero.pos.y + 1.55, this.hero.pos.z);
    this.titleT = 0;
    this.subQueue = [];
    this.subT = 0;
    this.hpLag = 1;
    this.ui = {
      hud: $('#hud'), hp: $('.bar.hp .fill'), hpLag: $('.bar.hp .lag'), st: $('.bar.st .fill'), flasks: $('#flasks'),
      objective: $('#objective .text'), prompt: $('#prompt'), promptText: $('#prompt span'), subtitle: $('#subtitle'),
      toast: $('#toast'), reticle: $('#reticle'), death: $('#death'), fade: $('#fade'),
      strip: $('#compass .strip'), mark: $('#compass .mark'), bossBar: $('#boss'), bossFill: $('#boss .fill'),
      bubbles: $('#bubbles'), truckHud: $('#truck'), truckInfo: $('#truck span'), heliHud: $('#heli'), heliAlt: $('#heli .alt'), heliGun: $('#heli .gun'),
    };
    this.buildCompass();
  }

  buildCompass() {
    const labels = ['N', '·', 'NE', '·', 'E', '·', 'SE', '·', 'S', '·', 'SW', '·', 'W', '·', 'NW', '·'];
    let html = '';
    for (let rep = 0; rep < 3; rep++) labels.forEach((l, i) => { html += `<span style="left:${(rep * 16 + i) * 45}px">${l}</span>`; });
    this.ui.strip.innerHTML = html;
  }

  start() {
    this.sfx.init();
    this.mode = 'play';
    this.ui.hud.classList.remove('hidden');
    this.queueSubs(STORY_INTRO);
    this.setObjective('Fortify the camp before the first raid — cut wood, break stone, carry it to the stockpile, build with B');
  }

  setObjective(t) { this.objective = t; this.ui.objective.textContent = t; }
  queueSubs(list) { this.subQueue.push(...list); }
  toast(text, small = false, dur = 2.2) {
    const el = this.ui.toast;
    el.textContent = text; el.classList.toggle('small', small); el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), dur * 1000);
  }

  // ---------------- main update ----------------
  update(dt, t) {
    const input = this.input.poll();
    if (this.mode === 'title') { this.titleCamera(dt); this.input.endFrame(); return; }

    // hit-stop: slow the world briefly on impact
    let gdt = dt;
    if (this.hitstop > 0) { this.hitstop -= dt; gdt = dt * 0.06; }

    const hero = this.hero;
    const events = this.events; events.length = 0;
    if (this.mode === 'play' || this.mode === 'dead' || this.mode === 'resting') {
      if (this.mode !== 'play') { input.pressed.clear(); input.moveX = input.moveY = 0; input.block = false; input.sprint = false; }
      if (this.inTruck) {
        this.target = null;
        const tr = this.truck;
        tr.update(gdt, { throttle: input.moveY, steer: input.moveX, brake: input.up }, this.world.collider, events, (x, z) => this.base.blocked(x, z), (p, r, h) => this.base.pushOut(p, r, h));
        tr.ram(this.enemies, events);
        // the turret follows the camera; fire to shoot
        const aimT = this.aimPoint(400);
        tr.aimTurret(aimT, gdt);
        this.turretT -= gdt;
        if (input.fire && !tr.broken && this.turretT <= 0 && this.mode === 'play') {
          this.turretT = 1 / 9;
          const mz = new THREE.Vector3(); tr.m.turret.muzzle.getWorldPosition(mz);
          const dir = new THREE.Vector3(); tr.m.turret.muzzle.getWorldDirection(dir);
          dir.x += (Math.random() - 0.5) * 0.02; dir.y += (Math.random() - 0.5) * 0.02; dir.z += (Math.random() - 0.5) * 0.02; dir.normalize();
          this.shoot(mz, dir, { dmg: 1.6, sever: 0.55, range: 300 }, events, mz);
          this.sfx.gun(); this.rig.addShake(0.03);
        }
        hero.pos.copy(tr.pos); hero.vel.set(0, 0, 0);
        if (input.pressed.has('exitVehicle') && this.mode === 'play') {
          if (Math.abs(tr.speed) < 3) this.exitTruck(); else this.toast('Slow down to get out', true, 1.2);
        }
        this.heli.update(gdt, { moveX: 0, moveY: 0, up: false, down: false, fire: false, lookYaw: this.heli.yaw }, this.world.collider, this.enemies, events);
      } else if (this.inHeli) {
        this.target = null;
        const heli = this.heli;
        heli.aimPoint.copy(this.heliAim());
        heli.update(gdt, { moveX: input.moveX, moveY: input.moveY, up: input.up, down: input.down, fire: input.fire && this.mode === 'play', lookYaw: this.rig.yaw }, this.world.collider, this.enemies, events);
        // rockets: right mouse / Q / ◎ / R3
        const rmb = !!input.mouseButtons?.has(2);
        if (this.mode === 'play' && ((rmb && !this._rmbPrev) || input.pressed.has('lock'))) {
          if (!heli.fireRocket(events) && heli.rockets <= 0) this.toast('Rockets reloading…', true, 1);
        }
        this._rmbPrev = rmb;
        hero.pos.copy(heli.pos); hero.vel.copy(heli.vel);
        if (input.pressed.has('exitVehicle') && this.mode === 'play') {
          if (heli.agl < 3 && heli.speed < 6) this.exitHeli();
          else this.toast('Land first to get out', true, 1.4);
        }
      } else {
        if (input.pressed.has('build') && this.mode === 'play') this.base.toggleBuild();
        if (this.base.building) {
          this.base.updateBuild(dt, input, hero, this.rig.yaw);
          for (const k of ['attack', 'heal', 'lock', 'switch', 'switchNext', 'switchPrev']) input.pressed.delete(k);
        }
        this.handleLock(input);
        hero.softTarget = this.softTarget(input);
        // guns: G cycles sword -> AK-47 -> sniper rifle
        if (input.pressed.has('weapon') && this.mode === 'play') this.cycleWeapon();
        const gunFireHeld = input.fire, gunFirePressed = input.pressed.has('attack');
        if (hero.gun) {
          input.pressed.delete('attack');
          const cd = new THREE.Vector3(); this.camera.getWorldDirection(cd);
          hero.aimPitch = Math.asin(THREE.MathUtils.clamp(cd.y, -0.95, 0.95));
          if (this.target) this.target = null;
        }
        const wasState = hero.state;
        hero.update(gdt, input, this.rig.yaw, this.target, this.world.collider, events);
        if (hero.state === 'roll' && wasState !== 'roll') this.sfx.roll();
        this.combat(gdt, events);
        if (hero.gun) this.updateGun(gdt, gunFireHeld, gunFirePressed, events);
        this.heli.update(gdt, { moveX: 0, moveY: 0, up: false, down: false, fire: false, lookYaw: this.heli.yaw }, this.world.collider, this.enemies, events);
        // don't walk through the parked helicopter or truck
        const dx = hero.pos.x - this.heli.pos.x, dz = hero.pos.z - this.heli.pos.z, d = Math.hypot(dx, dz);
        if (d < 2.3 && d > 1e-3 && Math.abs(hero.pos.y - this.heli.pos.y) < 3) { hero.pos.x += dx / d * (2.3 - d); hero.pos.z += dz / d * (2.3 - d); }
        this.truck.update(gdt, { throttle: 0, steer: 0, brake: true }, this.world.collider, events, (x, z) => this.base.blocked(x, z), null);
        {
          const tr = this.truck, s = Math.sin(tr.yaw), c = Math.cos(tr.yaw);
          const lx = (hero.pos.x - tr.pos.x) * c - (hero.pos.z - tr.pos.z) * s, lz = (hero.pos.x - tr.pos.x) * s + (hero.pos.z - tr.pos.z) * c;
          if (Math.abs(lx) < 1.5 && Math.abs(lz) < 3.3 && hero.pos.y < tr.pos.y + 2.2) {
            const px = 1.5 - Math.abs(lx), pz = 3.3 - Math.abs(lz);
            const nlx = px < pz ? Math.sign(lx) * 1.5 : lx, nlz = px < pz ? lz : Math.sign(lz) * 3.3;
            hero.pos.x = tr.pos.x + nlx * c + nlz * s; hero.pos.z = tr.pos.z - nlx * s + nlz * c;
          }
          // load the backpack into the truck bed when you walk up to it
          if (!tr.broken && this.base.carriedTotal > 0 && Math.hypot(hero.pos.x - tr.pos.x, hero.pos.z - tr.pos.z) < 3.9 && tr.cargoTotal < TRUCK_CAPACITY) {
            const room = TRUCK_CAPACITY - tr.cargoTotal;
            const w = Math.min(this.base.carried.wood, room), st = Math.min(this.base.carried.stone, room - w);
            tr.cargo.wood += w; tr.cargo.stone += st; this.base.carried.wood -= w; this.base.carried.stone -= st;
            this.floatText(`Loaded ${w ? w + ' wood ' : ''}${st ? st + ' stone' : ''}`, tr.pos.clone().setY(tr.pos.y + 2));
            this.sfx.place();
          }
        }
        // the river is too deep to wade
        if (this.base.blocked(hero.pos.x, hero.pos.z)) {
          const safe = this.base.blocked(this.heroSafe.x, this.heroSafe.z) ? new THREE.Vector3(BRIDGE_ENDS.a.x, 0, BRIDGE_ENDS.a.z) : this.heroSafe;
          hero.pos.x = safe.x; hero.pos.z = safe.z; hero.pos.y = Math.max(hero.pos.y, groundHeight(safe.x, safe.z)); hero.vel.set(0, 0, 0);
          if (!this._wadeT || performance.now() - this._wadeT > 2500) { this._wadeT = performance.now(); this.toast('Too deep to wade — the river needs a bridge', true, 1.8); }
        } else this.heroSafe.copy(hero.pos);
      }
      this.sfx.setRotor(this.heli.spool);
      this.sfx.setEngine(this.inTruck, Math.min(1, Math.abs(this.truck.speed) / 21));
      // the truck unloads itself at the stockpile
      if (this.truck.cargoTotal > 0 && this.truck.pos.distanceTo(this.base.stockpile) < 9) {
        const c = this.truck.cargo;
        this.base.stored.wood += c.wood; this.base.stored.stone += c.stone;
        this.toast(`Unloaded ${c.wood} wood, ${c.stone} stone at the stockpile`, true, 2);
        c.wood = c.stone = 0;
        this.sfx.place();
      }
      this.base.preEnemies();
      for (const e of [...this.enemies]) e.update(gdt, hero, this.enemies, this.world.collider, events);
      this.base.postEnemies(gdt, events);
      // nobody walks through the truck or the helicopter
      for (const e of this.enemies) if (e.alive && e.kind !== 'boss') this.pushOutOfVehicles(e.pos, e.radius || 0.45);
      GORE.update(gdt);
      this.rocketSys.update(gdt, this.enemies, this.world.collider, events);
      this.smoke.update(gdt);
      this.tracers.update(gdt);
      this.boomLight.intensity = Math.max(0, this.boomLight.intensity - gdt * 900);
      this.flashLight.intensity = Math.max(0, this.flashLight.intensity - gdt * 900);
      if (this.pickupMeshes) for (const gm of this.pickupMeshes) { gm.rotation.y += gdt * 0.8; gm.position.y = 0.75 + Math.sin(performance.now() * 0.003) * 0.08; }
      this.handleEvents(events);
      if (!this.inHeli && !this.inTruck) this.interactions(input); else this.ui.prompt.classList.add('hidden');
      this.story();
    }
    if (this.inTruck) this.rig.updateTruck(dt, input, this.truck, this.world.collider);
    else if (this.inHeli) this.rig.updateHeli(dt, input, this.heli, this.world.collider);
    else this.rig.update(dt, input, hero, this.target, this.world.collider);
    this.updateBubbles(dt);
    this.updateRipples(dt);
    if (this.mode !== 'title') this.puzzles.update(dt, hero);
    if (this.flags.ended) {
      this.endT += dt;
      const b = this.world.temple.bell;
      b.rotation.x = Math.sin(this.endT * 2.4) * 0.35 * Math.exp(-this.endT * 0.04);
      b.material.emissiveIntensity = 0.4 + 0.4 * Math.max(0, Math.sin(this.endT * 2.4));
      // the temple doors swing open
      const o = Math.min(1, this.endT / 6) * 1.35;
      this.world.temple.doors.forEach((d, i) => { d.rotation.y = (i === 0 ? -1 : 1) * o; });
    }
    {
      const B = this.boss, show = B.awake || (B.state === 'dead' && B.stateT < 3);
      this.ui.bossBar.classList.toggle('hidden', !show);
      document.body.classList.toggle('bossfight', show);
      if (show) this.ui.bossFill.style.transform = `scaleX(${Math.max(0, B.hp / B.maxHP)})`;
    }
    // grass and trees part around the warden, the truck and the helicopter's downwash
    {
      const P = [];
      if (!this.inHeli && !this.inTruck) P.push({ x: hero.pos.x, z: hero.pos.z, r: 0.95, s: 1 });
      const tr = this.truck;
      if (Math.abs(tr.speed) > 0.5 || this.inTruck) P.push({ x: tr.pos.x, z: tr.pos.z, r: 2.8, s: 1.2 });
      const h = this.heli;
      if (h.spool > 0.3 && h.agl < 28) P.push({ x: h.pos.x, z: h.pos.z, r: 5 + (28 - h.agl) * 0.45, s: h.spool * Math.min(1, (28 - h.agl) / 18) * 2.4 });
      setPushers(P);
      // wind you can hear
      const g = gustAt(this.camera.position.x, this.camera.position.z);
      this.sfx.setWind(g);
      // wading leaves ripples
      if (!this.inHeli && !this.inTruck && hero.speed > 0.5 && this.waterDepthAt(hero.pos.x, hero.pos.z) > 0.05 && Math.random() < dt * 4) this.ripple(hero.pos, 0.5);
      // the head follows the camera when standing still
      hero.lookTarget = angDiff(hero.yaw, this.rig.yaw);
    }
    this.trail.update(hero.model.bladeBase, hero.model.bladeTip, hero.state === 'attack' && hero.stateT / hero.attack.dur > hero.attack.hit[0] - 0.08 && hero.stateT / hero.attack.dur < hero.attack.hit[1] + 0.05, dt);
    this.sparks.update(gdt);
    this.world.updateSun(hero.pos);

    // depth of field focus on hero / target
    const focusPt = this.inTruck ? this.truck.pos.clone().setY(this.truck.pos.y + 1.5) : this.inHeli ? this.heli.pos.clone().setY(this.heli.pos.y + 2) : this.target ? this.target.lockPoint.lerp(hero.centre, 0.5) : hero.centre;
    const fd = this.camera.position.distanceTo(focusPt);
    this.pipeline.focus = THREE.MathUtils.lerp(this.pipeline.focus, fd, 1 - Math.exp(-8 * dt));
    this.pipeline.params.hurt = Math.max(0, this.pipeline.params.hurt - dt * 1.5);
    this.updateHUD(dt);
    this.updateSubs(dt);
    this.input.endFrame();
  }

  titleCamera(dt) {
    this.titleT += dt;
    const c = CAMP;
    const a = -0.5 + this.titleT * 0.03;
    const pos = new THREE.Vector3(c.x + Math.sin(a) * 8, c.y + 2.6, c.z + Math.cos(a) * 8);
    this.camera.position.copy(pos);
    const look = new THREE.Vector3(c.x, c.y + 1.2, c.z).lerp(new THREE.Vector3(TEMPLE.x, TEMPLE.y + 20, TEMPLE.z), 0.0);
    this.camera.lookAt(look);
    this.pipeline.focus = pos.distanceTo(look);
    this.world.updateSun(new THREE.Vector3(c.x, c.y, c.z));
    this.sparks.update(dt);
    this.trail.update(this.hero.model.bladeBase, this.hero.model.bladeTip, false, dt);
    this.hero.animate(dt);
  }

  // ---------------- guns, explosions ----------------
  /** Where the crosshair points (first enemy or surface along the camera ray). */
  aimPoint(range = 400) {
    const cam = this.camera, o = cam.position.clone(), dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const h = hitscan(o, dir, range, this.enemies, this.world.collider);
    return h ? h.point : o.addScaledVector(dir, range);
  }

  /** One bullet: hit test, tracer, wounds. */
  shoot(origin, dir, opts, events, tracerFrom) {
    const h = hitscan(origin, dir, opts.range || 300, this.enemies, this.world.collider);
    const end = h ? h.point : origin.clone().addScaledVector(dir, opts.range || 300);
    this.tracers.add(tracerFrom || origin, end);
    this.flashLight.position.copy(tracerFrom || origin); this.flashLight.intensity = 45;
    if (!h) return null;
    if (h.enemy) {
      const e = h.enemy;
      const from = h.point.clone().addScaledVector(dir, -3);
      if (e.kind === 'zombie') {
        const head = h.part === 'head';
        e.takeHit(opts.dmg * (head ? 2 : 1), from, events, { part: h.part || 'torso', sever: head ? Math.min(1, opts.sever * 1.4) : opts.sever });
      } else {
        e.takeHit(opts.dmg, from, events);
        this.sparks.burst(h.point, 8, new THREE.Color(6, 2.6, 0.8), 4, 1);
      }
      this.ui.crosshairHit = 0.15;
      this.hitstop = Math.max(this.hitstop, h.part === 'head' ? 0.05 : 0.03);   // a tiny freeze sells the hit
    } else {
      this.sparks.burst(h.point.clone().addScaledVector(dir, -0.05), 4, new THREE.Color(3, 2.4, 1.4), 3, 1);
      this.smoke.puff(h.point, 1, 0.5, 0.2, 0.4, 0.8);
    }
    return h;
  }

  cycleWeapon() {
    const hero = this.hero;
    const order = [null, 'ak', 'sniper'].filter((k) => k === null || hero.guns.has(k));
    if (order.length < 2) { this.toast('No guns yet — find one along the road', true, 1.6); return; }
    const next = order[(order.indexOf(hero.gun) + 1) % order.length];
    hero.equip(next);
    this.sfx.reload();
    this.toast(next ? GUNS[next].name : 'Sword and shield', true, 1.2);
  }

  updateGun(dt, fireHeld, firePressed, events) {
    const hero = this.hero, kind = hero.gun, G = GUNS[kind], st = this.gunState[kind];
    this.gunFireT -= dt;
    if (st.reloading) {
      st.reloadT -= dt;
      if (st.reloadT <= 0) { st.reloading = false; st.ammo = G.mag; }
      return;
    }
    if (st.ammo <= 0) { st.reloading = true; st.reloadT = G.reload; this.sfx.reload(); return; }
    const want = G.semi ? firePressed : fireHeld;
    if (!want || this.gunFireT > 0 || hero.state !== 'move' || this.mode !== 'play') return;
    this.gunFireT = 1 / G.rate;
    st.ammo--;
    const cam = this.camera, dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    const spread = G.spread * (hero.aiming ? 0.35 : 1) * (hero.speed > 1 ? 1.8 : 1);
    dir.x += (Math.random() - 0.5) * spread * 2; dir.y += (Math.random() - 0.5) * spread * 2; dir.z += (Math.random() - 0.5) * spread * 2; dir.normalize();
    // start the ray at the hero, not behind the camera (walls behind the warden don't block the shot)
    const t0 = Math.max(0, hero.centre.clone().sub(cam.position).dot(dir) - 0.3);
    const origin = cam.position.clone().addScaledVector(dir, t0);
    const mesh = hero.gunMeshes[kind];
    const muzzle = mesh.userData.muzzle.clone(); mesh.localToWorld(muzzle);
    this.shoot(origin, dir, G, events, muzzle);
    this.sparks.burst(muzzle, 4, new THREE.Color(9, 5, 1.8), 2.5, 0.3);
    hero.recoil = 1;
    this.rig.addShake(G.kick);
    this.rig.pitch = (this.rig.pitch || 0) - G.kick * 0.06;
    if (kind === 'sniper') this.sfx.rifle(); else this.sfx.gun();
  }

  /** Rockets: fire, smoke, flying zombie parts, a dent in anything close. */
  explode(pos, radius, dmg, events) {
    this.sfx.boom(); this.sfx.crash();
    this.sparks.burst(pos, 90, new THREE.Color(9, 4, 1.2), 9, 4);
    this.smoke.puff(pos, 26, 0.12, 2.2, 2.0, 3.2);
    this.boomLight.position.copy(pos).y += 1.5; this.boomLight.intensity = 600;
    GORE.splat(pos.x, groundHeight(pos.x, pos.z), pos.z, 1.6);
    const dh = pos.distanceTo(this.hero.pos);
    this.rig.addShake(Math.max(0.1, 1 - dh / 60), this.hero.pos.clone().sub(pos));
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.lockPoint.distanceTo(pos);
      if (d > radius) continue;
      const k = 1 - d / radius;
      if (e.kind === 'zombie') e.takeHit(d < radius * 0.6 ? 99 : 2.5, pos, events, { sever: 1 });
      else e.takeHit(dmg * k * 2, pos, events);
    }
    if (!this.inHeli && !this.inTruck && dh < radius) this.hero.takeHit(40 * (1 - dh / radius), pos, events, { unblockable: true, knock: 1 });
    const dt2 = pos.distanceTo(this.truck.pos); if (dt2 < radius + 2) this.truck.damage(22 * (1 - dt2 / (radius + 2)), events);
    const dhe = pos.distanceTo(this.heli.pos); if (dhe < radius + 2 && this.heli.agl < 6) this.heli.damage(15 * (1 - dhe / (radius + 2)), events);
  }

  /** Push a body (feet at pos) out of the truck's box and the helicopter's cabin. */
  pushOutOfVehicles(pos, r) {
    const tr = this.truck, s = Math.sin(tr.yaw), c = Math.cos(tr.yaw);
    const hw = tr.m.halfW + r, hl = tr.m.halfL + r;
    const lx = (pos.x - tr.pos.x) * c - (pos.z - tr.pos.z) * s, lz = (pos.x - tr.pos.x) * s + (pos.z - tr.pos.z) * c;
    if (Math.abs(lx) < hw && Math.abs(lz) < hl && pos.y < tr.pos.y + 2.2) {
      const px = hw - Math.abs(lx), pz = hl - Math.abs(lz);
      const nlx = px < pz ? Math.sign(lx) * hw : lx, nlz = px < pz ? lz : Math.sign(lz) * hl;
      pos.x = tr.pos.x + nlx * c + nlz * s; pos.z = tr.pos.z - nlx * s + nlz * c;
    }
    const h = this.heli, dx = pos.x - h.pos.x, dz = pos.z - h.pos.z, d = Math.hypot(dx, dz), R = 1.9 + r;
    if (d < R && d > 1e-3 && Math.abs(pos.y - h.pos.y) < 3) { pos.x += dx / d * (R - d); pos.z += dz / d * (R - d); }
  }

  /** The AK-47 on a crate at camp, the sniper rifle up the road. */
  spawnPickups() {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x5b4a2e, roughness: 0.8 });
    const spots = [
      { kind: 'ak', x: CAMP.x + 6, z: CAMP.z - 7 },
      { kind: 'sniper', x: roadX(-62) + 5, z: -62 },
    ];
    for (const sp of spots) {
      const y = groundHeight(sp.x, sp.z);
      const g = new THREE.Group(); g.position.set(sp.x, y, sp.z);
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 0.6), crateMat); crate.position.y = 0.25; crate.castShadow = crate.receiveShadow = true; g.add(crate);
      const gun = makeGunMesh(sp.kind); gun.position.set(0, 0.6, -0.1); gun.rotation.set(0, Math.PI / 2, Math.PI / 2 - 0.1); g.add(gun);
      const glow = new THREE.PointLight(new THREE.Color(1, 0.8, 0.4), 4, 4, 2); glow.position.y = 1; g.add(glow);
      this.scene.add(g);
      (this.pickupMeshes ||= []).push(gun);
      const it = { type: 'pickup', position: g.position.clone(), radius: 2.2, prompt: `Pick up the ${GUNS[sp.kind].name}` };
      it.onUse = () => {
        this.hero.guns.add(sp.kind); this.hero.equip(sp.kind);
        this.scene.remove(g);
        this.world.interactables.splice(this.world.interactables.indexOf(it), 1);
        this.sfx.reload();
        this.toast(GUNS[sp.kind].name, false, 2);
        this.queueSubs([[sp.kind === 'ak' ? 'An AK-47. Left mouse fires, hold right mouse to aim, G switches back to the sword.' : 'A sniper rifle. Hold right mouse to look through the scope. One shot takes a limb — or a head.', 5]]);
      };
      this.world.interactables.push(it);
    }
  }

  // ---------------- helicopter ----------------
  /** Where the screen centre points: first enemy along the ray (generous radius), else the world. */
  heliAim() {
    const cam = this.camera;
    const o = cam.position.clone();
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir);
    let best = null, bestT = 600;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const c = e.lockPoint;
      const v = c.clone().sub(o);
      const t = v.dot(dir);
      if (t < 0 || t > bestT) continue;
      const d = Math.sqrt(Math.max(0, v.lengthSq() - t * t));
      if (d < 1.2 + t * 0.012) { best = c; bestT = t; }
    }
    if (best) return best.clone().setY(best.y - 0.25);
    const ray = new THREE.Ray(o, dir);
    const hit = this.world.collider.boundsTree.raycastFirst(ray, THREE.DoubleSide);
    return hit && hit.distance < 600 ? hit.point.clone() : o.addScaledVector(dir, 400);
  }

  enterTruck() {
    const hero = this.hero;
    this.inTruck = true; this.target = null;
    hero.state = 'pilot'; hero.stateT = 0; hero.object.visible = false;
    this.truck.driven = true;
    this.rig.yaw = this.truck.yaw; this.rig.pitch = 0.3; this.rig.curDist = 8.5;
    this.ui.truckHud.classList.remove('hidden');
    if (!this.flags.truckHelp) { this.flags.truckHelp = true; this.queueSubs([['W/S drive · A/D steer · Space brake · E to get out. Faster is better for running things over.', 5]]); }
  }

  exitTruck() {
    const hero = this.hero, tr = this.truck;
    this.inTruck = false; tr.driven = false;
    const side = new THREE.Vector3(-Math.cos(tr.yaw), 0, Math.sin(tr.yaw));
    let p = tr.pos.clone().addScaledVector(side, 2.3);
    if (this.base.blocked(p.x, p.z)) p = tr.pos.clone().addScaledVector(side, -2.3);
    hero.pos.set(p.x, Math.max(tr.pos.y, groundHeight(p.x, p.z)) + 0.6, p.z);
    hero.vel.set(0, 0, 0); hero.state = 'move'; hero.stateT = 0; hero.yaw = tr.yaw; hero.object.visible = true;
    hero.model.cloak.reset();
    this.rig.dist = 4.6; this.rig.curDist = 4.6;
    this.ui.truckHud.classList.add('hidden');
  }

  enterHeli() {
    const hero = this.hero;
    this.inHeli = true;
    this.target = null;
    hero.state = 'pilot'; hero.stateT = 0;
    hero.object.visible = false;
    this.heli.piloted = true;
    this.rig.yaw = this.heli.yaw; this.rig.pitch = 0.25;
    this.ui.heliHud.classList.remove('hidden');
    this.ui.prompt.classList.add('hidden');
    if (!this.flags.heliHelp) {
      this.flags.heliHelp = true;
      this.queueSubs([['Mouse steers · WASD fly · Space climb · Shift descend · hold LMB to fire (below 15 m) · E to land and get out', 6]]);
    }
  }

  exitHeli() {
    const hero = this.hero, heli = this.heli;
    this.inHeli = false;
    heli.piloted = false;
    const side = new THREE.Vector3(-Math.cos(heli.yaw), 0, Math.sin(heli.yaw));
    hero.pos.copy(heli.pos).addScaledVector(side, 2.8);
    hero.pos.y += 1.0;
    hero.vel.set(0, 0, 0);
    hero.state = 'move'; hero.stateT = 0;
    hero.yaw = heli.yaw;
    hero.object.visible = true;
    hero.model.cloak.reset();
    this.rig.dist = 4.6; this.rig.curDist = 4.6;
    this.ui.heliHud.classList.add('hidden');
  }

  // ---------------- speech bubbles ----------------
  say(enemy, text, quiet = false) {
    let b = this.bubbles.get(enemy);
    if (!b) { const el = document.createElement('div'); el.className = 'bubble'; this.ui.bubbles.appendChild(el); b = { el, t: 0 }; this.bubbles.set(enemy, b); }
    b.el.textContent = text;
    b.t = Math.min(4.5, 1.6 + text.length * 0.045);
    b.el.classList.add('show');
    if (!quiet) this.sfx.blah();
  }

  waterDepthAt(x, z) {
    if (Math.abs(z - riverZ(x)) > 12) return 0;
    return WATER - groundHeight(x, z);
  }

  ripple(p, size = 1) {
    const r = this.ripples.find((q) => q.t >= 1) || this.ripples[0];
    r.t = 0; r.size = size;
    r.mesh.position.set(p.x, WATER + 0.02, p.z);
    r.mesh.visible = true;
  }

  footstep(p, speed) {
    const depth = this.waterDepthAt(p.x, p.z);
    if (depth > 0.02) {
      this.sparks.burst(new THREE.Vector3(p.x, WATER + 0.05, p.z), 10 + speed * 2, new THREE.Color(1.4, 1.6, 1.8), 1.8 + speed * 0.3, 2.2);
      this.ripple(p, 0.6 + speed * 0.12);
      this.sfx.splash();
    } else {
      const dusty = roadDist(p.x, p.z) < 4.5 || Math.hypot(p.x - this.base.hearth.pos.x, p.z - this.base.hearth.pos.z) < 8;
      if (dusty && speed > 3) this.sparks.burst(new THREE.Vector3(p.x, p.y + 0.05, p.z), 4, new THREE.Color(0.45, 0.38, 0.28), 0.8, 0.6);
      this.sfx.step(speed, dusty);
    }
  }

  updateRipples(dt) {
    for (const r of this.ripples) {
      if (r.t >= 1) continue;
      r.t = Math.min(1, r.t + dt / 1.4);
      const s = (0.2 + r.t * 1.6) * r.size;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = (1 - r.t) * 0.45;
      if (r.t >= 1) r.mesh.visible = false;
    }
  }

  floatText(text, pos) {
    const el = document.createElement('div');
    el.className = 'float'; el.textContent = text;
    this.ui.bubbles.appendChild(el);
    this.floats.push({ el, pos: pos.clone(), t: 0 });
  }

  updateBubbles(dt) {
    for (const f of [...this.floats]) {
      f.t += dt;
      if (f.t > 1.2) { f.el.remove(); this.floats.splice(this.floats.indexOf(f), 1); continue; }
      const p = f.pos.clone(); p.y += f.t * 1.2;
      p.project(this.camera);
      f.el.style.opacity = String(1 - f.t / 1.2);
      f.el.style.transform = `translate(-50%, -50%) translate(${(p.x * 0.5 + 0.5) * innerWidth}px, ${(-p.y * 0.5 + 0.5) * innerHeight}px)`;
    }
    for (const [e, b] of this.bubbles) {
      b.t -= dt;
      if (b.t <= 0 || !e.object.visible) { b.el.classList.remove('show'); continue; }
      const p = e.lockPoint; p.y += 1.0;
      const dist = p.distanceTo(this.camera.position);
      p.project(this.camera);
      const vis = p.z < 1 && dist < 45;
      b.el.classList.toggle('show', vis);
      b.el.style.transform = `translate(-50%, -100%) translate(${(p.x * 0.5 + 0.5) * innerWidth}px, ${(-p.y * 0.5 + 0.5) * innerHeight}px)`;
    }
  }

  // ---------------- lock-on ----------------
  handleLock(input) {
    const hero = this.hero;
    const p = input.pressed;
    if (this.target && (!this.target.alive || this.target.pos.distanceTo(hero.pos) > 28)) {
      const was = this.target;
      this.target = null;
      if (!was.alive) this.target = this.pickTarget(12);
    }
    if (p.has('lock')) {
      if (this.target) this.target = null;
      else {
        this.target = this.pickTarget(22);
        if (!this.target) this.rig.yaw = hero.yaw; // recentre camera like the classics
      }
    }
    if (this.target && (p.has('switch') || p.has('switchNext') || p.has('switchPrev'))) {
      const dirSign = p.has('switchPrev') ? -1 : 1;
      const camYaw = this.rig.yaw;
      const curA = angDiff(camYaw, Math.atan2(this.target.pos.x - hero.pos.x, this.target.pos.z - hero.pos.z));
      let best = null, bestD = Infinity;
      for (const e of this.enemies) {
        if (!e.alive || e === this.target || e.pos.distanceTo(hero.pos) > 22) continue;
        const a = angDiff(camYaw, Math.atan2(e.pos.x - hero.pos.x, e.pos.z - hero.pos.z));
        let d = (curA - a) * dirSign; // positive = to the right
        if (d <= 0) d += Math.PI * 2;
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) this.target = best;
    }
  }

  /** Nearest enemy roughly where the player is pushing / facing, for attack magnetism. */
  softTarget(input) {
    const hero = this.hero;
    let dirYaw = hero.yaw;
    if (Math.hypot(input.moveX, input.moveY) > 0.3) {
      const f = this.rig.yaw;
      dirYaw = Math.atan2(Math.sin(f) * input.moveY - Math.cos(f) * input.moveX, Math.cos(f) * input.moveY + Math.sin(f) * input.moveX);
    }
    let best = null, bestS = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - hero.pos.x, e.pos.z - hero.pos.z);
      if (d > 4.5) continue;
      const a = Math.abs(angDiff(dirYaw, Math.atan2(e.pos.x - hero.pos.x, e.pos.z - hero.pos.z)));
      if (a > 1.0) continue;
      const sc = d + a * 2;
      if (sc < bestS) { bestS = sc; best = e; }
    }
    return best;
  }

  pickTarget(range) {
    const hero = this.hero;
    let best = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(hero.pos);
      if (d > range) continue;
      const a = Math.abs(angDiff(this.rig.yaw, Math.atan2(e.pos.x - hero.pos.x, e.pos.z - hero.pos.z)));
      if (a > 1.5 && d > 5) continue;
      const s = d + a * 6;
      if (s < bestScore) { bestScore = s; best = e; }
    }
    return best;
  }

  // ---------------- combat ----------------
  combat(dt, events) {
    const hero = this.hero;
    if (hero.state === 'attack') {
      const a = hero.attack;
      const t = hero.stateT / a.dur;
      if (!hero.swingSoundPlayed && t > a.hit[0] - 0.05) { hero.swingSoundPlayed = true; this.sfx.swing(); }
    }
    if (!hero.isAttackActive()) return;
    if (!hero.attackHits.has('puzzle') && this.puzzles.trySwing(hero)) hero.attackHits.add('puzzle');
    if (!hero.attackHits.has('harvest') && this.base.tryHarvest(hero, events)) hero.attackHits.add('harvest');
    const a = hero.attack;
    for (const e of this.enemies) {
      if (!e.alive || hero.attackHits.has(e)) continue;
      const dx = e.pos.x - hero.pos.x, dz = e.pos.z - hero.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.55 + e.radius || Math.abs(e.pos.y - hero.pos.y) > 1.8) continue;
      const ang = Math.abs(angDiff(hero.yaw, Math.atan2(dx, dz)));
      if (ang > (hero.attackIndex === 2 ? 0.9 : 1.5) && d > 0.9) continue;
      hero.attackHits.add(e);
      e.takeHit(a.dmg, hero.pos, events);
      const p = e.lockPoint; p.y -= 0.1;
      if (e.kind === 'zombie') { /* blood comes from the zombie itself */ }
      else this.sparks.burst(p, 26, new THREE.Color(6, 2.6, 0.8), 6, 1.5);
      this.hitstop = hero.attackIndex === 2 ? 0.11 : 0.065;
      this.rig.addShake(hero.attackIndex === 2 ? 0.45 : 0.28);
      this.sfx.hit();
    }
  }

  handleEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'hurt': this.sfx.hurt(); this.rig.addShake(0.5, ev.dir); this.pipeline.params.hurt = 0.55; this.hitstop = 0.05; break;
        case 'block': this.sfx.block(); this.rig.addShake(0.2); this.sparks.burst(this.hero.centre.clone().add(new THREE.Vector3(Math.sin(this.hero.yaw) * 0.5, 0, Math.cos(this.hero.yaw) * 0.5)), 18, new THREE.Color(5, 4, 2.5), 4, 1); break;
        case 'guardbreak': this.sfx.hurt(); this.toast('Guard broken', true, 1.2); this.rig.addShake(0.5); break;
        case 'dodge': break;
        case 'windup': this.sfx.enemyWind(); break;
        case 'sparks': this.sparks.burst(ev.pos, ev.n, new THREE.Color(...ev.color), ev.speed || 4, 1.5); break;
        case 'robot-hit': break;
        case 'boss-wake':
          this.sfx.bossRoar(); this.rig.addShake(0.5);
          this.toast('The Hollow King', false, 3.2);
          if (!this.flags.bossSeen) { this.flags.bossSeen = true; this.queueSubs([['He stole the clapper of the Sun Bell and made it his mace. Take it back.', 4.5]]); }
          this.setObjective('Defeat the Hollow King and reclaim the Sun Bell\'s clapper');
          break;
        case 'boss-windup': if (ev.attack === 'toll') this.sfx.bell(); else this.sfx.enemyWind(); break;
        case 'boss-slam': this.sfx.boom(); this.sfx.crash(); this.rig.addShake(0.75); this.sparks.burst(ev.pos.clone().setY(ev.pos.y + 0.3), 70, new THREE.Color(6, 2.4, 0.6), 7, 3); break;
        case 'boss-toll': this.sfx.bell(); this.rig.addShake(0.4); break;
        case 'boss-hit': this.sfx.clank(); break;
        case 'boss-stagger': this.sfx.crash(); this.toast('Staggered — strike!', true, 1.4); break;
        case 'boss-phase2': this.sfx.bossRoar(); this.rig.addShake(0.6); this.queueSubs([['The embers inside him burn brighter. The Hollow King will not fall quietly.', 4]]); break;
        case 'boss-leash': this.setObjective('Defeat the Hollow King and reclaim the Sun Bell\'s clapper'); break;
        case 'say': this.say(ev.enemy, ev.text); break;
        case 'heli-shot': this.sfx.gun(); this.rig.addShake(0.04); break;
        case 'heli-hit': if (ev.enemy.kind === 'zombie') break; this.sparks.burst(ev.pos, 10, new THREE.Color(6, 2.6, 0.8), 5, 1); break;
        case 'heli-impact': break;
        case 'truck-hit': this.sfx.hit(); this.rig.addShake(0.3); break;
        case 'truck-crash': this.sfx.crash(); this.rig.addShake(0.45); break;
        case 'truck-bump': this.sfx.clank(); this.rig.addShake(0.2); break;
        case 'truck-water': if (!this._twT || performance.now() - this._twT > 2500) { this._twT = performance.now(); this.toast('Too deep — the truck needs the bridge', true, 1.6); } break;
        case 'heli-too-high': this.toast(`Too high — drop below ${GUN_ALTITUDE} m to fire`, true, 1.4); break;
        case 'kill': {
          if (ev.boss) { this.sfx.kill(); this.sfx.bossRoar(); this.sparks.burst(ev.enemy.lockPoint, 120, new THREE.Color(7, 2.6, 0.6), 6, 4); this.target = null; setTimeout(() => this.ending(), 3200); break; }
          if (ev.zombie) {
            this.sfx.gore();
            if (!this.flags.zombieKill) { this.flags.zombieKill = true; this.queueSubs([['The dead walk the valley since the Bell fell silent. Cut them apart — it is the only thing that stops them.', 5]]); }
            break;
          }
          this.sfx.kill();
          this.sparks.burst(ev.enemy.lockPoint, 60, new THREE.Color(5, 1.8, 0.4), 3.5, 3);
          if (!this.flags.firstKill) { this.flags.firstKill = true; this.queueSubs([['The husk crumbles to ash. A faint warmth lingers where it stood.', 4]]); }
          break;
        }
        case 'sever': this.sfx.gore(); this.rig.addShake(0.15); this.hitstop = Math.max(this.hitstop, 0.04); break;
        case 'explosion': this.explode(ev.pos, ev.radius, ev.dmg, events); break;
        case 'rocket-launch': this.sfx.whoosh(); this.rig.addShake(0.12); this.smoke.puff(ev.pos, 6, 0.6, 0.8, 0.5, 1.4); break;
        case 'truck-wrecked': this.toast('The truck is wrecked — get out and repair it', true, 2.6); this.sfx.crash(); break;
        case 'heli-wrecked': this.toast('Engine failure! The helicopter needs repairs', true, 2.8); this.sfx.shutdown?.(); break;
        case 'heli-damage': this.rig.addShake(0.25); break;
        case 'zombie-groan': if (ev.enemy.pos.distanceTo(this.hero.pos) < (ev.quiet ? 12 : 20)) this.sfx.groan(ev.quiet ? 0.08 : 0.18); break;
        case 'zombie-bite': break;
        case 'zombie-say': {
          const d = ev.enemy.pos.distanceTo(this.hero.pos);
          if (d > 26) break;
          this.say(ev.enemy, ev.text, true);
          this.sfx.speak(ev.text, ev.female, 1.1 - d / 26);
          break;
        }
        case 'healed': this.sfx.heal(); this.sparks.burst(this.hero.centre, 30, new THREE.Color(4, 3, 1.2), 1.5, 2); break;
        case 'death': this.onDeath(); break;
      }
    }
  }

  // ---------------- interactions & story ----------------
  interactions(input) {
    const hero = this.hero;
    let near = null;
    for (const it of this.world.interactables) {
      if (it.position.distanceTo(hero.pos) < it.radius + 0.5 && Math.abs(it.position.y - hero.pos.y) < 2.5) { near = it; break; }
    }
    const canAct = near && hero.state === 'move' && this.mode === 'play';
    this.ui.prompt.classList.toggle('hidden', !canAct);
    if (canAct) {
      this.ui.prompt.querySelector('kbd').textContent = this.input.lastDevice === 'pad' ? 'A' : this.input.lastDevice === 'touch' ? 'Use' : 'E';
      this.ui.promptText.textContent = near.prompt;
    }
    if (canAct && input.pressed.has('interact')) this.interact(near);
  }

  interact(it) {
    if (it.onUse) { it.onUse(); return; }
    this.sfx.ui();
    if (it.type === 'rest') this.rest();
    if (it.type === 'heli') {
      if (this.heli.disabled) {
        const s = this.base.stored;
        if (s.wood >= REPAIR_COST.wood && s.stone >= REPAIR_COST.stone) { s.wood -= REPAIR_COST.wood; s.stone -= REPAIR_COST.stone; this.heli.repair(); this.sfx.place(); this.toast('The helicopter is patched up', false, 2.2); }
        else this.toast(`Repairs need ${REPAIR_COST.wood} wood and ${REPAIR_COST.stone} stone stored at camp`, true, 2.4);
      } else { this.base.toggleBuild(false); this.enterHeli(); }
    }
    if (it.type === 'stockpile') this.base.deposit();
    if (it.type === 'bridgeSite') { this.base.toggleBuild(true); this.base.setType('bridge'); }
    if (it.type === 'truck') {
      const tr = this.truck;
      if (tr.broken) {
        const s = this.base.stored;
        if (s.wood >= REPAIR_COST.wood && s.stone >= REPAIR_COST.stone) {
          s.wood -= REPAIR_COST.wood; s.stone -= REPAIR_COST.stone;
          tr.repair(); this.sfx.place(); this.toast('The old truck coughs back to life!', false, 2.4);
          this.queueSubs([['Drive it to the woods. Walk up to the truck to load your backpack — it unloads itself at the stockpile.', 5]]);
        } else this.toast(`Repairs need ${REPAIR_COST.wood} wood and ${REPAIR_COST.stone} stone stored at camp`, true, 2.4);
      } else { this.base.toggleBuild(false); this.enterTruck(); }
    }
    if (it.type === 'drum') { if (this.base.raid.active) this.toast('The raid is already here!', true, 1.4); else this.base.startRaid(); }
    if (it.type === 'door') {
      this.queueSubs([
        ['Three sockets ring the seal, each carved like a small sun. They are cold to the touch.', 4.5],
        ['Somewhere in this temple, the sun-marks must be rekindled.', 4],
      ]);
      const n = this.puzzles.solved.filter(Boolean).length;
      if (n < 3) this.setObjective(`Rekindle the three sun-marks on the temple platform (${n}/3)`);
    }
  }

  /** The Sun Bell rings: warmth returns, the hollow fall still, the valley brightens. */
  ending() {
    if (this.flags.ended) return;
    this.flags.ended = true;
    const temple = this.world.temple;
    this.toast('The Sun Bell rings', false, 5);
    this.setObjective('The valley is warm again. Free roam — build, explore, hold the fort.');
    let n = 0;
    const toll = () => { this.sfx.bell(); this.rig.addShake(0.25); if (++n < 4) setTimeout(toll, 2600); };
    toll();
    this.queueSubs([
      ['The clapper strikes bronze, and for the first time in nine winters the Sun Bell sings.', 5],
      ['Its warmth rolls down the valley. One by one, the hollow lie down and are still.', 5],
      ['Warden — the valley is yours to keep.', 4],
    ]);
    this.endT = 0;
    for (const e of this.enemies) if (e.alive && e.kind !== 'boss') setTimeout(() => e.alive && e.takeHit(99, e.pos.clone().setY(e.pos.y + 1), this.events), 1500 + Math.random() * 5000);
    temple.sockets.forEach((s) => { s.material = s.material.clone(); s.material.emissiveIntensity = 6; });
    temple.bell.material.emissiveIntensity = 0.6;
    this.world.sun.intensity *= 1.15;
    this.pipeline.params.exposureBias = 0.2;
  }

  rest() {
    const hero = this.hero;
    if (this.base.raid.active) { this.toast('No rest during a raid!', true, 1.6); return; }
    this.base.toggleBuild(false);
    this.mode = 'resting';
    this.target = null;
    hero.state = 'rest'; hero.stateT = 0;
    hero.yaw = Math.atan2(CAMP.x - hero.pos.x, CAMP.z - hero.pos.z);
    this.ui.fade.style.opacity = 0.85;
    setTimeout(() => {
      hero.hp = hero.maxHP; hero.flasks = hero.maxFlasks; hero.stamina = hero.maxStamina;
      for (const e of this.enemies) e.reset();
      this.checkpoint = { pos: hero.pos.clone().setY(hero.pos.y + 0.2), yaw: hero.yaw };
      this.ui.fade.style.opacity = 0;
      this.toast('Rested · The dead have risen again', true, 2.5);
      if (!this.flags.firstRest) { this.flags.firstRest = true; this.queueSubs([['The fire is warm. For a moment, the valley feels as it did when the Bell still rang.', 4.5]]); }
      setTimeout(() => { hero.state = 'move'; hero.stateT = 0; this.mode = 'play'; }, 900);
    }, 1400);
  }

  onDeath() {
    this.mode = 'dead';
    this.base.toggleBuild(false);
    this.target = null;
    setTimeout(() => this.ui.death.classList.remove('hidden'), 900);
    setTimeout(() => { this.ui.fade.style.opacity = 1; }, 2800);
    setTimeout(() => {
      this.ui.death.classList.add('hidden');
      this.hero.spawn(this.checkpoint.pos, this.checkpoint.yaw);
      this.rig.yaw = this.checkpoint.yaw;
      this.base.reset();
      for (const e of this.enemies) e.reset();
      this.base.carried.wood = this.base.carried.stone = 0;
      this.mode = 'play';
      this.ui.fade.style.opacity = 0;
    }, 4300);
  }

  story() {
    const hero = this.hero;
    if (!this.flags.templeSeen && hero.pos.z < TEMPLE.z + 70) {
      this.flags.templeSeen = true;
      if (this.flags.bossSeen) return;
      this.toast('Temple of the Sun Bell', false, 3.5);
      this.queueSubs([['High above, the great Bell hangs dark and silent in its tower.', 4.5]]);
      this.setObjective('Rekindle the three sun-marks on the temple platform (0/3)');
    }
  }

  updateSubs(dt) {
    const el = this.ui.subtitle;
    if (this.curSub) {
      this.subT -= dt;
      if (this.subT <= 0) { this.curSub = null; el.classList.remove('show'); this.subGap = 0.6; }
    } else if (this.subQueue.length && this.mode === 'play') {
      this.subGap = (this.subGap || 0) - dt;
      if (this.subGap <= 0) {
        const [text, dur] = this.subQueue.shift();
        this.curSub = text; this.subT = dur; el.textContent = text; el.classList.add('show');
      }
    }
  }

  // ---------------- HUD ----------------
  updateHUD(dt) {
    const h = this.hero, ui = this.ui;
    this.base.updateHUD();
    const hp = Math.max(0, h.hp / h.maxHP);
    ui.hp.style.transform = `scaleX(${hp})`;
    ui.hpLag.style.transform = `scaleX(${hp})`;
    ui.st.style.transform = `scaleX(${Math.max(0, h.stamina / h.maxStamina)})`;
    const fl = `${'<i></i>'.repeat(h.flasks)}${'<i class="empty"></i>'.repeat(h.maxFlasks - h.flasks)}`;
    if (fl !== this._fl) { ui.flasks.innerHTML = fl; this._fl = fl; }

    // compass: heading = camera yaw. 0 yaw looks +Z = south. North = -Z.
    const heading = (Math.PI - this.rig.yaw); // 0 = north, increases clockwise (east)
    const pxPerRad = 16 * 45 / (Math.PI * 2);
    const centre = 170;
    const off = ((heading / (Math.PI * 2)) % 1 + 1) % 1;
    ui.strip.style.left = `${centre - (16 + off * 16) * 45}px`;
    const toTemple = Math.atan2(TEMPLE.x - h.pos.x, TEMPLE.z - h.pos.z);
    const rel = angDiff(this.rig.yaw, toTemple);
    ui.mark.style.left = `${centre - rel * pxPerRad}px`;
    ui.mark.style.opacity = Math.abs(rel) < 1.9 ? 1 : 0;

    if (this.inTruck) {
      const tr = this.truck;
      this.ui.truckInfo.textContent = `${Math.abs(tr.speed * 3.6).toFixed(0)} km/h · body ${Math.ceil(tr.hp)}% · LMB turret · cargo ${tr.cargoTotal}/${TRUCK_CAPACITY} (${tr.cargo.wood} wood, ${tr.cargo.stone} stone)`;
    }
    if (this.inHeli) {
      const h = this.heli;
      this.ui.heliAlt.textContent = `ALT ${h.agl.toFixed(0)} m · ${(h.speed * 3.6).toFixed(0)} km/h · hull ${Math.ceil(h.hp)}% · rockets ${h.rockets} (RMB/Q)`;
      const ready = h.gunsReady;
      this.ui.heliGun.textContent = h.spool < 0.85 ? 'Spooling up…' : ready ? 'GUNS LIVE' : `Fly below ${GUN_ALTITUDE} m to fire`;
      this.ui.heliGun.className = `gun ${ready ? 'live' : ''}`;
    }
    // crosshair, scope and ammo for the guns
    const gun = !this.inHeli && !this.inTruck && this.hero.gun;
    const G = gun && GUNS[gun], st = gun && this.gunState[gun];
    const scoped = gun === 'sniper' && this.hero.aiming;
    $('#crosshair').classList.toggle('hidden', !gun || scoped);
    this.ui.crosshairHit = Math.max(0, (this.ui.crosshairHit || 0) - 1 / 60);
    $('#crosshair').classList.toggle('hit', this.ui.crosshairHit > 0);
    // vignette tightens and pulses when badly hurt
    { const low = 1 - Math.min(1, this.hero.hp / 35); this.pipeline.params.vignette = 0.45 + low * (0.35 + 0.15 * Math.sin(performance.now() * 0.006)); }
    $('#scope').classList.toggle('hidden', !scoped);
    const ammoEl = $('#ammo');
    ammoEl.classList.toggle('hidden', !gun);
    if (gun) ammoEl.innerHTML = `<small>${G.name} · G switch · RMB aim</small>${st.reloading ? 'Reloading…' : `${st.ammo} / ${G.mag}`}`;
    this.rig.zoomFov = gun && this.hero.aiming ? G.zoom : null;
    // reticle
    if (this.target) {
      const p = this.target.lockPoint.project(this.camera);
      const vis = p.z < 1;
      ui.reticle.classList.toggle('hidden', !vis);
      ui.reticle.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`;
      ui.reticle.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`;
    } else ui.reticle.classList.add('hidden');
  }
}
