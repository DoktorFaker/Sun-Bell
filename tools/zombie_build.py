"""Build cut-apart 3D zombies from turnaround sheets (front / side / back).

Each body part is a stack of elliptical rings: width from the FRONT silhouette, depth from the SIDE
silhouette, row by row. The game paints them by projecting the front, back and side pictures
(see src/game/Zombie.js), so every part looks like the drawing and can be cut off on its own.

usage: python3 -I tools/zombie_build.py  -> public/models/zombie{1,2,3}.json + .jpg
"""
import json, sys, os
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__))
from zombie_seg import load, SHEETS

H = 1.75          # standing height in metres
SEG = 14          # vertices per ring


def runs_of(row):
    d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
    a = np.where(d == 1)[0]; b = np.where(d == -1)[0]
    return [(x0, x1) for x0, x1 in zip(a, b) if x1 - x0 >= 2]


def pick(runs, c):
    for r in runs:
        if r[0] <= c < r[1]: return r
    return min(runs, key=lambda r: min(abs(r[0] - c), abs(r[1] - c))) if runs else None


def bleed(crop, mask):
    small = cv2.resize(crop, None, fx=0.5, fy=0.5)
    sm = cv2.resize(mask, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    fill = cv2.inpaint(small, (1 - sm).astype(np.uint8) * 255, 6, cv2.INPAINT_TELEA)
    fill = cv2.resize(fill, (crop.shape[1], crop.shape[0]))
    m = cv2.erode(mask, np.ones((5, 5), np.uint8))[..., None].astype(bool)
    return np.where(m, crop, fill)


def keep_largest(m):
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8))
    if n <= 1: return m
    return (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)


