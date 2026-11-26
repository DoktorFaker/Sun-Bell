import * as THREE from 'three';

// ------------------------------------------------------------------
// Procedural, tileable PBR textures generated at load time.
// Each texture = albedo (sRGB) + normal map (from a height field).
// ------------------------------------------------------------------

function rngf(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

class Tile {
  constructor(seed) {
    const r = rngf(seed);
    this.p = new Uint8Array(512);
    const a = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    for (let i = 0; i < 512; i++) this.p[i] = a[i & 255];
    this.g = new Float32Array(256); for (let i = 0; i < 256; i++) this.g[i] = r();
  }
  h(x, y) { return this.g[this.p[this.p[x & 255] + (y & 255)]]; }
  /** periodic value noise, period P (integer lattice cells) */
  n(x, y, P) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P, x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
    const a = this.h(x0, y0), b = this.h(x1, y0), c = this.h(x0, y1), d = this.h(x1, y1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  /** periodic fbm over uv in [0,1) */
  fbm(u, v, base, oct, gain = 0.5) {
    let s = 0, amp = 0.5, f = base, n = 0;
    for (let i = 0; i < oct; i++) { s += amp * this.n(u * f, v * f, f); n += amp; amp *= gain; f *= 2; }
    return s / n;
  }
  /** periodic worley: returns [F1, F2, cellId] */
  worley(u, v, cells) {
    const x = u * cells, y = v * cells;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
      const px = cx + this.h(wx, wy), py = cy + this.h(wx + 37, wy + 91);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; id = this.h(wx + 11, wy + 5); } else if (d < f2) f2 = d;
    }
    return [f1, f2, id];
  }
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mix = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * gen(u, v) -> [height 0..1, r, g, b] (colour 0..1, sRGB)
 */
function build(size, gen, { normalStrength = 2.5 } = {}) {
  const H = new Float32Array(size * size);
  const C = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [h, r, g, b] = gen(x / size, y / size);
      const i = y * size + x;
      H[i] = h;
      C[i * 4] = clamp01(r) * 255; C[i * 4 + 1] = clamp01(g) * 255; C[i * 4 + 2] = clamp01(b) * 255; C[i * 4 + 3] = h * 255;
    }
  }
  const N = new Uint8Array(size * size * 4);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * normalStrength * size / 256;
      const dy = (at(x, y + 1) - at(x, y - 1)) * normalStrength * size / 256;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      N[i] = (-dx / l * 0.5 + 0.5) * 255; N[i + 1] = (dy / l * 0.5 + 0.5) * 255; N[i + 2] = (1 / l * 0.5 + 0.5) * 255; N[i + 3] = 255;
    }
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(C, true), normal: mk(N, false) };
}

export const TEX = {};

