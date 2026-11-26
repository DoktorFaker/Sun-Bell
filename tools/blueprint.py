"""Turn a blueprint sheet (side / top / front / rear / bottom views) into a textured game mesh.

The shape is a visual hull: voxels survive only where every carving view's silhouette covers them,
then marching cubes. Each triangle is textured by projecting the view that faces it (by normal),
so the model looks exactly like the drawing from every side.

usage: python3 -I tools/blueprint.py <truck|heli> <sheet.jpg> <out_dir>
writes <name>.bin (geometry), <name>.jpg (texture atlas), <name>.json (layout + parts)
"""
import sys, json, struct
import numpy as np, cv2
from scipy import ndimage
from skimage.measure import marching_cubes

CFG = {
    'truck': dict(
        L=6.2, zmin=-2.9, W=2.4, voxel=0.045,
        views={  # abs boxes x0,y0,x1,y1 ; front_right = vehicle nose on the right of the drawing
            'left':   dict(box=(334, 71, 1481, 518), front_right=True),
            'right':  dict(box=(1450, 524, 2550, 957), front_right=False),
            'top':    dict(box=(492, 940, 1459, 1376)),
            'bottom': dict(box=(1496, 982, 2546, 1348)),
            'front':  dict(box=(1565, 72, 2002, 432)),
            'rear':   dict(box=(2090, 70, 2520, 434)),
            'wheel':  dict(box=(30, 72, 270, 310), raw=True),
            'tread':  dict(box=(38, 325, 261, 467), raw=True),
        },
        carve=['left', 'top'],
        # wheels cut out of the side silhouette (abs px centre, radius) -> separate spinning wheels
        wheels=[(597, 420, 101), (1305, 420, 101)],
        hollow=dict(rect=(1032, 1000, 1418, 1322), floor=1.18),   # the bed: top-view px rect, floor height (m)
    ),
    'ak': dict(
        L=0.88, zmin=-0.44, W=0.075, voxel=0.0035,
        views={
            'left':   dict(box=(68, 222, 1295, 586), front_right=True),
            'right':  dict(box=(1310, 222, 2548, 586), front_right=False),
            'top':    dict(box=(72, 775, 1548, 918), flip=True),
            'bottom': dict(box=(72, 1118, 1548, 1302), flip=True),
            'front':  dict(box=(1730, 790, 1955, 1298)),
            'rear':   dict(box=(2235, 790, 2405, 1298)),
        },
        carve=['left', 'front'],
    ),
    'heli': dict(
        L=10.6, zmin=-7.3, W=2.6, voxel=0.05,
        views={
            'left':   dict(box=(18, 32, 1408, 490), front_right=True),
            'right':  dict(box=(1040, 448, 2560, 916), front_right=False),
            'top':    dict(box=(565, 1008, 1616, 1272)),
            'bottom': dict(box=(1645, 1008, 2696, 1272), virtual=True),   # tail runs off the sheet: same scale as top
            'front':  dict(box=(1608, 80, 1996, 490)),
            'rear':   dict(box=(2186, 66, 2466, 456)),
            'blade':  dict(box=(368, 714, 962, 776), raw=True),
        },
        carve=['left', 'top', 'front'],
        thin_tail_px=236,
        erase_side=[(0, 418, 640, 500)],   # loose rotor blade drawn under the tail     # side-view x left of this: tail rotor / fin -> keep only a thin plate
    ),
}


def view_mask(img, box, bg):
    x0, y0, x1, y1 = box
    sub = img[y0:y1, x0:x1]
    d = np.abs(sub.astype(int) - bg).max(axis=2)
    fg = (d > 9).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg)
    big = 1 + np.argsort(-st[1:, cv2.CC_STAT_AREA])
    mask = np.zeros_like(fg)
    a0 = st[big[0], cv2.CC_STAT_AREA]
    for i in big[:12]:   # main body + any sizeable attached-looking parts
        if st[i, cv2.CC_STAT_AREA] > a0 * 0.02:
            mask |= (lab == i).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    h, w = mask.shape
    ff = np.pad(mask, 1).copy(); fl = np.zeros((h + 4, w + 4), np.uint8)
    cv2.floodFill(ff, fl, (0, 0), 1)
    return mask | (1 - ff[1:-1, 1:-1])


