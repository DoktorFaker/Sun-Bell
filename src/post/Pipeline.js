import * as THREE from 'three';
import * as S from './shaders.js';

const tri = new THREE.BufferGeometry();
tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

function rt(w, h, { type = THREE.HalfFloatType, filter = THREE.LinearFilter, depth = false, format = THREE.RGBAFormat } = {}) {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type, format, minFilter: filter, magFilter: filter, depthBuffer: depth, generateMipmaps: false,
  });
  t.texture.wrapS = t.texture.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function mat(frag, uniforms = {}, defines = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: S.fullscreenVert, fragmentShader: frag, uniforms, defines,
    depthTest: false, depthWrite: false,
  });
}

/**
 * Cinematic HDR pipeline:
 *   scene (HDR + depth) -> SSAO -> volumetric fog (sun shadow map) -> composite
 *   -> depth of field -> bloom -> auto exposure -> ACES + grade -> FXAA -> screen
 */
export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(tri, null);
    this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene();
    this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;
    this.frame = 0;
    this.time = 0;
    this.lumInit = true;
    this.focus = 6;

    // Look-dev parameters (tweakable at runtime)
    this.params = {
      fogDensity: 0.0034, fogFalloff: 0.05, fogBase: 0, fogMaxDist: 420, fogAniso: 0.62,
      fogSun: 9, fogAmbient: new THREE.Color(0.05, 0.056, 0.072),
      aoRadius: 1.4, aoIntensity: 1.1, aoStrength: 0.9,
      bloom: 0.07, bloomThreshold: 1.6, bloomKnee: 0.8, bloomRadius: 1.0,
      key: 0.2, minLum: 0.03, maxLum: 6.0, exposureBias: 0.0,
      saturation: 1.08, contrast: 1.06,
      lift: new THREE.Vector3(0.012, 0.010, 0.022),
      gamma: new THREE.Vector3(1.0, 1.0, 1.02),
      gain: new THREE.Vector3(1.04, 1.0, 0.95),
      tint: new THREE.Vector3(1.03, 1.0, 0.96),
      vignette: 0.45, grain: 0.025,
      dofFocusRange: 8, dofFarRange: 160, dofMaxRadius: 4,
      fade: 0, fadeColor: new THREE.Vector3(0, 0, 0), hurt: 0,
    };
    this.lumTargets = [rt(64, 64, { filter: THREE.LinearFilter }), rt(16, 16), rt(4, 4), rt(1, 1)];
    this.adapt = [rt(1, 1, { filter: THREE.NearestFilter }), rt(1, 1, { filter: THREE.NearestFilter })];
  }

  configure(preset, width, height) {
    this.preset = preset;
    if (preset.fogDist) this.params.fogMaxDist = preset.fogDist;
    this.width = width; this.height = height;
    this.dispose();
    const W = Math.max(2, Math.round(width * preset.renderScale));
    const H = Math.max(2, Math.round(height * preset.renderScale));
    this.W = W; this.H = H;

    this.sceneRT = rt(W, H, { depth: true });
    this.sceneRT.depthTexture = new THREE.DepthTexture(W, H, THREE.FloatType);
    this.sceneRT.depthTexture.minFilter = this.sceneRT.depthTexture.magFilter = THREE.NearestFilter;

    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    if (preset.ao) { this.aoRT = rt(hw, hh, { type: THREE.UnsignedByteType }); this.aoBlurRT = rt(hw, hh, { type: THREE.UnsignedByteType }); }
    const fw = Math.ceil(W * preset.fogScale), fh = Math.ceil(H * preset.fogScale);
    this.fogRT = rt(fw, fh);
    this.hdrA = rt(W, H);
    this.hdrB = rt(W, H);
    if (preset.dof) { this.dofA = rt(hw, hh); this.dofB = rt(hw, hh); }
    this.bloomDown = []; this.bloomUp = [];
    let bw = hw, bh = hh;
    for (let i = 0; i < preset.bloomLevels; i++) {
      this.bloomDown.push(rt(bw, bh)); this.bloomUp.push(rt(bw, bh));
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    this.ldrRT = rt(W, H, { type: THREE.UnsignedByteType });

    // materials
    this.mAO = preset.ao ? mat(S.aoFrag, {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() },
      uRes: { value: new THREE.Vector2(hw, hh) }, uRadius: { value: 1 }, uIntensity: { value: 1 }, uFrame: { value: 0 },
    }, { AO_SAMPLES: preset.aoSamples }) : null;
    this.mAOBlur = preset.ao ? mat(S.aoBlurFrag, {
      tAO: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(hw, hh) }, uNearFar: { value: new THREE.Vector2() },
    }) : null;
    this.mFog = mat(S.fogFrag, {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
      uAmbient: { value: new THREE.Color() }, uShadow: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() },
      uHasShadow: { value: 0 }, uDensity: { value: 0 }, uFalloff: { value: 0 }, uBase: { value: 0 }, uMaxDist: { value: 0 },
      uTime: { value: 0 }, uFrame: { value: 0 }, uAniso: { value: 0.6 },
    }, { FOG_STEPS: preset.fogSteps });
    this.mComposite = mat(S.compositeFrag, {
      tScene: { value: null }, tAO: { value: null }, tFog: { value: null }, uAOStrength: { value: 1 },
    });
    const cocU = () => ({ uNearFar: { value: new THREE.Vector2() }, uFocus: { value: 5 }, uFocusRange: { value: 5 }, uFarRange: { value: 50 } });
    if (preset.dof) {
      this.mDofPre = mat(S.dofPrefilterFrag, { tColor: { value: null }, tDepth: { value: null }, ...cocU() });
      this.mDofBlur = mat(S.dofBlurFrag, { tSrc: { value: null }, uRes: { value: new THREE.Vector2(hw, hh) }, uMaxRadius: { value: 6 } }, { DOF_SAMPLES: preset.dofSamples });
      this.mDofCombine = mat(S.dofCombineFrag, { tColor: { value: null }, tBlur: { value: null }, tDepth: { value: null }, ...cocU() });
    }
    this.mBloomDown = mat(S.bloomDownFrag, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 }, uThreshold: { value: 1 }, uKnee: { value: 0.5 },
    });
    this.mBloomUp = mat(S.bloomUpFrag, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
    this.mBloomUp.uniforms.tHigh.value = null;
    this.mLum = mat(S.lumFrag, { tSrc: { value: null } });
    this.mDown4 = mat(S.down4Frag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mAdapt = mat(S.adaptFrag, { tAvg: { value: null }, tPrev: { value: null }, uDt: { value: 0 }, uInit: { value: 1 } });
    this.mGrade = mat(S.gradeFrag, {
      tHDR: { value: null }, tBloom: { value: null }, tLum: { value: null }, uBloom: { value: 0 }, uKey: { value: 0.18 },
      uMinLum: { value: 0 }, uMaxLum: { value: 1 }, uExposureBias: { value: 0 }, uSaturation: { value: 1 }, uContrast: { value: 1 },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uTint: { value: new THREE.Vector3(1, 1, 1) }, uVignette: { value: 0 }, uFade: { value: 0 }, uFadeColor: { value: new THREE.Vector3() },
      uHurt: { value: 0 }, uTime: { value: 0 }, uGrain: { value: 0 },
    });
    this.mFXAA = mat(S.fxaaFrag, { tSrc: { value: null }, uRes: { value: new THREE.Vector2() }, uSharp: { value: 0.6 } });
    this.lumInit = true;
  }

  dispose() {
    for (const k of ['sceneRT', 'aoRT', 'aoBlurRT', 'fogRT', 'hdrA', 'hdrB', 'dofA', 'dofB', 'ldrRT']) {
      if (this[k]) { if (this[k].depthTexture) this[k].depthTexture.dispose(); this[k].dispose(); this[k] = null; }
    }
    (this.bloomDown || []).forEach((t) => t.dispose());
    (this.bloomUp || []).forEach((t) => t.dispose());
    for (const k of ['mAO', 'mAOBlur', 'mFog', 'mComposite', 'mDofPre', 'mDofBlur', 'mDofCombine', 'mBloomDown', 'mBloomUp', 'mLum', 'mDown4', 'mAdapt', 'mGrade', 'mFXAA']) {
      if (this[k]) { this[k].dispose(); this[k] = null; }
    }
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.qScene, this.qCam);
  }

  /**
   * @param scene, camera
   * @param sun { light: DirectionalLight, dir: Vector3 (towards sun), color: Color }
   */
  render(scene, camera, sun, dt) {
    const r = this.renderer;
    const P = this.params;
    const pr = this.preset;
    this.frame++;
    this.time += dt;

    // 1. Scene -> HDR target (shadow maps are rendered as part of this)
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);
    const depth = this.sceneRT.depthTexture;
    const invProj = camera.projectionMatrixInverse;
    const nearFar = new THREE.Vector2(camera.near, camera.far);

    // 2. AO
    let aoTex = this.white;
    if (pr.ao) {
      const u = this.mAO.uniforms;
      u.tDepth.value = depth; u.uInvProj.value.copy(invProj); u.uProj.value.copy(camera.projectionMatrix);
      u.uRadius.value = P.aoRadius; u.uIntensity.value = P.aoIntensity; u.uFrame.value = this.frame;
      this.pass(this.mAO, this.aoRT);
      const b = this.mAOBlur.uniforms;
      b.tAO.value = this.aoRT.texture; b.tDepth.value = depth; b.uNearFar.value.copy(nearFar);
      this.pass(this.mAOBlur, this.aoBlurRT);
      aoTex = this.aoBlurRT.texture;
    }

    // 3. Volumetric fog
    {
      const u = this.mFog.uniforms;
      u.tDepth.value = depth; u.uInvProj.value.copy(invProj); u.uInvView.value.copy(camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uSunDir.value.copy(sun.dir);
      u.uSunColor.value.copy(sun.color).multiplyScalar(P.fogSun * sun.light.intensity / 3.0);
      u.uAmbient.value.copy(P.fogAmbient);
      const sm = sun.light.castShadow && sun.light.shadow.map && sun.light.shadow.map.depthTexture;
      u.uShadow.value = sm || null;
      u.uHasShadow.value = sm ? 1 : 0;
      u.uShadowMatrix.value.copy(sun.light.shadow.matrix);
      u.uDensity.value = P.fogDensity; u.uFalloff.value = P.fogFalloff; u.uBase.value = P.fogBase;
      u.uMaxDist.value = P.fogMaxDist; u.uTime.value = this.time; u.uFrame.value = this.frame % 64; u.uAniso.value = P.fogAniso;
      if (sm) this.pass(this.mFog, this.fogRT);
      else {
        // no shadow map yet (first frame): no fog contribution
        const old = r.getClearAlpha(); const oc = r.getClearColor(new THREE.Color());
        r.setRenderTarget(this.fogRT); r.setClearColor(0x000000, 1); r.clear(); r.setClearColor(oc, old);
      }
    }

    // 4. Composite
    {
      const u = this.mComposite.uniforms;
      u.tScene.value = this.sceneRT.texture; u.tAO.value = aoTex; u.tFog.value = this.fogRT.texture; u.uAOStrength.value = P.aoStrength;
      this.pass(this.mComposite, this.hdrA);
    }

    // 5. Depth of field
    let hdr = this.hdrA;
    if (pr.dof) {
      const setCoc = (u) => {
        u.uNearFar.value.copy(nearFar); u.uFocus.value = this.focus;
        u.uFocusRange.value = P.dofFocusRange; u.uFarRange.value = P.dofFarRange;
      };
      let u = this.mDofPre.uniforms;
      u.tColor.value = this.hdrA.texture; u.tDepth.value = depth; setCoc(u);
      this.pass(this.mDofPre, this.dofA);
      u = this.mDofBlur.uniforms; u.tSrc.value = this.dofA.texture; u.uMaxRadius.value = P.dofMaxRadius * (this.H / 2) / 540;
      this.pass(this.mDofBlur, this.dofB);
      u = this.mDofCombine.uniforms;
      u.tColor.value = this.hdrA.texture; u.tBlur.value = this.dofB.texture; u.tDepth.value = depth; setCoc(u);
      this.pass(this.mDofCombine, this.hdrB);
      hdr = this.hdrB;
    }

    // 6. Bloom
    {
      const d = this.mBloomDown.uniforms;
      let src = hdr;
      for (let i = 0; i < this.bloomDown.length; i++) {
        d.tSrc.value = src.texture;
        d.uTexel.value.set(1 / src.width, 1 / src.height);
        d.uPrefilter.value = i === 0 ? 1 : 0;
        d.uThreshold.value = P.bloomThreshold; d.uKnee.value = P.bloomKnee;
        this.pass(this.mBloomDown, this.bloomDown[i]);
        src = this.bloomDown[i];
      }
      const u = this.mBloomUp.uniforms;
      let low = this.bloomDown[this.bloomDown.length - 1];
      for (let i = this.bloomDown.length - 2; i >= 0; i--) {
        u.tLow.value = low.texture; u.tHigh.value = this.bloomDown[i].texture;
        u.uTexel.value.set(1 / low.width, 1 / low.height); u.uRadius.value = P.bloomRadius;
        this.pass(this.mBloomUp, this.bloomUp[i]);
        low = this.bloomUp[i];
      }
      this.bloomTex = (this.bloomDown.length > 1 ? this.bloomUp[0] : this.bloomDown[0]).texture;
    }

    // 7. Auto exposure
    {
      this.mLum.uniforms.tSrc.value = hdr.texture;
      this.pass(this.mLum, this.lumTargets[0]);
      for (let i = 1; i < 4; i++) {
        const s = this.lumTargets[i - 1];
        this.mDown4.uniforms.tSrc.value = s.texture;
        this.mDown4.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
        this.pass(this.mDown4, this.lumTargets[i]);
      }
      const prev = this.adapt[this.frame & 1], next = this.adapt[(this.frame + 1) & 1];
      const a = this.mAdapt.uniforms;
      a.tAvg.value = this.lumTargets[3].texture; a.tPrev.value = prev.texture; a.uDt.value = Math.min(dt, 0.1); a.uInit.value = this.lumInit ? 1 : 0;
      this.pass(this.mAdapt, next);
      this.lumTex = next.texture;
      this.lumInit = false;
    }

    // 8. Tonemap + grade -> LDR
    {
      const u = this.mGrade.uniforms;
      u.tHDR.value = hdr.texture; u.tBloom.value = this.bloomTex; u.tLum.value = this.lumTex;
      u.uBloom.value = P.bloom; u.uKey.value = P.key; u.uMinLum.value = P.minLum; u.uMaxLum.value = P.maxLum;
      u.uExposureBias.value = P.exposureBias; u.uSaturation.value = P.saturation; u.uContrast.value = P.contrast;
      u.uLift.value.copy(P.lift); u.uGamma.value.copy(P.gamma); u.uGain.value.copy(P.gain); u.uTint.value.copy(P.tint);
      u.uVignette.value = P.vignette; u.uFade.value = P.fade; u.uFadeColor.value.copy(P.fadeColor); u.uHurt.value = P.hurt;
      u.uTime.value = this.time; u.uGrain.value = P.grain;
      this.pass(this.mGrade, this.ldrRT);
    }

    // 9. FXAA -> screen
    {
      const u = this.mFXAA.uniforms;
      u.tSrc.value = this.ldrRT.texture; u.uRes.value.set(this.W, this.H);
      // sharpen more when the image is being upscaled
      u.uSharp.value = THREE.MathUtils.clamp(0.45 + (this.width / this.W - 1) * 1.2, 0.45, 1.0);
      this.pass(this.mFXAA, null);
    }
  }
}
