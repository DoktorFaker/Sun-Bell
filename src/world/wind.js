import * as THREE from 'three';

/**
 * One wind field shared by every shader and simulation: a slowly changing base strength,
 * gust fronts that roll across the valley along the wind direction, and "pushers"
 * (the warden, the truck, the helicopter's downwash) that bend grass and trees.
 */
export const WIND = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.82, 0.57).normalize() },
  uWindStrength: { value: 0.6 },
  uPush: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
};

export const windGLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform vec4 uPush[4];   // x, z, radius, strength
float w_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float w_noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(w_hash(i), w_hash(i + vec2(1, 0)), f.x), mix(w_hash(i + vec2(0, 1)), w_hash(i + vec2(1, 1)), f.x), f.y); }
// 0..~1.3: gust fronts travelling downwind
float gust(vec2 p) {
  float along = dot(p, uWindDir);
  float front = 0.5 + 0.5 * sin(along * 0.045 - uTime * 1.25 + w_noise(p * 0.012 + uTime * 0.03) * 5.0);
  front = front * front * front;
  float patchy = w_noise(p * 0.03 - uWindDir * uTime * 0.6);
  return uWindStrength * (0.3 + 1.1 * front * (0.6 + 0.6 * patchy));
}
// sideways push away from nearby movers (xz), scaled by strength
vec2 pushAt(vec2 p, float minRadius) {
  vec2 o = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 q = uPush[i];
    if (q.z < minRadius) continue;
    vec2 d = p - q.xy;
    float l = length(d);
    if (l < q.z && l > 0.001) o += d / l * (1.0 - l / q.z) * q.w;
  }
  return o;
}
`;

// JS mirror of the gust field, for cloth and particles
function h(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function n(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function gustAt(x, z) {
  const W = WIND, t = W.uTime.value, d = W.uWindDir.value;
  const along = x * d.x + z * d.y;
  let front = 0.5 + 0.5 * Math.sin(along * 0.045 - t * 1.25 + n(x * 0.012 + t * 0.03, z * 0.012 + t * 0.03) * 5);
  front = front * front * front;
  const patchy = n(x * 0.03 - d.x * t * 0.6, z * 0.03 - d.y * t * 0.6);
  return W.uWindStrength.value * (0.3 + 1.1 * front * (0.6 + 0.6 * patchy));
}

/** Advance time and let the overall wind wander between calm and blustery. */
export function updateWind(t) {
  WIND.uTime.value = t;
  WIND.uWindStrength.value = 0.55 + 0.3 * Math.sin(t * 0.05) + 0.15 * Math.sin(t * 0.13 + 1.7);
  const a = 0.6 + 0.25 * Math.sin(t * 0.017);
  WIND.uWindDir.value.set(Math.cos(a), Math.sin(a));
}

/** Set up to 4 pushers: [{x, z, r, s}] */
export function setPushers(list) {
  const P = WIND.uPush.value;
  for (let i = 0; i < 4; i++) {
    const p = list[i];
    if (p) P[i].set(p.x, p.z, p.r, p.s); else P[i].set(0, 0, 0, 0);
  }
}

/**
 * Vertex code that bends a tree (trunk and crown move together) with gusts and downwash.
 * Expects instancing. heightScale = typical tree height.
 */
export function treeWindVertex(flutter) {
  return /* glsl */ `
  #ifdef USE_INSTANCING
  {
    vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    float g = gust(ip.xz);
    vec2 push = pushAt(ip.xz, 3.0);
    float hn = max(position.y, 0.0) / 9.0;
    float sway = sin(uTime * 1.7 + ip.x * 0.37 + ip.z * 0.21) * 0.35 + 0.65;
    vec2 bendW = uWindDir * g * sway * 1.1 + push * 1.6;
    vec3 bend = vec3(bendW.x, 0.0, bendW.y) * hn * hn;
    // into instance-local space (instances are rotated about Y)
    mat3 im = mat3(instanceMatrix);
    vec3 lb = transpose(im) * bend / max(dot(im[0], im[0]), 1e-4);
    transformed += lb;
    transformed.y -= length(bendW) * hn * hn * 0.12;
    ${flutter ? `
    float fl = sin(uTime * 7.0 + position.x * 4.0 + position.z * 3.0 + ip.x) * cos(uTime * 5.3 + position.y * 3.0 + ip.z);
    transformed += normal * fl * 0.05 * (g + length(push)) * hn;` : ''}
  }
  #endif`;
}
