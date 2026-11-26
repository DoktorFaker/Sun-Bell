import * as THREE from 'three';
import { M } from './materials.js';
import { Fire } from './fx.js';
import { TEMPLE, heightAt } from './terrain.js';

// The Temple of the Sun Bell: platform, stairs, portico, sealed hall and bell tower.
export function buildTemple(world, cb) {
  const scene = world.scene;
  const g = new THREE.Group();
  const base = TEMPLE.y;
  g.position.set(TEMPLE.x, base, TEMPLE.z);
  scene.add(g);
  const add = (geo, mat, x, y, z, { collide = true, ry = 0, rx = 0, rz = 0, parent = g } = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    if (collide) { m.updateWorldMatrix(true, false); cb.addMesh(m); }
    return m;
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  // Platform (top at +3)
  const PH = 3;
  add(box(46, PH + 2, 38), M.stoneDark, 0, PH / 2 - 1, 0);
  // trim
  add(box(47, 0.4, 39), M.stone, 0, PH + 0.2 - 0.4, 0, { collide: false });
  if (M.cobble) {
    // cobbled platform top
    const top = new THREE.Mesh(new THREE.PlaneGeometry(45.4, 37.4).rotateX(-Math.PI / 2), M.cobble);
    top.position.set(0, PH + 0.012, 0); top.receiveShadow = true; g.add(top);
    // plaza at the foot of the stairs, its edge broken up where the grass takes over
    const pts = [];
    for (let i = 0; i < 48; i++) {
      const a = i / 48 * Math.PI * 2;
      const r = 1 + 0.12 * Math.sin(a * 5 + 1) + 0.07 * Math.sin(a * 11 + 2) + 0.05 * Math.sin(a * 23);
      pts.push(new THREE.Vector2(Math.cos(a) * 15 * r, Math.sin(a) * 9 * r));
    }
    const plaza = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts)).rotateX(-Math.PI / 2), M.cobble);
    plaza.position.set(0, 0.04, 30); plaza.receiveShadow = true; g.add(plaza);
  }

  // Front stairs (visual steps + invisible ramp collider)
  const steps = 8, stepH = PH / steps, stepD = 0.85, SW = 14;
  for (let i = 0; i < steps; i++) {
    add(box(SW, stepH * (i + 1), stepD), M.stone, 0, stepH * (i + 1) / 2, 19 + (steps - i - 0.5) * stepD, { collide: false });
  }
  {
    const z0 = 19 + steps * stepD + 0.3, z1 = 19;
    const ramp = new THREE.BufferGeometry();
    const hw = SW / 2;
    ramp.setAttribute('position', new THREE.Float32BufferAttribute([
      -hw, 0, z0, hw, 0, z0, -hw, PH, z1, hw, 0, z0, hw, PH, z1, -hw, PH, z1,
    ], 3));
    ramp.translate(TEMPLE.x, base, TEMPLE.z);
    cb.add(ramp);
  }
  // Stair side blocks
  for (const s of [-1, 1]) add(box(1.6, PH + 0.8, steps * stepD + 0.6), M.stoneDark, s * (SW / 2 + 0.8), (PH + 0.8) / 2, 19 + steps * stepD / 2);

  // Braziers flanking stairs
  for (const s of [-1, 1]) {
    const bx = s * (SW / 2 + 0.8), bz = 19 + steps * stepD - 0.6;
    add(new THREE.CylinderGeometry(0.55, 0.35, 0.7, 10), M.bronzeDull, bx, PH + 0.8 + 0.35, bz, { collide: false });
    const f = new Fire(0.7, 10, 18);
    f.group.position.set(bx, PH + 0.8 + 0.62, bz);
    g.add(f.group);
    world.flames.push(f);
  }

  // Portico columns
  const colG = new THREE.CylinderGeometry(0.75, 0.85, 9, 14);
  const capG = box(2.1, 0.6, 2.1);
  const xs = [-11, -6.6, -2.2, 2.2, 6.6, 11];
  xs.forEach((x, i) => {
    const broken = i === 4;
    const h = broken ? 5.2 : 9;
    const c = add(broken ? new THREE.CylinderGeometry(0.75, 0.85, h, 14) : colG, M.stone, x, PH + h / 2, 10);
    add(box(2.0, 0.6, 2.0), M.stoneDark, x, PH + 0.3, 10, { collide: false });
    if (!broken) add(capG, M.stoneDark, x, PH + 9.3, 10, { collide: false });
    else {
      // fallen drum
      add(new THREE.CylinderGeometry(0.75, 0.75, 3.2, 14), M.stone, x + 2.4, PH + 0.75, 14.5, { rz: Math.PI / 2, ry: 0.6 });
    }
  });
  // Architrave (broken over the fallen column)
  add(box(13.4, 1.4, 2.2), M.stoneDark, -4.6, PH + 10.3, 10, { collide: false });
  add(box(4.8, 1.4, 2.2), M.stoneDark, 10.0, PH + 10.3, 10, { collide: false, rz: -0.06 });

  // Hall: walls with a doorway, roof partly collapsed
  const hallZ = -4, hallW = 26, hallD = 20, hallH = 10, wallT = 1.2;
  const doorW = 5.2, doorH = 7.2;
  const sideW = (hallW - doorW) / 2;
  add(box(sideW, hallH, wallT), M.stone, -(doorW / 2 + sideW / 2), PH + hallH / 2, hallZ + hallD / 2);
  add(box(sideW, hallH, wallT), M.stone, (doorW / 2 + sideW / 2), PH + hallH / 2, hallZ + hallD / 2);
  add(box(doorW, hallH - doorH, wallT), M.stone, 0, PH + doorH + (hallH - doorH) / 2, hallZ + hallD / 2);
  add(box(hallW, hallH, wallT), M.stone, 0, PH + hallH / 2, hallZ - hallD / 2);
  add(box(wallT, hallH, hallD), M.stone, -hallW / 2, PH + hallH / 2, hallZ);
  add(box(wallT, hallH, hallD), M.stone, hallW / 2, PH + hallH / 2, hallZ);
  add(box(hallW + 2, 1.0, hallD * 0.6), M.stoneDark, 0, PH + hallH + 0.5, hallZ - hallD * 0.2, { collide: false });
  add(box(hallW * 0.45, 1.0, hallD * 0.4), M.stoneDark, -hallW * 0.27, PH + hallH + 0.3, hallZ + hallD * 0.3, { collide: false, rz: 0.08 });
  // Door frame & sealed doors
  add(box(doorW + 1.2, 0.8, wallT + 0.6), M.stoneDark, 0, PH + doorH + 0.4, hallZ + hallD / 2 + 0.1, { collide: false });
  const doorMat = M.bronzeDull;
  const doors = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * doorW / 2, PH, hallZ + hallD / 2 + 0.25);
    g.add(pivot);
    const d = add(box(doorW / 2, doorH, 0.4), doorMat, -s * doorW / 4, doorH / 2, 0, { collide: false, parent: pivot });
    doors.push(pivot);
  }
  // door collider (removed when the temple opens in a later chapter)
  add(box(doorW, doorH, 0.5), doorMat, 0, PH + doorH / 2, hallZ + hallD / 2 + 0.25).visible = false;
  // Sun seal on the doors: ring + three dim sockets
  const seal = new THREE.Group();
  seal.position.set(0, PH + doorH * 0.6, hallZ + hallD / 2 + 0.5);
  g.add(seal);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.09, 8, 40), M.sealDim);
  seal.add(ring);
  const sockets = [];
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + i * Math.PI * 2 / 3;
    const sm = new THREE.Mesh(new THREE.CircleGeometry(0.28, 16), M.sealDim.clone());
    sm.position.set(Math.cos(a) * 0.75, Math.sin(a) * 0.75, 0.01);
    seal.add(sm); sockets.push(sm);
  }

  // Three sun-seal pedestals on the plaza (puzzles to come)
  const pedestals = [];
  for (const [x, z] of [[-14, 14], [14, 14], [20.5, -10]]) {
    const p = add(new THREE.CylinderGeometry(0.7, 0.9, 1.2, 8), M.stone, x, PH + 0.6, z);
    const top = add(new THREE.CylinderGeometry(0.45, 0.45, 0.12, 16), M.sealDim, x, PH + 1.26, z, { collide: false });
    pedestals.push(top);
  }

  // Bell tower behind the hall
  const tz = -21, tW = 8, tH = 24;
  add(box(tW, tH, tW), M.stone, 0, PH + tH / 2, tz);
  add(box(tW + 1, 0.8, tW + 1), M.stoneDark, 0, PH + tH, tz, { collide: false });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(box(1.2, 6.5, 1.2), M.stone, sx * (tW / 2 - 0.6), PH + tH + 3.6, tz + sz * (tW / 2 - 0.6), { collide: false });
  }
  add(box(tW + 1.6, 1.0, tW + 1.6), M.stoneDark, 0, PH + tH + 7.3, tz, { collide: false });
  add(new THREE.ConeGeometry(tW * 0.78, 5, 4), M.stoneDark, 0, PH + tH + 10.3, tz, { collide: false, ry: Math.PI / 4 });
  // The Sun Bell
  const prof = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const r = 0.25 + Math.pow(t, 1.8) * 2.0 + (t > 0.9 ? (t - 0.9) * 3 : 0);
    prof.push(new THREE.Vector2(r, 3.4 * (1 - t)));
  }
  const bell = new THREE.Mesh(new THREE.LatheGeometry(prof, 32).translate(0, -3.4, 0), new THREE.MeshStandardMaterial({ color: 0xa07a3a, metalness: 1, roughness: 0.45, side: THREE.DoubleSide, emissive: 0xffa030, emissiveIntensity: 0.0 }));
  bell.position.set(0, PH + tH + 6.4, tz); // pivot at the crown so it can swing
  bell.castShadow = true;
  g.add(bell);
  add(box(0.3, 1.2, 0.3), M.bronzeDull, 0, PH + tH + 6.6, tz, { collide: false });

  // Scattered ruins
  const R = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < 14; i++) {
    const x = R(-26, 26), z = R(-24, 30);
    if (Math.abs(x) < 9 && z > 16) continue;
    const s = R(0.6, 1.6);
    const y = heightAt(TEMPLE.x + x, TEMPLE.z + z) - base;
    const onPlat = Math.abs(x) < 22 && Math.abs(z) < 18;
    add(box(s * 1.4, s * 0.8, s), M.stone, x, (onPlat ? PH : y) + s * 0.35, z, { ry: R(0, 3), rz: R(-0.2, 0.2) });
  }

  world.interactables.push({
    type: 'door', position: new THREE.Vector3(TEMPLE.x, base + PH, TEMPLE.z + hallZ + hallD / 2 + 1.5), radius: 3.2,
    prompt: 'Examine the sealed doors',
  });


  return {
    group: g, bell, doors, sockets, pedestals, seal,
    entrance: new THREE.Vector3(TEMPLE.x, base, TEMPLE.z + 19 + steps * stepD + 2),
    focus: new THREE.Vector3(TEMPLE.x, base + PH + tH, TEMPLE.z + tz),
  };
}
