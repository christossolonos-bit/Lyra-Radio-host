#!/usr/bin/env python3
"""Build Lyra's lip-sync frames: line each mouth edit up with the base face, then paste ONLY the mouth area.

  python tools/make_sprites.py          # writes public/clips/lipsync/{rest,small,ah,ee,oo}.jpg (+ a check sheet)

Free, no API calls. The image model reframes each edit slightly, so every edit is first aligned to the base
with feature matching (rotation, scale, shift), and then a soft oval around the mouth is blended in.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

CLIPS = Path(__file__).resolve().parent.parent / "public" / "clips"
SHAPES = CLIPS / "shapes"
OUT = CLIPS / "lipsync"
OUT.mkdir(parents=True, exist_ok=True)

FACE = (560, 120, 980, 560)  # x0, y0, x1, y1 of her face in the 1536x864 base frame


def align(edit: np.ndarray, base: np.ndarray) -> np.ndarray:
    """Warp the edit so her face sits exactly where it is in the base."""
    x0, y0, x1, y1 = FACE
    mask = np.zeros(base.shape[:2], np.uint8)
    mask[y0:y1, x0:x1] = 255
    orb = cv2.ORB_create(4000)
    g = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    kb, db = orb.detectAndCompute(g(base), mask)
    ke, de = orb.detectAndCompute(g(edit), mask)
    matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(de, db, k=2)
    good = [m for m, n in (p for p in matches if len(p) == 2) if m.distance < 0.75 * n.distance]
    src = np.float32([ke[m.queryIdx].pt for m in good])
    dst = np.float32([kb[m.trainIdx].pt for m in good])
    M, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3)
    scale = float(np.hypot(M[0, 0], M[0, 1]))
    print(f"  {len(good)} matches, {int(inliers.sum())} inliers, scale {scale:.3f}, shift ({M[0, 2]:.0f}, {M[1, 2]:.0f})")
    return cv2.warpAffine(edit, M, (base.shape[1], base.shape[0]), flags=cv2.INTER_CUBIC)


def mouth_center(aligned: list[np.ndarray], base: np.ndarray) -> tuple[int, int]:
    """Where the edits differ most from the base inside the lower face = the mouth."""
    x0, y0, x1, y1 = FACE
    heat = np.zeros(base.shape[:2], np.float32)
    for a in aligned:
        heat += cv2.GaussianBlur(cv2.absdiff(a, base).mean(axis=2).astype(np.float32), (0, 0), 12)
    lower = heat[y0 + (y1 - y0) // 2:y1, x0:x1]
    _, _, _, (mx, my) = cv2.minMaxLoc(lower)
    return x0 + mx, y0 + (y1 - y0) // 2 + my


def oval_mask(shape, center, rx, ry, feather) -> np.ndarray:
    m = np.zeros(shape[:2], np.float32)
    cv2.ellipse(m, center, (rx, ry), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(m, (0, 0), feather)[..., None]


def main() -> None:
    base = cv2.imread(str(CLIPS / "lyra_live_first.png"))
    names = [n for n in ("small", "ah", "ee") if (SHAPES / f"{n}.png").exists()]
    aligned = {}
    for n in names:
        print(n)
        aligned[n] = align(cv2.resize(cv2.imread(str(SHAPES / f"{n}.png")), (base.shape[1], base.shape[0])), base)

    cx, cy = mouth_center(list(aligned.values()), base)
    print(f"mouth at ({cx}, {cy})")
    mask = oval_mask(base.shape, (cx, cy + 8), 92, 62, 14)  # a little below centre: the jaw drops on "ah"

    frames = {"rest": base}
    for n, a in aligned.items():
        frames[n] = (a * mask + base * (1 - mask)).astype(np.uint8)

    # "oo" until a real one is generated: the slightly-open mouth squeezed narrower around its centre.
    if "small" in frames and not (SHAPES / "oo.png").exists():
        w = 160
        patch = frames["small"][cy - 70:cy + 90, cx - w:cx + w]
        narrow = cv2.resize(patch, (int(2 * w * 0.78), patch.shape[0]), interpolation=cv2.INTER_CUBIC)
        pad = (2 * w - narrow.shape[1]) // 2
        squeezed = base[cy - 70:cy + 90, cx - w:cx + w].copy()
        squeezed[:, pad:pad + narrow.shape[1]] = narrow
        oo = base.copy()
        oo[cy - 70:cy + 90, cx - w:cx + w] = squeezed
        small_mask = oval_mask(base.shape, (cx, cy + 4), 70, 50, 12)
        frames["oo"] = (oo * small_mask + base * (1 - small_mask)).astype(np.uint8)

    for n, f in frames.items():
        cv2.imwrite(str(OUT / f"{n}.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 92])
    x0, y0, x1, y1 = FACE
    sheet = np.hstack([frames[n][y0:y1, x0:x1] for n in frames])
    cv2.imwrite(str(OUT.parent.parent.parent / "tools" / "lipsync_check.jpg"), sheet)
    print("WROTE", ", ".join(f"{n}.jpg" for n in frames))


if __name__ == "__main__":
    main()
