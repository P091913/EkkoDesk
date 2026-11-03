"""Webcam -> MediaPipe hand landmarks -> pinch events -> the desk server. The message format is in PROTOCOL.md."""
import argparse
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path

import cv2
import mediapipe as mp
from websockets.sync.client import connect

from pinch import START, Hand, Pincher, measure

MODEL = Path(__file__).with_name('hand_landmarker.task')


def sender(url: str, key: str, q: queue.Queue):
    """Owns the WebSocket in its own thread, so a slow or dead desk never stalls the camera."""
    while True:
        try:
            with connect(url, additional_headers={'X-Api-Key': key}, open_timeout=5) as ws:
                while not q.empty():  # events from while we were down are stale
                    q.get_nowait()
                print('connected to', url)
                while True:
                    ws.send(q.get())
        except Exception as e:  # refused, 403, timeout, dropped
            print(f'desk: {e!r}; retrying in 2 s')
            time.sleep(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default='0', help='camera index or stream URL')
    ap.add_argument('--desk', default='ws://127.0.0.1:8081/ws/tracker')
    ap.add_argument('--preview', action='store_true', help='show the camera with each pinch point and ratio')
    args = ap.parse_args()

    key = os.environ.get('DESK_TRACKER_KEY')
    if not key:
        sys.exit('DESK_TRACKER_KEY is not set (the same value as in the desk server .env)')
    if not MODEL.exists():
        sys.exit(f'{MODEL} is missing: see README')

    cap = cv2.VideoCapture(int(args.source) if args.source.isdigit() else args.source)
    if not cap.isOpened():
        sys.exit(f'cannot open camera {args.source}')
    # A request: the camera picks its nearest mode, printed below.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    cap.set(cv2.CAP_PROP_FPS, 60)
    print(f'camera: {cap.get(cv2.CAP_PROP_FRAME_WIDTH):.0f}x{cap.get(cv2.CAP_PROP_FRAME_HEIGHT):.0f} at {cap.get(cv2.CAP_PROP_FPS):.0f} fps')

    q: queue.Queue = queue.Queue(maxsize=256)
    threading.Thread(target=sender, args=(args.desk, key, q), daemon=True).start()

    v = mp.tasks.vision
    opts = v.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=v.RunningMode.VIDEO,
        num_hands=2,
    )
    pincher = Pincher()
    with v.HandLandmarker.create_from_options(opts) as landmarker:
        while True:
            ok, frame = cap.read()
            if not ok:
                sys.exit('camera stopped')
            t = time.monotonic_ns() // 1_000_000  # only gaps matter, and the landmarker needs it to always increase
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)  # OpenCV gives BGR
            r = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), t)

            # shortcut: the camera frame maps straight to the page, mirrored for a webcam facing you;
            # phase 2's calibration replaces this with the homography.
            hands = [
                Hand(measure(w), 1 - (lm[4].x + lm[8].x) / 2, (lm[4].y + lm[8].y) / 2, hd[0].category_name.lower())
                for lm, w, hd in zip(r.hand_landmarks, r.hand_world_landmarks, r.handedness)
            ]
            for e in pincher.update(hands, t):
                try:
                    q.put_nowait(json.dumps(e))
                except queue.Full:  # desk down: drop rather than grow forever
                    pass

            if args.preview:
                frame = cv2.flip(frame, 1)
                fh, fw = frame.shape[:2]
                for h in hands:
                    color = (0, 255, 0) if h.ratio < START else (0, 0, 255)
                    p = (int(h.x * fw), int(h.y * fh))
                    cv2.circle(frame, p, 10, color, 2)
                    cv2.putText(frame, f'{h.ratio:.2f}', (p[0] + 14, p[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
                cv2.imshow('ekko-desk tracker (Esc quits)', frame)
                if cv2.waitKey(1) == 27:
                    break


if __name__ == '__main__':
    main()
