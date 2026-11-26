import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ------------------------------------------------------------------
// Trees built from photographed branch cards (public/textures/branch_*.png).
// Each crown is dozens of alpha-tested branch quads around the trunk,
// with soft "crown" normals so the whole tree lights like a volume.
// ------------------------------------------------------------------

export const BRANCH = { leaf: null, pine: null, grass: null, reeds: null, bush: null, sky: null };

function loadTex(url) {
  return new Promise((res) => {
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      res(t);
    }, undefined, () => res(null));
  });
}

export async function loadBranchTextures() {
  const [leaf, pine, grass, reeds, bush] = await Promise.all(['branch_leaf', 'branch_pine', 'grass_clump', 'reeds', 'bush'].map((n) => loadTex(`textures/${n}.png`)));
  Object.assign(BRANCH, { leaf, pine, grass, reeds, bush });
  for (const ext of ['jpg', 'png', 'webp']) {
    const sky = await loadTex(`textures/sky.${ext}`);
    if (sky) { sky.wrapS = THREE.RepeatWrapping; sky.anisotropy = 1; BRANCH.sky = sky; break; }
  }
  return !!(leaf && pine);
}

const _v = new THREE.Vector3();

/** One branch quad: stem at `base`, reaching along `dir` for `len`, `w` wide, rolled by `roll` about its axis. */
function card(base, dir, len, w, roll, centre, shade) {
  const d = dir.clone().normalize();
  let side = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
  if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
  side.normalize().applyAxisAngle(d, roll);
  const tip = base.clone().addScaledVector(d, len);
  const p = [
    base.clone().addScaledVector(side, -w / 2), base.clone().addScaledVector(side, w / 2),
    tip.clone().addScaledVector(side, w / 2), tip.clone().addScaledVector(side, -w / 2),
  ];
  const pos = [], nrm = [], uv = [], col = [];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let i = 0; i < 4; i++) {
    pos.push(p[i].x, p[i].y, p[i].z);
    // crown normal: outward from the crown centre, tilted up a little
    _v.copy(p[i]).sub(centre).normalize().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.45, 0)).normalize();
    nrm.push(_v.x, _v.y, _v.z);
    uv.push(uvs[i][0], uvs[i][1]);
    const k = shade(p[i]);
    col.push(k, k, k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Conifer: tiers of drooping branches shrinking towards the top, plus a crossed leader. */
export function pineFoliage(seed = 1) {
  const R = rng(seed);
  const parts = [];
  const top = 11.2, bottom = 2.6;
  const centre = new THREE.Vector3(0, 6.2, 0);
  const shade = (p) => 0.5 + 0.5 * Math.min(1, Math.hypot(p.x, p.z) / 2.2) * (0.75 + 0.25 * (p.y - bottom) / (top - bottom));
  const tiers = 10;
  for (let t = 0; t < tiers; t++) {
    const u = t / (tiers - 1);
    const y = bottom + u * (top - bottom - 1.2);
    const radius = 3.0 * (1 - u) + 0.5;
    const n = Math.round(7 - u * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + t * 2.39996 + (R() - 0.5) * 0.5;
      const droop = -0.28 - 0.25 * (1 - u) + (R() - 0.5) * 0.15;
      const dir = new THREE.Vector3(Math.cos(a), droop + 0.35, Math.sin(a));
      const base = new THREE.Vector3(Math.cos(a) * 0.12, y + (R() - 0.5) * 0.3, Math.sin(a) * 0.12);
      const len = radius * (1.05 + R() * 0.25);
      const roll = (R() - 0.5) * 0.7;
      parts.push(card(base, dir, len, len * 0.95, roll, centre, shade));
      if (u < 0.75) parts.push(card(base, dir, len * 0.85, len * 0.8, roll + Math.PI / 2 * 0.8, centre, shade));
    }
  }
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI / 3;
    parts.push(card(new THREE.Vector3(0, top - 1.8, 0), new THREE.Vector3(Math.cos(a) * 0.05, 1, Math.sin(a) * 0.05), 2.1, 1.5, a, centre, () => 0.95));
  }
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

/** Broadleaf: a rounded crown of branch clusters radiating from inside. */
export function leafFoliage(seed = 2) {
  const R = rng(seed);
  const parts = [];
  const centre = new THREE.Vector3(0, 6.0, 0);
  const rad = new THREE.Vector3(2.9, 2.4, 2.9);
  const shade = (p) => {
    const q = _v.copy(p).sub(centre).divide(rad);
    return 0.45 + 0.55 * Math.min(1, q.length()) * (0.8 + 0.2 * Math.max(0, q.y));
  };
  const n = 46;
  for (let i = 0; i < n; i++) {
    // evenly spread directions (fibonacci sphere), squashed below
    const k = (i + 0.5) / n;
    const phi = Math.acos(1 - 2 * k), th = i * 2.39996;
    const dir = new THREE.Vector3(Math.sin(phi) * Math.cos(th), Math.cos(phi) * (Math.cos(phi) < 0 ? 0.55 : 1), Math.sin(phi) * Math.sin(th));
    dir.x += (R() - 0.5) * 0.3; dir.z += (R() - 0.5) * 0.3; dir.normalize();
    const base = centre.clone().addScaledVector(dir.clone().multiply(rad), 0.25 + R() * 0.2);
    const len = 1.9 + R() * 0.8;
    parts.push(card(base, dir.clone().add(new THREE.Vector3(0, 0.25, 0)), len, len * 0.85, (R() - 0.5) * Math.PI, centre, shade));
  }
  // a few inner limbs to fill the middle
  for (let i = 0; i < 10; i++) {
    const a = R() * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(a), 0.6 + R() * 0.5, Math.sin(a));
    parts.push(card(new THREE.Vector3(0, 3.6 + R() * 1.4, 0), dir, 2.6, 2.2, R() * 3, centre, shade));
  }
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

/** n vertical cards crossed around the centre (grass clumps, reeds, bushes). Darker at the base. */
export function crossedCards(w, h, n = 3, baseShade = 0.55) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI;
    const cx = Math.cos(a) * w / 2, cz = Math.sin(a) * w / 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-cx, 0, -cz, cx, 0, cz, cx, h, cz, -cx, h, -cz], 3));
    // soft normals: mostly up, so both faces light evenly
    const nx = -Math.sin(a) * 0.35, nz = Math.cos(a) * 0.35;
    g.setAttribute('normal', new THREE.Float32BufferAttribute([nx, 1, nz, nx, 1, nz, nx * 0.5, 1, nz * 0.5, nx * 0.5, 1, nz * 0.5], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute([baseShade, baseShade, baseShade, baseShade, baseShade, baseShade, 1, 1, 1, 1, 1, 1], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    parts.push(g);
  }
  const out = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  out.attributes.normal.array.forEach((_, i, arr) => { if (i % 3 === 2) { const k = i - 2; const l = Math.hypot(arr[k], arr[k + 1], arr[k + 2]); arr[k] /= l; arr[k + 1] /= l; arr[k + 2] /= l; } });
  return out;
}
