import * as THREE from 'three';

const flameMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 } },
  vertexShader: /* glsl */ `
    uniform float uTime;
    varying float vH;
    varying vec3 vN;
    varying vec3 vView;
    void main() {
      vec3 p = position;
      float h = clamp(uv.y, 0.0, 1.0);
      vH = h;
      float s = sin(uTime * 9.0 + p.y * 6.0 + p.x * 3.0) * 0.08 + sin(uTime * 13.0 + p.z * 5.0) * 0.05;
      p.x += s * h; p.z += cos(uTime * 7.0 + p.y * 4.0) * 0.06 * h;
      p.y *= 0.85 + 0.25 * sin(uTime * 11.0 + position.x * 20.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vN = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uIntensity;
    varying float vH;
    varying vec3 vN;
    varying vec3 vView;
    void main() {
      float rim = abs(dot(normalize(vN), vView));
      vec3 hot = vec3(6.0, 3.4, 1.4), cool = vec3(2.4, 0.5, 0.1);
      vec3 c = mix(hot, cool, smoothstep(0.0, 0.9, vH));
      float a = pow(rim, 1.5) * (1.0 - smoothstep(0.55, 1.0, vH));
      gl_FragColor = vec4(c * a * uIntensity, 1.0);
    }`,
});

const emberMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: { value: 0 }, uScale: { value: 300 } },
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform float uScale;
    attribute float aSeed;
    varying float vLife;
    void main() {
      float life = fract(uTime * (0.25 + aSeed * 0.2) + aSeed * 13.0);
      vLife = life;
      vec3 p = position;
      p.y += life * (2.5 + aSeed * 2.0);
      p.x += sin(uTime * 2.0 + aSeed * 30.0) * 0.3 * life;
      p.z += cos(uTime * 1.7 + aSeed * 20.0) * 0.3 * life;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = uScale * 0.025 / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vLife;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      gl_FragColor = vec4(vec3(5.0, 1.8, 0.5) * (1.0 - vLife) * (1.0 - d * 2.0), 1.0);
    }`,
});

export class Fire {
  constructor(scale = 1, lightIntensity = 14, distance = 22) {
    this.group = new THREE.Group();
    this.mat = flameMat.clone();
    for (let i = 0; i < 3; i++) {
      const g = new THREE.ConeGeometry(0.32 * scale * (1 - i * 0.2), 1.1 * scale * (1 + i * 0.15), 10, 6, true).translate(0, 0.55 * scale, 0);
      const m = new THREE.Mesh(g, this.mat);
      m.rotation.y = i * 1.1;
      m.position.set(Math.sin(i * 2.4) * 0.08 * scale, 0, Math.cos(i * 2.4) * 0.08 * scale);
      m.renderOrder = 5;
      this.group.add(m);
    }
    const n = 40;
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 0.5 * scale; pos[i * 3 + 1] = 0.3; pos[i * 3 + 2] = (Math.random() - 0.5) * 0.5 * scale; seed[i] = Math.random(); }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.emberMat = emberMat.clone();
    const pts = new THREE.Points(pg, this.emberMat);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.light = new THREE.PointLight(new THREE.Color(1.0, 0.55, 0.25), lightIntensity, distance, 2);
    this.light.position.y = 0.8 * scale;
    this.baseIntensity = lightIntensity;
    this.group.add(this.light);
    this.seed = Math.random() * 100;
  }
  update(dt, t) {
    this.mat.uniforms.uTime.value = t + this.seed;
    this.emberMat.uniforms.uTime.value = t + this.seed;
    this.emberMat.uniforms.uScale.value = innerHeight;
    const f = 0.85 + Math.sin(t * 13 + this.seed) * 0.06 + Math.sin(t * 23.7 + this.seed * 2) * 0.05 + Math.sin(t * 5.1) * 0.04;
    this.light.intensity = this.baseIntensity * f;
  }
}
