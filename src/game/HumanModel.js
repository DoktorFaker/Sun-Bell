import * as THREE from 'three';
import { gustAt, WIND } from '../world/wind.js';
import { TEX } from '../world/textures.js';

// ------------------------------------------------------------------
// A procedurally built, skinned human (the warden).
// One continuous body mesh on a skeleton: hips, spine, chest, neck, head,
// clavicles, arms, hands with finger and thumb bones, legs, feet and toes.
// Character faces +Z, Y up, ~1.78 m tall. Bind pose: arms hanging, palms in.
// ------------------------------------------------------------------

const C = {
  skin: new THREE.Color(0xd9a27a),
  skinDark: new THREE.Color(0xb98463),
  tunic: new THREE.Color(0x2c5868),
  tunicDark: new THREE.Color(0x1e3d49),
  leather: new THREE.Color(0x5a3a22),
  leatherDark: new THREE.Color(0x3a2616),
  trousers: new THREE.Color(0x3b3a33),
  boot: new THREE.Color(0x2e2117),
  hair: new THREE.Color(0x3b2516),
};

class Builder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.si = []; this.sw = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  vert(p, n, c, inf) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.col.push(c.r, c.g, c.b);
    const s = [0, 0, 0, 0], w = [0, 0, 0, 0];
    inf.slice(0, 4).forEach(([b, wt], i) => { s[i] = b; w[i] = wt; });
    const tot = w[0] + w[1] + w[2] + w[3] || 1;
    this.si.push(...s); this.sw.push(w[0] / tot, w[1] / tot, w[2] / tot, w[3] / tot);
  }
  /** Generic loft: rows of rings. ring(rowT) -> { centre, rx, rz, xAxis, zAxis, axis, cap } ; style(t, a) -> {c, inf} */
  loft(rows, radial, ringAt, style, { closeStart = true, closeEnd = true } = {}) {
    const start = this.count;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const R = ringAt(t);
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const p = R.centre.clone().addScaledVector(R.xAxis, ca * R.rx).addScaledVector(R.zAxis, sa * R.rz);
        const n = R.xAxis.clone().multiplyScalar(ca / Math.max(R.rx, 1e-4)).addScaledVector(R.zAxis, sa / Math.max(R.rz, 1e-4)).normalize();
        if (R.cap) n.addScaledVector(R.axis, R.cap).normalize();
        const { c, inf } = style(t, a, p);
        this.vert(p, n, c, inf);
      }
    }
    const w = radial + 1;
    for (let r = 0; r < rows; r++) for (let i = 0; i < radial; i++) {
      const a = start + r * w + i, b = a + 1, c = a + w, d = c + 1;
      this.idx.push(a, c, b, b, c, d);
    }
    return start;
  }
  /** Capsule-ended limb from A to B. prof(t) -> [rx, rz]. bone weights blend into parent/child near the joints. */
  limb(A, B, prof, bone, parent, child, color, { radial = 12, rows = 10, capRows = 3, ref = null } = {}) {
    const axis = B.clone().sub(A); const L = axis.length(); axis.normalize();
    const up = ref || (Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
    const xAxis = new THREE.Vector3().crossVectors(up, axis).normalize();
    const zAxis = new THREE.Vector3().crossVectors(axis, xAxis).normalize();
    const [r0x] = prof(0), [r1x] = prof(1);
    const e0 = r0x / L, e1 = r1x / L;
    const total = rows + capRows * 2;
    this.loft(total, radial, (u) => {
      const k = u * total;
      let t, cap = 0, f = 1;
      if (k < capRows) { const q = 1 - k / capRows; t = -e0 * q; f = Math.sqrt(Math.max(0, 1 - q * q)); cap = -q; }
      else if (k > capRows + rows) { const q = (k - capRows - rows) / capRows; t = 1 + e1 * q; f = Math.sqrt(Math.max(0, 1 - q * q)); cap = q; }
      else t = (k - capRows) / rows;
      const [rx, rz] = prof(Math.min(1, Math.max(0, t)));
      return { centre: A.clone().addScaledVector(axis, t * L), rx: rx * f + 1e-4, rz: rz * f + 1e-4, xAxis, zAxis, axis, cap };
    }, (u) => {
      const k = u * total;
      const t = k < capRows ? 0 : k > capRows + rows ? 1 : (k - capRows) / rows;
      const inf = [];
      let wp = 0, wc = 0;
      if (parent >= 0 && t < 0.3) wp = 0.5 * (1 - t / 0.3);
      if (child >= 0 && t > 0.7) wc = 0.5 * ((t - 0.7) / 0.3);
      inf.push([bone, 1 - wp - wc]);
      if (wp > 0) inf.push([parent, wp]);
      if (wc > 0) inf.push([child, wc]);
      return { c: typeof color === 'function' ? color(t) : color, inf };
    });
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function buildHumanModel() {
  // ---------------- skeleton ----------------
  const bones = [], B = {}, bind = {};
  const bone = (name, parent, p) => {
    const b = new THREE.Bone(); b.name = name;
    bind[name] = p.clone();
    if (parent) { b.position.copy(p).sub(bind[parent]); B[parent].add(b); } else b.position.copy(p);
    B[name] = b; b.userData.index = bones.length; bones.push(b);
    return b;
  };
  bone('hips', null, V(0, 0.95, 0));
  bone('spine', 'hips', V(0, 1.07, 0));
  bone('chest', 'spine', V(0, 1.28, 0));
  bone('neck', 'chest', V(0, 1.50, -0.01));
  bone('head', 'neck', V(0, 1.60, 0));
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) {
    bone('clav' + k, 'chest', V(s * 0.05, 1.44, 0));
    bone('upper' + k, 'clav' + k, V(s * 0.19, 1.42, 0));
    bone('fore' + k, 'upper' + k, V(s * 0.205, 1.14, 0));
    bone('hand' + k, 'fore' + k, V(s * 0.21, 0.895, 0));
    bone('fing1' + k, 'hand' + k, V(s * 0.21, 0.81, 0.004));
    bone('fing2' + k, 'fing1' + k, V(s * 0.21, 0.768, 0.004));
    bone('thumb' + k, 'hand' + k, V(s * 0.198, 0.872, 0.03));
    bone('thigh' + k, 'hips', V(s * 0.095, 0.93, 0));
    bone('shin' + k, 'thigh' + k, V(s * 0.097, 0.51, 0.012));
    bone('foot' + k, 'shin' + k, V(s * 0.099, 0.085, 0));
    bone('toe' + k, 'foot' + k, V(s * 0.099, 0.03, 0.125));
  }
  const I = (n) => B[n].userData.index;

  // ---------------- body mesh ----------------
  const G = new Builder();
  // torso loft from crotch to base of neck
  const torso = [
    [0.80, 0.10, 0.08, 0.00], [0.86, 0.155, 0.11, -0.005], [0.93, 0.168, 0.118, -0.01], [1.00, 0.150, 0.108, 0.0],
    [1.08, 0.146, 0.106, 0.005], [1.17, 0.158, 0.114, 0.012], [1.27, 0.176, 0.126, 0.018], [1.36, 0.186, 0.122, 0.012],
    [1.42, 0.170, 0.110, 0.0], [1.47, 0.120, 0.090, -0.005], [1.51, 0.062, 0.058, -0.01],
  ];
  const lerpRow = (y) => {
    for (let i = 0; i < torso.length - 1; i++) {
      const a = torso[i], b = torso[i + 1];
      if (y <= b[0]) { const t = (y - a[0]) / (b[0] - a[0]); return a.map((v, j) => v + (b[j] - v) * t); }
    }
    return torso[torso.length - 1];
  };
  G.loft(22, 20, (t) => {
    const y = 0.80 + t * 0.71;
    const [, rx, rz, zo] = lerpRow(y);
    return { centre: V(0, y, zo), rx, rz, xAxis: V(1, 0, 0), zAxis: V(0, 0, 1), axis: V(0, 1, 0), cap: t < 0.04 ? -0.6 : t > 0.96 ? 0.6 : 0 };
  }, (t, a, p) => {
    const y = p.y;
    const inf = [];
    const wHS = sstep(0.98, 1.12, y), wSC = sstep(1.20, 1.32, y), wCN = sstep(1.46, 1.51, y);
    if (y < 1.12) { inf.push([I('hips'), 1 - wHS], [I('spine'), wHS]); }
    else if (y < 1.32) { inf.push([I('spine'), 1 - wSC], [I('chest'), wSC]); }
    else { inf.push([I('chest'), 1 - wCN], [I('neck'), wCN]); }
    // upper-chest sides follow the arms a little (shoulder deformation)
    if (y > 1.33 && Math.abs(p.x) > 0.12) inf.push([I(p.x > 0 ? 'upperL' : 'upperR'), 0.35 * sstep(0.12, 0.18, Math.abs(p.x))]);
    // crotch follows the thighs
    if (y < 0.9) inf.push([I(p.x > 0 ? 'thighL' : 'thighR'), 0.5 * sstep(0.9, 0.82, y)]);
    let c = C.tunic;
    if (y > 0.985 && y < 1.035) c = C.leather;               // belt
    else if (y < 0.985) c = C.trousers;
    if (y > 1.475 && Math.abs(p.x) < 0.045 && p.z > 0) c = C.skin; // collar opening
    return { c, inf };
  });
  // tunic skirt flaring over the hips, lower edge follows the thighs
  G.loft(8, 20, (t) => {
    const y = 1.0 - t * 0.36;
    return { centre: V(0, y, -0.005), rx: 0.172 + t * 0.06, rz: 0.124 + t * 0.055, xAxis: V(1, 0, 0), zAxis: V(0, 0, 1), axis: V(0, -1, 0), cap: 0 };
  }, (t, a, p) => {
    const side = p.x >= 0 ? 'thighL' : 'thighR';
    const k = sstep(0.15, 1.0, t) * 0.6 * sstep(0.02, 0.12, Math.abs(p.x));
    return { c: t > 0.92 ? C.tunicDark : C.tunic, inf: [[I('hips'), 1 - k], [I(side), k]] };
  });
  // neck & head
  G.limb(V(0, 1.47, -0.008), V(0, 1.63, 0.0), () => [0.052, 0.056], I('neck'), I('chest'), I('head'), C.skin, { radial: 12, rows: 4 });
  G.loft(18, 22, (t) => {
    const th = t * Math.PI;                       // 0 = top, PI = chin
    const y = 1.685 + Math.cos(th) * 0.118;
    const s = Math.sin(th);
    const jaw = th > Math.PI * 0.55 ? 1 - (th - Math.PI * 0.55) / (Math.PI * 0.45) * 0.28 : 1;
    return { centre: V(0, y, 0.008 + (th > 1.6 ? (th - 1.6) * 0.02 : 0)), rx: 0.088 * s * jaw + 1e-4, rz: 0.102 * s + 1e-4, xAxis: V(1, 0, 0), zAxis: V(0, 0, 1), axis: V(0, 1, 0), cap: 0 };
  }, (t, a, p) => ({ c: C.skin, inf: [[I('head'), 1]] }));

  for (const [s, k] of [[1, 'L'], [-1, 'R']]) {
    const sh = bind['upper' + k], el = bind['fore' + k], wr = bind['hand' + k];
    // shoulder cap + upper arm (sleeve), forearm (bracer), hand
    G.limb(sh.clone().add(V(-s * 0.01, 0.02, 0)), el, (t) => [0.056 - t * 0.014 + Math.sin(t * Math.PI) * 0.006, 0.054 - t * 0.012], I('upper' + k), I('clav' + k), I('fore' + k), (t) => (t > 0.8 ? C.tunicDark : C.tunic));
    G.limb(el, wr, (t) => [0.043 - t * 0.012 + Math.sin(t * Math.PI) * 0.004, 0.046 - t * 0.012], I('fore' + k), I('upper' + k), I('hand' + k), (t) => (t < 0.18 ? C.skin : t > 0.92 ? C.leatherDark : C.leather));
    // palm: thin across X (palms face the body), wide front-to-back
    G.limb(wr.clone().add(V(0, 0.005, 0)), V(s * 0.21, 0.812, 0.004), (t) => [0.018 + t * 0.004, 0.036 + t * 0.008], I('hand' + k), I('fore' + k), I('fing1' + k), C.skin, { radial: 10, rows: 4, capRows: 2, ref: V(0, 0, 1) });
    // four fingers
    for (const z of [0.027, 0.009, -0.009, -0.026]) {
      const len = z === -0.026 ? 0.8 : z === 0.009 ? 1.08 : 1;
      G.limb(V(s * 0.21, 0.812, z + 0.004), V(s * 0.21, 0.812 - 0.044 * len, z + 0.004), () => [0.0085, 0.009], I('fing1' + k), I('hand' + k), I('fing2' + k), C.skin, { radial: 6, rows: 3, capRows: 2, ref: V(0, 0, 1) });
      G.limb(V(s * 0.21, 0.812 - 0.044 * len, z + 0.004), V(s * 0.21, 0.812 - 0.082 * len, z + 0.004), () => [0.008, 0.0082], I('fing2' + k), I('fing1' + k), -1, C.skin, { radial: 6, rows: 3, capRows: 2, ref: V(0, 0, 1) });
    }
    G.limb(V(s * 0.196, 0.872, 0.03), V(s * 0.188, 0.83, 0.048), () => [0.01, 0.011], I('thumb' + k), I('hand' + k), -1, C.skin, { radial: 6, rows: 3, capRows: 2, ref: V(0, 0, 1) });
    // legs: thigh, shin (boot below the knee), foot
    const hp = bind['thigh' + k], kn = bind['shin' + k], an = bind['foot' + k];
    G.limb(hp.clone().add(V(0, 0.02, 0)), kn, (t) => [0.083 - t * 0.03, 0.088 - t * 0.032], I('thigh' + k), I('hips'), I('shin' + k), C.trousers, { radial: 14 });
    G.limb(kn, an.clone().add(V(0, 0.02, 0)), (t) => [0.054 - t * 0.016 + Math.sin(t * Math.PI * 0.8) * 0.008, 0.058 - t * 0.018 + Math.sin(t * Math.PI * 0.7) * 0.01], I('shin' + k), I('thigh' + k), I('foot' + k), (t) => (t < 0.22 ? C.trousers : t < 0.27 ? C.leatherDark : C.boot), { radial: 14 });
    G.limb(V(s * 0.099, 0.06, -0.075), V(s * 0.099, 0.045, 0.125), (t) => [0.044 + Math.sin(t * Math.PI) * 0.006, 0.05 - t * 0.022], I('foot' + k), I('shin' + k), I('toe' + k), C.boot, { radial: 12, rows: 6, ref: V(0, 1, 0) });
    G.limb(V(s * 0.099, 0.04, 0.125), V(s * 0.099, 0.032, 0.19), (t) => [0.042 - t * 0.008, 0.028 - t * 0.008], I('toe' + k), I('foot' + k), -1, C.boot, { radial: 12, rows: 3, ref: V(0, 1, 0) });
  }

  const geo = G.geometry();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0 });
  const body = new THREE.SkinnedMesh(geo, mat);
  body.castShadow = true; body.receiveShadow = true;
  body.frustumCulled = false;

  const root = new THREE.Group();
  root.add(B.hips);
  root.add(body);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  body.bind(skeleton);

  // ---------------- face, hair, gear (rigid, parented to bones) ----------------
  const rigid = (geo, matl, boneName, worldPos, rot) => {
    const m = new THREE.Mesh(geo, matl);
    m.position.copy(worldPos).sub(bind[boneName]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    B[boneName].add(m);
    return m;
  };
  const skinMat = new THREE.MeshStandardMaterial({ color: C.skin, roughness: 0.6 });
  const hairMat = new THREE.MeshStandardMaterial({ color: C.hair, roughness: 0.85 });
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xe8e2d8, roughness: 0.3 });
  const iris = new THREE.MeshStandardMaterial({ color: 0x2a3a2a, roughness: 0.2 });
  const lipMat = new THREE.MeshStandardMaterial({ color: 0x9a5a48, roughness: 0.6 });
  rigid(new THREE.ConeGeometry(0.016, 0.045, 8), skinMat, 'head', V(0, 1.68, 0.108), [Math.PI / 2 - 0.25, 0, 0]);
  for (const s of [-1, 1]) {
    rigid(new THREE.SphereGeometry(0.014, 10, 8), eyeWhite, 'head', V(s * 0.034, 1.705, 0.092));
    rigid(new THREE.SphereGeometry(0.008, 8, 6), iris, 'head', V(s * 0.034, 1.705, 0.103));
    rigid(new THREE.BoxGeometry(0.03, 0.006, 0.01), hairMat, 'head', V(s * 0.034, 1.727, 0.1), [0, 0, s * -0.12]);
    rigid(new THREE.SphereGeometry(0.02, 8, 6), skinMat, 'head', V(s * 0.088, 1.69, 0.0)).scale.set(0.45, 1, 0.75);
  }
  rigid(new THREE.BoxGeometry(0.034, 0.008, 0.01), lipMat, 'head', V(0, 1.632, 0.097));
  const hairCap = rigid(new THREE.SphereGeometry(0.122, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), hairMat, 'head', V(0, 1.7, -0.008), [-0.32, 0, 0]);
  hairCap.scale.set(0.93, 1.0, 1.04);
  rigid(new THREE.SphereGeometry(0.11, 14, 10, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.35, Math.PI * 0.5), hairMat, 'head', V(0, 1.68, -0.03), [0, Math.PI, 0]);
  const tail = rigid(new THREE.CapsuleGeometry(0.03, 0.14, 3, 8), hairMat, 'head', V(0, 1.6, -0.11), [0.35, 0, 0]);
  // belt buckle, pauldrons, scabbard
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a548, metalness: 1, roughness: 0.32 });
  const leather = new THREE.MeshStandardMaterial({ color: C.leather, roughness: 0.6 });
  if (TEX.leather && TEX.leather.custom) {
    // the gear meshes have UVs, so the photo maps directly (no swimming as the arms move)
    const map = TEX.leather.map.clone(); map.repeat.set(1.5, 1.5); map.needsUpdate = true;
    const nrm = TEX.leather.normal.clone(); nrm.repeat.set(1.5, 1.5); nrm.needsUpdate = true;
    leather.map = map; leather.normalMap = nrm; leather.normalScale.set(1.2, 1.2);
    leather.color.set(0xd8cfc6); leather.roughness = 0.68;
  }
  rigid(new THREE.BoxGeometry(0.05, 0.035, 0.012), gold, 'hips', V(0, 1.01, 0.112));
  for (const [s, k] of [[1, 'L'], [-1, 'R']]) {
    const p = rigid(new THREE.SphereGeometry(0.075, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), leather, 'upper' + k, V(s * 0.2, 1.43, 0), [0, 0, -s * 0.45]);
    p.scale.set(1, 0.7, 1.05);
  }

  // ---------------- sword & shield ----------------
  const steel = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 1, roughness: 0.22 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6a4428, roughness: 0.75 });
  const sword = new THREE.Group();
  const add = (g, m, parent, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
  add(new THREE.CylinderGeometry(0.019, 0.021, 0.19, 8), leather, sword);
  add(new THREE.BoxGeometry(0.24, 0.035, 0.045), gold, sword, 0, 0.11, 0);
  add(new THREE.SphereGeometry(0.032, 8, 6), gold, sword, 0, -0.11, 0);
  const bladeGeo = new THREE.BoxGeometry(0.062, 0.92, 0.012, 1, 8, 1);
  const bp = bladeGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) { const y = bp.getY(i); if (y > 0.3) bp.setX(i, bp.getX(i) * Math.max(0.08, 1 - (y - 0.3) / 0.16)); }
  bladeGeo.computeVertexNormals();
  add(bladeGeo, steel, sword, 0, 0.59, 0);
  sword.rotation.x = Math.PI / 2;
  sword.position.set(0, -0.075, 0.0);
  B.handR.add(sword);
  const bladeBase = new THREE.Object3D(); bladeBase.position.y = 0.18; sword.add(bladeBase);
  const bladeTip = new THREE.Object3D(); bladeTip.position.y = 1.04; sword.add(bladeTip);

  const shield = new THREE.Group();
  const disc = add(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 28), wood, shield); disc.rotation.x = Math.PI / 2;
  add(new THREE.TorusGeometry(0.34, 0.025, 8, 32), gold, shield);
  const boss = add(new THREE.SphereGeometry(0.08, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), gold, shield, 0, 0, 0.03); boss.rotation.x = Math.PI / 2;
  for (let i = 0; i < 8; i++) {
    const r = add(new THREE.BoxGeometry(0.03, 0.16, 0.01), gold, shield);
    const a = i / 8 * Math.PI * 2;
    r.position.set(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.03); r.rotation.z = a - Math.PI / 2;
  }
  shield.position.set(0.07, -0.13, 0.0);
  shield.rotation.y = Math.PI / 2;
  B.foreL.add(shield);

  // ---------------- cloth cloak (verlet) ----------------
  const cloak = new Cloak(B.chest, root);

  return {
    root, body, skeleton, B, bind, sword, shield, bladeBase, bladeTip, cloak, tail,
    legLen: { thigh: bind.thighL.distanceTo(bind.shinL), shin: bind.shinL.distanceTo(bind.footL), ankle: bind.footL.y },
    hipY: bind.hips.y,
    thighOffset: bind.thighL.y - bind.hips.y,
  };
}