def find_arms(F, cx, h, w):
    """Arms are the thin parts on either side: open the silhouette with a disc wider than an arm."""
    k = int(h * 0.075) | 1
    core = cv2.morphologyEx(F, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    thin = (F & ~core).astype(np.uint8)
    thin[int(h * 0.7):] = 0
    thin[:int(h * 0.12)] = 0
    n, lab, st, cen = cv2.connectedComponentsWithStats(thin)
    out = {}
    for sd, sgn in (('R', -1), ('L', 1)):
        best = None
        for i in range(1, n):
            a = st[i, cv2.CC_STAT_AREA]
            if a < h * h * 0.004: continue
            if (cen[i][0] - cx) * sgn < h * 0.07: continue
            if best is None or a > st[best, cv2.CC_STAT_AREA]: best = i
        if best is None: return None
        m = (lab == best).astype(np.uint8)
        x, y, bw, bh = cv2.boundingRect(m)
        if np.hypot(bw, bh) < h * 0.27: return None   # arms held against the body: use the row method
        out[sd] = m
    return out


def axis_arm(m, cx, h, s, ss, czs, side_at, neck):
    """Slice an arm across its own length (works for hanging and outstretched arms)."""
    ys, xs = np.nonzero(m)
    P = np.stack([xs, ys], 1).astype(float)
    mu = P.mean(0)
    u, sv, vt = np.linalg.svd(P - mu, full_matrices=False)
    a = vt[0]
    t = (P - mu) @ a
    # the shoulder end is the one nearer the body's centre line / higher up
    e0 = mu + a * t.min(); e1 = mu + a * t.max()
    if abs(e1[0] - cx) + e1[1] * 0.3 < abs(e0[0] - cx) + e0[1] * 0.3: a = -a; t = -t
    perp = np.array([-a[1], a[0]])
    q = (P - mu) @ perp
    t0, t1 = t.min(), t.max()
    step = max(4.0, (t1 - t0) / 26)
    slices = []
    for tc in np.arange(t0 + step / 2, t1, step):
        sel = np.abs(t - tc) < step * 0.75
        if sel.sum() < 4: continue
        qa, qb = np.percentile(q[sel], [3, 97])
        slices.append((tc, (qa + qb) / 2, max((qb - qa) / 2, 2.0)))
    S = np.array(slices)
    for c in (1, 2):
        S[1:-1, c] = (S[:-2, c] + 2 * S[1:-1, c] + S[2:, c]) / 4
    # image -> model; image y grows downward
    def to_model(tc, qc):
        p = mu + a * tc + perp * qc
        return np.array([(p[0] - cx) * s, (h - p[1]) * s])
    am = np.array([a[0], -a[1]]); am /= np.linalg.norm(am)
    pm = np.array([-am[1], am[0]])        # ring frame: pm x z == axis direction
    split = t0 + 0.46 * (t1 - t0)
    ext = 0.045 / s
    def ring_list(lo, hi, pre, post):
        R = [r for r in S if lo <= r[0] <= hi]
        if pre: R = [(R[0][0] - pre, R[0][1], R[0][2] * 0.92)] + R
        if post: R = R + [(R[-1][0] + post, R[-1][1], R[-1][2] * 0.92)]
        return R
    def mesh(R):
        pos, idx = [], []
        for (tc, qc, hw) in R:
            c = to_model(tc, qc)
            wv = hw * s
            zc_px, hz = side_at(c[1])
            zc = (zc_px - czs) * ss * 0.6
            wz = min(hz * ss, wv * 1.0); wz = max(wz, wv * 0.6)
            for k in range(SEG):
                th = k / SEG * np.pi * 2
                xy = c + pm * wv * np.cos(th)
                pos.append((xy[0], xy[1], zc + wz * np.sin(th)))
        n = len(R)
        for j in range(n - 1):
            for k in range(SEG):
                a0, b0 = j * SEG + k, j * SEG + (k + 1) % SEG
                idx += [a0, a0 + SEG, b0, b0, a0 + SEG, b0 + SEG]
        for j, flip in ((0, False), (n - 1, True)):
            ring = np.array(pos[j * SEG:(j + 1) * SEG]); ci = len(pos); pos.append(tuple(ring.mean(0)))
            for k in range(SEG):
                a0, b0 = j * SEG + k, j * SEG + (k + 1) % SEG
                idx += [ci, b0, a0] if not flip else [ci, a0, b0]
        return dict(pos=np.round(np.array(pos), 4).ravel().tolist(), idx=idx)
    up = mesh(ring_list(t0, split, ext * 1.4, ext * 0.6))
    fore = mesh(ring_list(split, t1 + 1, ext, 0))
    def piv(tc, qc):
        c = to_model(tc, qc); zc_px, _ = side_at(c[1])
        return [round(float(c[0]), 4), round(float(c[1]), 4), round(float((zc_px - czs) * ss * 0.6), 4)]
    first = S[0]; mid = min(S, key=lambda r: abs(r[0] - split))
    return up, fore, piv(first[0] - ext * 0.3, first[1]), piv(mid[0], mid[1])


def build(i, out):
    V = load(i)
    fc, F = V['front']; sc, S = V['side']; bc, B = V['back']
    F0 = F.copy()
    h, w = F.shape; s = H / h
    hs, ws = S.shape; ss = H / hs
    hb, wb = B.shape; sb = H / hb
    # trim floor shadow: feet rows narrower than ~70% of the widest foot row stay; others no
    # centre line at the hips
    hipr = int(h * 0.5)
    cx = np.mean(pick(runs_of(F[hipr]), w // 2))
    cxb = np.mean(pick(runs_of(B[int(hb * 0.5)]), wb // 2))
    czs = np.mean(max(runs_of(S[int(hs * 0.5)]), key=lambda r: r[1] - r[0]))

    arm_masks = find_arms(F, cx, h, w)
    if arm_masks:
        F = F & ~(arm_masks['R'] | arm_masks['L'])
        F = keep_largest(F)
    neck = int(h * 0.155)
    armpit = next((r for r in range(int(h * 0.17), int(h * 0.4)) if len(runs_of(F[r])) >= 3), int(h * 0.24)) + 4
    crotch = next((r for r in range(int(h * 0.42), int(h * 0.6)) if not F[r, int(cx)] and len(runs_of(F[r])) >= 2), int(h * 0.5))
    # rows per part: centre/width in the front view
    rows = {k: {} for k in ('head', 'torso', 'uarmR', 'farmR', 'uarmL', 'farmL', 'thighR', 'shinR', 'thighL', 'shinL')}
    torso_w = max(np.diff(pick(runs_of(F[r]), int(cx)))[0] for r in range(int(h * 0.45), crotch - 4))
    arm_bottom = {'R': armpit, 'L': armpit}
    arm_rows = {'R': {}, 'L': {}}
    leg_rows = {'R': {}, 'L': {}}
    for r in range(h):
        rr = runs_of(F[r])
        if not rr: continue
        if r < armpit or (r < crotch and r >= armpit):
            t = pick(rr, cx)
            (rows['head'] if r < neck else rows['torso'])[r] = t
            if r >= armpit:
                for side, cond in (('R', lambda q: q[1] <= t[0]), ('L', lambda q: q[0] >= t[1])):
                    q = [x for x in rr if cond(x)]
                    if q: arm_rows[side][r] = (min(x[0] for x in q), max(x[1] for x in q)); arm_bottom[side] = r
        else:
            near = [q for q in rr if abs((q[0] + q[1]) / 2 - cx) < torso_w * 0.62]
            legs = []
            for sgn in (-1, 1):   # the run nearest the centre on each side is the leg
                c = [q for q in near if ((q[0] + q[1]) / 2 - cx) * sgn > 0 or q[0] <= cx < q[1]]
                if c: legs.append(min(c, key=lambda q: abs((q[0] + q[1]) / 2 - cx)))
            legs = list(dict.fromkeys(legs))
            arms = [q for q in rr if q not in legs]
            if len(legs) == 1 and legs[0][0] < cx < legs[0][1]:
                legs = [(legs[0][0], int(cx)), (int(cx), legs[0][1])]
            for q in legs:
                leg_rows['R' if (q[0] + q[1]) / 2 < cx else 'L'][r] = q
            for q in arms:
                side = 'R' if q[1] <= cx else 'L'
                prev = arm_rows[side].get(r)
                arm_rows[side][r] = (min(q[0], prev[0]), max(q[1], prev[1])) if prev else q
                arm_bottom[side] = max(arm_bottom[side], r)
    # arms pressed against the body (above the armpit, or a sleeve touching the jacket): cut along the
    # arm's inner edge, carried on from the rows where the arm hangs free
    full_w = np.diff(pick(runs_of(F[armpit - 6]), int(cx)))[0]
    shoulder = next((r for r in range(neck, armpit) if np.diff(pick(runs_of(F[r]), int(cx)))[0] > 0.85 * full_w), neck + 10)
    hip_half = torso_w / 2
    for side in 'RL':
        ks = sorted(k for k in arm_rows[side] if k < crotch)
        if len(ks) < 5: continue
        ks = [k for k in ks if k < ks[0] + h * 0.1]   # fit the upper arm only
        inner = np.array([arm_rows[side][k][1] if side == 'R' else arm_rows[side][k][0] for k in ks], float)
        widths = np.array([arm_rows[side][k][1] - arm_rows[side][k][0] for k in ks], float)
        armW = float(np.median(widths))
        A = np.polyfit(ks, inner, 1)
        for r in range(shoulder + 3, crotch):
            t = rows['torso'].get(r)
            if not t or r in arm_rows[side] and r >= armpit: continue
            e = int(np.polyval(A, r))
            if side == 'R':
                e = min(e, t[0] + int(armW * 1.25))
                if e > t[0] + 3 and e < cx - hip_half * 0.5:
                    arm_rows[side][r] = (t[0], e); rows['torso'][r] = (e, t[1]); arm_bottom[side] = max(arm_bottom[side], r)
            else:
                e = max(e, t[1] - int(armW * 1.25))
                if e < t[1] - 3 and e > cx + hip_half * 0.5:
                    arm_rows[side][r] = (e, t[1]); rows['torso'][r] = (t[0], e); arm_bottom[side] = max(arm_bottom[side], r)
    for side in 'RL':
        ks = sorted(arm_rows[side]); keep = []
        for k in ks:
            if keep and k - keep[-1] > h * 0.06: break
            keep.append(k)
        filled = {}
        for a, b in zip(keep, keep[1:] + [keep[-1] + 1] if keep else []):
            for r in range(a, b):   # bridge short gaps where the arm touched the body
                q0, q1 = arm_rows[side][a], arm_rows[side].get(b, arm_rows[side][a])
                f = (r - a) / max(1, b - a)
                filled[r] = (int(q0[0] + (q1[0] - q0[0]) * f), int(q0[1] + (q1[1] - q0[1]) * f))
                if r != a and side == 'R' and rows['torso'].get(r) and rows['torso'][r][0] < filled[r][1]: rows['torso'][r] = (filled[r][1], rows['torso'][r][1])
                if r != a and side == 'L' and rows['torso'].get(r) and rows['torso'][r][1] > filled[r][0]: rows['torso'][r] = (rows['torso'][r][0], filled[r][0])
        arm_rows[side] = filled
        arm_bottom[side] = keep[-1] if keep else armpit
    ankle = int(h * 0.9)
    for side in 'RL':
        a0, a1 = min(arm_rows[side]), arm_bottom[side]
        elbow = int(a0 + 0.44 * (a1 - a0))
        for r, q in arm_rows[side].items():
            rows[('uarm' if r < elbow else 'farm') + side][r] = q
        rows['uarm' + side]['elbow'] = elbow
        k0 = min(leg_rows[side]) if leg_rows[side] else crotch
        knee = int(k0 + 0.47 * (h - k0))
        for r, q in leg_rows[side].items():
            rows[('thigh' if r < knee else 'shin') + side][r] = q
        rows['thigh' + side]['knee'] = knee

    def side_at(y):
        r = int(np.clip(hs - y / ss, 0, hs - 1))
        rr = runs_of(S[r])
        if not rr: return czs, 0.05 / ss
        a, b = min(q[0] for q in rr), max(q[1] for q in rr)
        return (a + b) / 2, (b - a) / 2

    def ring_rows(part, step):
        d = {k: v for k, v in rows[part].items() if isinstance(k, (int, np.integer))}
        if len(d) < 3: return []
        ks = sorted(d)
        sel = list(range(ks[0], ks[-1] + 1, step))
        if sel[-1] != ks[-1]: sel.append(ks[-1])
        out = []
        for r in sel:
            r2 = min(d, key=lambda k: abs(k - r))
            a, b = d[r2]
            out.append((r, (a + b) / 2, (b - a) / 2))
        # smooth centre/width a little
        arr = np.array(out, float)
        for c in (1, 2):
            arr[1:-1, c] = (arr[:-2, c] + 2 * arr[1:-1, c] + arr[2:, c]) / 4
        return arr

    parts = []
    limb = lambda p: p not in ('head', 'torso')
    def make(name, step, depth_cap):
        R = ring_rows(name, step)
        if len(R) < 2: return None
        # overlap the joints so no gaps open when the parts bend
        ext = 0.045 / s
        if name not in ('torso', 'head'):
            R = np.vstack([[R[0, 0] - ext, R[0, 1], R[0, 2] * 0.9], R])
        if name in ('torso', 'head', 'uarmR', 'uarmL', 'thighR', 'thighL'):
            R = np.vstack([R, [R[-1, 0] + ext * 0.6, R[-1, 1], R[-1, 2] * 0.9]])
        pos, idx = [], []
        for (r, xc, hw) in R:
            y = (h - r) * s
            x = (xc - cx) * s; wx = max(hw * s, 0.012)
            zc_px, hz = side_at(y)
            zc = (zc_px - czs) * ss; wz = hz * ss
            cap = depth_cap(y, wx)
            wz = min(wz, cap) if cap else wz
            wz = max(wz, wx * 0.45)
            if limb(name) and y > 0.12:
                zc = zc * 0.6     # limbs hang at mid-depth, not at the belly's centre
            for k in range(SEG):
                t = k / SEG * np.pi * 2
                pos.append((x + wx * np.cos(t), y, zc + wz * np.sin(t)))
        n = len(R)
        for j in range(n - 1):
            for k in range(SEG):
                a, b = j * SEG + k, j * SEG + (k + 1) % SEG
                c, d = a + SEG, b + SEG
                idx += [a, c, b, b, c, d]
        # caps
        for j, flip in ((0, False), (n - 1, True)):
            ring = np.array(pos[j * SEG:(j + 1) * SEG]); cen = ring.mean(0)
            ci = len(pos); pos.append(tuple(cen))
            for k in range(SEG):
                a, b = j * SEG + k, j * SEG + (k + 1) % SEG
                idx += [ci, b, a] if not flip else [ci, a, b]
        return dict(name=name, pos=np.round(np.array(pos), 4).ravel().tolist(), idx=idx, rows=R)

    caps = {
        'head': lambda y, wx: None, 'torso': lambda y, wx: None,
        'arm': lambda y, wx: wx * 1.0,
        'leg': lambda y, wx: (wx * 1.15 if y > (h - ankle) * s else wx * 2.6),
    }
    defs = [('head', 4, caps['head'], None), ('torso', 6, caps['torso'], None)]
    for sd in 'RL':
        if not arm_masks:
            defs += [('uarm' + sd, 6, caps['arm'], 'torso'), ('farm' + sd, 6, caps['arm'], 'uarm' + sd)]
        defs += [('thigh' + sd, 7, caps['leg'], 'root'), ('shin' + sd, 7, caps['leg'], 'thigh' + sd)]
    built = {}
    for name, step, cap, parent in defs:
        p = make(name, step, cap)
        if p: built[name] = (p, parent)
    arm_piv = {}
    if arm_masks:
        for sd in 'RL':
            up, fore, sh, el = axis_arm(arm_masks[sd], cx, h, s, ss, czs, side_at, neck)
            built['uarm' + sd] = (dict(name='uarm' + sd, **up), 'torso')
            built['farm' + sd] = (dict(name='farm' + sd, **fore), 'uarm' + sd)
            arm_piv['uarm' + sd] = sh; arm_piv['farm' + sd] = el

    # joints (pivots) in model space
    def centre_row(name, r):
        R = built[name][0]['rows']; j = np.argmin(np.abs(R[:, 0] - r))
        y = (h - R[j, 0]) * s; x = (R[j, 1] - cx) * s
        zc_px, _ = side_at(y); z = (zc_px - czs) * ss * (0.6 if limb(name) else 1)
        return [round(float(x), 4), round(float(y), 4), round(float(z), 4)]
    piv = {}
    piv['root'] = [0, round((h - crotch) * s, 4), 0]
    piv['torso'] = [0, round((h - crotch) * s + 0.08, 4), round((side_at((h - crotch) * s)[0] - czs) * ss, 4)]
    piv['head'] = centre_row('torso', neck + 2)
    for sd in 'RL':
        if arm_piv:
            piv['uarm' + sd] = arm_piv['uarm' + sd]; piv['farm' + sd] = arm_piv['farm' + sd]
        else:
            R = built['uarm' + sd][0]['rows']
            sh = centre_row('uarm' + sd, R[0, 0]); sh[1] += 0.04
            sh[0] = sh[0] * 0.85   # shoulder sits in from the arm's outer edge
            piv['uarm' + sd] = sh
            piv['farm' + sd] = centre_row('uarm' + sd, built['uarm' + sd][0]['rows'][-1, 0])
        piv['thigh' + sd] = centre_row('thigh' + sd, built['thigh' + sd][0]['rows'][0, 0])
        piv['shin' + sd] = centre_row('thigh' + sd, built['thigh' + sd][0]['rows'][-1, 0])

    # atlas: row 1 = front | side | back of the body ; row 2 = the close-up head sheet (if any)
    RH = 1280
    tiles = []
    for c, m in ((fc, F0), (sc, S), (bc, B)):
        t = bleed(c, m)
        tiles.append(cv2.resize(t, (int(round(t.shape[1] * RH / t.shape[0])), RH), interpolation=cv2.INTER_AREA))
    face = SHEETS[i].get('face')
    ftiles = []
    if face:
        fimg = cv2.imread(face['file'])
        FH = 1024
        for key in ('front_box', 'side_box'):
            x0, y0, x1, y1 = face[key]
            t = fimg[y0:y1, x0:x1]
            if key == 'side_box' and face.get('side_flip'): t = t[:, ::-1]   # landmarks are given in the flipped picture
            t = np.ascontiguousarray(t)
            fm = (np.abs(t.astype(int) - 250).max(axis=2) > 18).astype(np.uint8)   # anything not the white backdrop
            fm = cv2.morphologyEx(fm, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
            t = bleed(t, fm)
            ftiles.append(cv2.resize(t, (int(round(t.shape[1] * FH / t.shape[0])), FH), interpolation=cv2.INTER_AREA))
    AW = max(sum(t.shape[1] for t in tiles), sum(t.shape[1] for t in ftiles) if ftiles else 0)
    AT = RH + (ftiles[0].shape[0] if ftiles else 0)
    atlas = np.zeros((AT, AW, 3), np.uint8)
    x = 0; offs = []
    for t in tiles: atlas[:RH, x:x + t.shape[1]] = t; offs.append(x); x += t.shape[1]
    fx = 0; foffs = []
    for t in ftiles: atlas[RH:, fx:fx + t.shape[1]] = t; foffs.append(fx); fx += t.shape[1]
    def proj(off, tw, img_w, img_h, centre, scale, sign):
        # px = centre + sign*coord/scale ; py = img_h - y/scale
        au = sign / scale / img_w * tw / AW
        bu = (off + centre / img_w * tw) / AW
        av = RH / (scale * img_h * AT); bv = 1 - RH / AT
        return [au, bu, av, bv]
    uv = {
        'front': proj(offs[0], tiles[0].shape[1], w, h, cx, s, 1),
        'side': proj(offs[1], tiles[1].shape[1], ws, hs, czs, ss, 1),
        'back': proj(offs[2], tiles[2].shape[1], wb, hb, cxb, sb, -1),
    }
    head_uv = None
    if face:
        k = face['k']
        def fproj(tile_i, box, body_lm, face_lm, origin, centre, scale, img_h):
            # body abs x = ox + centre + coord/scale ; face x = fx + k*(abs - bx)
            ox, oy = origin
            Kx = k / scale; Cx = face_lm[0] + k * (ox + centre - body_lm[0])
            # body abs y = oy + img_h - y/scale ; face y = fy + k*(abs - by)
            Ky = -k / scale; Cy = face_lm[1] + k * (oy + img_h - body_lm[1])
            x0, y0, x1, y1 = box; fw, fh = x1 - x0, y1 - y0
            tw, th = ftiles[tile_i].shape[1], ftiles[tile_i].shape[0]
            tx, ty = foffs[tile_i], RH
            return [Kx * tw / (fw * AW), (tx + (Cx - x0) * tw / fw) / AW,
                    -Ky * th / (fh * AT), 1 - (ty + (Cy - y0) * th / fh) / AT]
        head_uv = {
            'front': fproj(0, face['front_box'], face['body_front'], face['face_front'], V['front_origin'], cx, s, h),
            'side': fproj(1, face['side_box'], face['body_side'], face['face_side'], V['side_origin'], czs, ss, hs),
            'back': uv['back'],
        }
    cv2.imwrite(f'{out}/zombie{i}.jpg', atlas, [cv2.IMWRITE_JPEG_QUALITY, 93])
    parts = []
    for name, (p, parent) in built.items():
        parts.append(dict(name=name, parent=parent, pivot=piv[name], pos=p['pos'], idx=p['idx']))
    meta = dict(H=H, root=piv['root'], parts=parts, uv=uv)
    if head_uv: meta['headUV'] = head_uv
    json.dump(meta, open(f'{out}/zombie{i}.json', 'w'), separators=(',', ':'))
    print(i, 'armpit', armpit / h, 'crotch', crotch / h, 'parts', list(built), 'verts', sum(len(p['pos']) // 3 for p in parts))


if __name__ == '__main__':
    for i in (1, 2, 3, 4):
        build(i, 'public/models')