export function generateTextures(size = 512) {
  const T = new Tile(7), T2 = new Tile(19), T3 = new Tile(31);

  // Meadow ground: clumpy grass with soil showing through
  TEX.grass = build(size, (u, v) => {
    const clump = T.fbm(u, v, 8, 5);
    const blades = T2.fbm(u * 1, v * 1, 64, 2) * 0.6 + T2.fbm(u, v, 128, 2) * 0.4;
    const soil = ss(0.62, 0.78, 1 - clump);
    const h = clamp01(0.55 * clump + 0.45 * blades - soil * 0.3);
    const tone = T3.fbm(u, v, 4, 3);
    let r = mix(0.24, 0.42, tone), g = mix(0.36, 0.48, tone), b = mix(0.10, 0.14, tone);
    const dry = ss(0.55, 0.8, T3.fbm(u + 0.3, v, 16, 3));
    r = mix(r, 0.55, dry * 0.5); g = mix(g, 0.5, dry * 0.4); b = mix(b, 0.22, dry * 0.4);
    const k = 0.55 + 0.55 * blades;
    r *= k; g *= k; b *= k;
    r = mix(r, 0.32, soil); g = mix(g, 0.24, soil); b = mix(b, 0.15, soil);
    return [h, r, g, b];
  }, { normalStrength: 3.5 });

  // Packed dirt / road with pebbles and ruts
  TEX.dirt = build(size, (u, v) => {
    const base = T.fbm(u + 0.5, v, 8, 6);
    const [f1, , id] = T2.worley(u, v, 24);
    const peb = ss(0.3, 0.16, f1) * (id > 0.7 ? 1 : 0) * 0.8;
    const fine = T3.fbm(u, v, 64, 3);
    const h = clamp01(base * 0.5 + fine * 0.25 + peb * 0.45);
    const t = T3.fbm(u, v, 6, 3);
    let r = mix(0.36, 0.50, t), g = mix(0.27, 0.38, t), b = mix(0.18, 0.25, t);
    const pc = 0.36 + id * 0.12;
    r = mix(r, pc, peb); g = mix(g, pc * 0.92, peb); b = mix(b, pc * 0.82, peb);
    const k = 0.75 + 0.4 * fine;
    return [h, r * k, g * k, b * k];
  }, { normalStrength: 3.0 });

  // Rock: layered, cracked, with lichen
  TEX.rock = build(size, (u, v) => {
    const ridge = 1 - Math.abs(T.fbm(u, v, 6, 6) * 2 - 1);
    const strata = 0.5 + 0.5 * Math.sin((v + T2.fbm(u, v, 4, 4) * 0.25) * Math.PI * 2 * 9);
    const [f1, f2] = T3.worley(u, v, 7);
    const crack = ss(0.0, 0.06, f2 - f1);
    const h = clamp01(ridge * 0.55 + strata * 0.2 + T2.fbm(u, v, 32, 3) * 0.3) * (0.55 + 0.45 * crack);
    const t = T2.fbm(u, v, 8, 4);
    let r = mix(0.40, 0.58, t), g = mix(0.38, 0.55, t), b = mix(0.35, 0.50, t);
    const lichen = ss(0.62, 0.75, T.fbm(u + 0.7, v + 0.2, 16, 4)) * ss(0.3, 0.6, h);
    r = mix(r, 0.62, lichen * 0.6); g = mix(g, 0.62, lichen * 0.6); b = mix(b, 0.35, lichen * 0.6);
    const k = 0.55 + 0.6 * h;
    return [h, r * k, g * k, b * k];
  }, { normalStrength: 4.0 });

  // River sand / wet mud
  TEX.sand = build(size, (u, v) => {
    const ripple = 0.5 + 0.5 * Math.sin((u * 14 + T.fbm(u, v, 4, 3) * 2.5) * Math.PI * 2);
    const grain = T2.fbm(u, v, 128, 2);
    const h = clamp01(ripple * 0.35 + grain * 0.4 + T3.fbm(u, v, 8, 4) * 0.25);
    const t = T3.fbm(u, v, 6, 3);
    const k = 0.8 + 0.3 * grain;
    return [h, mix(0.46, 0.58, t) * k, mix(0.40, 0.50, t) * k, mix(0.30, 0.38, t) * k];
  }, { normalStrength: 2.0 });

  // Cut stone blocks (temple, walls)
  TEX.bricks = build(size, (u, v) => {
    const rows = 6, cols = 3;
    const ry = v * rows, row = Math.floor(ry);
    const off = (row % 2) * 0.5;
    const rx = u * cols + off, col = Math.floor(rx);
    const fx = rx - col, fy = ry - row;
    const edge = Math.min(fx, 1 - fx, (fy) * cols / rows * 2, (1 - fy) * cols / rows * 2);
    const chip = T.fbm(u, v, 16, 4);
    const mortar = ss(0.015, 0.05 + chip * 0.03, edge);
    const id = T2.h(((col % cols) + cols) % cols, row % rows);
    const surf = T3.fbm(u, v, 16, 5);
    const h = clamp01(mortar * (0.7 + surf * 0.3));
    const tone = 0.75 + id * 0.3;
    let r = 0.62 * tone, g = 0.57 * tone, b = 0.48 * tone;
    const k = 0.7 + 0.45 * surf;
    r *= k; g *= k; b *= k;
    const moss = ss(0.66, 0.8, T.fbm(u + 0.2, v, 8, 4)) * 0.6;
    r = mix(r, 0.3, moss); g = mix(g, 0.38, moss); b = mix(b, 0.16, moss);
    r = mix(0.28, r, mortar); g = mix(0.26, g, mortar); b = mix(0.22, b, mortar);
    return [h, r, g, b];
  }, { normalStrength: 3.0 });

  // Bark: vertical fibrous furrows
  TEX.bark = build(size, (u, v) => {
    const fur = T.fbm(u, v * 0.125, 16, 5);   // stretched along v
    const ridges = 1 - Math.abs(Math.sin((u * 10 + fur * 2.2) * Math.PI));
    const fine = T2.fbm(u, v, 64, 3);
    const h = clamp01(ridges * 0.65 + fine * 0.35);
    const t = T3.fbm(u, v, 8, 3);
    const k = 0.45 + 0.7 * h;
    return [h, mix(0.30, 0.42, t) * k, mix(0.22, 0.30, t) * k, mix(0.15, 0.20, t) * k];
  }, { normalStrength: 4.5 });

  // Planks: grain + seams
  TEX.planks = build(size, (u, v) => {
    const boards = 4;
    const bx = u * boards, bi = Math.floor(bx), fx = bx - bi;
    const seam = ss(0.0, 0.03, Math.min(fx, 1 - fx));
    const bid = T.h(bi % boards, 3);
    const grain = 0.5 + 0.5 * Math.sin((fx * 6 + T2.fbm(u, v, 4, 4) * 3 + bid * 5) * Math.PI * 2 + v * 2);
    const fine = T3.fbm(u * 1, v, 64, 2);
    const knot = ss(0.12, 0.0, T.worley(u, v, 5)[0]) * (bid > 0.5 ? 1 : 0);
    const h = clamp01(seam * (0.6 + grain * 0.25 + fine * 0.15) - knot * 0.3);
    const tone = 0.8 + bid * 0.35;
    const k = (0.7 + 0.3 * grain) * tone;
    let r = 0.52 * k, g = 0.36 * k, b = 0.22 * k;
    r = mix(0.12, r, seam); g = mix(0.08, g, seam); b = mix(0.05, b, seam);
    r = mix(r, 0.25, knot); g = mix(g, 0.15, knot); b = mix(b, 0.08, knot);
    return [h, r, g, b];
  }, { normalStrength: 3.0 });

  // Woven cloth (tunics, banners, tents)
  TEX.cloth = build(256, (u, v) => {
    const w1 = 0.5 + 0.5 * Math.sin(u * 128 * Math.PI * 2), w2 = 0.5 + 0.5 * Math.sin(v * 128 * Math.PI * 2);
    const h = clamp01((w1 * 0.5 + w2 * 0.5) * 0.7 + T.fbm(u, v, 32, 3) * 0.3);
    const k = 0.85 + 0.15 * h;
    return [h, k, k, k];
  }, { normalStrength: 1.5 });

  // Water ripples (normal source only)
  TEX.water = build(256, (u, v) => {
    let h = 0;
    for (let i = 0; i < 6; i++) h += T3.fbm(u, v, 4 << (i % 3), 3) * (1 / (i + 1));
    h = h / 2.45;
    return [clamp01(h), 0, 0, 0];
  }, { normalStrength: 2.0 });

  return TEX;
}

