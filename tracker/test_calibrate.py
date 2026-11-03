import math
import unittest

import cv2
import numpy as np

from calibrate import MIN_MARKERS, PAGE, detect, layout, mapper, sheet, solve

CAMERA = (1280, 720)


def camera_view(G):
    """What a camera sees when the sheet lands on its image through G (page px -> camera px)."""
    return cv2.warpPerspective(sheet(), G, CAMERA, borderValue=255)


class CalibrateTest(unittest.TestCase):
    def test_flat_sheet_corners_match_the_layout(self):
        found = detect(sheet())
        self.assertEqual(len(found), len(layout()))
        for i, c in found.items():
            self.assertLess(np.abs(c - layout()[i]).max(), 1.0, f'marker {i}')

    def test_recovers_a_known_homography_within_2px(self):
        corners = np.float32([[0, 0], [PAGE[0], 0], [PAGE[0], PAGE[1]], [0, PAGE[1]]])
        # Smaller, off-centre and in perspective, like a camera mounted beside the projector.
        seen = np.float32([[180, 90], [1100, 140], [1180, 650], [120, 600]])
        G = cv2.getPerspectiveTransform(corners, seen)
        found = detect(camera_view(G))
        self.assertGreaterEqual(len(found), MIN_MARKERS)

        H, err = solve(found, CAMERA)
        self.assertLess(err['max'], 2)
        to_page = mapper(H)
        for px, py in [(0, 0), (1280, 720), (640, 360), (100, 650), (1200, 40)]:
            cx, cy = cv2.perspectiveTransform(np.float32([[[px, py]]]), G)[0, 0]
            x, y = to_page(cx / CAMERA[0], cy / CAMERA[1])
            self.assertLess(math.hypot(x * PAGE[0] - px, y * PAGE[1] - py), 2, f'page point {(px, py)}')

    def test_too_few_markers_is_an_error(self):
        found = dict(list(detect(sheet()).items())[:MIN_MARKERS - 1])
        with self.assertRaises(ValueError):
            solve(found, CAMERA)


if __name__ == '__main__':
    unittest.main()
