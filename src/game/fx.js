import * as THREE from 'three';

/** Additive ribbon following the blade during swings. */
export class SwordTrail {
  constructor(scene, n = 14) {
    this.n = n;
    this.base = []; this.tip = [];
    const pos = new Float32Array(n * 2 * 3);
    const a = new Float32Array(n * 2);
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
    g.setIndex(idx);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(1.6, 1.25, 0.8) } },
      vertexShader: 'attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA * vA, 1.0); }',
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.intensity = 0;
  }
  update(baseObj, tipObj, active, dt) {
    const b = new THREE.Vector3(), t = new THREE.Vector3();
    baseObj.getWorldPosition(b); tipObj.getWorldPosition(t);
    this.intensity = active ? 1 : Math.max(0, this.intensity - dt * 6);
    this.base.unshift(b); this.tip.unshift(t);
    if (this.base.length > this.n) { this.base.pop(); this.tip.pop(); }
    const pos = this.geo.attributes.position.array, a = this.geo.attributes.aAlpha.array;
    for (let i = 0; i < this.n; i++) {
      const bb = this.base[Math.min(i, this.base.length - 1)], tt = this.tip[Math.min(i, this.tip.length - 1)];
      pos.set([bb.x, bb.y, bb.z, tt.x, tt.y, tt.z], i * 6);
      const f = (1 - i / (this.n - 1)) * this.intensity * 0.32;
      a[i * 2] = 0; a[i * 2 + 1] = f;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.mesh.visible = this.intensity > 0.01;
  }
}

