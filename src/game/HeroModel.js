import * as THREE from 'three';

// Procedural low-poly warden with sword and shield, posed by code.
export function buildHeroModel() {
  const mats = {
    tunic: new THREE.MeshStandardMaterial({ color: 0x2f5d6e, roughness: 0.85 }),
    tunicDark: new THREE.MeshStandardMaterial({ color: 0x1f3c48, roughness: 0.9 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd9a37c, roughness: 0.7 }),
    hair: new THREE.MeshStandardMaterial({ color: 0x3b2516, roughness: 0.8 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 1, roughness: 0.22 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd4a548, metalness: 1, roughness: 0.32 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6a4428, roughness: 0.8 }),
    cloak: new THREE.MeshStandardMaterial({ color: 0x8b3326, roughness: 0.9, side: THREE.DoubleSide }),
  };
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
  };
  const cap = (r, l, seg = 6) => new THREE.CapsuleGeometry(r, l, 3, seg);

  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.95; root.add(hips);
  const spine = new THREE.Group(); spine.position.y = 0.05; hips.add(spine);
  // pelvis & torso
  hips.add(mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.26, 8), mats.leather, 0, 0, 0));
  spine.add(mesh(cap(0.2, 0.32, 8), mats.tunic, 0, 0.28, 0));
  spine.add(mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.07, 10), mats.leather, 0, 0.1, 0)); // belt
  spine.add(mesh(new THREE.BoxGeometry(0.08, 0.05, 0.03), mats.gold, 0, 0.1, 0.235));
  // skirt (tunic tail)
  const skirt = mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.32, 10, 1, true), mats.tunicDark, 0, -0.14, 0);
  skirt.material = mats.tunicDark.clone(); skirt.material.side = THREE.DoubleSide;
  hips.add(skirt);
  // pauldrons
  for (const s of [-1, 1]) spine.add(mesh(new THREE.SphereGeometry(0.11, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), mats.leather, s * 0.24, 0.48, 0));
  // head
  const neck = new THREE.Group(); neck.position.y = 0.56; spine.add(neck);
  neck.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 6), mats.skin, 0, 0.03, 0));
  const head = mesh(new THREE.SphereGeometry(0.135, 12, 10), mats.skin, 0, 0.18, 0.0);
  head.scale.set(0.95, 1.08, 1.0);
  neck.add(head);
  const hair = mesh(new THREE.SphereGeometry(0.145, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mats.hair, 0, 0.2, -0.015);
  neck.add(hair);
  neck.add(mesh(new THREE.CapsuleGeometry(0.05, 0.12, 2, 6), mats.hair, 0, 0.12, -0.13)); // ponytail
  // cloak
  const cloakGeo = new THREE.PlaneGeometry(0.4, 0.78, 4, 6).translate(0, -0.39, 0);
  const cloak = mesh(cloakGeo, mats.cloak, 0, 0.5, -0.19);
  spine.add(cloak);

  // arms
  const makeArm = (side) => {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 0.27, 0.44, 0); spine.add(shoulder);
    shoulder.add(mesh(cap(0.06, 0.22), mats.tunic, 0, -0.14, 0));
    const elbow = new THREE.Group(); elbow.position.y = -0.3; shoulder.add(elbow);
    elbow.add(mesh(cap(0.055, 0.2), mats.leather, 0, -0.13, 0));
    const hand = new THREE.Group(); hand.position.y = -0.3; elbow.add(hand);
    hand.add(mesh(new THREE.SphereGeometry(0.055, 8, 6), mats.skin, 0, 0, 0));
    return { shoulder, elbow, hand };
  };
  const armR = makeArm(-1), armL = makeArm(1);   // model faces +Z, so right arm is at -X

  // legs
  const makeLeg = (side) => {
    const hip = new THREE.Group(); hip.position.set(side * 0.11, -0.05, 0); hips.add(hip);
    hip.add(mesh(cap(0.08, 0.28), mats.tunicDark, 0, -0.2, 0));
    const knee = new THREE.Group(); knee.position.y = -0.42; hip.add(knee);
    knee.add(mesh(cap(0.07, 0.26), mats.leather, 0, -0.2, 0));
    const foot = mesh(new THREE.BoxGeometry(0.11, 0.08, 0.24), mats.leather, 0, -0.43, 0.05);
    knee.add(foot);
    return { hip, knee };
  };
  const legR = makeLeg(-1), legL = makeLeg(1);

  // sword (in right hand, blade along +Y of the grip group, rotated forward)
  const sword = new THREE.Group();
  sword.add(mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 6), mats.leather, 0, 0, 0));
  sword.add(mesh(new THREE.BoxGeometry(0.26, 0.04, 0.05), mats.gold, 0, 0.11, 0));
  sword.add(mesh(new THREE.SphereGeometry(0.035, 6, 4), mats.gold, 0, -0.11, 0));
  const bladeGeo = new THREE.BoxGeometry(0.07, 0.95, 0.012);
  const bp = bladeGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) if (bp.getY(i) > 0.4) bp.setX(i, bp.getX(i) * 0.25); // tapered tip
  bladeGeo.computeVertexNormals();
  sword.add(mesh(bladeGeo, mats.steel, 0, 0.6, 0));
  sword.rotation.x = Math.PI / 2;
  armR.hand.add(sword);
  const bladeBase = new THREE.Object3D(); bladeBase.position.y = 0.18; sword.add(bladeBase);
  const bladeTip = new THREE.Object3D(); bladeTip.position.y = 1.06; sword.add(bladeTip);

  // shield (on left forearm)
  const shield = new THREE.Group();
  const disc = mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 20), mats.wood);
  disc.rotation.x = Math.PI / 2; shield.add(disc);
  const rim = mesh(new THREE.TorusGeometry(0.34, 0.025, 6, 24), mats.gold); shield.add(rim);
  const boss = mesh(new THREE.SphereGeometry(0.08, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), mats.gold, 0, 0, 0.03);
  boss.rotation.x = Math.PI / 2; shield.add(boss);
  for (let i = 0; i < 8; i++) {
    const ray = mesh(new THREE.BoxGeometry(0.03, 0.16, 0.01), mats.gold);
    const a = i / 8 * Math.PI * 2;
    ray.position.set(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.03); ray.rotation.z = a - Math.PI / 2;
    shield.add(ray);
  }
  shield.position.set(0.07, -0.12, 0.02);
  shield.rotation.y = Math.PI / 2;
  armL.elbow.add(shield);

  return { root, hips, spine, neck, armR, armL, legR, legL, sword, shield, cloak, bladeBase, bladeTip, mats };
}