def bleed(crop, mask):
    """Fill background pixels with nearby paint so edges never show the grey sheet."""
    if mask.all():
        return crop
    small = cv2.resize(crop, None, fx=0.5, fy=0.5)
    sm = cv2.resize(mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    fill = cv2.inpaint(small, (1 - sm).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
    fill = cv2.resize(fill, (crop.shape[1], crop.shape[0]))
    m = cv2.erode(mask, np.ones((3, 3), np.uint8))[..., None].astype(bool)
    return np.where(m, crop, fill)


def main(name, sheet, out):
    C = CFG[name]
    img0 = cv2.imread(sheet)
    PAD = 200
    img = cv2.copyMakeBorder(img0, PAD, PAD, PAD, PAD, cv2.BORDER_REPLICATE)
    bg = int(np.median(img0[5:40, 5:40]))
    V = {}
    for k, v in C['views'].items():
        x0, y0, x1, y1 = v['box']
        box = (x0 + PAD, y0 + PAD, x1 + PAD, y1 + PAD)
        crop = img[box[1]:box[3], box[0]:box[2]].copy()
        mask = np.ones(crop.shape[:2], np.uint8) if v.get('raw') else view_mask(img, box, bg)
        if v.get('flip'): crop, mask = crop[:, ::-1].copy(), mask[:, ::-1].copy()
        V[k] = dict(crop=crop, mask=mask, **v)

    L, zmin, W, vs = C['L'], C['zmin'], C['W'], C['voxel']
    lw, lh = V['left']['crop'].shape[1], V['left']['crop'].shape[0]
    H = L * lh / lw                     # height from the side view's proportions
    zmax = zmin + L
    print(f'{name}: L={L} H={H:.2f} W={W}')

    side = V['left']['mask'].copy()
    for (ex0, ey0, ex1, ey1) in C.get('erase_side', []):
        bx, by = C['views']['left']['box'][:2]
        side[max(0, ey0 - by):max(0, ey1 - by), max(0, ex0 - bx):max(0, ex1 - bx)] = 0
    for (cx, cy, r) in C.get('wheels', []):
        x0, y0 = C['views']['left']['box'][:2]
        cv2.circle(side, (cx - x0, cy - y0), int(r * 1.04), 0, -1)

    nz, ny, nx = int(L / vs) + 3, int(H / vs) + 3, int(W / vs) + 3
    zs = zmin + (np.arange(nz) - 1) * vs
    ys = (np.arange(ny) - 1) * vs
    xs = -W / 2 + (np.arange(nx) - 1) * vs

    def sample(mask, u, v):     # u,v in 0..1 (image left->right, top->bottom)
        h, w = mask.shape
        ui = np.clip((u * w).astype(int), 0, w - 1); vi = np.clip((v * h).astype(int), 0, h - 1)
        ok = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
        return mask[vi, ui].astype(bool) & ok

    Z, Y, X = np.meshgrid(zs, ys, xs, indexing='ij')
    occ = np.ones(Z.shape, bool)
    if 'left' in C['carve']:
        occ &= sample(side, (Z - zmin) / L, (H - Y) / H)
    if 'top' in C['carve']:
        occ &= sample(V['top']['mask'], (zmax - Z) / L, (X + W / 2) / W)
    if 'front' in C['carve']:
        occ &= sample(V['front']['mask'], (X + W / 2) / W, (H - Y) / H)
    if 'thin_tail_px' in C:
        x0 = C['views']['left']['box'][0]
        ztail = zmin + (C['thin_tail_px'] - x0) / lw * L
        occ &= ~((Z < ztail) & (np.abs(X) > 0.09))
        # the tail plate is thinner than a voxel otherwise: keep the centre column
    if 'hollow' in C:
        hx0, hy0, hx1, hy1 = C['hollow']['rect']
        tx0, ty0, tx1, ty1 = C['views']['top']['box']
        tw, th = tx1 - tx0, ty1 - ty0
        za, zb = sorted([zmax - (hx0 - tx0) / tw * L, zmax - (hx1 - tx0) / tw * L])
        xa, xb = -W / 2 + (hy0 - ty0) / th * W, -W / 2 + (hy1 - ty0) / th * W
        occ &= ~((Z > za) & (Z < zb) & (X > xa) & (X < xb) & (Y > C['hollow']['floor']))
        meta_bed = dict(z0=za, z1=zb, x0=xa, x1=xb, floor=C['hollow']['floor'])
    vol = ndimage.gaussian_filter(occ.astype(np.float32), 0.9)
    verts, faces, _, _ = marching_cubes(vol, 0.5)
    P = np.stack([xs[0] + verts[:, 2] * vs, ys[0] + verts[:, 1] * vs, zs[0] + verts[:, 0] * vs], 1)
    tri = P[faces]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    # marching_cubes winding with our axis swap: make normals point outwards
    signed_vol = np.einsum('ij,ij->i', tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum()
    print('signed volume', signed_vol / 6)
    if signed_vol < 0:
        faces = faces[:, ::-1]; fn = -fn
    fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-9

    # ---- texture atlas
    S = 2048
    atlas = np.zeros((S, S, 3), np.uint8)
    layout = {'left': (0, 0, 1024, 420), 'right': (1024, 0, 1024, 420),
              'top': (0, 424, 1024, 440), 'bottom': (1024, 424, 1024, 440),
              'front': (0, 868, 512, 470), 'rear': (512, 868, 512, 470)}
    extra = {'wheel': (1024, 868, 300, 300), 'tread': (1328, 868, 300, 190), 'blade': (1024, 868, 1000, 110)}
    rects = {}
    for k, v in V.items():
        r = layout.get(k) or extra.get(k)
        if r is None: continue
        x, y, w, h = r
        tex = bleed(v['crop'], v['mask'])
        atlas[y:y + h, x:x + w] = cv2.resize(tex, (w, h), interpolation=cv2.INTER_AREA)
        rects[k] = [x / S, y / S, w / S, h / S]

    def uv_for(view, p):
        x, y, z = p[..., 0], p[..., 1], p[..., 2]
        if view == 'left':  u, v = (z - zmin) / L, (H - y) / H
        elif view == 'right': u, v = (zmax - z) / L, (H - y) / H
        elif view == 'top':   u, v = (zmax - z) / L, (x + W / 2) / W
        elif view == 'bottom': u, v = (zmax - z) / L, (W / 2 - x) / W
        elif view == 'front': u, v = (x + W / 2) / W, (H - y) / H
        else:                 u, v = (W / 2 - x) / W, (H - y) / H
        rx, ry, rw, rh = rects[view]
        u = np.clip(u, 0.002, 0.998); v = np.clip(v, 0.002, 0.998)
        return np.stack([rx + u * rw, 1 - (ry + v * rh)], -1)   # flipY texture convention

    ax = np.abs(fn).argmax(1)
    sgn = np.sign(fn[np.arange(len(fn)), ax])
    # left drawing (nose on the right) is what you see standing at -x
    names = {(0, -1): 'left', (0, 1): 'right', (1, 1): 'top', (1, -1): 'bottom', (2, 1): 'front', (2, -1): 'rear'}
    pos, uvs, nrm, idx = [], [], [], []
    base = 0
    for (a, s), view in names.items():
        sel = np.where((ax == a) & (sgn == s))[0]
        if not len(sel): continue
        f = faces[sel]
        used, inv = np.unique(f.ravel(), return_inverse=True)
        p = P[used]
        pos.append(p); uvs.append(uv_for(view, p)); idx.append(inv.reshape(-1, 3) + base)
        base += len(used)
    pos = np.concatenate(pos).astype(np.float32); uvs = np.concatenate(uvs).astype(np.float32)
    idx = np.concatenate(idx).astype(np.uint32)
    with open(f'{out}/{name}.bin', 'wb') as fh:
        fh.write(struct.pack('<II', len(pos), idx.size))
        fh.write(pos.tobytes()); fh.write(uvs.tobytes()); fh.write(idx.tobytes())
    cv2.imwrite(f'{out}/{name}.jpg', atlas, [cv2.IMWRITE_JPEG_QUALITY, 88])

    # parts placed from the drawing
    def side_to_model(px, py):
        x0, y0 = C['views']['left']['box'][:2]
        return zmin + (px - x0) / lw * L, H - (py - y0) / lh * H
    meta = dict(L=L, H=H, W=W, zmin=zmin, rects=rects, tris=len(idx), verts=len(pos))
    if 'hollow' in C: meta['bed'] = meta_bed
    if 'wheels' in C:
        meta['wheels'] = [dict(z=side_to_model(cx, cy)[0], y=side_to_model(cx, cy)[1], r=r / lw * L) for cx, cy, r in C['wheels']]
    json.dump(meta, open(f'{out}/{name}.json', 'w'), indent=1)
    print(json.dumps({k: meta[k] for k in meta if k != 'rects'}))


if __name__ == '__main__':
    main(*sys.argv[1:4])
