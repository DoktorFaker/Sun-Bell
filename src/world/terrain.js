// Analytic valley height field shared by terrain mesh, placement and AI.

export function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}
export function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, oct = 4) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

export const ROAD_START = 84;   // camp end (south)
export const ROAD_END = -246;   // temple stairs (north)

export function roadX(z) {
  z = clamp(z, ROAD_END, ROAD_START);
  return 16 * Math.sin(z * 0.017) + 7 * Math.sin(z * 0.041 + 1.3);
}
export function roadY(z) {
  z = clamp(z, ROAD_END, ROAD_START);
  return 9 * smooth(60, -240, z) + 1.2 * Math.sin(z * 0.05);
}

export const CAMP = { x: roadX(70) + 9, z: 70 };
CAMP.y = roadY(70) + 0.1;
export const HELIPAD = { x: CAMP.x + 9, z: CAMP.z + 11 };

// The river crossing the valley north of camp
export function riverZ(x) { return 38 + 6 * Math.sin(x * 0.03 + 0.4) + 2 * Math.sin(x * 0.011); }
export const BRIDGE = (() => {
  let z = 38;
  for (let i = 0; i < 8; i++) z = riverZ(roadX(z));
  const x = roadX(z);
  // road heading at the crossing
  const dx = roadX(z - 1) - roadX(z + 1);
  return { x, z, yaw: Math.atan2(dx, -2), deck: roadY(z) + 0.35, half: 11, width: 5.2 };
})();
export const WATER = roadY(BRIDGE.z) - 2.1;
export const TRUCK = { x: roadX(ROAD_START) - 7, z: ROAD_START + 4, yaw: Math.PI * 0.85 };
export const TEMPLE = { x: roadX(ROAD_END), z: -288 };
TEMPLE.y = roadY(ROAD_END);

export function roadDist(x, z) {
  const zc = clamp(z, ROAD_END, ROAD_START);
  const dz = z - zc;
  const dx = x - roadX(zc);
  return Math.hypot(dx, dz);
}

export function heightAt(x, z) {
  const d = roadDist(x, z);
  const n = fbm(x * 0.011 + 3.1, z * 0.011 - 7.7);
  let h = roadY(z);
  const wall = smooth(9, 150, d);
  h += wall * wall * (62 + 70 * n);
  h += (fbm(x * 0.03, z * 0.03, 3) - 0.5) * 16 * wall;
  h += (fbm(x * 0.07 + 9, z * 0.07, 3) - 0.5) * 2.4 * smooth(4.5, 16, d);
  // close the valley at both ends
  h += smooth(105, 210, z) * (60 + 40 * n);
  h += smooth(-318, -420, z) * (80 + 50 * n);
  // temple plateau
  const dt = Math.hypot(x - TEMPLE.x, (z - TEMPLE.z) * 0.85);
  h = lerp(h, TEMPLE.y, 1 - smooth(40, 62, dt));
  // river channel
  const dr = Math.abs(z - riverZ(x));
  const kr = 1 - smooth(5, 11, dr);
  h = lerp(h, Math.min(h, WATER - 2.0 + dr * 0.08), kr);
  // truck shed clearing
  const dtk = Math.hypot(x - TRUCK.x, z - TRUCK.z);
  h = lerp(h, roadY(ROAD_START) + 0.05, 1 - smooth(6, 13, dtk));
  // helipad
  const dh = Math.hypot(x - HELIPAD.x, z - HELIPAD.z);
  h = lerp(h, CAMP.y - 0.05, 1 - smooth(6, 13, dh));
  // camp clearing
  const dc = Math.hypot(x - CAMP.x, z - CAMP.z);
  h = lerp(h, CAMP.y - 0.1 + (fbm(x * 0.2, z * 0.2, 2) - 0.5) * 0.3, 1 - smooth(7, 17, dc));
  return h;
}

export function slopeAt(x, z) {
  const e = 0.75;
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return { gx, gz, s: Math.hypot(gx, gz) };
}

// Seeded RNG for deterministic placement
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** True where the water is too deep to wade (bridge handled by callers). */
export function deepWater(x, z) { return Math.abs(z - riverZ(x)) < 12 && heightAt(x, z) < WATER - 0.9; }

// Bridge local frame helpers
const BF = { fx: Math.sin(BRIDGE.yaw), fz: Math.cos(BRIDGE.yaw) };
export function bridgeLocal(x, z) {
  const dx = x - BRIDGE.x, dz = z - BRIDGE.z;
  return { along: dx * BF.fx + dz * BF.fz, side: dx * BF.fz - dz * BF.fx };
}
const endA = { x: BRIDGE.x - BF.fx * BRIDGE.half, z: BRIDGE.z - BF.fz * BRIDGE.half };
const endB = { x: BRIDGE.x + BF.fx * BRIDGE.half, z: BRIDGE.z + BF.fz * BRIDGE.half };
export const BRIDGE_ENDS = { a: endA, b: endB }; // a = camp side (south), b = north side
/** Deck height at a point on the bridge (gentle arch between the two banks). */
export function deckHeight(along) {
  const t = (along + BRIDGE.half) / (BRIDGE.half * 2);
  const ha = heightAt(endA.x, endA.z), hb = heightAt(endB.x, endB.z);
  return ha + (hb - ha) * t + Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.6 + 0.12;
}