/** Burst of glowing sparks (hits, deaths). Pooled. */
export class Sparks {
  constructor(scene, max = 400) {
    this.max = max;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.life = new Float32Array(max); this.col = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo = g;
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      uniforms: { uScale: { value: 600 } },
      vertexShader: 'uniform float uScale; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = uScale*0.03/-mv.z; gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'varying vec3 vC; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor = vec4(vC*(1.0-d*2.0),1.0); }',
    });
    this.mat = m;
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.i = 0;
  }
  burst(pos, n, color, speed = 5, up = 2) {
    for (let k = 0; k < n; k++) {
      const i = this.i = (this.i + 1) % this.max;
      this.p[i * 3] = pos.x; this.p[i * 3 + 1] = pos.y; this.p[i * 3 + 2] = pos.z;
      const a = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1;
      const s = speed * (0.3 + Math.random());
      this.v[i * 3] = Math.cos(a) * Math.sqrt(1 - e * e) * s;
      this.v[i * 3 + 1] = e * s + up;
      this.v[i * 3 + 2] = Math.sin(a) * Math.sqrt(1 - e * e) * s;
      this.life[i] = 0.4 + Math.random() * 0.6;
      this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    }
  }
  update(dt) {
    this.mat.uniforms.uScale.value = innerHeight;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.v[i * 3 + 1] -= 9 * dt;
      for (let c = 0; c < 3; c++) { this.p[i * 3 + c] += this.v[i * 3 + c] * dt; this.v[i * 3 + c] *= 1 - dt * 1.5; }
      if (this.life[i] <= 0) { this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0; this.p[i * 3 + 1] = -1000; }
      else { const f = 1 - dt * 1.2; this.col[i * 3] *= f; this.col[i * 3 + 1] *= f; this.col[i * 3 + 2] *= f; }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

/** Tiny synthesized sound effects (no audio assets). */
export class Sfx {
  constructor() { this.ctx = null; }
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // ambient wind
      const src = this.ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
      const g = this.ctx.createGain(); g.gain.value = 0.05;
      src.connect(f).connect(g).connect(this.master); src.start();
      this.wind = { f, g };
    } catch (e) { this.ctx = null; }
  }
  _noise(dur, type, freq, q, gain, sweepTo) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  _tone(freq, dur, gain, type = 'sine', to) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  swing() { this._noise(0.22, 'bandpass', 900, 1.5, 0.35, 2600); }
  groan(gain = 0.22) { const f = 70 + Math.random() * 40; this._tone(f, 1.1, gain, 'sawtooth', f * 0.7); this._tone(f * 1.51, 0.9, gain * 0.4, 'sawtooth', f * 1.1); this._noise(0.9, 'bandpass', 380, 3, gain * 0.8, 250); }
  gore() { this._noise(0.28, 'lowpass', 700, 0.9, 0.9, 120); this._noise(0.12, 'bandpass', 1600, 1.2, 0.35, 500); this._tone(80, 0.18, 0.35, 'sine', 40); }
  hit() { this._noise(0.18, 'lowpass', 1800, 0.7, 0.8, 200); this._tone(110, 0.2, 0.5, 'triangle', 50); }
  block() { this._tone(1250, 0.4, 0.18, 'square', 900); this._tone(1870, 0.3, 0.12, 'sine'); this._noise(0.12, 'highpass', 3000, 0.7, 0.4); }
  hurt() { this._noise(0.25, 'lowpass', 700, 1, 0.9, 120); this._tone(90, 0.25, 0.4, 'sawtooth', 50); }
  roll() { this._noise(0.3, 'lowpass', 500, 0.8, 0.3, 200); }
  enemyWind() { this._tone(70, 0.6, 0.25, 'sawtooth', 140); }
  kill() { this._noise(0.9, 'bandpass', 400, 2, 0.5, 80); this._tone(220, 1.2, 0.15, 'sine', 55); }
  heal() { [523, 659, 784].forEach((f, i) => setTimeout(() => this._tone(f, 0.8, 0.12), i * 90)); }
  bossRoar() { this._tone(55, 2.2, 0.35, 'sawtooth', 32); this._tone(82, 1.8, 0.2, 'sawtooth', 45); this._noise(1.8, 'lowpass', 400, 0.8, 0.5, 90); }
  bell() { [196, 392, 588, 787].forEach((f, i) => this._tone(f, 4 - i * 0.6, 0.18 / (i + 1))); }
  ui() { this._tone(880, 0.12, 0.08); }
  step(speed, dusty) {
    if (!this.ctx) return;
    const v = Math.min(1, speed / 8);
    this._noise(0.07, 'lowpass', dusty ? 900 : 600, 0.8, 0.05 + v * 0.07, 120);
  }
  splash() { this._noise(0.25, 'bandpass', 1500, 0.9, 0.18, 500); this._noise(0.12, 'highpass', 3000, 0.7, 0.08); }
  setWind(g) {
    if (!this.wind || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind.g.gain.setTargetAtTime(0.025 + g * 0.09, t, 0.4);
    this.wind.f.frequency.setTargetAtTime(220 + g * 650, t, 0.4);
  }
  gun() { this._noise(0.09, 'highpass', 900, 0.7, 0.5); this._tone(110, 0.08, 0.35, 'square', 50); }
  glug() { [0, 160, 320].forEach((d) => setTimeout(() => this._tone(220 + Math.random() * 60, 0.12, 0.12, 'sine', 120), d)); }
  blah() { const n = 3 + Math.floor(Math.random() * 3); for (let i = 0; i < n; i++) setTimeout(() => this._tone(140 + Math.random() * 90, 0.09, 0.06, 'sawtooth', 110 + Math.random() * 60), i * 95); }
  /** Continuous truck engine: on, speed 0..1 */
  setEngine(on, speed) {
    if (!this.ctx) return;
    if (!this.engine) {
      const c = this.ctx;
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 40;
      const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 20;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320;
      const g = c.createGain(); g.gain.value = 0;
      o.connect(f); o2.connect(f); f.connect(g).connect(this.master); o.start(); o2.start();
      this.engine = { o, o2, g, f };
    }
    const e = this.engine, t = this.ctx.currentTime;
    e.g.gain.setTargetAtTime(on ? 0.09 + speed * 0.06 : 0, t, 0.15);
    e.o.frequency.setTargetAtTime(38 + speed * 70, t, 0.1);
    e.o2.frequency.setTargetAtTime(19 + speed * 35, t, 0.1);
    e.f.frequency.setTargetAtTime(260 + speed * 500, t, 0.1);
  }
  /** Continuous rotor sound: level 0..1. */
  setRotor(level) {
    if (!this.ctx) return;
    if (!this.rotor) {
      const c = this.ctx;
      const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380;
      const g = c.createGain(); g.gain.value = 0;
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0;
      const lg = c.createGain(); lg.gain.value = 0;
      lfo.connect(lg).connect(g.gain);
      src.connect(f).connect(g).connect(this.master); src.start(); lfo.start();
      const hum = c.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 45;
      const hg = c.createGain(); hg.gain.value = 0; const hf = c.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 200;
      hum.connect(hf).connect(hg).connect(this.master); hum.start();
      this.rotor = { g, lfo, lg, hum, hg };
    }
    const r = this.rotor, t = this.ctx.currentTime;
    r.g.gain.setTargetAtTime(level * 0.55, t, 0.1);
    r.lg.gain.setTargetAtTime(level * 0.45, t, 0.1);
    r.lfo.frequency.setTargetAtTime(2 + level * 9, t, 0.2);
    r.hum.frequency.setTargetAtTime(30 + level * 30, t, 0.2);
    r.hg.gain.setTargetAtTime(level * 0.08, t, 0.1);
  }
  chop() { this._tone(160, 0.12, 0.35, 'triangle', 90); this._noise(0.1, 'bandpass', 1200, 1.5, 0.4); }
  clink() { this._tone(1900, 0.15, 0.12, 'square', 1500); this._noise(0.08, 'highpass', 3000, 0.7, 0.35); }
  place() { this._tone(110, 0.2, 0.35, 'sine', 70); this._noise(0.15, 'lowpass', 800, 0.7, 0.4); }
  crumble() { this._noise(0.7, 'lowpass', 900, 0.7, 0.7, 120); this._tone(90, 0.5, 0.2, 'triangle', 50); }
  cannon() { this._noise(0.6, 'lowpass', 1400, 0.7, 0.9, 80); this._tone(60, 0.5, 0.5, 'sine', 30); }
  horn() { this._tone(147, 1.6, 0.2, 'sawtooth', 140); this._tone(220, 1.6, 0.12, 'sawtooth', 210); }
  // Rustcart
  beep() { [1320, 1760, 1180].forEach((f, i) => setTimeout(() => this._tone(f, 0.09, 0.07, 'square'), i * 85)); }
  alarm() { for (let i = 0; i < 3; i++) setTimeout(() => this._tone(940, 0.16, 0.08, 'square', 620), i * 190); }
  charge() { this._tone(90, 0.9, 0.22, 'sawtooth', 260); this._noise(0.8, 'bandpass', 300, 1.2, 0.25, 900); }
  crash() { this._noise(0.5, 'lowpass', 2400, 0.8, 0.9, 150); this._tone(180, 0.4, 0.25, 'square', 60); this._tone(2100, 0.5, 0.06, 'sine', 1900); }
  laserCharge() { this._tone(400, 0.85, 0.08, 'sine', 1800); }
  zap() { this._tone(2400, 0.35, 0.12, 'sawtooth', 300); this._noise(0.3, 'highpass', 2500, 0.8, 0.35); }
  toss() { this._noise(0.25, 'bandpass', 600, 1.2, 0.25, 1400); }
  boom() { this._noise(0.7, 'lowpass', 1200, 0.7, 1.0, 90); this._tone(70, 0.6, 0.35, 'sine', 35); }
  clank() { this._tone(620, 0.25, 0.14, 'square', 380); this._tone(1430, 0.2, 0.08, 'triangle'); this._noise(0.12, 'bandpass', 2500, 2, 0.4); }
  shutdown() { this._tone(880, 1.4, 0.12, 'square', 60); this._noise(1.2, 'highpass', 3000, 0.7, 0.2); }
}
