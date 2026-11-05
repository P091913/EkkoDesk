# Ekko Desk

A projected desk for Ekko: a camera watches your hands, and pinches grab and move cards. The design is in [PLAN.md](PLAN.md), and the messages between the parts are in [PROTOCOL.md](PROTOCOL.md).

- **Desk server and page** (TypeScript, this folder): the server runs on `127.0.0.1:8081`, and the page is the desk.
- **Tracker** (Python, `tracker/`): it reads the webcam, finds pinches and sends them to the desk server.

## Keys

`.env` holds these, one per line; `.env.example` lists the names. Keys never get printed: the commands below write them straight where they go.

| Name | What it is |
|---|---|
| `DESK_TRACKER_KEY` | Shared by the tracker and the desk server. |
| `DESK_BRAIN_KEY` | The key Ekko's Brain sends with notes: the same value as the Brain's `Desk__ApiKey`. |
| `EKKO_URL` | Where the Brain is, for the chat card: `http://127.0.0.1:5065`, no trailing slash. |
| `EKKO_KEY` | The desk's own key to the Brain: the same value as the Brain's `Api__Keys__desk`. |
| `FILES_URL` | Where Ekko.Files is, for the Files card and viewers: `http://127.0.0.1:5095` on the PC, no trailing slash. The PC's tailnet address in phase 4. |
| `FILES_KEY` | The desk's own key to Ekko.Files. The page never gets it. |
| `FOOD_URL`, `BUDGET_URL` | Where Ekko.Food and Ekko.Budget are, for the Today card: `http://127.0.0.1:5085` and `http://127.0.0.1:5080` on the PC. The PC's tailnet address in phase 4. |
| `FOOD_KEY`, `BUDGET_KEY` | The desk's own keys to them: the same values as Ekko's `Food_DeskKey` and `Budget_DeskKey`. The budget key is read-only. The page never gets either. |

Make the tracker key and add it to `.env`, then copy it into the tracker's environment (open a new terminal afterwards):

```powershell
node -e "require('fs').appendFileSync('.env', 'DESK_TRACKER_KEY=' + require('crypto').randomBytes(24).toString('hex') + '\n')"
setx DESK_TRACKER_KEY (Select-String -Path .env -Pattern '^DESK_TRACKER_KEY=(.+)').Matches[-1].Groups[1].Value
```

## Desk server and page

Node 22.18 or newer.

```powershell
npm install
npm run build
npm start              # then open http://127.0.0.1:8081
```

- **`npm run dev`:** Vite with hot reload on http://localhost:5173. Keep `npm start` running, since it serves `/ws`.
- **`npm test`** and **`npm run check`:** the tests and the typecheck.

## On the Pi

The desk runs on the Pi next to ekko-deck: its own server on `127.0.0.1:8081`, and its own Chromium, full screen on the
projector (`HDMI-A-1`). The tracker stays on the PC. `<pi>.<tailnet>` below is the Pi's tailnet name; keep it out of git.

**Install, once:**
```bash
git clone https://github.com/P091913/EkkoDesk.git ~/ekko-desk
cd ~/ekko-desk && npm ci && npm run build
```
- **`.env`:** copy the PC's over (`scp .env <user>@<pi>:ekko-desk/.env` from the PC). Then point its URLs at the PC, using
  the PC's name from the deck's `.env`:
  ```bash
  PC=$(sed -n 's#^EKKO_URL=https*://\([^:/]*\).*#\1#p' ~/ekko-deck/.env)
  sed -i "s#//\(127\.0\.0\.1\|localhost\):#//$PC:#" ~/ekko-desk/.env
  ```
- **Server:** `sudo cp ~/ekko-desk/ops/ekko-desk.service /etc/systemd/system/`, then `sudo systemctl daemon-reload` and
  `sudo systemctl enable --now ekko-desk`.
- **Tailnet:** `sudo tailscale serve --bg --https=8445 http://127.0.0.1:8081`, for Ekko's Brain and the tracker.
  - Ekko's `.env`: `Desk_BaseUrl=https://<pi>.<tailnet>.ts.net:8445/`, then restart the Brain.
  - The tracker: `--desk wss://<pi>.<tailnet>.ts.net:8445/ws/tracker`.
  - The page's routes refuse the tailnet name (Host check), so only the Pi's own Chromium can use them.
- **Browser at login:** `~/.config/autostart/ekko-desk.desktop` runs `ops/desk-browser.sh`:
  ```ini
  [Desktop Entry]
  Type=Application
  Name=Ekko Desk
  Exec=sh /home/<user>/ekko-desk/ops/desk-browser.sh
  ```
- **Screens:** in `~/.config/labwc/rc.xml`, next to the `<touch …/>` line, then `kill -HUP $(pidof labwc)`:
  ```xml
  <windowRules>
    <windowRule identifier="chrome-127.0.0.1*">
      <action name="MoveToOutput" output="HDMI-A-1"/>
      <action name="ToggleFullscreen"/>
    </windowRule>
    <windowRule identifier="chromium">
      <action name="MoveToOutput" output="DSI-1"/>
    </windowRule>
  </windowRules>
  ```
  The first sends the desk's window (`--app`) to the projector full screen; the second keeps the deck on the touchscreen.
- **Projector mode:** 1280x720, its native resolution, set in `~/.config/kanshi/config`.

**Updating:** merge to main on GitHub, then `sh ~/ekko-desk/ops/update.sh` on the Pi. It pulls, installs, builds and
restarts the server; the page reloads itself when the server is back. `.env` and `data/` are never touched, so a new
`.env` name is added there by hand.

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
- **Ask Ekko:** the tracker also records the PC's default microphone when the chat card's Ask Ekko button is tapped, and turns it into text with speaches. `--speech` is speaches' URL, `http://127.0.0.1:8000` by default (the same server as Ekko's glasses), and `--speech-model` its model, `Systran/faster-distil-whisper-small.en` by default. After pulling this change, run the `pip install -r requirements.txt` line again for `sounddevice`.
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
