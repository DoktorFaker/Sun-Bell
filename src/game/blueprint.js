// Vehicles built from the user's blueprint sheets (see tools/blueprint.py).
import * as THREE from 'three';

export const BLUEPRINT = {};   // name -> { geometry, map, meta }

async function loadOne(name) {
  const base = `./models/${name}`;
  const [bin, meta, map] = await Promise.all([
    fetch(`${base}.bin`).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
    fetch(`${base}.json`).then((r) => r.json()),
    new THREE.TextureLoader().loadAsync(`${base}.jpg`),
  ]);
  const [nv, ni] = new Uint32Array(bin, 0, 2);
  let o = 8;
  const pos = new Float32Array(bin, o, nv * 3); o += nv * 12;
  const uv = new Float32Array(bin, o, nv * 2); o += nv * 8;
  const idx = new Uint32Array(bin, o, ni);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  BLUEPRINT[name] = { geometry: g, map, meta };
}

export async function loadBlueprints() {
  await Promise.all(['truck', 'heli', 'ak'].map((n) => loadOne(n).catch((e) => console.warn(`blueprint ${n}:`, e))));
}

/** Texture region of the atlas as a cloned texture (for wheels, tyres, blades). */
export function atlasPart(name, part, repeatU = 1) {
  const bp = BLUEPRINT[name];
  const r = bp?.meta.rects[part];
  if (!r) return null;
  const t = bp.map.clone();
  t.needsUpdate = true;
  t.repeat.set(r[2] / repeatU, r[3]);
  t.offset.set(r[0], 1 - r[1] - r[3]);
  if (repeatU !== 1) t.wrapS = THREE.RepeatWrapping;   // not used across atlas edges
  return t;
}
