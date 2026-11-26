// Quality presets and GPU-based auto selection.

export const PRESETS = {
  low: {
    name: 'Low', renderScale: 0.75, maxDpr: 1, shadowSize: 1024, shadowRange: 32,
    ao: false, aoSamples: 0, fogSteps: 12, fogScale: 0.25, dof: false, dofSamples: 0,
    bloomLevels: 4, grass: 6000, treeShadows: false,
  },
  medium: {
    name: 'Medium', renderScale: 0.85, maxDpr: 1, shadowSize: 2048, shadowRange: 40,
    ao: true, aoSamples: 8, fogSteps: 20, fogScale: 0.25, dof: false, dofSamples: 0,
    bloomLevels: 5, grass: 22000, treeShadows: true,
  },
  high: {
    name: 'High', renderScale: 1, maxDpr: 1.5, shadowSize: 2048, shadowRange: 48,
    ao: true, aoSamples: 12, fogSteps: 32, fogScale: 0.5, dof: true, dofSamples: 24,
    bloomLevels: 6, grass: 40000, treeShadows: true,
  },
  ultra: {
    name: 'Ultra', renderScale: 1, maxDpr: 2, shadowSize: 4096, shadowRange: 56,
    ao: true, aoSamples: 16, fogSteps: 48, fogScale: 0.5, dof: true, dofSamples: 40,
    bloomLevels: 6, grass: 60000, treeShadows: true,
  },
};

export const ORDER = ['low', 'medium', 'high', 'ultra'];

export function gpuString(renderer) {
  const gl = renderer.getContext();
  let s = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { /* ignore */ }
  return String(s || 'unknown GPU');
}

// Returns { tier, gpu, reason }
export function detectTier(renderer) {
  const gpu = gpuString(renderer);
  const g = gpu.toLowerCase();
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent));
  let tier = 'medium';
  let reason = 'unrecognised GPU, safe default';

  const test = (re) => re.test(g);
  if (test(/swiftshader|llvmpipe|softpipe|microsoft basic|software/)) {
    tier = 'low'; reason = 'software renderer';
  } else if (test(/rtx\s*(50\d0|40[6-9]0|30[7-9]0)|rx\s*(7[89]\d0|9\d{3})|radeon pro w7|apple m\d (max|ultra)/)) {
    tier = 'ultra'; reason = 'high-end discrete GPU';
  } else if (test(/rtx|gtx\s*1(07|08)0|gtx\s*16\d0|rx\s*(6\d{3}|5[67]\d{2}|7[67]\d0)|arc\s*a7|apple m\d pro|apple m[3-9]/)) {
    tier = 'high'; reason = 'capable discrete GPU';
  } else if (test(/gtx|radeon|rx\s*\d|arc|iris xe|apple m\d|apple gpu|adreno.*(7\d\d|8\d\d)/)) {
    tier = 'medium'; reason = 'mid-range or integrated GPU';
  } else if (test(/intel|uhd|hd graphics|mali|adreno|powervr|vivante/)) {
    tier = 'low'; reason = 'integrated or mobile GPU';
  }
  if (mobile && (tier === 'high' || tier === 'ultra')) { tier = 'medium'; reason += ', capped on mobile'; }
  return { tier, gpu, reason };
}
