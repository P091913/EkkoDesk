"""Webcam (or a recording) -> MediaPipe hand landmarks -> pinch events -> the desk server. The messages are in PROTOCOL.md."""
import argparse
import base64
import gzip
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

import calibrate
from pinch import START, Pincher, hands_from, measure, mirror, read_clip

MODEL = Path(__file__).with_name('hand_landmarker.task')


def sender(url: str, key: str, q: queue.Queue, connected: threading.Event):
    """Owns the WebSocket in its own thread, so a slow or dead desk never stalls the camera."""
    while True:
        try:
            with connect(url, additional_headers={'X-Api-Key': key}, open_timeout=5) as ws:
                while not q.empty():  # events from while we were down are stale
                    q.get_nowait()
                connected.set()
                print('connected to', url)
                while True:
                    try:
                        msg = q.get(timeout=1)
                    except queue.Empty:
                        ws.ping()  # raises once the desk has gone, so a restart is noticed within ~1 s
                        continue
                    ws.send(msg)
        except Exception as e:  # refused, 403, timeout, dropped
            connected.clear()
            print(f'desk: {e!r}; retrying in 2 s')
            time.sleep(2)


def send(q: queue.Queue, msg: dict):
    try:
        q.put_nowait(json.dumps(msg))
    except queue.Full:  # desk down: drop rather than grow forever
        pass


def flush(q: queue.Queue):
    """Give the sender a moment to send what's queued before we exit."""
    deadline = time.monotonic() + 2
    while not q.empty() and time.monotonic() < deadline:
        time.sleep(0.05)
    time.sleep(0.2)  # shortcut: the last message may still be mid-send; track acks if exits ever drop one


def open_camera(source: str):
    cap = cv2.VideoCapture(int(source) if source.isdigit() else source)
    if not cap.isOpened():
        sys.exit(f'cannot open camera {source}')
    # A request: the camera picks its nearest mode, printed below.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    cap.set(cv2.CAP_PROP_FPS, 60)
    size = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    print(f'camera: {size[0]}x{size[1]} at {cap.get(cv2.CAP_PROP_FPS):.0f} fps')
    return cap, size


def frame_of(r, t: int) -> dict:
    """A MediaPipe result as a plain frame, the same shape a recording holds (see pinch.py)."""
    return {'t': t, 'hands': [
        {'label': hd[0].category_name.lower(),
         'img': [[round(p.x, 4), round(p.y, 4)] for p in lm],
         'world': [[round(p.x, 5), round(p.y, 5), round(p.z, 5)] for p in w]}
        for lm, w, hd in zip(r.hand_landmarks, r.hand_world_landmarks, r.handedness)]}


def show(img, frame: dict) -> bool:
    """The camera, mirrored, with each pinch point and its ratio (green below START). False when Esc is pressed."""
    img = cv2.flip(img, 1)
    fh, fw = img.shape[:2]
    for hd in frame['hands']:
        ratio = measure(hd['world'])
        x, y = mirror((hd['img'][4][0] + hd['img'][8][0]) / 2, (hd['img'][4][1] + hd['img'][8][1]) / 2)
        color = (0, 255, 0) if ratio < START else (0, 0, 255)
        p = (int(x * fw), int(y * fh))
        cv2.circle(img, p, 10, color, 2)
        cv2.putText(img, f'{ratio:.2f}', (p[0] + 14, p[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    cv2.imshow('ekko-desk tracker (Esc quits)', img)
    return cv2.waitKey(1) != 27


def from_camera(cap, preview: bool, record: str | None):
    """Live frames. With `record`, each one is also saved; the file is closed properly even on Ctrl+C."""
    if not MODEL.exists():
        sys.exit(f'{MODEL} is missing: see README')
    v = mp.tasks.vision
    opts = v.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=v.RunningMode.VIDEO,
        num_hands=2,
    )
    if record:
        Path(record).parent.mkdir(parents=True, exist_ok=True)
    rec = gzip.open(record, 'wt', encoding='utf-8') if record else None
    try:
        with v.HandLandmarker.create_from_options(opts) as landmarker:
            while True:
                ok, img = cap.read()
                if not ok:
                    print('camera stopped')
                    return
                t = time.monotonic_ns() // 1_000_000  # only gaps matter, and the landmarker needs it to always increase
                rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)  # OpenCV gives BGR
                frame = frame_of(landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), t), t)
                if rec:
                    rec.write(json.dumps(frame, separators=(',', ':')) + '\n')
                if preview and not show(img, frame):
                    return
                yield frame
    finally:
        if rec:
            rec.close()
            print('saved', record)


