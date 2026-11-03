# Ekko Desk

A projected desk for Ekko: a camera watches your hands, and pinches grab and move cards. The design is in [PLAN.md](PLAN.md), and the messages between the parts are in [PROTOCOL.md](PROTOCOL.md).

- **Desk server and page** (TypeScript, this folder): the server runs on `127.0.0.1:8081`, and the page is the desk.
- **Tracker** (Python, `tracker/`): it reads the webcam, finds pinches and sends them to the desk server.

## Key

The tracker and the desk server share one key. Generate it once:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

- **Desk server:** copy `.env.example` to `.env` and set `DESK_TRACKER_KEY` there.
- **Tracker:** set the same value in its environment, for example `setx DESK_TRACKER_KEY <value>`, then open a new terminal.

## Desk server and page

Node 22.18 or newer.

```powershell
npm install
npm run build
npm start              # then open http://127.0.0.1:8081
```

- **`npm run dev`:** Vite with hot reload on http://localhost:5173. Keep `npm start` running, since it serves `/ws`.
- **`npm test`** and **`npm run check`:** the tests and the typecheck.

## Tracker

Python 3.14 (MediaPipe 1.2.0 supports 3.9–3.14).

```powershell
cd tracker
py -3.14 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
curl.exe -L -o hand_landmarker.task https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
.venv\Scripts\python main.py --preview
```

- **The model** (`hand_landmarker.task`, about 8 MB) stays out of git.
- **`--preview`:** opens a camera window that shows each pinch point and its ratio. Green means below the start threshold. Press Esc to quit.
- **`--source`:** a camera index (`0` by default) or a stream URL. **`--desk`:** the server's tracker URL, `ws://127.0.0.1:8081/ws/tracker` by default.
- **Tests:** `.venv\Scripts\python -m unittest`, run inside `tracker/`.

### Recording clips for tuning

The tests replay these clips to check the pinch thresholds and the filter. Point the camera down at the desk the way it will be mounted, keep the desk server running, and record each one for about 10 s. Press Esc in the preview window to stop and save.

```powershell
.venv\Scripts\python main.py --preview --record recordings\still.jsonl.gz
```

| Clip | What to do | Pinches |
|---|---|---|
| `still` | Pinch, hold still for 5 s, let go. | 1 |
| `slow-drags` | Three slow pinch-drag-release moves. | 3 |
| `fast-drags` | Three fast ones. | 3 |
| `open-hand` | Wave an open hand and make a loose fist, without pinching. | 0 |
| `two-hands` | Pinch with both hands at once, pull them apart, let go. | 2 |

- **Replay to the desk:** `--replay recordings\still.jsonl.gz`, at the speed it was recorded.
- **Thresholds:** `START`, `END`, `MIN_CUTOFF` and `BETA` at the top of `pinch.py`.

### Calibration

Calibration finds where the page is in the camera's view and saves it to `calibration.json` (kept out of git). Run it again after moving the camera or changing the projector's keystone.

- **Printed sheet (no projector):** save the sheet with `.venv\Scripts\python calibrate.py --png sheet.png`, print it in landscape scaled to fit, and lay it where the projection will go.
- **Projector:** nothing to print. The tracker shows the sheet on the desk page itself.

```powershell
.venv\Scripts\python main.py --calibrate --preview
```

- It needs at least 8 of the 15 markers in view, and prints the error in px. Over about 10 px at the edges means the lens needs calibrating too.
- Without `calibration.json`, the tracker uses the camera frame mirrored, as in phase 1.