// ------------------------------------------------------------------
// Shader helpers
// ------------------------------------------------------------------

/** GLSL: triplanar sample (albedo + world-space normal) */
export const triplanarGLSL = /* glsl */ `
vec3 tpBlend(vec3 n) { vec3 b = pow(abs(n), vec3(4.0)); return b / (b.x + b.y + b.z); }
vec4 tpAlbedo(sampler2D t, vec3 p, vec3 n, float s) {
  vec3 b = tpBlend(n);
  return texture(t, p.zy * s) * b.x + texture(t, p.xz * s) * b.y + texture(t, p.xy * s) * b.z;
}
vec3 tpNormal(sampler2D t, vec3 p, vec3 n, float s, float k) {
  vec3 b = tpBlend(n);
  vec3 tx = texture(t, p.zy * s).xyz * 2.0 - 1.0;
  vec3 ty = texture(t, p.xz * s).xyz * 2.0 - 1.0;
  vec3 tz = texture(t, p.xy * s).xyz * 2.0 - 1.0;
  tx.xy *= k; ty.xy *= k; tz.xy *= k;
  // whiteout blend per projection, swizzled into world space
  vec3 nx = vec3(n.x, tx.y + n.y, tx.x + n.z) * vec3(1.0, 1.0, 1.0);
  vec3 ny = vec3(ty.x + n.x, n.y, ty.y + n.z);
  vec3 nz = vec3(tz.x + n.x, tz.y + n.y, n.z);
  return normalize(nx * b.x + ny * b.y + nz * b.z);
}
`;

/**
 * Turn a MeshStandardMaterial into a triplanar-textured one (world space, works with instancing).
 * opts: { tex, scale, normalScale, tint (Color), macro (0..1) }
 */
