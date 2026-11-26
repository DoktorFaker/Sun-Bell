"""Cut the FRONT / SIDE / BACK figures out of a zombie turnaround sheet (GrabCut)."""
import cv2, numpy as np

SHEETS = {
    1: dict(front=(40, 55, 966, 1395), side=(970, 55, 1205, 1395), back=(1215, 55, 2110, 1395), side_faces='right',   # A-pose sheet
            # close-up head sheet: landmarks (eye line, chin, nose) matched by hand to the body sheet
            face=dict(file='tools/sheets/zombie1_face.jpg', front_box=(150, 0, 1250, 1300), side_box=(1250, 0, 2576, 1300),
                      body_front=(510, 175), face_front=(660, 540), body_side=(1190, 175), face_side=(2360, 540), k=400 / 82)),
    2: dict(front=(30, 40, 830, 1410), side=(2125, 40, 2450, 1410), back=(1230, 40, 2025, 1410), side_faces='right',   # A-pose sheet
            face=dict(file='tools/sheets/zombie2_face.jpg', front_box=(100, 0, 1300, 1438), side_box=(1250, 0, 2576, 1438), side_flip=True,
                      body_front=(428, 165), face_front=(676, 540), body_side=(2382, 192), face_side=(2330, 690), k=4.76)),
    4: dict(front=(30, 60, 925, 1380), side=(2160, 60, 2510, 1380), back=(1205, 60, 2100, 1380), side_faces='right',   # A-pose sheet
            face=dict(file='tools/sheets/zombie4_face.jpg', front_box=(100, 0, 1300, 1438), side_box=(1300, 0, 2576, 1438), side_flip=True,
                      body_front=(479, 176), face_front=(666, 570), body_side=(2394, 200), face_side=(2426, 690), k=5.2)),
    3: dict(front=(40, 40, 962, 1400), side=(2140, 40, 2515, 1400), back=(1215, 40, 2125, 1400), side_faces='right',   # A-pose sheet
            face=dict(file='tools/sheets/zombie3_face.jpg', front_box=(100, 0, 1300, 1438), side_box=(1350, 0, 2576, 1438), side_flip=True,
                      body_front=(506, 156), face_front=(670, 570), body_side=(2392, 158), face_side=(2456, 570), k=4.5)),
}

def cut(img, box, bg_poly=None):
    x0, y0, x1, y1 = box
    sub = img[y0:y1, x0:x1].copy()
    h, w = sub.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    g = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
    # confident figure: clearly darker than the backdrop or coloured
    bg = np.median(np.concatenate([g[:, :8].ravel(), g[:, -8:].ravel()]))
    mask[(g < bg - 45) | (hsv[..., 1] > 70)] = cv2.GC_PR_FGD
    mask[(g < bg - 90)] = cv2.GC_FGD
    if bg_poly:
        cv2.fillPoly(mask, [np.array([(x - x0, y - y0) for x, y in bg_poly], np.int32)], cv2.GC_BGD)
    mask[:, :4] = cv2.GC_BGD; mask[:, -4:] = cv2.GC_BGD; mask[:4] = cv2.GC_BGD
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(sub, mask, None, bgd, fgd, 6, cv2.GC_INIT_WITH_MASK)
    m = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    i = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
    m = (lab == i).astype(np.uint8)
    ff = np.pad(m, 1).copy(); fl = np.zeros((h + 4, w + 4), np.uint8); cv2.floodFill(ff, fl, (0, 0), 1)
    m = m | (1 - ff[1:-1, 1:-1])
    x, y, bw, bh = cv2.boundingRect(m)
    return sub[y:y + bh, x:x + bw], m[y:y + bh, x:x + bw], (x0 + x, y0 + y)

def load(i):
    img = cv2.imread(f'tools/sheets/zombie{i}.jpg')
    cfg = SHEETS[i]
    out = {}
    for k in ('front', 'side', 'back'):
        c, m, o = cut(img, cfg[k], cfg.get('bg_poly', {}).get(k))
        if k == 'side' and cfg['side_faces'] == 'left':
            c, m = c[:, ::-1].copy(), m[:, ::-1].copy()
        out[k] = (c, m)
        out[k + '_origin'] = o
    return out

if __name__ == '__main__':
    for i in (1, 2, 3, 4):
        v = load(i)
        tiles = []
        for k in ('front', 'side', 'back'):
            c, m = v[k][:2]
            t = c.copy(); t[m == 0] = (255, 0, 255)
            t = cv2.resize(t, (int(t.shape[1] * 500 / t.shape[0]), 500)); tiles.append(t)
        cv2.imwrite(f'/tmp/zb/seg{i}.png', np.hstack(tiles))
