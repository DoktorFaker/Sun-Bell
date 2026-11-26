"""Make a photo tile: centre square crop, then blend each edge into the opposite one (wraps without seams)."""
import sys, numpy as np, cv2
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2048
im = cv2.imread(src).astype(np.float32)
h, w = im.shape[:2]; s = min(h, w)
im = im[(h - s) // 2:(h - s) // 2 + s, (w - s) // 2:(w - s) // 2 + s]
b = s // 6                                   # blend band
out = im[:s - b, :s - b].copy()              # (s-b) square that will wrap
n = s - b
# horizontal: blend the extra band on the right into the left edge
ramp = np.linspace(0, 1, b)[None, :, None]
out[:, :b] = im[:n, n:n + b] * (1 - ramp) + out[:, :b] * ramp
# vertical
ramp = np.linspace(0, 1, b)[:, None, None]
extra = np.concatenate([im[n:n + b, :n]], 0)
extra[:, :b] = im[n:n + b, n:n + b] * (1 - np.linspace(0, 1, b)[None, :, None]) + extra[:, :b] * np.linspace(0, 1, b)[None, :, None]
out[:b] = extra * (1 - ramp) + out[:b] * ramp
out = cv2.resize(out, (size, size), interpolation=cv2.INTER_AREA)
cv2.imwrite(dst, np.clip(out, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
