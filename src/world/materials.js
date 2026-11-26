import * as THREE from 'three';
import { TEX, triplanar, triplanarGLSL } from './textures.js';
import { WIND, windGLSL, treeWindVertex } from './wind.js';
import { BRANCH } from './trees.js';

const noiseGLSL = /* glsl */ `
float dn_hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float dn_noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dn_hash(i), dn_hash(i + vec3(1,0,0)), f.x), mix(dn_hash(i + vec3(0,1,0)), dn_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dn_hash(i + vec3(0,0,1)), dn_hash(i + vec3(1,0,1)), f.x), mix(dn_hash(i + vec3(0,1,1)), dn_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float dn_fbm(vec3 p) { return dn_noise(p) * 0.5 + dn_noise(p * 2.13) * 0.3 + dn_noise(p * 4.7) * 0.2; }
`;

/**
 * Adds world-space procedural detail to a standard material: albedo variation
 * and roughness variation, so flat-coloured meshes read as stone, bark, earth.
 */
export function withDetail(material, { scale = 1.5, amount = 0.35, roughAmount = 0.15, wind = 0 } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vDetailPos;\nuniform float uTime;\n${noiseGLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${wind > 0 ? `
        {
          #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          #else
          vec3 ip = vec3(0.0);
          #endif
          float sway = sin(uTime * 1.3 + ip.x * 0.11 + ip.z * 0.07) * 0.5 + sin(uTime * 2.7 + ip.x * 0.3) * 0.2;
          float hgt = max(position.y, 0.0);
          transformed.x += sway * ${wind.toFixed(3)} * hgt * hgt * 0.04;
          transformed.z += sway * ${wind.toFixed(3)} * hgt * hgt * 0.02;
        }` : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 wp4 = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
          #endif
          vDetailPos = (modelMatrix * wp4).xyz;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vDetailPos;\n${noiseGLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dnv = dn_fbm(vDetailPos * ${scale.toFixed(3)});
        diffuseColor.rgb *= 1.0 + (dnv - 0.5) * ${(amount * 2).toFixed(3)};`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (dnv - 0.5) * ${(roughAmount * 2).toFixed(3)}, 0.04, 1.0);`);
  };
  material.customProgramCacheKey = () => `detail-${scale}-${amount}-${roughAmount}-${wind}`;
  return material;
}

export const windTime = { value: 0 };

export const M = {};
/** Add the shared wind field to a material's vertex stage. */
function addWind(shader, vertexCode) {
  Object.assign(shader.uniforms, WIND);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${windGLSL}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexCode}`);
}

function foliage(mat) {
  const cards = !!mat.map;
  mat.onBeforeCompile = (shader) => {
    addWind(shader, treeWindVertex(true));
    // branch cards: keep the soft crown normal on both faces (no back-face flip)
    if (cards) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
    // a touch of light coming through the leaves
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += diffuseColor.rgb * 0.06;`);
  };
  mat.customProgramCacheKey = () => `foliage-wind-${cards}`;
  return mat;
}

