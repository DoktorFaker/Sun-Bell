import * as THREE from 'three';

const damp = (a, b, k, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-k * dt));
const atlases = {};

/** Load a packed sprite atlas from public/sprites/<name>.png + .json (once). */
export async function loadAtlas(name) {
  if (atlases[name]) return atlases[name];
  const [meta, tex] = await Promise.all([
    fetch(`sprites/${name}.json`).then((r) => r.json()),
    new THREE.TextureLoader().loadAsync(`sprites/${name}.png`),
  ]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  atlases[name] = { meta, tex };
  return atlases[name];
}
export function getAtlas(name) {
  if (!atlases[name]) throw new Error(`sprite atlas "${name}" not loaded`);
  return atlases[name];
}

function makeMaterial(tex, glowCyan, glowHot) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  mat.userData.flash = { value: 0 };
  mat.userData.glow = { value: 1 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlash = mat.userData.flash;
    shader.uniforms.uGlow = mat.userData.glow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFlash;\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 c = diffuseColor.rgb;
          float cyan = smoothstep(0.08, 0.3, c.b - c.r) * smoothstep(0.25, 0.6, c.b);
          float hot = smoothstep(0.35, 0.6, c.r - c.b) * smoothstep(0.55, 0.85, c.r);
          totalEmissiveRadiance += c * (cyan * ${glowCyan.toFixed(2)} + hot * ${glowHot.toFixed(2)}) * uGlow + vec3(uFlash * 2.5);
        }`);
  };
  mat.customProgramCacheKey = () => `sprite-${glowCyan}-${glowHot}`;
  return mat;
}

/**
 * A camera-facing (cylindrical) sprite body standing on its feet.
 * The art in the sheets faces screen-right, so it mirrors to face its target.
 */
export class SpriteBody {
  static camera = null;

  constructor(atlasName, { ppm = 235, glowCyan = 0, glowHot = 0 } = {}) {
    this.atlas = getAtlas(atlasName);
    this.ppm = ppm;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(8), 2));
    const n = new THREE.Vector3(0, 0.45, 1).normalize();
    g.setAttribute('normal', new THREE.Float32BufferAttribute([n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.geo = g;
    this.mat = makeMaterial(this.atlas.tex, glowCyan, glowHot);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.castShadow = true;
    this.object = new THREE.Group();
    this.object.add(this.mesh);
    this.frame = -1;
    this.flip = 1;
    this.setFrame(0);
  }

  get flash() { return this.mat.userData.flash.value; }
  set flash(v) { this.mat.userData.flash.value = v; }
  get glow() { return this.mat.userData.glow.value; }
  set glow(v) { this.mat.userData.glow.value = v; }

  /** Converts a pixel position in a frame (from its top-left, original sheet scale) to sprite-local metres. */
  local(frame, px, py) {
    const m = this.atlas.meta.frames[frame];
    const s = 1 / this.ppm;
    return new THREE.Vector3((px * m.scale - m.ax) * s / m.scale, (m.h / m.scale - py) * s, 0.05);
  }

  setFrame(i) {
    if (i === this.frame) return;
    this.frame = i;
    const A = this.atlas.meta, m = A.frames[i];
    const s = 1 / (this.ppm * m.scale);
    const x0 = -m.ax * s, x1 = (m.w - m.ax) * s, h = m.h * s;
    this.geo.attributes.position.array.set([x0, 0, 0, x1, 0, 0, x1, h, 0, x0, h, 0]);
    const u0 = m.x / A.width, u1 = (m.x + m.w) / A.width, v0 = 1 - (m.y + m.h) / A.height, v1 = 1 - m.y / A.height;
    this.geo.attributes.uv.array.set([u0, v0, u1, v0, u1, v1, u0, v1]);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  /** Place at pos, billboard to the camera and mirror towards facing yaw. */
  update(dt, pos, yaw, { lift = 0, speed = 0, wobble = 0 } = {}) {
    const cam = SpriteBody.camera;
    this.object.position.set(pos.x, pos.y + lift, pos.z);
    if (cam) {
      const ry = Math.atan2(cam.position.x - pos.x, cam.position.z - pos.z);
      this.object.rotation.y = ry;
      const side = Math.cos(ry) * Math.sin(yaw) - Math.sin(ry) * Math.cos(yaw); // camera-right · facing
      if (Math.abs(side) > 0.15) this.flip = side > 0 ? 1 : -1;
      this.mesh.scale.x = damp(this.mesh.scale.x, this.flip, 18, dt);
    }
    const t = performance.now();
    const k = Math.min(1, speed / 3);
    this.mesh.position.y = Math.abs(Math.sin(t * 0.025)) * 0.025 * k;
    this.mesh.rotation.z = Math.sin(t * 0.013) * 0.015 * k + Math.sin(t * 0.0021) * wobble;
  }
}
