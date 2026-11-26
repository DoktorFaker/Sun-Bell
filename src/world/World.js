import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { heightAt, roadX, roadY, roadDist, slopeAt, fbm, rng, CAMP, TEMPLE, HELIPAD, ROAD_START, ROAD_END, riverZ, WATER, BRIDGE, TRUCK } from './terrain.js';
import { M, makeMaterials, makeSky, windTime } from './materials.js';
import { generateTextures, TEX } from './textures.js';
import { updateWind, gustAt, WIND } from './wind.js';
import { FallingLeaves } from './leaves.js';
import { BRANCH, pineFoliage, leafFoliage, crossedCards } from './trees.js';
import { buildCamp } from './camp.js';
import { buildTemple } from './temple.js';

export const SUN_DIR = new THREE.Vector3(-0.8, 0.3, 0.3).normalize();
export const SUN_COLOR = new THREE.Color(1.0, 0.80, 0.58);

/** Collects world-space geometry for the BVH collider. */
export class ColliderBuilder {
  constructor() { this.parts = []; }
  add(geometry, matrix) {
    let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.morphAttributes = {};
    if (matrix) g.applyMatrix4(matrix);
    this.parts.push(g);
  }
  addMesh(mesh) {
    mesh.updateWorldMatrix(true, false);
    this.add(mesh.geometry, mesh.matrixWorld);
  }
  build() {
    const merged = mergeGeometries(this.parts, false);
    const g = mergeVertices(merged, 1e-3);
    g.boundsTree = new MeshBVH(g, { targetLeafSize: 12 });
    this.parts.forEach((p) => p.dispose());
    return g;
  }
}

export class World {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.interactables = [];
    this.lights = [];
    this.flames = [];
    this.enemySpawns = [];
    this.zombieSpawns = [];
    this.harvest = [];
    this.leafSources = [];
    if (!TEX.grass) generateTextures(quality.renderScale < 0.8 ? 256 : 512);
    makeMaterials();
    const cb = new ColliderBuilder();
    this.cb = cb;

    this.buildLighting();
    this.buildTerrain(cb);
    this.buildRocks(cb);
    this.buildTrees(cb);
    this.buildWaystones(cb);
    this.buildRiver();
    this.buildShed(cb);
    const camp = buildCamp(this, cb);
    this.camp = camp;
    const temple = buildTemple(this, cb);
    this.temple = temple;
    this.setGrass(quality.grass);
    this.buildPlants(quality);
    this.leaves = new FallingLeaves(this.scene, this.leafSources, quality.renderScale < 0.8 ? 120 : 280);

