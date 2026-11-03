"""Camera-to-page calibration: a sheet of ArUco markers, shown by the projector or printed, gives the homography.

The tracker owns all of this; the page only shows the sheet when asked, and never knows there's a camera.
Run `python calibrate.py --png sheet.png` to save the sheet for printing.
"""
import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np

PAGE = (1280, 720)  # the sheet's size in px; the page stretches it like any 0-1 position
COLS, ROWS, SIZE = 5, 3, 140  # 15 markers spread to the edges, where errors show most
MIN_MARKERS = 8
DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
FILE = Path(__file__).with_name('calibration.json')


def layout() -> dict[int, np.ndarray]:
    """Each marker's 4 corners on the page in px: top-left, top-right, bottom-right, bottom-left.

    Like ArUco, a corner is the outermost black pixel, so the far edges are at SIZE - 1.
    """
    cw, ch = PAGE[0] / COLS, PAGE[1] / ROWS
    out = {}
    e = SIZE - 1
    for i in range(COLS * ROWS):
        x, y = int(cw * (i % COLS) + (cw - SIZE) / 2), int(ch * (i // COLS) + (ch - SIZE) / 2)
        out[i] = np.float32([[x, y], [x + e, y], [x + e, y + e], [x, y + e]])
    return out


def sheet() -> np.ndarray:
    """The marker sheet: black markers on white, page-sized."""
    img = np.full((PAGE[1], PAGE[0]), 255, np.uint8)
    for i, c in layout().items():
        x, y = c[0].astype(int)
        img[y:y + SIZE, x:x + SIZE] = cv2.aruco.generateImageMarker(DICT, i, SIZE)
    return img


def detect(gray: np.ndarray) -> dict[int, np.ndarray]:
    """Markers found in a camera image: id -> 4 corners in camera px."""
    corners, ids, _ = cv2.aruco.ArucoDetector(DICT, cv2.aruco.DetectorParameters()).detectMarkers(gray)
    return {} if ids is None else {int(i): c.reshape(4, 2) for i, c in zip(ids.ravel(), corners)}


def solve(found: dict[int, np.ndarray], camera: tuple[int, int]) -> tuple[np.ndarray, dict]:
    """Homography from camera 0-1 to page 0-1 (RANSAC over every corner), and its error in page px."""
    page = layout()
    ids = sorted(i for i in found if i in page)
    if len(ids) < MIN_MARKERS:
        raise ValueError(f'saw {len(ids)} of {len(page)} markers; need {MIN_MARKERS}')
    src = np.concatenate([found[i] for i in ids]).astype(np.float32)
    dst = np.concatenate([page[i] for i in ids])
    H, inliers = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None:
        raise ValueError('no homography fits the markers')
    err = np.linalg.norm(cv2.perspectiveTransform(src[:, None], H)[:, 0] - dst, axis=1)
    # Work in px for a meaningful RANSAC threshold, then store 0-1 to 0-1 so the mapping doesn't depend on resolution.
    unit = np.diag([1 / PAGE[0], 1 / PAGE[1], 1]) @ H @ np.diag([camera[0], camera[1], 1])
    return unit, {'mean': round(float(err.mean()), 2), 'max': round(float(err.max()), 2), 'markers': len(ids), 'inliers': int(inliers.sum())}


def mapper(H):
    """Camera 0-1 -> page 0-1 through the homography (an array, or the nested list calibration.json holds)."""
    H = np.asarray(H, dtype=float)

    def to_page(x: float, y: float) -> tuple[float, float]:
        u, v, w = H @ (x, y, 1.0)
        return float(u / w), float(v / w)
    return to_page


def save(H: np.ndarray, camera: tuple[int, int], error: dict):
    FILE.write_text(json.dumps({'H': H.tolist(), 'camera': list(camera), 'error_px': error, 'at': time.strftime('%Y-%m-%d %H:%M')}, indent=2))


def load() -> dict | None:
    return json.loads(FILE.read_text()) if FILE.exists() else None


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--png', required=True, help='where to save the marker sheet for printing')
    path = ap.parse_args().png
    cv2.imwrite(path, sheet())
    print(f'saved {path}: print it in landscape, scaled to fit the page')