def from_file(path: str):
    """Recorded frames, at the speed they were recorded."""
    frames = read_clip(path)
    start = time.monotonic()
    for f in frames:
        time.sleep(max(0.0, start + (f['t'] - frames[0]['t']) / 1000 - time.monotonic()))
        yield f


def run_calibration(cap, size, q: queue.Queue, connected: threading.Event, preview: bool):
    """Shows the sheet on the desk, finds it with the camera, and saves calibration.json."""
    if connected.wait(5):
        png = base64.b64encode(cv2.imencode('.png', calibrate.sheet())[1].tobytes()).decode()
        send(q, {'v': 1, 'type': 'calibrate', 'png': png})
    else:
        print('desk not connected: calibrating against a printed sheet')
    try:
        time.sleep(1.5)  # let the page draw it and the camera adjust to the light
        best: dict = {}
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and len(best) < calibrate.COLS * calibrate.ROWS:
            ok, img = cap.read()
            if not ok:
                break
            found = calibrate.detect(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
            if len(found) > len(best):
                best = found
            if preview:
                for c in found.values():
                    cv2.polylines(img, [c.astype(int)], True, (0, 255, 0), 2)
                cv2.imshow('ekko-desk calibration', img)
                cv2.waitKey(1)
        H, error = calibrate.solve(best, size)
    except ValueError as e:
        sys.exit(f'calibration failed: {e}. Check the whole sheet is in view and evenly lit.')
    finally:
        send(q, {'v': 1, 'type': 'calibrate', 'png': None})
        flush(q)
    calibrate.save(H, size, error)
    print(f'saved {calibrate.FILE.name}: {error["markers"]} markers, error {error["mean"]} px mean, {error["max"]} px max')
    if error['max'] > 10:
        print('the error is over 10 px: the lens may need calibrating too (PLAN.md, Risks)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default='0', help='camera index or stream URL')
    ap.add_argument('--desk', default='ws://127.0.0.1:8081/ws/tracker')
    ap.add_argument('--preview', action='store_true', help='show the camera with each pinch point and ratio')
    ap.add_argument('--record', metavar='FILE', help='also save the raw landmarks, e.g. recordings/still.jsonl.gz')
    ap.add_argument('--replay', metavar='FILE', help='play a recording to the desk instead of using the camera')
    ap.add_argument('--calibrate', action='store_true', help='find the marker sheet and save calibration.json')
    args = ap.parse_args()

    key = os.environ.get('DESK_TRACKER_KEY')
    if not key:
        sys.exit('DESK_TRACKER_KEY is not set (the same value as in the desk server .env)')

    q: queue.Queue = queue.Queue(maxsize=256)
    connected = threading.Event()
    threading.Thread(target=sender, args=(args.desk, key, q, connected), daemon=True).start()

    cal = calibrate.load()
    to_page = calibrate.mapper(cal['H']) if cal else mirror
    print(f'mapping: calibration.json from {cal["at"]}' if cal else 'mapping: none yet, so the camera frame mirrored')

    if args.replay:
        if not connected.wait(5):
            sys.exit(f'desk unavailable at {args.desk}')
        frames = from_file(args.replay)
    else:
        cap, size = open_camera(args.source)
        if args.calibrate:
            return run_calibration(cap, size, q, connected, args.preview)
        if cal and tuple(cal['camera']) != size:
            print(f'warning: calibrated at {cal["camera"][0]}x{cal["camera"][1]}, camera is now {size[0]}x{size[1]}; recalibrate')
        frames = from_camera(cap, args.preview, args.record)

    pincher, t = Pincher(), 0
    try:
        for frame in frames:
            t = frame['t']
            for e in pincher.update(hands_from(frame, to_page), t):
                send(q, e)
    except KeyboardInterrupt:
        pass
    finally:
        frames.close()  # closes a recording cleanly
        for e in pincher.end(t):
            send(q, e)
        flush(q)


if __name__ == '__main__':
    main()
