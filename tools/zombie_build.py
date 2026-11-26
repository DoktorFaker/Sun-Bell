"""Build cut-apart 3D zombies from turnaround sheets (front / side / back).

Each body part is a stack of elliptical rings: width from the FRONT silhouette, depth from the SIDE
silhouette, row by row. The game paints them by projecting the front, back and side pictures
(see src/game/Zombie.js), so every part looks like the drawing and can be cut off on its own.

usage: python3 -I tools/zombie_build.py  -> public/models/zombie{1,2,3}.json + .jpg
"""
import json, sys, os
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__))
from zombie_seg import load

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


def build(i, out):
    V = load(i)
    fc, F = V['front']; sc, S = V['side']; bc, B = V['back']
    h, w = F.shape; s = H / h
    hs, ws = S.shape; ss = H / hs
    hb, wb = B.shape; sb = H / hb
    # trim floor shadow: feet rows narrower than ~70% of the widest foot row stay; others no
    # centre line at the hips
    hipr = int(h * 0.5)
    cx = np.mean(pick(runs_of(F[hipr]), w // 2))
    cxb = np.mean(pick(runs_of(B[int(hb * 0.5)]), wb // 2))
    czs = np.mean(max(runs_of(S[int(hs * 0.5)]), key=lambda r: r[1] - r[0]))

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
        if name != 'torso':
            R = np.vstack([[R[0, 0] - ext, R[0, 1], R[0, 2] * 0.9], R])
        if name in ('torso', 'uarmR', 'uarmL', 'thighR', 'thighL'):
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
        defs += [('uarm' + sd, 6, caps['arm'], 'torso'), ('farm' + sd, 6, caps['arm'], 'uarm' + sd),
                 ('thigh' + sd, 7, caps['leg'], 'root'), ('shin' + sd, 7, caps['leg'], 'thigh' + sd)]
    built = {}
    for name, step, cap, parent in defs:
        p = make(name, step, cap)
        if p: built[name] = (p, parent)

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
        R = built['uarm' + sd][0]['rows']
        sh = centre_row('uarm' + sd, R[0, 0]); sh[1] += 0.04
        # shoulder sits in from the arm's outer edge
        sh[0] = sh[0] * 0.85
        piv['uarm' + sd] = sh
        piv['farm' + sd] = centre_row('uarm' + sd, built['uarm' + sd][0]['rows'][-1, 0])
        piv['thigh' + sd] = centre_row('thigh' + sd, built['thigh' + sd][0]['rows'][0, 0])
        piv['shin' + sd] = centre_row('thigh' + sd, built['thigh' + sd][0]['rows'][-1, 0])

    # atlas: front | side | back, 1024 tall
    AH = 1280   # keep the sheets' full detail
    tiles = []
    for c, m in ((fc, F), (sc, S), (bc, B)):
        t = bleed(c, m)
        tiles.append(cv2.resize(t, (int(round(t.shape[1] * AH / t.shape[0])), AH), interpolation=cv2.INTER_AREA))
    AW = sum(t.shape[1] for t in tiles)
    atlas = np.hstack(tiles)
    offs = np.cumsum([0] + [t.shape[1] for t in tiles])
    # projection: atlas u = au*coord + bu ; texture v (flipY) = av*y + bv
    def proj(off, tw, img_w, img_h, centre, scale, sign):
        # px = centre + sign*coord/scale ; u = (off + px/img_w*tw)/AW
        au = sign / scale / img_w * tw / AW
        bu = (off + centre / img_w * tw) / AW
        # py = img_h - y/scale ; v_img = py/img_h ; texture v = 1 - v_img = y/(scale*img_h)
        av = 1 / (scale * img_h); bv = 0.0
        return [au, bu, av, bv]
    uv = {
        'front': proj(offs[0], tiles[0].shape[1], w, h, cx, s, 1),
        'side': proj(offs[1], tiles[1].shape[1], ws, hs, czs, ss, 1),
        'back': proj(offs[2], tiles[2].shape[1], wb, hb, cxb, sb, -1),
    }
    cv2.imwrite(f'{out}/zombie{i}.jpg', atlas, [cv2.IMWRITE_JPEG_QUALITY, 93])
    parts = []
    for name, (p, parent) in built.items():
        parts.append(dict(name=name, parent=parent, pivot=piv[name], pos=p['pos'], idx=p['idx']))
    meta = dict(H=H, root=piv['root'], parts=parts, uv=uv)
    json.dump(meta, open(f'{out}/zombie{i}.json', 'w'), separators=(',', ':'))
    print(i, 'armpit', armpit / h, 'crotch', crotch / h, 'parts', list(built), 'verts', sum(len(p['pos']) // 3 for p in parts))


if __name__ == '__main__':
    for i in (1, 2, 3):
        build(i, 'public/models')
