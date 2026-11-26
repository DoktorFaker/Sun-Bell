import * as THREE from 'three';

const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _tri = new THREE.Vector3();
const _cap = new THREE.Vector3();
const _ray = new THREE.Ray();
const _dir = new THREE.Vector3();

/**
 * Capsule vs BVH resolution (after the three-mesh-bvh character controller approach).
 * pos = feet position (mutated). Returns { onGround, delta }.
 */
export function resolveCapsule(collider, pos, radius, height) {
  _seg.start.set(pos.x, pos.y + radius, pos.z);
  _seg.end.set(pos.x, pos.y + height - radius, pos.z);
  _box.makeEmpty();
  _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
  _box.min.addScalar(-radius); _box.max.addScalar(radius);
  let groundNormalY = -1;
  collider.boundsTree.shapecast({
    intersectsBounds: (b) => b.intersectsBox(_box),
    intersectsTriangle: (tri) => {
      const dist = tri.closestPointToSegment(_seg, _tri, _cap);
      if (dist < radius) {
        const depth = radius - dist;
        _dir.subVectors(_cap, _tri).normalize();
        _seg.start.addScaledVector(_dir, depth);
        _seg.end.addScaledVector(_dir, depth);
        if (_dir.y > groundNormalY) groundNormalY = _dir.y;
      }
    },
  });
  const nx = _seg.start.x, ny = _seg.start.y - radius, nz = _seg.start.z;
  const delta = new THREE.Vector3(nx - pos.x, ny - pos.y, nz - pos.z);
  pos.set(nx, ny, nz);
  return { delta, groundNormalY };
}

/** Extra walkable surfaces that aren't in the static BVH (e.g. a bridge built at runtime). fn(x, z) -> height | null */
export const extraGround = { fn: null };
const _up = new THREE.Vector3(0, 1, 0);

/** Nearest surface straight below origin within maxDist (or null). */
export function probeDown(collider, origin, maxDist) {
  _ray.origin.copy(origin);
  _ray.direction.set(0, -1, 0);
  let hit = collider.boundsTree.raycastFirst(_ray, THREE.DoubleSide);
  if (hit && hit.distance > maxDist) hit = null;
  const g = extraGround.fn ? extraGround.fn(origin.x, origin.z) : null;
  if (g !== null && g <= origin.y && origin.y - g <= maxDist && (!hit || g > hit.point.y)) {
    return { point: new THREE.Vector3(origin.x, g, origin.z), distance: origin.y - g, face: { normal: _up } };
  }
  return hit;
}

export function rayHit(collider, origin, dir, maxDist) {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);
  const hit = collider.boundsTree.raycastFirst(_ray, THREE.DoubleSide, 0, maxDist);
  if (hit && hit.distance <= maxDist) return hit;
  return null;
}
