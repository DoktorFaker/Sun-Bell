import struct, sys, json, os
import numpy as np
src, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(src)
d = open(src, 'rb').read(); o = 4
def rd(fmt):
    global o; v = struct.unpack_from('<' + fmt, d, o); o += struct.calcsize('<' + fmt); return v
rd('f'); n, = rd('B'); enc, addUV, vIdx, tIdx, mIdx, bIdx, morphIdx, rbIdx = rd('%dB' % n)
def text():
    global o; L, = rd('i'); s = d[o:o+L]; o += L; return s.decode('utf-16-le' if enc == 0 else 'utf-8')
def idx(size): return rd({1: 'b', 2: 'h', 4: 'i'}[size])[0]
for _ in range(4): text()
S = 1 / 12.5
nv, = rd('i')
P = np.zeros((nv, 3), np.float32); N = np.zeros((nv, 3), np.float32); UV = np.zeros((nv, 2), np.float32)
J = np.zeros((nv, 4), np.uint16); W = np.zeros((nv, 4), np.float32)
for i in range(nv):
    x, y, z, nx, ny, nz, u, v = rd('8f'); rd('%df' % (4 * addUV))
    P[i] = (x * S, y * S, -z * S); N[i] = (nx, ny, -nz); UV[i] = (u, v)
    w, = rd('B')
    if w == 0: J[i, 0] = idx(bIdx); W[i, 0] = 1
    elif w == 1: a = idx(bIdx); b = idx(bIdx); f, = rd('f'); J[i, :2] = (a, b); W[i, :2] = (f, 1 - f)
    elif w == 2: J[i] = [idx(bIdx) for _ in range(4)]; W[i] = rd('4f')
    else: raise SystemExit('unsupported weight type %d' % w)
    rd('f')
