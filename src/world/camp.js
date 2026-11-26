import * as THREE from 'three';
import { M } from './materials.js';
import { Fire } from './fx.js';
import { CAMP, heightAt, roadX } from './terrain.js';
import { gustAt } from './wind.js';

export function buildCamp(world, cb) {
  const scene = world.scene;
  const g = new THREE.Group();
  const y0 = heightAt(CAMP.x, CAMP.z);
  g.position.set(CAMP.x, y0, CAMP.z);
  scene.add(g);
  const add = (mesh, collide = false, shadow = true) => {
    mesh.castShadow = shadow; mesh.receiveShadow = true;
    g.add(mesh);
    if (collide) { g.updateMatrixWorld(true); cb.addMesh(mesh); }
    return mesh;
  };

  // Fire pit: ring of stones + crossed logs
  const stone = new THREE.DodecahedronGeometry(0.22, 0);
  for (let i = 0; i < 11; i++) {
    const a = i / 11 * Math.PI * 2;
    const s = add(new THREE.Mesh(stone, M.rock));
    s.position.set(Math.cos(a) * 0.75, 0.08, Math.sin(a) * 0.75);
    s.rotation.set(a, a * 2, 0);
    s.scale.set(1, 0.7, 1);
  }
  const logG = new THREE.CylinderGeometry(0.08, 0.1, 1.1, 6).rotateZ(Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const l = add(new THREE.Mesh(logG, M.wood));
    l.position.y = 0.12;
    l.rotation.set(0, i * Math.PI / 4, 0.25);
  }
  const charcoal = add(new THREE.Mesh(new THREE.CircleGeometry(0.55, 12).rotateX(-Math.PI / 2), M.ember), false, false);
  charcoal.position.y = 0.04;
  charcoal.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.35, 0.08) });
  const fire = new Fire(1, 16, 24);
  fire.group.position.y = 0.05;
  g.add(fire.group);
  world.flames.push(fire);

  // Tent: triangular prism
  const tentG = new THREE.CylinderGeometry(1.6, 1.6, 3.4, 3, 1, true).rotateZ(Math.PI / 2).rotateX(Math.PI / 6);
  const tent = add(new THREE.Mesh(tentG, M.canvas), true);
  tent.position.set(4.2, 0.8, -1.2);
  tent.rotation.y = 0.5;
  const pole = new THREE.CylinderGeometry(0.04, 0.04, 2.6, 5);
  for (const s of [-1, 1]) {
    const p = add(new THREE.Mesh(pole, M.wood));
    p.position.set(4.2 + Math.cos(0.5) * 1.75 * s, 1.2, -1.2 - Math.sin(0.5) * 1.75 * s);
  }

  // Log benches
  const bench = new THREE.CylinderGeometry(0.22, 0.24, 2.2, 8).rotateZ(Math.PI / 2);
  for (const [x, z, r] of [[-2.2, 0.6, 1.2], [0.4, 2.4, 0.1], [0.9, -2.3, -0.2]]) {
    const b = add(new THREE.Mesh(bench, M.wood), true);
    b.position.set(x, 0.2, z);
    b.rotation.y = r;
  }

  // Bedroll
  const roll = add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 2.0), M.cloth));
  roll.position.set(2.4, 0.05, 1.6);
  roll.rotation.y = 0.9;

  // Warden's banner
  const bp = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 4, 6), M.wood), true);
  bp.position.set(-3.0, 2, -2.4);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.8, 6, 10), new THREE.MeshStandardMaterial({ color: 0x2a4f6a, roughness: 0.9, side: THREE.DoubleSide }));
  banner.position.set(-2.48, 2.9, -2.4);
  banner.castShadow = true;
  g.add(banner);
  const sunEmblem = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), new THREE.MeshStandardMaterial({ color: 0xd8a640, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }));
  sunEmblem.position.set(-2.48, 3.2, -2.39);
  g.add(sunEmblem);
  const bPos = banner.geometry.attributes.position;
  const bBase = Float32Array.from(bPos.array);
  world.flames.push({
    update(dt, t) {
      const g = gustAt(CAMP.x - 3, CAMP.z - 2.4);
      const amp = 0.03 + g * 0.14, spd = 2 + g * 4;
      for (let i = 0; i < bPos.count; i++) {
        const x = bBase[i * 3] + 0.5;
        bPos.setZ(i, Math.sin(t * spd + x * 4) * amp * x + Math.sin(t * spd * 1.8 + bBase[i * 3 + 1] * 3) * amp * 0.35 * x);
      }
      bPos.needsUpdate = true;
      banner.geometry.computeVertexNormals();
      sunEmblem.position.z = -2.39 + Math.sin(t * 3 + 2) * 0.04;
    },
  });

  // Supplies
  const crate = new THREE.BoxGeometry(0.6, 0.5, 0.6);
  for (const [x, z, r] of [[5.6, 1.5, 0.3], [6.1, 0.9, 0.9]]) {
    const c = add(new THREE.Mesh(crate, M.wood), true);
    c.position.set(x, 0.25, z); c.rotation.y = r;
  }

  world.interactables.push({
    type: 'rest', position: new THREE.Vector3(CAMP.x, y0, CAMP.z), radius: 2.6,
    prompt: 'Rest at the campfire',
  });
  // spawn just south of the fire, facing the road
  const spawn = new THREE.Vector3(CAMP.x - 2.5, y0 + 0.5, CAMP.z + 2);
  return { group: g, fire, spawn, spawnYaw: Math.atan2(roadX(40) - spawn.x, 40 - spawn.z) };
}
