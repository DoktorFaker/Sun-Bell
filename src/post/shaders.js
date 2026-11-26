// GLSL for the HDR post pipeline. All passes draw a full-screen triangle.

export const fullscreenVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const common = /* glsl */ `
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const viewPos = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
vec3 viewPosAt(vec2 uv) {
  float d = texture(tDepth, uv).x;
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
`;

// ---------- Ambient occlusion (scalable SAO-style, normals from depth) ----------
export const aoFrag = /* glsl */ `
${common}
${viewPos}
uniform mat4 uProj;
uniform vec2 uRes;
uniform float uRadius;
uniform float uIntensity;
uniform float uFrame;
void main() {
  float d = texture(tDepth, vUv).x;
  if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPosAt(vUv);
  vec2 t = 1.0 / uRes;
  vec3 pr = viewPosAt(vUv + vec2(t.x, 0.0)), pl = viewPosAt(vUv - vec2(t.x, 0.0));
  vec3 pu = viewPosAt(vUv + vec2(0.0, t.y)), pd = viewPosAt(vUv - vec2(0.0, t.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = normalize(cross(dx, dy));
  float noise = ign(gl_FragCoord.xy) * 6.2831853;
  vec2 scale = 0.5 * vec2(uProj[0][0], uProj[1][1]) * uRadius / -P.z;
  float sum = 0.0;
  float r2 = uRadius * uRadius;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float fi = float(i);
    float a = fi * 2.39996 + noise;
    float r = (fi + 0.5) / float(AO_SAMPLES);
    vec2 uv2 = vUv + vec2(cos(a), sin(a)) * r * scale;
    vec3 S = viewPosAt(uv2);
    vec3 v = S - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    float f = max(r2 - vv, 0.0) / r2;
    sum += f * max(vn - 0.02 * -P.z * 0.05, 0.0) / (vv + 0.02);
  }
  float ao = max(0.0, 1.0 - uIntensity * 2.0 * sum / float(AO_SAMPLES));
  gl_FragColor = vec4(vec3(ao), 1.0);
}
`;

export const aoBlurFrag = /* glsl */ `
${common}
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform vec2 uNearFar;
float lin(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x)); }
void main() {
  vec2 t = 1.0 / uRes;
  float zc = lin(texture(tDepth, vUv).x);
  float s = 0.0, w = 0.0;
  for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
    vec2 uv = vUv + vec2(x, y) * t;
    float z = lin(texture(tDepth, uv).x);
    float wt = exp(-abs(z - zc) / (0.05 * zc + 0.05));
    s += texture(tAO, uv).r * wt; w += wt;
  }
  gl_FragColor = vec4(vec3(s / w), 1.0);
}
`;

// ---------- Volumetric fog: ray-marched height fog with sun shadow-map visibility ----------
export const fogFrag = /* glsl */ `
${common}
${viewPos}
uniform mat4 uInvView;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform sampler2DShadow uShadow;
uniform mat4 uShadowMatrix;
uniform float uHasShadow;
uniform float uDensity;
uniform float uFalloff;
uniform float uBase;
uniform float uMaxDist;
uniform float uTime;
uniform float uFrame;
uniform float uAniso;

float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

void main() {
  float d = texture(tDepth, vUv).x;
  vec3 vp = viewPosAt(vUv);
  vec3 wp = (uInvView * vec4(vp, 1.0)).xyz;
  vec3 ray = wp - uCamPos;
  float dist = length(ray);
  ray /= dist;
  if (d >= 0.99999) dist = uMaxDist;
  dist = min(dist, uMaxDist);
  float stepLen = dist / float(FOG_STEPS);
  float jitter = ign(gl_FragCoord.xy + uFrame * 5.588238);
  float cosT = dot(ray, uSunDir);
  float phase = mix(hg(cosT, uAniso), 0.0796, 0.25);
  vec3 scatter = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < FOG_STEPS; i++) {
    float t = (float(i) + jitter) * stepLen;
    vec3 p = uCamPos + ray * t;
    float h = max(p.y - uBase, 0.0);
    float n = noise3(p * 0.045 + vec3(uTime * 0.05, 0.0, uTime * 0.03));
    float dens = uDensity * exp(-h * uFalloff) * (0.55 + 0.9 * n);
    float vis = 1.0;
    if (uHasShadow > 0.5) {
      vec4 sc = uShadowMatrix * vec4(p, 1.0);
      sc.xyz /= sc.w;
      if (all(greaterThan(sc.xyz, vec3(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) vis = texture(uShadow, sc.xyz);
    }
    vec3 S = (uSunColor * vis * phase + uAmbient) * dens;
    float st = exp(-dens * stepLen);
    scatter += trans * S * (1.0 - st) / max(dens, 1e-6);
    trans *= st;
  }
  gl_FragColor = vec4(scatter, trans);
}
`;

