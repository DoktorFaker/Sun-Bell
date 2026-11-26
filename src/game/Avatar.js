import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ------------------------------------------------------------------
// Loads a humanoid model (public/models/heroine.glb, converted from the
// VRM Studio PMX export) and drives it from the warden's procedural rig:
// every frame the source skeleton's world rotations are copied across
// (with a per-bone reference offset, because the model is in a T-pose and
// the warden's rig is built with arms hanging), then a two-bone IK pass
// re-plants the model's own feet.
// ------------------------------------------------------------------

export const AVATAR = { gltf: null };

export function avatarChoice() {
  try { return localStorage.getItem('sunbell.hero') || 'heroine'; } catch { return 'heroine'; }
}

export async function loadAvatar(url = 'models/heroine.glb') {
  if (avatarChoice() !== 'heroine') return null;
  try {
    AVATAR.gltf = await new GLTFLoader().loadAsync(url);
  } catch (e) { console.warn('Avatar not loaded, using the warden', e); AVATAR.gltf = null; }
  return AVATAR.gltf;
}

// target bone -> [source bone, target child used to measure its direction]
function boneMap(k, s) {
  const m = {
    [`shoulder_${k}`]: [`clav${s}`, `arm_${k}`],
    [`arm_${k}`]: [`upper${s}`, `elbow_${k}`],
    [`elbow_${k}`]: [`fore${s}`, `wrist_${k}`],
    [`wrist_${k}`]: [`hand${s}`, `middle1_${k}`],
    [`J_Bip_${k}_Thumb1`]: [`thumb${s}`, `thumb1_${k}`],
    [`thumb1_${k}`]: [`thumb${s}`, `thumb2_${k}`],
    [`thumb2_${k}`]: [`thumb${s}`, `J_Bip_${k}_Thumb3_end`],
    [`leg_${k}`]: [`thigh${s}`, `knee_${k}`],
    [`knee_${k}`]: [`shin${s}`, `ankle_${k}`],
    [`ankle_${k}`]: [`foot${s}`, `toe_${k}`],
    [`toe_${k}`]: [`toe${s}`, `J_Bip_${k}_ToeBase_end`],
  };
  for (const f of ['index', 'middle', 'ring', 'little']) {
    const F = f[0].toUpperCase() + f.slice(1);
    m[`${f}1_${k}`] = [`fing1${s}`, `${f}2_${k}`];
    m[`${f}2_${k}`] = [`fing2${s}`, `${f}3_${k}`];
    m[`${f}3_${k}`] = [`fing2${s}`, `J_Bip_${k}_${F}3_end`];
  }
  return m;
}
const MAP = {
  hips: ['hips', 'spine'], spine: ['spine', 'chest'], chest: ['chest', 'upperChest'], upperChest: ['chest', 'neck'],
  neck: ['neck', 'head'], head: ['head', null],
  ...boneMap('L', 'L'), ...boneMap('R', 'R'),
};

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export class AvatarRig {
  /**
   * @param gltf  loaded model (T-pose, metres, facing +Z)
   * @param src   the warden model from buildHumanModel()
   */
  constructor(gltf, src) {
    this.src = src;
    const scene = gltf.scene;
    this.scene = scene;
    const bones = {};
    scene.traverse((o) => {
      if (o.isBone || (o.name && !o.isMesh)) bones[o.name] = o;
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        const m = o.material;
        m.roughness = 0.72; m.metalness = 0;
        if (m.map) m.map.anisotropy = 8;
        if (/Face|Facebaked/.test(m.name)) m.envMapIntensity = 0.6;
      }
    });
    this.T = bones;
    scene.updateMatrixWorld(true);
    const w = (n) => new THREE.Vector3().setFromMatrixPosition(bones[n].matrixWorld);
    const S = src.B, sb = src.bind;

    // size her so her legs match the warden's (the foot IK depends on it)
    const tLeg = w('leg_L').y - w('ankle_L').y;
    const sLeg = sb.thighL.y - sb.footL.y;
    this.scale = sLeg / tLeg;
    scene.scale.setScalar(this.scale);
    scene.position.y = sb.footL.y - w('ankle_L').y * this.scale;
    src.root.add(scene);
    scene.updateMatrixWorld(true);

    // reference rotation per bone: aligns the model's T-pose bone with the warden's bind direction
    this.ref = {};
    const dirS = (name) => {
      const kids = { hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head', head: null };
      const child = kids[name] || ({ clav: 'upper', upper: 'fore', fore: 'hand', hand: 'fing1', fing1: 'fing2', fing2: null, thumb: null, thigh: 'shin', shin: 'foot', foot: 'toe', toe: null })[name.slice(0, -1)];
      if (!child) return null;
      const c = kids[name] !== undefined ? child : child + name.slice(-1);
      return sb[c].clone().sub(sb[name]).normalize();
    };
    const fixedDir = { fing2L: new THREE.Vector3(0, -1, 0.05).normalize(), fing2R: new THREE.Vector3(0, -1, 0.05).normalize(), thumbL: new THREE.Vector3(0.02, -0.7, 0.72).normalize(), thumbR: new THREE.Vector3(-0.02, -0.7, 0.72).normalize() };
    for (const [tn, [sn, child]] of Object.entries(MAP)) {
      if (!bones[tn]) continue;
      if (!child || !bones[child]) { this.ref[tn] = new THREE.Quaternion(); continue; }
      const dT = w(child).sub(w(tn)).normalize();
      const dS = fixedDir[sn] || dirS(sn);
      this.ref[tn] = dS ? new THREE.Quaternion().setFromUnitVectors(dT, dS) : new THREE.Quaternion();
    }
    // hips/spine/head stay as authored (they're already upright)
    for (const n of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head']) this.ref[n] = new THREE.Quaternion();
    // process parents before children
    this.order = [];
    scene.traverse((o) => { if (MAP[o.name] && bones[o.name] === o) this.order.push(o); });
    this.hipsBind = bones.hips.position.clone();
    this.srcHipsBind = new THREE.Vector3(0, sb.hips.y, 0);
    this.ankleOff = {
      L: new THREE.Vector3(w('ankle_L').x, w('ankle_L').y, w('ankle_L').z).sub(sb.footL),
      R: new THREE.Vector3(w('ankle_R').x, w('ankle_R').y, w('ankle_R').z).sub(sb.footR),
    };

    // hide the warden's own body and gear, move sword and shield onto her hands
    src.root.traverse((o) => { if (o.isMesh && o !== src.cloak.mesh && !scene.getObjectById(o.id)) o.visible = false; });
    const holder = (bone, srcBone) => {
      const h = new THREE.Group();
      h.quaternion.copy(this.ref[bone]).invert();
      h.scale.setScalar(1 / this.scale);
      bones[bone].add(h);
      return h;
    };
    const showAll = (g) => g.traverse((o) => { if (o.isMesh) o.visible = true; });
    holder('wrist_R').add(src.sword); showAll(src.sword);
    holder('elbow_L').add(src.shield); showAll(src.shield);
    src.sword.position.y = -0.06; // her hand is a little shorter than the warden's
  }

  update() {
    const src = this.src, T = this.T;
    src.root.updateMatrixWorld(true);
    // hips position follows the warden's pelvis
    _v.copy(src.B.hips.position).sub(this.srcHipsBind).divideScalar(this.scale);
    T.hips.position.copy(this.hipsBind).add(_v);
    // rotations: target world = source world * reference
    for (const b of this.order) {
      const [sn] = MAP[b.name];
      src.B[sn].getWorldQuaternion(_q).multiply(this.ref[b.name]);
      b.parent.getWorldQuaternion(_q2);
      b.quaternion.copy(_q2.invert().multiply(_q));
      b.updateMatrixWorld(true);
    }
    // re-plant her feet where the warden's IK put his
    for (const k of ['L', 'R']) {
      const goal = _v3.copy(this.ankleOff[k]).applyQuaternion(src.root.quaternion);
      goal.add(_v.setFromMatrixPosition(src.B['foot' + k].matrixWorld));
      this.ik(T['leg_' + k], T['knee_' + k], T['ankle_' + k], goal);
      // keep the foot's orientation from the source
      src.B['foot' + k].getWorldQuaternion(_q).multiply(this.ref['ankle_' + k]);
      T['ankle_' + k].parent.getWorldQuaternion(_q2);
      T['ankle_' + k].quaternion.copy(_q2.invert().multiply(_q));
      T['ankle_' + k].updateMatrixWorld(true);
    }
  }

  /** Two-bone IK in world space, keeping the current knee bend plane. */
  ik(hip, knee, ankle, goal) {
    const H = new THREE.Vector3().setFromMatrixPosition(hip.matrixWorld);
    const K = new THREE.Vector3().setFromMatrixPosition(knee.matrixWorld);
    const A = new THREE.Vector3().setFromMatrixPosition(ankle.matrixWorld);
    const L1 = H.distanceTo(K), L2 = K.distanceTo(A);
    const toGoal = goal.clone().sub(H);
    const d = THREE.MathUtils.clamp(toGoal.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    const dir = toGoal.normalize();
    // bend plane from the current knee position
    let bend = K.clone().sub(H); bend.addScaledVector(dir, -bend.dot(dir));
    if (bend.lengthSq() < 1e-8) bend = new THREE.Vector3(0, 0, 1).applyQuaternion(hip.getWorldQuaternion(new THREE.Quaternion()));
    bend.normalize();
    const a = Math.acos(THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    const newK = H.clone().addScaledVector(dir, Math.cos(a) * L1).addScaledVector(bend, Math.sin(a) * L1);
    const newA = H.clone().addScaledVector(dir, d);
    const rot = (bone, from, to) => {
      const q = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
      const wq = bone.getWorldQuaternion(new THREE.Quaternion());
      const pq = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      bone.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
      bone.updateMatrixWorld(true);
    };
    rot(hip, K.clone().sub(H), newK.clone().sub(H));
    const K2 = new THREE.Vector3().setFromMatrixPosition(knee.matrixWorld);
    const A2 = new THREE.Vector3().setFromMatrixPosition(ankle.matrixWorld);
    rot(knee, A2.sub(K2), newA.sub(K2));
  }
}