J[J < 0] = 0
W /= np.maximum(W.sum(1, keepdims=True), 1e-6)
nl = np.linalg.norm(N, axis=1, keepdims=True); N /= np.maximum(nl, 1e-6)
nf, = rd('i')
F = np.frombuffer(d, {2: np.uint16, 4: np.uint32, 1: np.uint8}[vIdx], nf, o).astype(np.uint32).reshape(-1, 3); o += nf * vIdx
F = F[:, [0, 2, 1]]  # z flipped: reverse winding
nt, = rd('i'); texs = [text() for _ in range(nt)]
nm, = rd('i'); mats = []
for _ in range(nm):
    name = text(); text(); diff = rd('4f'); rd('3f'); rd('f'); rd('3f'); fl, = rd('B'); rd('4f'); rd('f')
    ti = idx(tIdx); idx(tIdx); rd('B'); sh, = rd('B')
    if sh == 0: idx(tIdx)
    else: rd('B')
    text(); fc, = rd('i')
    mats.append(dict(name=name, diff=diff, double=bool(fl & 1), tex=ti, count=fc // 3))
nb, = rd('i'); bones = []
for _ in range(nb):
    jn = text(); en = text(); x, y, z = rd('3f'); par = idx(bIdx); rd('i'); fl, = rd('H')
    if fl & 1: idx(bIdx)
    else: rd('3f')
    if fl & 0x300: idx(bIdx); rd('f')
    if fl & 0x400: rd('3f')
    if fl & 0x800: rd('6f')
    if fl & 0x2000: rd('i')
    if fl & 0x20:
        idx(bIdx); rd('i'); rd('f'); n2, = rd('i')
        for _ in range(n2):
            idx(bIdx); lim, = rd('B')
            if lim: rd('6f')
    bones.append(dict(name=en or jn, pos=np.array([x * S, y * S, -z * S], np.float32), parent=par))

# this exporter writes bone positions relative to the parent: accumulate to absolute
loc = [b['pos'].copy() for b in bones]
done = [False] * len(bones)
def absolute(i):
    if done[i]: return bones[i]['pos']
    par = bones[i]['parent']
    bones[i]['pos'] = loc[i] + (absolute(par) if par >= 0 else 0)
    done[i] = True
    return bones[i]['pos']
for i in range(len(bones)): absolute(i)
# ---------------- build glTF ----------------
bin_ = bytearray(); views = []; accs = []
def add_view(data, target=None):
    while len(bin_) % 4: bin_.append(0)
    off = len(bin_); bin_.extend(data)
    v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
    if target: v['target'] = target
    views.append(v); return len(views) - 1
def add_acc(arr, ctype, typ, target=None, minmax=False):
    arr = np.ascontiguousarray(arr)
    a = {'bufferView': add_view(arr.tobytes(), target), 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1
aP = add_acc(P, 5126, 'VEC3', 34962, True); aN = add_acc(N, 5126, 'VEC3', 34962)
aUV = add_acc(UV, 5126, 'VEC2', 34962); aJ = add_acc(J, 5123, 'VEC4', 34962); aW = add_acc(W, 5126, 'VEC4', 34962)
images, textures = [], []
alpha_tex = set()
from PIL import Image
for i, t in enumerate(texs):
    path = os.path.join(base, t.replace('\\', '/'))
    data = open(path, 'rb').read()
    a = np.asarray(Image.open(path).convert('RGBA'))[..., 3]
    if (a < 250).mean() > 0.01: alpha_tex.add(i)
    images.append({'bufferView': add_view(data), 'mimeType': 'image/png'}); textures.append({'source': i, 'sampler': 0})
materials, prims = [], []
start = 0
for m in mats:
    tri = F[start:start + m['count']]; start += m['count']
    mat = {'name': m['name'], 'pbrMetallicRoughness': {'baseColorFactor': list(m['diff'][:3]) + [1.0], 'metallicFactor': 0.0, 'roughnessFactor': 0.75}, 'doubleSided': m['double']}
    if m['tex'] >= 0:
        mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': m['tex']}
        if m['tex'] in alpha_tex: mat['alphaMode'] = 'MASK'; mat['alphaCutoff'] = 0.4
    materials.append(mat)
    ai = add_acc(tri.reshape(-1).astype(np.uint32), 5125, 'SCALAR', 34963)
    prims.append({'attributes': {'POSITION': aP, 'NORMAL': aN, 'TEXCOORD_0': aUV, 'JOINTS_0': aJ, 'WEIGHTS_0': aW}, 'indices': ai, 'material': len(materials) - 1})
# nodes: 0 = scene root, 1 = mesh, 2.. = bones
nodes = [{'name': 'Avatar', 'children': [1]}, {'name': 'Body', 'mesh': 0, 'skin': 0}]
bstart = 2
for i, b in enumerate(bones):
    pp = bones[b['parent']]['pos'] if b['parent'] >= 0 else np.zeros(3, np.float32)
    nodes.append({'name': b['name'], 'translation': (b['pos'] - pp).tolist()})
for i, b in enumerate(bones):
    if b['parent'] >= 0: nodes[bstart + b['parent']].setdefault('children', []).append(bstart + i)
    else: nodes[0]['children'].append(bstart + i)
ibm = np.zeros((nb, 16), np.float32)
for i, b in enumerate(bones):
    m = np.eye(4, dtype=np.float32); m[:3, 3] = -b['pos']
    ibm[i] = m.T.reshape(-1)  # column-major
aIBM = add_acc(ibm, 5126, 'MAT4')
gltf = {
    'asset': {'version': '2.0', 'generator': 'pmx2glb (Sun Bell)'},
    'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': nodes,
    'meshes': [{'name': 'Body', 'primitives': prims}],
    'skins': [{'joints': list(range(bstart, bstart + nb)), 'inverseBindMatrices': aIBM, 'skeleton': bstart}],
    'materials': materials, 'textures': textures, 'images': images,
    'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
    'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}],
}
js = json.dumps(gltf, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
while len(bin_) % 4: bin_.append(0)
total = 12 + 8 + len(js) + 8 + len(bin_)
with open(out, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
    f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)
by = {b['name']: b['pos'] for b in bones}
print('wrote', out, total, 'bytes')
for k in ['hips', 'neck', 'head', 'leg_L', 'knee_L', 'ankle_L', 'toe_L', 'arm_L', 'elbow_L', 'wrist_L']: print(k, np.round(by[k], 3))
print('height approx', P[:, 1].max(), 'min', P[:, 1].min(), 'facing z extent', P[:, 2].min(), P[:, 2].max())