export function makeMaterials() {
  M.stone = triplanar(new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.88 }), { tex: TEX.bricks, scale: 0.42, normalScale: 1.1 });
  M.stoneDark = triplanar(new THREE.MeshStandardMaterial({ color: 0x8c8476, roughness: 0.9 }), { tex: TEX.bricks, scale: 0.42, normalScale: 1.1 });
  M.stoneDark.userData.key = 'dark';
  M.rock = triplanar(new THREE.MeshStandardMaterial({ color: 0xc4beb4, roughness: 0.92 }), { tex: TEX.cliff || TEX.rock, scale: TEX.cliff ? 0.16 : 0.32, normalScale: 1.3, macro: 0.4 });
  M.road = triplanar(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), { tex: TEX.dirt, scale: 0.35 });
  M.bark = triplanar(new THREE.MeshStandardMaterial({ color: 0xd8d0c8, roughness: 0.95 }), { tex: TEX.bark, scale: 0.9, normalScale: 1.4, wind: 1 });
  M.bark.userData.afterCompile = (shader) => addWind(shader, treeWindVertex(false));
  if (BRANCH.pine && BRANCH.leaf) {
    const cardMat = (map) => new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.82, alphaTest: 0.42, side: THREE.DoubleSide });
    M.pine = foliage(cardMat(BRANCH.pine));
    M.leaf = foliage(cardMat(BRANCH.leaf));
  } else {
    M.pine = foliage(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
    M.leaf = foliage(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }));
  }
  M.wood = triplanar(new THREE.MeshStandardMaterial({ color: 0xe0d4c4, roughness: 0.8 }), { tex: TEX.planks, scale: 0.55, normalScale: 1.0 });
  M.canvas = triplanar(new THREE.MeshStandardMaterial({ color: 0xc8b496, roughness: 0.95, side: THREE.DoubleSide }), { tex: TEX.cloth, scale: 2.2, normalScale: 0.6 });
  M.cloth = new THREE.MeshStandardMaterial({ color: 0x7a2c22, roughness: 0.9, side: THREE.DoubleSide });
  M.bronze = new THREE.MeshStandardMaterial({ color: 0xb08a4a, metalness: 1, roughness: 0.38 });
  M.bronzeDull = withDetail(new THREE.MeshStandardMaterial({ color: 0x8a6a3e, metalness: 0.9, roughness: 0.6 }), { scale: 3, amount: 0.4 });
  M.sealDim = new THREE.MeshStandardMaterial({ color: 0x3a3020, emissive: 0xffa040, emissiveIntensity: 0.25, roughness: 0.6 });
  M.crystal = new THREE.MeshStandardMaterial({ color: 0x223344, emissive: 0x9fd4ff, emissiveIntensity: 6, roughness: 0.2 });
  M.ember = new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 3.2, 1.0) });
  M.roof = TEX.roof && TEX.roof.custom
    ? triplanar(new THREE.MeshStandardMaterial({ color: 0xe8e0d8, roughness: 0.9 }), { tex: TEX.roof, scale: 0.42, normalScale: 1.3 })
    : null;
  M.cobble = TEX.cobble && TEX.cobble.custom
    ? triplanar(new THREE.MeshStandardMaterial({ color: 0xe0d8d0, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { tex: TEX.cobble, scale: 0.28, normalScale: 1.4 })
    : null;
  M.terrain = makeTerrainMaterial();
  M.grass = makeGrassMaterial(BRANCH.grass, 1);
  M.reeds = BRANCH.reeds ? makeGrassMaterial(BRANCH.reeds, 0.22) : null;
  M.bush = BRANCH.bush ? makeGrassMaterial(BRANCH.bush, 0.06) : null;
  return M;
}

/**
 * Terrain: four texture layers (grass, dirt, rock, sand) blended per vertex (aSplat) with
 * height-based transitions, two-scale sampling against tiling, triplanar rock on slopes,
 * and wet, darker, glossier sand at the waterline.
 */
export function makeTerrainMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const U = {
    tGA: { value: TEX.grass.map }, tGN: { value: TEX.grass.normal },
    tDA: { value: TEX.dirt.map }, tDN: { value: TEX.dirt.normal },
    tRA: { value: TEX.rock.map }, tRN: { value: TEX.rock.normal },
    tSA: { value: TEX.sand.map }, tSN: { value: TEX.sand.normal },
    uWater: { value: 0 },
    // mountain photos: blocky outcrops and ridged slopes
    tCA: { value: (TEX.cliff || TEX.rock).map }, tCN: { value: (TEX.cliff || TEX.rock).normal },
    tC2A: { value: (TEX.cliff2 || TEX.cliff || TEX.rock).map }, tC2N: { value: (TEX.cliff2 || TEX.cliff || TEX.rock).normal },
    // per-layer brightness: photos (custom) are brighter than generated textures
    uGain: { value: new THREE.Vector4(TEX.grass.custom ? 0.68 : 1, TEX.dirt.custom ? 0.68 : 1, TEX.rock.custom ? 0.62 : 1, TEX.sand.custom ? 0.7 : 1) },
  };
  mat.userData.uniforms = U;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSplat;\nvarying vec4 vSplat;\nvarying vec3 vTPPos;\nvarying vec3 vTPNrm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSplat = aSplat;\nvTPPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTPNrm = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vSplat; varying vec3 vTPPos; varying vec3 vTPNrm;
        uniform sampler2D tGA, tGN, tDA, tDN, tRA, tRN, tSA, tSN, tCA, tCN, tC2A, tC2N;

        uniform float uWater;
        uniform vec4 uGain;
        ${triplanarGLSL}
        // two cliff photos, each sampled at two scales: near detail plus large shapes far away, so repeats don't show
        float cliffMix(vec3 p) { return smoothstep(0.35, 0.65, texture(tC2A, p.xz * 0.0021 + 0.3).g * 0.6 + sin(p.x * 0.011 + p.z * 0.007) * 0.25 + 0.2); }
        vec4 cliffAlb(vec3 p, vec3 n, float far) {
          vec4 a = mix(tpAlbedo(tCA, p, n, 0.075), tpAlbedo(tCA, p, n, 0.022), far);
          vec4 b = mix(tpAlbedo(tC2A, p, n, 0.055), tpAlbedo(tC2A, p, n, 0.017), far);
          return mix(a, b, cliffMix(p));
        }
        vec3 cliffNrm(vec3 p, vec3 n, float far) {
          vec3 a = tpNormal(tCN, p, n, mix(0.075, 0.022, far), 1.6);
          vec3 b = tpNormal(tC2N, p, n, mix(0.055, 0.017, far), 1.6);
          return normalize(mix(a, b, cliffMix(p)));
        }
        vec3 topN(sampler2D t, vec2 uv, vec3 n, float k) { vec3 ts = texture(t, uv).xyz * 2.0 - 1.0; return normalize(vec3(n.x + ts.x * k, n.y, n.z + ts.y * k)); }`)
      .replace('#include <map_fragment>', `
        vec3 tn = normalize(vTPNrm);
        vec2 uv = vTPPos.xz;
        vec4 gA = texture(tGA, uv * 0.26), gB = texture(tGA, uv * 0.061 + 0.37);
        vec4 dA = texture(tDA, uv * 0.3), dB = texture(tDA, uv * 0.07 + 0.11);
        vec4 sA = texture(tSA, uv * 0.33);
        float camD = length(vTPPos - cameraPosition);
        float farK = smoothstep(60.0, 260.0, camD) * 0.75;
        vec4 rA = tpAlbedo(tRA, vTPPos, tn, 0.16);
        // steep and high ground is mountain: use the cliff photos there
        float mtn = clamp(smoothstep(0.82, 0.55, tn.y) + smoothstep(18.0, 45.0, vTPPos.y), 0.0, 1.0);
        vec4 cA = cliffAlb(vTPPos, tn, farK);
        rA = mix(rA * uGain.z, cA * 0.62, mtn); rA.a = mix(rA.a, 0.6, mtn);
        vec3 grassC = gA.rgb * (0.62 + 0.76 * gB.rgb) * uGain.x;
        vec3 dirtC = dA.rgb * (0.7 + 0.6 * dB.rgb) * uGain.y;
        sA.rgb *= uGain.w;
        vec4 w = max(vSplat, 0.0) + 1e-4;
        w *= vec4(gA.a + 0.35, dA.a + 0.35, rA.a + 0.35, sA.a + 0.35);
        w = pow(w, vec4(4.0)); w /= (w.x + w.y + w.z + w.w);
        w = mix(w, vec4(0.0, 0.0, 1.0, 0.0), mtn * 0.85);
        vec3 alb = grassC * w.x + dirtC * w.y + rA.rgb * w.z + sA.rgb * w.w;
        float wet = smoothstep(uWater + 0.5, uWater - 0.05, vTPPos.y) * (w.w + w.y * 0.6);
        alb *= 1.0 - wet * 0.45;
        diffuseColor.rgb *= alb * 1.75;
        vec4 tW = w; float tMtn = mtn;`)
      .replace('#include <color_fragment>', `
        #if defined( USE_COLOR )
          diffuseColor.rgb *= mix(vColor.rgb, vec3(0.92), tMtn);   // the photos carry their own colour on the mountains
        #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(dot(tW, vec4(0.97, 0.9, 0.82, 0.8)) - wet * 0.55, 0.12, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 nG = topN(tGN, uv * 0.26, tn, 1.0);
          vec3 nD = topN(tDN, uv * 0.3, tn, 1.0);
          vec3 nS = topN(tSN, uv * 0.33, tn, 0.8);
          vec3 nR = normalize(mix(tpNormal(tRN, vTPPos, tn, 0.16, 1.3), cliffNrm(vTPPos, tn, farK), mtn));
          vec3 wn = normalize(nG * tW.x + nD * tW.y + nR * tW.z + nS * tW.w);
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`);
  };
  mat.customProgramCacheKey = () => 'terrain-splat';
  return mat;
}

/** Grass clumps that lean with gusts (visible rolling waves) and part around the warden, the truck and rotor wash. */
export function makeGrassMaterial(map = null, bend = 1) {
  const mat = map
    ? new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.85, alphaTest: 0.45, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WIND);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${windGLSL}\nvarying float vGust;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          float g = gust(ip.xz);
          vec2 push = pushAt(ip.xz, 0.0);
          float hy = position.y * position.y;
          float flick = sin(uTime * 3.1 + ip.x * 1.7 + ip.z * 1.3) * 0.25;
          vec2 b = uWindDir * (g * 0.9 + flick * g) + push * 1.6;
          mat3 im = mat3(instanceMatrix);
          vec3 lb = transpose(im) * vec3(b.x, 0.0, b.y) / max(dot(im[0], im[0]), 1e-4);
          transformed += lb * hy * ${(1.4 * bend).toFixed(3)};
          transformed.y -= length(b) * hy * ${(0.6 * bend).toFixed(3)};
          vGust = clamp(g * 0.6 + length(push) * 0.5, 0.0, 1.2);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGust;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 0.85 + vGust * 0.35;');
    if (map) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  mat.customProgramCacheKey = () => `grass-wind-${!!map}-${bend}`;
  return mat;
}

// ---------------- Sky ----------------
export function makeSky(sunDir) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir }, uTime: windTime,
      tSky: { value: BRANCH.sky }, uHasSky: { value: BRANCH.sky ? 1 : 0 },
      // turn the panorama so its brightest region sits behind the sun (bright area is ~19% across the image)
      uSkyOffset: { value: 0.19 - Math.atan2(sunDir.x, sunDir.z) / (Math.PI * 2) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
        vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform sampler2D tSky; uniform float uHasSky; uniform float uSkyOffset;
      uniform float uTime;
      varying vec3 vDir;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n(p); p *= 2.07; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float sd = dot(d, uSunDir);
        float up = max(d.y, 0.0);
        vec3 zenith = vec3(0.10, 0.20, 0.46) * 1.5;
        vec3 horSun = vec3(1.25, 0.70, 0.38) * 2.0;
        vec3 horAway = vec3(0.50, 0.55, 0.68) * 1.25;
        float side = pow(sd * 0.5 + 0.5, 2.5);
        vec3 hor = mix(horAway, horSun, side);
        vec3 col = mix(hor, zenith, pow(up, 0.45));
        // below horizon: dusky haze
        col = mix(col, hor * 0.55, smoothstep(0.0, -0.15, d.y));
        // clouds on a plane
        if (d.y > 0.01) {
          vec2 uv = d.xz / (d.y + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
          float c = smoothstep(0.48, 0.78, fbm(uv));
          float thin = smoothstep(0.35, 0.9, fbm(uv * 0.5 + 3.0));
          c *= thin;
          vec3 cc = mix(vec3(0.45, 0.42, 0.48), vec3(2.6, 1.6, 0.9), pow(sd * 0.5 + 0.5, 3.0));
          col = mix(col, cc * (0.9 + 0.3 * up), c * 0.85 * smoothstep(0.01, 0.12, d.y));
        }
        // photographed panorama (upper hemisphere: bottom of the image = horizon)
        if (uHasSky > 0.5) {
          float az = atan(d.x, d.z) / 6.2831853 + uSkyOffset;
          float el = clamp(asin(clamp(d.y, -1.0, 1.0)) / 1.5707963, 0.0, 1.0);
          vec3 photo = texture(tSky, vec2(fract(az), mix(0.004, 0.996, pow(el, 0.8)))).rgb;
          photo = pow(photo, vec3(1.08)) * 2.3;
          vec3 haze = texture(tSky, vec2(fract(az), 0.01)).rgb * 1.4;
          col = d.y >= 0.0 ? photo : mix(haze, haze * 0.5, smoothstep(0.0, -0.2, d.y));
        }
        // sun
        col += vec3(1.0, 0.75, 0.45) * (pow(max(sd, 0.0), 12.0) * 0.9 + pow(max(sd, 0.0), 180.0) * 5.0);
        col += vec3(1.0, 0.85, 0.6) * smoothstep(0.99965, 0.99985, sd) * 120.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  return sky;
}