// ---------- Composite: scene * AO, then fog ----------
export const compositeFrag = /* glsl */ `
${common}
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tFog;
uniform float uAOStrength;
void main() {
  vec3 c = texture(tScene, vUv).rgb;
  float ao = texture(tAO, vUv).r;
  c *= mix(1.0, ao, uAOStrength);
  vec4 f = texture(tFog, vUv);
  c = c * f.a + f.rgb;
  gl_FragColor = vec4(c, 1.0);
}
`;

// ---------- Depth of field ----------
const coc = /* glsl */ `
uniform vec2 uNearFar;
uniform float uFocus;
uniform float uFocusRange;
uniform float uFarRange;
float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x)); }
float cocAt(float d) {
  float z = linZ(d);
  float far = clamp((z - uFocus - uFocusRange) / uFarRange, 0.0, 1.0);
  float near = clamp((uFocus * 0.45 - z) / (uFocus * 0.45), 0.0, 1.0);
  return max(far, near * 0.6);
}
`;

export const dofPrefilterFrag = /* glsl */ `
${common}
uniform sampler2D tColor;
uniform sampler2D tDepth;
${coc}
void main() {
  gl_FragColor = vec4(texture(tColor, vUv).rgb, cocAt(texture(tDepth, vUv).x));
}
`;

export const dofBlurFrag = /* glsl */ `
${common}
uniform sampler2D tSrc;
uniform vec2 uRes;
uniform float uMaxRadius;
void main() {
  vec4 c = texture(tSrc, vUv);
  float r0 = c.a * uMaxRadius;
  vec3 acc = c.rgb; float w = 1.0;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  for (int i = 0; i < DOF_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(DOF_SAMPLES)) * uMaxRadius;
    float a = fi * 2.39996 + rot;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
    vec4 s = texture(tSrc, uv);
    float sr = s.a * uMaxRadius;
    float wt = clamp(min(sr, r0 + 1.5) - r + 1.0, 0.0, 1.0);
    acc += s.rgb * wt; w += wt;
  }
  gl_FragColor = vec4(acc / w, c.a);
}
`;

export const dofCombineFrag = /* glsl */ `
${common}
uniform sampler2D tColor;
uniform sampler2D tBlur;
uniform sampler2D tDepth;
${coc}
void main() {
  vec3 sharp = texture(tColor, vUv).rgb;
  vec4 b = texture(tBlur, vUv);
  float c = max(cocAt(texture(tDepth, vUv).x), b.a);
  gl_FragColor = vec4(mix(sharp, b.rgb, smoothstep(0.05, 0.5, c)), 1.0);
}
`;

// ---------- Bloom (13-tap downsample with soft threshold, tent upsample) ----------
export const bloomDownFrag = /* glsl */ `
${common}
uniform sampler2D tSrc;
uniform vec2 uTexel;   // source texel size
uniform float uPrefilter;
uniform float uThreshold;
uniform float uKnee;
vec3 thresh(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  return c * max(rq, br - uThreshold) / max(br, 1e-4);
}
void main() {
  vec2 t = uTexel;
  vec3 a = texture(tSrc, vUv + t * vec2(-2, 2)).rgb, b = texture(tSrc, vUv + t * vec2(0, 2)).rgb, c = texture(tSrc, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture(tSrc, vUv + t * vec2(-2, 0)).rgb, e = texture(tSrc, vUv).rgb, f = texture(tSrc, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture(tSrc, vUv + t * vec2(-2, -2)).rgb, h = texture(tSrc, vUv + t * vec2(0, -2)).rgb, i = texture(tSrc, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture(tSrc, vUv + t * vec2(-1, 1)).rgb, k = texture(tSrc, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture(tSrc, vUv + t * vec2(-1, -1)).rgb, m = texture(tSrc, vUv + t * vec2(1, -1)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o = min(o, vec3(64.0));
  if (uPrefilter > 0.5) o = thresh(o);
  gl_FragColor = vec4(o, 1.0);
}
`;

export const bloomUpFrag = /* glsl */ `
${common}
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;  // low texel size
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tLow, vUv).rgb * 4.0;
  s += (texture(tLow, vUv + vec2(-t.x, 0)).rgb + texture(tLow, vUv + vec2(t.x, 0)).rgb + texture(tLow, vUv + vec2(0, -t.y)).rgb + texture(tLow, vUv + vec2(0, t.y)).rgb) * 2.0;
  s += texture(tLow, vUv + vec2(-t.x, -t.y)).rgb + texture(tLow, vUv + vec2(t.x, -t.y)).rgb + texture(tLow, vUv + vec2(-t.x, t.y)).rgb + texture(tLow, vUv + vec2(t.x, t.y)).rgb;
  gl_FragColor = vec4(s / 16.0 + texture(tHigh, vUv).rgb, 1.0);
}
`;