    this.collider = cb.build();
    this.colliderMesh = new THREE.Mesh(this.collider, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x00ff88 }));
    this.colliderMesh.visible = false;
    this.scene.add(this.colliderMesh);

    // a few more of the dead on the temple approach
    for (const [dx, dz] of [[6, 36], [-5, 40]]) {
      const x = TEMPLE.x + dx, z = TEMPLE.z + dz;
      this.enemySpawns.push(new THREE.Vector3(x, heightAt(x, z), z));
    }
    // Helicopter parked beside the camp
    {
      const x = HELIPAD.x, z = HELIPAD.z;
      this.heliSpawn = new THREE.Vector3(x, heightAt(x, z), z);
      this.heliYaw = Math.PI;
    }

    {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.4, 0.25, 32), M.stone);
      pad.position.copy(this.heliSpawn).setY(this.heliSpawn.y - 0.08);
      pad.receiveShadow = true;
      this.scene.add(pad);
      const paint = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.8 });
      for (const [w, d, x] of [[0.5, 4, -1.1], [0.5, 4, 1.1], [2.2, 0.5, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), paint);
        m.position.set(this.heliSpawn.x + x, this.heliSpawn.y + 0.06, this.heliSpawn.z);
        m.receiveShadow = true;
        this.scene.add(m);
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(4.3, 4.6, 40).rotateX(-Math.PI / 2), paint);
      ring.position.copy(this.heliSpawn).setY(this.heliSpawn.y + 0.06);
      this.scene.add(ring);
    }

    // Enemy spawn points along the road
    for (const [z, off] of [[24, 2], [-44, -2], [-104, 3], [-114, -3], [-178, 0], [-214, 3], [-222, -3]]) {
      this.enemySpawns.push(new THREE.Vector3(roadX(z) + off, heightAt(roadX(z) + off, z), z));
    }
  }

  /** Shambling packs in the woods along the road. */
  buildZombieSpawns(n) {
    const packs = [[34, 15], [-8, -16], [-58, 16], [-92, -15], [-136, 14], [-168, -16], [-205, 15]];
    let left = n;
    for (const [z, off] of packs) {
      const k = Math.min(left, z > 0 ? 2 : 3);
      for (let i = 0; i < k; i++) {
        const x = roadX(z) + off + (Math.random() - 0.5) * 5, zz = z + (Math.random() - 0.5) * 5;
        this.zombieSpawns.push(new THREE.Vector3(x, heightAt(x, zz), zz));
      }
      left -= k; if (left <= 0) break;
    }
  }

  buildLighting() {
    const s = this.scene;
    this.sky = makeSky(SUN_DIR);
    s.add(this.sky);

    // Image-based light from the sky
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(makeSky(SUN_DIR));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(800, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.10, 0.09, 0.06) }));
    ground.position.y = -8;
    envScene.add(ground);
    this.envRT = pm.fromScene(envScene, 0.02, 1, 2000);
    s.environment = this.envRT.texture;
    s.environmentIntensity = 0.22;
    pm.dispose();

    const hemi = new THREE.HemisphereLight(new THREE.Color(0.55, 0.62, 0.8), new THREE.Color(0.28, 0.22, 0.14), 0.25);
    s.add(hemi);

    const sun = new THREE.DirectionalLight(SUN_COLOR, 4.2);
    sun.castShadow = true;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    s.add(sun, sun.target);
    this.sun = sun;
    this.sunInfo = { light: sun, dir: SUN_DIR, color: SUN_COLOR };
    this.applyShadowQuality(this.quality);
  }

  applyShadowQuality(q) {
    const sun = this.sun;
    sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const r = q.shadowRange;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 320 });
    sun.shadow.camera.updateProjectionMatrix();
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    this.shadowRange = r;
    if (this.trees) for (const t of this.trees) t.castShadow = q.treeShadows;
  }

  /** Keep the sun shadow frustum centred on the hero, snapped to texels to avoid shimmer. */
  updateSun(focus) {
    const sun = this.sun;
    const size = this.shadowRange * 2 / sun.shadow.mapSize.x;
    // Build light-space basis
    const z = SUN_DIR.clone();
    const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
    const y = z.clone().cross(x);
    const px = Math.round(focus.dot(x) / size) * size;
    const py = Math.round(focus.dot(y) / size) * size;
    const pz = focus.dot(z);
    const c = x.multiplyScalar(px).add(y.multiplyScalar(py)).add(z.multiplyScalar(pz));
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(SUN_DIR, 160);
    sun.target.updateMatrixWorld();
  }

  buildTerrain(cb) {
    const W = 620, D = 660, SX = 280, SZ = 300;
    const geo = new THREE.PlaneGeometry(W, D, SX, SZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -105);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, heightAt(x, z));
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    const spl = new Float32Array(pos.count * 4);
    const S = THREE.MathUtils.smoothstep;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const ny = nrm.getY(i);
      const n = fbm(x * 0.05, z * 0.05, 3), n2 = fbm(x * 0.13 + 7, z * 0.13, 2);
      // layer weights: grass, dirt, rock, sand
      const d = roadDist(x, z);
      const dc = Math.hypot(x - CAMP.x, z - CAMP.z);
      const dt = Math.hypot(x - TEMPLE.x, (z - TEMPLE.z) * 0.85);
      let dirt = Math.max(1 - S(d, 2.6, 4.4), (1 - S(dc, 3, 7.5)) * 0.9, (1 - S(dt, 28, 44)) * 0.7, S(n2, 0.66, 0.8) * 0.6);
      let rock = Math.max(1 - S(ny, 0.6, 0.82), S(y, 40, 75) * 0.7, (1 - S(dt, 22, 30)) * 0.4);
      const dr = Math.abs(z - riverZ(x));
      let sand = (1 - S(dr, 6.5, 10.5)) * (1 - S(y, WATER + 1.2, WATER + 2.2));
      let grass = Math.max(0, 1 - dirt - rock - sand) + 0.02;
      spl.set([grass, dirt, rock * (1 - sand), sand], i * 4);
      // macro tint: drier, warmer grass up the valley sides, lusher patches below
      const dry = S(y, 18, 60) * 0.7 + S(n, 0.55, 0.8) * 0.3;
      const tr = 0.92 + dry * 0.18 + (n - 0.5) * 0.1, tg = 1.0 - dry * 0.02 + (n - 0.5) * 0.12, tb = 0.95 - dry * 0.18;
      col[i * 3] = tr; col[i * 3 + 1] = tg; col[i * 3 + 2] = tb;
    }
    geo.setAttribute('aSplat', new THREE.BufferAttribute(spl, 4));
    M.terrain.userData.uniforms.uWater.value = WATER;
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, M.terrain);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.terrain = mesh;
    cb.add(geo);
  }

  buildRoad() {
    // A crisp dirt ribbon draped over the terrain
    const verts = [], cols = [], idx = [];
    const step = 1.2, half = 3.0, across = 6;
    let rows = 0;
    const c = new THREE.Color();
    for (let z = ROAD_START + 2; z >= ROAD_END - 1; z -= step) {
      const x0 = roadX(z);
      const dx = roadX(z - 0.5) - roadX(z + 0.5);
      const tl = Math.hypot(1, dx);
      for (let j = 0; j <= across; j++) {
        const u = j / across * 2 - 1;
        const x = x0 + u * half / tl;
        const zz = z + u * half * dx / tl;
        const y = heightAt(x, zz) + 0.04;
        verts.push(x, y, zz);
        const edge = Math.abs(u);
        const n = fbm(x * 0.4, zz * 0.4, 2);
        c.setRGB(0.40, 0.31, 0.20).multiplyScalar(0.8 + 0.4 * n);
        if (Math.abs(u) < 0.25 || Math.abs(Math.abs(u) - 0.55) < 0.12) c.multiplyScalar(0.85); // wheel ruts
        c.lerp(new THREE.Color(0.33, 0.35, 0.15), Math.pow(edge, 3) * 0.75);
        cols.push(c.r, c.g, c.b);
      }
      rows++;
    }
    const per = across + 1;
    for (let r = 0; r < rows - 1; r++) for (let j = 0; j < across; j++) {
      const a = r * per + j, b = a + 1, c2 = a + per, d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, M.road);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildRocks(cb) {
    const R = rng(7);
    const base = new THREE.IcosahedronGeometry(1, 3);
    const p = base.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const n = fbm(v.x * 1.7 + 4, v.y * 1.7 + v.z * 1.3, 3);
      v.multiplyScalar(0.75 + n * 0.55);
      v.y *= 0.7;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    base.computeVertexNormals();
    const count = 340;
    const inst = new THREE.InstancedMesh(base, M.rock, count);
    inst.castShadow = true; inst.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
    let n = 0;
    for (let tries = 0; tries < 4000 && n < count; tries++) {
      const z = THREE.MathUtils.lerp(150, -360, R());
      const x = roadX(z) + (R() - 0.5) * 220;
      const d = roadDist(x, z);
      if (d < 5.5) continue;
      if (Math.hypot(x - CAMP.x, z - CAMP.z) < 9) continue;
      if (Math.hypot(x - HELIPAD.x, z - HELIPAD.z) < 10) continue;
      if (Math.abs(z - riverZ(x)) < 11 || Math.hypot(x - TRUCK.x, z - TRUCK.z) < 10) continue;
      if (Math.hypot(x - TEMPLE.x, z - TEMPLE.z) < 36) continue;
      const big = R() < 0.15;
      const sc = big ? 2.5 + R() * 4 : 0.4 + R() * 1.4;
      if (d < 9 && sc > 1.2) continue;
      t.set(x, heightAt(x, z) - sc * 0.25, z);
      q.setFromEuler(new THREE.Euler(R() * 0.4, R() * Math.PI * 2, R() * 0.4));
      s.set(sc * (0.8 + R() * 0.5), sc * (0.7 + R() * 0.6), sc * (0.8 + R() * 0.5));
      m.compose(t, q, s);
      this.harvest.push({ kind: 'rock', mesh: inst, idx: n, pos: t.clone(), size: sc, matrix: m.clone(), left: Math.round(4 + sc * 3) });
      inst.setMatrixAt(n++, m);
      if (sc > 0.7) cb.add(base, m);
    }
    inst.count = n;
    inst.computeBoundingSphere();
    this.scene.add(inst);
  }

  buildTrees(cb) {
    const R = rng(21);
    // --- pine
    const pineTrunkH = BRANCH.pine ? 10.5 : 5;
    const trunk = new THREE.CylinderGeometry(0.1, 0.34, pineTrunkH, 8).translate(0, pineTrunkH / 2, 0);
    const cones = [];
    for (let i = 0; i < 4; i++) {
      const r = 2.3 - i * 0.48, h = 3.2 - i * 0.35;
      const cg = new THREE.ConeGeometry(r, h, 7).translate(0, 3.2 + i * 1.55 + h / 2, 0);
      const cc = new Float32Array(cg.attributes.position.count * 3);
      for (let k = 0; k < cg.attributes.position.count; k++) {
        const yy = cg.attributes.position.getY(k);
        const sh = 0.55 + 0.45 * THREE.MathUtils.smoothstep(yy, 3, 10);
        cc[k * 3] = 0.11 * sh; cc[k * 3 + 1] = 0.20 * sh; cc[k * 3 + 2] = 0.10 * sh;
      }
      cg.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      cones.push(cg.toNonIndexed());
    }
    const cards = !!(BRANCH.pine && BRANCH.leaf);
    let pineFol = mergeGeometries(cones.map((g) => { g.deleteAttribute('uv'); return g; }));
    pineFol.computeVertexNormals();
    if (cards) pineFol = pineFoliage(5);
    // --- broadleaf (autumn)
    const blobs = [];
    const bR = rng(3);
    for (let i = 0; i < 5; i++) {
      const g = new THREE.IcosahedronGeometry(1.4 + bR() * 0.8, 0);
      g.translate((bR() - 0.5) * 2.2, 4.6 + bR() * 2.2, (bR() - 0.5) * 2.2);
      g.deleteAttribute('uv');
      const cc = new Float32Array(g.attributes.position.count * 3);
      for (let k = 0; k < cc.length; k += 3) { cc[k] = 0.62; cc[k + 1] = 0.36; cc[k + 2] = 0.08; }
      g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      blobs.push(g);
    }
    let leafFol = mergeGeometries(blobs);
    leafFol.computeVertexNormals();
    if (cards) leafFol = leafFoliage(9);
    const trunk2 = new THREE.CylinderGeometry(0.12, 0.3, 5.6, 8).translate(0, 2.8, 0);

    const P = 900, L = 260;
    const make = (geo, mat, n) => { const im = new THREE.InstancedMesh(geo, mat, n); im.castShadow = true; im.receiveShadow = true; return im; };
    const pineT = make(trunk, M.bark, P), pineF = make(pineFol, M.pine, P);
    const leafT = make(trunk2, M.bark, L), leafF = make(leafFol, M.leaf, L);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
    const col = new THREE.Color();
    let np = 0, nl = 0;
    const colliderTrunk = new THREE.CylinderGeometry(0.35, 0.4, 4, 6).translate(0, 2, 0);
    for (let tries = 0; tries < 9000 && (np < P || nl < L); tries++) {
      const z = THREE.MathUtils.lerp(170, -380, R());
      const x = roadX(z) + (R() - 0.5) * 260;
      const d = roadDist(x, z);
      if (d < 8) continue;
      if (Math.hypot(x - CAMP.x, z - CAMP.z) < 14) continue;
      if (Math.hypot(x - HELIPAD.x, z - HELIPAD.z) < 12) continue;
      if (Math.abs(z - riverZ(x)) < 12 || Math.hypot(x - TRUCK.x, z - TRUCK.z) < 11) continue;
      if (Math.hypot(x - TEMPLE.x, (z - TEMPLE.z) * 0.85) < 52) continue;
      const sl = slopeAt(x, z).s;
      if (sl > 0.9) continue;
      const cluster = fbm(x * 0.02 + 11, z * 0.02, 3);
      if (cluster < 0.45 && R() < 0.75) continue;
      const leaf = fbm(x * 0.015, z * 0.015 + 30, 2) > 0.55 && d < 70;
      const sc = 0.8 + R() * 0.7;
      t.set(x, heightAt(x, z) - 0.2, z);
      q.setFromEuler(new THREE.Euler((R() - 0.5) * 0.08, R() * Math.PI * 2, (R() - 0.5) * 0.08));
      s.set(sc, sc * (0.9 + R() * 0.35), sc);
      m.compose(t, q, s);
      if (leaf && nl < L) {
        leafT.setMatrixAt(nl, m); leafF.setMatrixAt(nl, m);
        this.leafSources.push(t.clone());
        this.harvest.push({ kind: 'tree', trunk: leafT, fol: leafF, idx: nl, pos: t.clone(), size: sc, matrix: m.clone(), left: 3, trunkH: 5.6 });
        if (cards) col.setHSL(0.08 + R() * 0.06, 0.35, 0.72 + R() * 0.22); else col.setHSL(0.06 + R() * 0.07, 0.75, 0.42 + R() * 0.15);
        leafF.setColorAt(nl, col); nl++;
      } else if (!leaf && np < P) {
        pineT.setMatrixAt(np, m); pineF.setMatrixAt(np, m);
        this.harvest.push({ kind: 'tree', trunk: pineT, fol: pineF, idx: np, pos: t.clone(), size: sc, matrix: m.clone(), left: 3, trunkH: pineTrunkH });
        if (cards) col.setHSL(0.18 + R() * 0.1, 0.2, 0.7 + R() * 0.25); else col.setHSL(0.25 + R() * 0.08, 0.35, 0.45 + R() * 0.25);
        pineF.setColorAt(np, col); np++;
      } else continue;
      if (d < 120) cb.add(colliderTrunk, m);
    }
    pineT.count = pineF.count = np; leafT.count = leafF.count = nl;
    for (const im of [pineT, pineF, leafT, leafF]) { im.computeBoundingSphere(); this.scene.add(im); }
    this.trees = [pineT, pineF, leafT, leafF];
    for (const t of this.trees) t.castShadow = this.quality.treeShadows;
  }

  setGrass(count) {
    if (this.grass) { this.grass.forEach((g) => { this.scene.remove(g); g.geometry.dispose(); }); this.grass = null; }
    if (!count) return;
    const cardGrass = !!BRANCH.grass;
    if (cardGrass) count = Math.round(count * 0.35);
    // A clump of crossed blades
    const blades = [];
    for (let i = 0; i < 5; i++) {
      const h = 0.45 + (i % 3) * 0.12;
      const g = new THREE.BufferGeometry();
      const w = 0.07;
      g.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, 0.02, h, 0], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0.3, 0, 1, 0.3, 0, 1, 0], 3));
      // both windings, with up-facing normals, so blades light consistently from either side
      g.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, 0.02, h, 0, w, 0, 0, -w, 0, 0, 0.02, h, 0], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0.2, 0, 1, 0.2, 0, 1, 0, 0, 1, -0.2, 0, 1, -0.2, 0, 1, 0], 3));
      g.rotateY(i * 1.26).translate(Math.cos(i * 2.1) * 0.18, 0, Math.sin(i * 2.1) * 0.18);
      blades.push(g);
    }
    const clump = mergeGeometries(blades);
    const col = new Float32Array(clump.attributes.position.count * 3);
    for (let i = 0; i < clump.attributes.position.count; i++) {
      const y = clump.attributes.position.getY(i);
      const k = y > 0.1 ? 1.1 : 0.55;
      col[i * 3] = 0.27 * k; col[i * 3 + 1] = 0.38 * k; col[i * 3 + 2] = 0.1 * k;
    }
    clump.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const clumpGeo = cardGrass ? crossedCards(1.15, 0.9, 3, 0.5) : clump;
    const mat = M.grass;
    const R = rng(99);
    const chunks = 18;
    const per = Math.ceil(count / chunks);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), c = new THREE.Color();
    this.grass = [];
    for (let ci = 0; ci < chunks; ci++) {
      const z0 = THREE.MathUtils.lerp(ROAD_START + 10, ROAD_END - 20, ci / chunks);
      const z1 = THREE.MathUtils.lerp(ROAD_START + 10, ROAD_END - 20, (ci + 1) / chunks);
      const im = new THREE.InstancedMesh(clumpGeo, mat, per);
      im.receiveShadow = true;
      let n = 0;
      for (let tries = 0; tries < per * 4 && n < per; tries++) {
        const z = THREE.MathUtils.lerp(z0, z1, R());
        const x = roadX(z) + (R() - 0.5) * 70;
        const d = roadDist(x, z);
        if (d < 3.4) continue;
        if (Math.hypot(x - CAMP.x, z - CAMP.z) < 6) continue;
        if (Math.hypot(x - HELIPAD.x, z - HELIPAD.z) < 6) continue;
        if (Math.abs(z - riverZ(x)) < 9 || Math.hypot(x - TRUCK.x, z - TRUCK.z) < 7) continue;
        if (Math.hypot(x - TEMPLE.x, (z - TEMPLE.z) * 0.85) < 34) continue;
        if (fbm(x * 0.08, z * 0.08, 2) < 0.38) continue;
        const sc = 0.7 + R() * 0.9;
        t.set(x, heightAt(x, z) - 0.03, z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 6.28);
        s.set(sc, sc * (0.8 + R() * 0.6), sc);
        m.compose(t, q, s);
        im.setMatrixAt(n, m);
        if (cardGrass) c.setHSL(0.2 + R() * 0.06, 0.28, 0.5 + R() * 0.22); else c.setHSL(0.17 + R() * 0.05, 0.32, 0.36 + R() * 0.2);
        im.setColorAt(n, c);
        n++;
      }
      im.count = n;
      im.computeBoundingSphere();
      im.computeBoundingBox?.();
      this.scene.add(im);
      this.grass.push(im);
    }
  }

  /** Reeds along the river banks and bushes along the forest edges (photo cards). */
  buildPlants(quality) {
    const R = rng(77);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3(), c = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const k = quality.renderScale < 0.8 ? 0.5 : 1;
    if (M.reeds) {
      const N = Math.round(900 * k);
      const im = new THREE.InstancedMesh(crossedCards(1.9, 1.8, 3, 0.55), M.reeds, N);
      im.receiveShadow = true;
      let n = 0;
      for (let tries = 0; tries < N * 8 && n < N; tries++) {
        const x = -300 + R() * 600;
        const side = R() < 0.5 ? -1 : 1;
        const z = riverZ(x) + side * (5.8 + R() * 3.2);
        const y = heightAt(x, z);
        if (y < WATER - 0.35 || y > WATER + 0.9) continue;
        if (Math.hypot(x - BRIDGE.x, z - BRIDGE.z) < BRIDGE.half + 3) continue;
        if (fbm(x * 0.05 + 3, z * 0.05, 2) < 0.42) continue;   // grow in stands, not a hedge
        const sc = 0.7 + R() * 0.6;
        t.set(x, y - 0.05, z); q.setFromAxisAngle(up, R() * 6.28); s.set(sc, sc * (0.85 + R() * 0.4), sc);
        im.setMatrixAt(n, m.compose(t, q, s));
        im.setColorAt(n, c.setHSL(0.14 + R() * 0.06, 0.15, 0.7 + R() * 0.25));
        n++;
      }
      im.count = n; im.computeBoundingSphere(); this.scene.add(im); this.reeds = im;
    }
    if (M.bush) {
      const N = Math.round(700 * k);
      const im = new THREE.InstancedMesh(crossedCards(2.4, 2.1, 4, 0.5), M.bush, N);
      im.castShadow = true; im.receiveShadow = true;
      let n = 0;
      for (let tries = 0; tries < N * 10 && n < N; tries++) {
        const z = THREE.MathUtils.lerp(150, -360, R());
        const x = roadX(z) + (R() - 0.5) * 180;
        const d = roadDist(x, z);
        if (d < 5.5 || d > 85) continue;
        if (Math.hypot(x - CAMP.x, z - CAMP.z) < 12 || Math.hypot(x - HELIPAD.x, z - HELIPAD.z) < 10) continue;
        if (Math.abs(z - riverZ(x)) < 9 || Math.hypot(x - TRUCK.x, z - TRUCK.z) < 9) continue;
        if (Math.hypot(x - TEMPLE.x, (z - TEMPLE.z) * 0.85) < 45) continue;
        if (slopeAt(x, z).s > 0.8) continue;
        // bushes gather where the trees are (same cluster field as the forest)
        if (fbm(x * 0.02 + 11, z * 0.02, 3) < 0.48) continue;
        const sc = 0.5 + R() * 0.7;
        t.set(x, heightAt(x, z) - 0.08, z); q.setFromAxisAngle(up, R() * 6.28); s.set(sc, sc * (0.8 + R() * 0.4), sc);
        im.setMatrixAt(n, m.compose(t, q, s));
        im.setColorAt(n, c.setHSL(0.2 + R() * 0.06, 0.15, 0.62 + R() * 0.3));
        n++;
      }
      im.count = n; im.computeBoundingSphere(); this.scene.add(im); this.bushes = im;
    }
  }

  buildRiver() {
    // water surface: a grid following the river, with the depth under each vertex for colour, clarity and foam
    const verts = [], depth = [], idx = [];
    const step = 2.5, half = 8.5, across = 10;
    let rows = 0;
    for (let x = -312; x <= 312; x += step) {
      const z = riverZ(x);
      for (let j = 0; j <= across; j++) {
        const zz = z - half + (j / across) * half * 2;
        verts.push(x, WATER, zz);
        depth.push(WATER - heightAt(x, zz));
      }
      rows++;
    }
    const w = across + 1;
    for (let r = 0; r < rows - 1; r++) for (let j = 0; j < across; j++) {
      const a = r * w + j, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.035, metalness: 0.0, envMapIntensity: 1.5, transparent: true, depthWrite: true });
    const U = { tWN: { value: TEX.water.normal } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U, { uTime: windTime, uWindStrength: WIND.uWindStrength });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDepth = aDepth;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vDepth; varying vec3 vWPos; uniform float uTime; uniform float uWindStrength; uniform sampler2D tWN;
          float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
            return mix(mix(wh(i), wh(i+vec2(1,0)), f.x), mix(wh(i+vec2(0,1)), wh(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float dep = max(vDepth, 0.0);
          vec2 flow = vec2(1.0, 0.18);
          // foam: along the banks and in streaks that drift downstream
          float streak = wn(vec2(vWPos.x * 0.35 - uTime * 1.1, vWPos.z * 1.6)) * wn(vWPos.xz * 0.8 - flow * uTime * 0.9);
          float foam = smoothstep(0.32, 0.02, dep) * (0.55 + 0.45 * wn(vWPos.xz * 3.0 - flow * uTime * 1.5));
          foam = max(foam, smoothstep(0.55, 0.85, streak) * 0.35);
          vec3 shallow = vec3(0.24, 0.30, 0.22), deep = vec3(0.025, 0.07, 0.075);
          vec3 wc = mix(shallow, deep, smoothstep(0.0, 1.8, dep));
          diffuseColor.rgb = mix(wc, vec3(0.85, 0.88, 0.86), foam);
          diffuseColor.a = max(mix(0.3, 0.93, smoothstep(0.0, 1.3, dep)), foam * 0.9) * smoothstep(0.0, 0.06, dep);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.6, foam);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            vec2 uv1 = vWPos.xz * 0.16 + flow * uTime * 0.09;
            vec2 uv2 = vWPos.xz * 0.06 + vec2(-0.3, 0.7) + flow * uTime * 0.04;
            vec2 uv3 = vWPos.xz * 0.45 + flow * uTime * 0.25;
            vec3 a = texture(tWN, uv1).xyz * 2.0 - 1.0, b = texture(tWN, uv2).xyz * 2.0 - 1.0, c = texture(tWN, uv3).xyz * 2.0 - 1.0;
            float k = 0.5 + uWindStrength * 0.5;
            vec2 d = (a.xy * 0.55 + b.xy * 0.8 + c.xy * 0.3) * k;
            vec3 wnrm = normalize(vec3(d.x, 1.0, d.y));
            normal = normalize((viewMatrix * vec4(wnrm, 0.0)).xyz);
          }`);
    };
    mat.customProgramCacheKey = () => 'river-water';
    const water = new THREE.Mesh(g, mat);
    water.receiveShadow = true;
    water.renderOrder = 2;
    this.scene.add(water);
    this.water = water;

    // the old bridge: broken piers and splintered deck ends
    const f = new THREE.Vector3(Math.sin(BRIDGE.yaw), 0, Math.cos(BRIDGE.yaw));
    for (const t of [-0.35, 0.35]) {
      const p = new THREE.Vector3(BRIDGE.x, 0, BRIDGE.z).addScaledVector(f, t * BRIDGE.half * 2);
      const pier = new THREE.Mesh(new THREE.BoxGeometry(BRIDGE.width + 0.8, 3.2, 1.6), M.stoneDark);
      pier.position.set(p.x, WATER - 0.7, p.z);
      pier.rotation.y = BRIDGE.yaw;
      pier.castShadow = pier.receiveShadow = true;
      this.scene.add(pier);
    }
    for (const s of [-1, 1]) {
      const p = new THREE.Vector3(BRIDGE.x, 0, BRIDGE.z).addScaledVector(f, s * (BRIDGE.half - 1.6));
      for (let i = 0; i < 4; i++) {
        const plank = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 3.2), M.wood);
        plank.position.set(p.x + (i - 1.5) * 1.15 * Math.cos(BRIDGE.yaw), heightAt(p.x, p.z) + 0.1 - i * 0.05, p.z - (i - 1.5) * 1.15 * Math.sin(BRIDGE.yaw));
        plank.rotation.set(0.12 * s * (i % 2 ? 1 : -1), BRIDGE.yaw + (Math.random() - 0.5) * 0.3, 0.05 * i);
        plank.castShadow = true;
        this.scene.add(plank);
      }
    }
    this.interactables.push({ type: 'bridgeSite', position: new THREE.Vector3(BRIDGE.x, heightAt(BRIDGE.x, BRIDGE.z + 0) , BRIDGE.z).addScaledVector(f, -BRIDGE.half + 0.5).setY(heightAt(BRIDGE.x - f.x * (BRIDGE.half - 0.5), BRIDGE.z - f.z * (BRIDGE.half - 0.5))), radius: 3, prompt: 'The old bridge is gone — press B and choose 6 to rebuild it' });
  }

  buildShed(cb) {
    // a ruined lean-to shed sheltering the abandoned truck
    const g = new THREE.Group();
    g.position.set(TRUCK.x, heightAt(TRUCK.x, TRUCK.z) - 0.05, TRUCK.z);
    g.rotation.y = TRUCK.yaw;
    this.scene.add(g);
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, collide = true) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = m.receiveShadow = true; g.add(m);
      if (collide) { g.updateMatrixWorld(true); cb.addMesh(m); }
      return m;
    };
    add(new THREE.BoxGeometry(0.3, 3, 8), M.wood, -2.6, 1.5, 0);
    add(new THREE.BoxGeometry(5.5, 3, 0.3), M.wood, 0, 1.5, -4);
    add(new THREE.BoxGeometry(0.3, 2, 3), M.wood, 2.6, 1, -2.4);
    for (const x of [-2.6, 2.6]) add(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 6), M.bark, x, 1.6, 3.9);
    { const r = add(new THREE.BoxGeometry(6, 0.15, 8.6), M.roof || M.canvas.clone(), 0, 3.25, 0, 0, 0, 0.12, false); if (!M.roof) r.material.color.set(0x5a4a3a); }
  }

  buildWaystones(cb) {
    // Old lantern stones along the road with faint sun-crystals
    const post = new THREE.BoxGeometry(0.5, 1.6, 0.5).translate(0, 0.8, 0);
    const cap = new THREE.BoxGeometry(0.75, 0.25, 0.75).translate(0, 1.72, 0);
    const gem = new THREE.OctahedronGeometry(0.16, 0).translate(0, 2.05, 0);
    for (let z = ROAD_START - 18; z > ROAD_END + 10; z -= 46) {
      const side = (Math.round(z) % 2 === 0) ? 1 : -1;
      const x = roadX(z) + side * 4.2;
      const g = new THREE.Group();
      g.position.set(x, heightAt(x, z) - 0.1, z);
      g.rotation.y = Math.random() * 0.4;
      const a = new THREE.Mesh(post, M.stone), b = new THREE.Mesh(cap, M.stoneDark), c = new THREE.Mesh(gem, M.crystal);
      a.castShadow = b.castShadow = true; a.receiveShadow = true;
      g.add(a, b, c);
      this.scene.add(g);
      g.updateMatrixWorld(true);
      cb.addMesh(a);
    }
  }

  update(dt, t) {
    windTime.value = t;
    updateWind(t);
    if (this.leaves && this.camera) this.leaves.update(dt, this.camera.position);
    for (const f of this.flames) f.update(dt, t);
  }
}
