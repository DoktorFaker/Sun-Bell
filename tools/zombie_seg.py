"""Cut the FRONT / SIDE / BACK figures out of a zombie turnaround sheet (GrabCut)."""
import cv2, numpy as np

SHEETS = {
    1: dict(front=(110, 150, 690, 1345), side=(1460, 150, 1745, 1345), back=(1905, 150, 2485, 1345), side_faces='right'),
    2: dict(front=(125, 150, 665, 1340), side=(1520, 150, 1805, 1340), back=(1940, 150, 2545, 1340), side_faces='right'),
    3: dict(front=(135, 115, 635, 1345), side=(1455, 115, 1765, 1345), back=(1945, 115, 2445, 1345), side_faces='left',
            bg_poly={'front': [(388, 800), (300, 1330), (478, 1330)]}),   # floor shadow between the legs
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
    return sub[y:y + bh, x:x + bw], m[y:y + bh, x:x + bw]

def load(i):
    img = cv2.imread(f'tools/sheets/zombie{i}.jpg')
    cfg = SHEETS[i]
    out = {}
    for k in ('front', 'side', 'back'):
        c, m = cut(img, cfg[k], cfg.get('bg_poly', {}).get(k))
        if k == 'side' and cfg['side_faces'] == 'left':
            c, m = c[:, ::-1].copy(), m[:, ::-1].copy()
        out[k] = (c, m)
    return out

if __name__ == '__main__':
    for i in (1, 2, 3):
        v = load(i)
        tiles = []
        for k in ('front', 'side', 'back'):
            c, m = v[k]
            t = c.copy(); t[m == 0] = (255, 0, 255)
            t = cv2.resize(t, (int(t.shape[1] * 500 / t.shape[0]), 500)); tiles.append(t)
        cv2.imwrite(f'/tmp/zb/seg{i}.png', np.hstack(tiles))