export function triplanar(mat, { tex, scale = 0.5, normalScale = 1, tint = null, macro = 0.25, wind = 0 } = {}) {
  // photo textures come in brighter than the generated ones
  const uniforms = { tAlb: { value: tex.map }, tNrm: { value: tex.normal }, uScale: { value: scale }, uNS: { value: normalScale }, uMacro: { value: macro }, uGain: { value: tex.custom ? 1.15 : 1.6 } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTPPos;\nvarying vec3 vTPNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 tp = vec4(transformed, 1.0);
          vec3 tn = objectNormal;
          #ifdef USE_INSTANCING
          tp = instanceMatrix * tp; tn = mat3(instanceMatrix) * tn;
          #endif
          vTPPos = (modelMatrix * tp).xyz;
          vTPNrm = normalize(mat3(modelMatrix) * tn);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTPPos; varying vec3 vTPNrm;
        uniform sampler2D tAlb; uniform sampler2D tNrm; uniform float uScale; uniform float uNS; uniform float uMacro; uniform float uGain;
        ${triplanarGLSL}`)
      .replace('#include <map_fragment>', `
        vec3 tpN = normalize(vTPNrm);
        vec4 tpA = tpAlbedo(tAlb, vTPPos, tpN, uScale);
        vec4 tpA2 = tpAlbedo(tAlb, vTPPos * 0.21 + 3.7, tpN, uScale);
        diffuseColor.rgb *= mix(tpA.rgb, tpA.rgb * (0.7 + 0.6 * tpA2.rgb), uMacro) * uGain;
        float tpH = tpA.a;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (0.5 - tpH) * 0.25, 0.05, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wn = tpNormal(tNrm, vTPPos, tpN, uScale, uNS);
          if (!gl_FrontFacing) wn = -wn;
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`);
    if (mat.userData.afterCompile) mat.userData.afterCompile(shader);
  };
  mat.customProgramCacheKey = () => `tp-${tex.custom ? 'c' : 'g'}-${scale}-${normalScale}-${wind}-${mat.userData.key || ''}`;
  return mat;
}

// ------------------------------------------------------------------
// Drop-in overrides: put an image in public/textures/<name>.(png|jpg|webp)
// and it replaces the generated texture. A normal map is derived from it,
// or supplied as <name>_normal.(png|jpg|webp).
// ------------------------------------------------------------------
export const OVERRIDABLE = ['grass', 'dirt', 'rock', 'sand', 'bricks', 'bark', 'planks', 'cloth', 'iron', 'roof', 'leather', 'cobble'];

function loadImage(url) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img.naturalWidth > 4 ? img : null);
    img.onerror = () => res(null);
    img.src = url;
  });
}
async function firstImage(base) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const img = await loadImage(`${base}.${ext}`);
    if (img) return img;
  }
  return null;
}
function pixels(img, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}
function dataTex(data, size, srgb) {
  const t = new THREE.DataTexture(new Uint8Array(data), size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
  return t;
}

/** Returns the list of textures that were replaced. */
export async function loadTextureOverrides(maxSize = 1024) {
  const used = [];
  await Promise.all(OVERRIDABLE.map(async (name) => {
    const img = await firstImage(`textures/${name}`);
    if (!img) return;
    const size = Math.min(maxSize, 2 ** Math.floor(Math.log2(Math.min(img.naturalWidth, img.naturalHeight))));
    const px = pixels(img, size);
    // height from luminance (stored in alpha, used for layer blending and roughness)
    const H = new Float32Array(size * size);
    let lo = 1, hi = 0;
    for (let i = 0; i < size * size; i++) { const l = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) / 255; H[i] = l; lo = Math.min(lo, l); hi = Math.max(hi, l); }
    const span = Math.max(0.05, hi - lo);
    for (let i = 0; i < size * size; i++) { H[i] = (H[i] - lo) / span; px[i * 4 + 3] = H[i] * 255; }
    let normal;
    const nImg = await firstImage(`textures/${name}_normal`);
    if (nImg) normal = dataTex(pixels(nImg, size), size, false);
    else {
      const N = new Uint8Array(size * size * 4);
      const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
      const k = 2.2 * size / 256;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * k, dy = (at(x, y + 1) - at(x, y - 1)) * k;
        const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
        N[i] = (-dx / l * 0.5 + 0.5) * 255; N[i + 1] = (dy / l * 0.5 + 0.5) * 255; N[i + 2] = (1 / l * 0.5 + 0.5) * 255; N[i + 3] = 255;
      }
      normal = dataTex(N, size, false);
    }
    TEX[name] = { map: dataTex(px, size, true), normal, custom: true };
    used.push(name);
  }));
  return used;
}