// ---------- Auto exposure ----------
export const lumFrag = /* glsl */ `
${common}
uniform sampler2D tSrc;
void main() {
  // centre-weighted log luminance
  vec2 c = vUv - 0.5;
  float w = 1.0 - smoothstep(0.2, 0.75, length(c));
  float l = luma(texture(tSrc, vUv).rgb);
  gl_FragColor = vec4(log(max(l, 1e-4)) * (0.25 + w), 0.25 + w, 0.0, 1.0);
}
`;

export const down4Frag = /* glsl */ `
${common}
uniform sampler2D tSrc;
uniform vec2 uTexel; // source texel
void main() {
  vec4 s = texture(tSrc, vUv + uTexel * vec2(-1, -1)) + texture(tSrc, vUv + uTexel * vec2(1, -1))
         + texture(tSrc, vUv + uTexel * vec2(-1, 1)) + texture(tSrc, vUv + uTexel * vec2(1, 1));
  gl_FragColor = s * 0.25;
}
`;

export const adaptFrag = /* glsl */ `
${common}
uniform sampler2D tAvg;
uniform sampler2D tPrev;
uniform float uDt;
uniform float uInit;
void main() {
  vec4 a = texture(tAvg, vec2(0.5));
  float avg = exp(a.r / max(a.g, 1e-4));
  float prev = texture(tPrev, vec2(0.5)).r;
  float speed = avg > prev ? 1.6 : 0.9;
  float l = uInit > 0.5 ? avg : prev + (avg - prev) * (1.0 - exp(-uDt * speed));
  gl_FragColor = vec4(l, 0.0, 0.0, 1.0);
}
`;

// ---------- Tonemap + colour grade ----------
export const gradeFrag = /* glsl */ `
${common}
uniform sampler2D tHDR;
uniform sampler2D tBloom;
uniform sampler2D tLum;
uniform float uBloom;
uniform float uKey;
uniform float uMinLum;
uniform float uMaxLum;
uniform float uExposureBias;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uTint;
uniform float uVignette;
uniform float uFade;
uniform vec3 uFadeColor;
uniform float uHurt;
uniform float uTime;
uniform float uGrain;

vec3 aces(vec3 x) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = i * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec3 hdr = texture(tHDR, vUv).rgb + texture(tBloom, vUv).rgb * uBloom;
  float avg = clamp(texture(tLum, vec2(0.5)).r, uMinLum, uMaxLum);
  float exposure = uKey / avg * exp2(uExposureBias);
  vec3 c = hdr * exposure * uTint;
  // contrast in log space around mid grey
  vec3 lc = log2(max(c, 1e-6) / 0.18);
  c = 0.18 * exp2(lc * uContrast);
  // saturation
  float l = luma(c);
  c = max(mix(vec3(l), c, uSaturation), 0.0);
  c = aces(c);
  // lift / gamma / gain (ASC-CDL flavoured)
  c = pow(max(c * uGain + uLift * (1.0 - c), 0.0), 1.0 / uGamma);
  // vignette
  vec2 q = vUv - 0.5;
  c *= mix(1.0, smoothstep(0.85, 0.2, length(q * vec2(1.1, 1.0))), uVignette);
  // hurt pulse
  c = mix(c, vec3(0.55, 0.04, 0.02), uHurt * smoothstep(0.25, 0.75, length(q)));
  c = toSRGB(clamp(c, 0.0, 1.0));
  c += (ign(gl_FragCoord.xy + fract(uTime) * 917.0) - 0.5) * uGrain;
  c = mix(c, uFadeColor, uFade);
  gl_FragColor = vec4(c, dot(c, vec3(0.299, 0.587, 0.114)));
}
`;

// ---------- FXAA ----------
export const fxaaFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uRes;
void main() {
  vec2 inv = 1.0 / uRes;
  vec2 uv = vUv;
  vec4 cM = texture(tSrc, uv);
  float lNW = texture(tSrc, uv + vec2(-1.0, -1.0) * inv).a;
  float lNE = texture(tSrc, uv + vec2(1.0, -1.0) * inv).a;
  float lSW = texture(tSrc, uv + vec2(-1.0, 1.0) * inv).a;
  float lSE = texture(tSrc, uv + vec2(1.0, 1.0) * inv).a;
  float lM = cM.a;
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) { gl_FragColor = vec4(cM.rgb, 1.0); return; }
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * inv;
  vec3 a = 0.5 * (texture(tSrc, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tSrc, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(tSrc, uv + dir * -0.5).rgb + texture(tSrc, uv + dir * 0.5).rgb);
  float lB = dot(b, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}
`;

export const copyFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tSrc;
void main() { gl_FragColor = texture(tSrc, vUv); }
`;