/**
 * Cloth cloak hanging from the shoulders: verlet particles pinned to the chest bone,
 * pushed by gravity and the shared wind field, colliding with the body.
 */
export class Cloak {
  constructor(chestBone, root) {
    this.chest = chestBone;
    this.root = root;
    this.W = 7; this.H = 11;
    this.width = 0.44; this.height = 0.92;
    const n = this.W * this.H;
    this.p = new Float32Array(n * 3); this.q = new Float32Array(n * 3);
    this.anchorsLocal = [];
    for (let i = 0; i < this.W; i++) {
      const u = i / (this.W - 1) - 0.5;
      this.anchorsLocal.push(new THREE.Vector3(u * this.width * (1 - Math.abs(u) * 0.2), 0.15 - Math.abs(u) * 0.025, -0.13 + Math.abs(u) * 0.03));
    }
    const g = new THREE.PlaneGeometry(1, 1, this.W - 1, this.H - 1);
    const uv = g.attributes.uv;
    this.geo = g;
    const mat = new THREE.MeshStandardMaterial({ color: 0x8b3326, roughness: 0.88, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    root.add(this.mesh);
    this.initialised = false;
    this.colliders = [];
    void uv;
  }
  reset() { this.initialised = false; }
  anchor(i, out) { return out.copy(this.anchorsLocal[i]).applyMatrix4(this.chest.matrixWorld); }
  update(dt, spheres) {
    const W = this.W, H = this.H, p = this.p, q = this.q;
    const dy = this.height / (H - 1), dx = this.width / (W - 1);
    const a = new THREE.Vector3();
    if (!this.initialised) {
      for (let i = 0; i < W; i++) {
        this.anchor(i, a);
        for (let j = 0; j < H; j++) { const k = (j * W + i) * 3; p[k] = q[k] = a.x; p[k + 1] = q[k + 1] = a.y - j * dy; p[k + 2] = q[k + 2] = a.z; }
      }
      this.initialised = true;
    }
    const steps = 2, h = Math.min(dt, 1 / 30) / steps;
    const wd = WIND.uWindDir.value;
    // the gust is the same across a cloak this small: sample it once, and the flutter once per vertex
    const g0 = gustAt(p[W * 3], p[W * 3 + 2]), tW = WIND.uTime.value * 9;
    const fl = this._fl || (this._fl = new Float32Array(W * H));
    for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) fl[j * W + i] = (Math.sin(tW + i * 1.3 + j * 0.9) * 0.6 + 0.6) * g0 * 2.6;
    for (let s = 0; s < steps; s++) {
      // integrate
      for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
        const k = (j * W + i) * 3;
        const f = fl[j * W + i];
        const fx = wd.x * f, fz = wd.y * f, fy = -9.8;
        for (let c = 0; c < 3; c++) {
          const v = THREE.MathUtils.clamp((p[k + c] - q[k + c]) * 0.975, -0.12, 0.12);
          q[k + c] = p[k + c];
          p[k + c] += v + (c === 0 ? fx : c === 1 ? fy : fz) * h * h;
        }
      }
      // pin top row
      for (let i = 0; i < W; i++) { this.anchor(i, a); const k = i * 3; p[k] = q[k] = a.x; p[k + 1] = q[k + 1] = a.y; p[k + 2] = q[k + 2] = a.z; }
      // constraints
      for (let it = 0; it < 4; it++) {
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          if (i < W - 1) this.link(j * W + i, j * W + i + 1, dx);
          if (j < H - 1) this.link(j * W + i, (j + 1) * W + i, dy);
          if (j < H - 2) this.link(j * W + i, (j + 2) * W + i, dy * 2);
          if (i < W - 2) this.link(j * W + i, j * W + i + 2, dx * 2);
        }
        // body collision
        for (let j = 1; j < H; j++) for (let i = 0; i < W; i++) {
          const k = (j * W + i) * 3;
          for (const sp of spheres) {
            const ex = p[k] - sp.x, ey = p[k + 1] - sp.y, ez = p[k + 2] - sp.z;
            const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (d < sp.r && d > 1e-5) { const f = (sp.r - d) / d; p[k] += ex * f; p[k + 1] += ey * f; p[k + 2] += ez * f; }
          }
        }
      }
    }
    // safety: if the body jumped (teleport, vehicle), drop the cloth back onto the shoulders
    this.anchor(0, a);
    const kb = ((H - 1) * W) * 3;
    if (Math.hypot(p[kb] - a.x, p[kb + 1] - a.y, p[kb + 2] - a.z) > this.height * 1.6) { this.initialised = false; }
    // write into the mesh, in root-local space
    const pos = this.geo.attributes.position;
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const v = new THREE.Vector3();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 3;
      v.set(p[k], p[k + 1], p[k + 2]).applyMatrix4(inv);
      pos.setXYZ(j * W + i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
  link(a, b, rest) {
    const p = this.p, ka = a * 3, kb = b * 3;
    const dx = p[kb] - p[ka], dy = p[kb + 1] - p[ka + 1], dz = p[kb + 2] - p[ka + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const diff = (d - rest) / d * 0.5;
    const pinA = a < this.W, pinB = b < this.W;
    const wa = pinA ? 0 : pinB ? 1 : 0.5, wb = pinB ? 0 : pinA ? 1 : 0.5;
    p[ka] += dx * diff * wa * 2; p[ka + 1] += dy * diff * wa * 2; p[ka + 2] += dz * diff * wa * 2;
    p[kb] -= dx * diff * wb * 2; p[kb + 1] -= dy * diff * wb * 2; p[kb + 2] -= dz * diff * wb * 2;
  }
}
