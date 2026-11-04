# Ekko Desk: plan

A projector above the desk shows widgets on the desk surface. A camera watches your hands, and pinch gestures grab, move, resize and tap the widgets.

Status: phases 1, 2 and 3 built (2026-11-03), and phase 3 checked from Telegram. Phase 2 still needs the recordings and a calibration run (README). Files on the desk (DR-40/41) is built and checked from Telegram (2026-11-04). Every decision is made (see Decisions at the end).

## Context: what already exists

- **Ekko** (`C:\Users\Jarre\RiderProjects\EkkoHomeAgent`) is the home agent: C#/.NET 10, microservices.
  - The Brain runs in Docker on the PC: `POST /message`, `GET /trace?after=<seq>`.
  - Every caller has its own key, sent as `X-Api-Key` (`Api:Keys:{deck, telegram, glasses}`).
  - `docs/ARCHITECTURE.md` there is the source of truth, with a decision record (DR) for each major choice. The desk becomes DR-39.
- **ekko-deck** (`C:\Users\Jarre\WebstormProjects\ekko-deck`) runs on the Pi as a browser page on the 800x480 DSI touchscreen. It must keep working.
  - `server/` runs Hono on `127.0.0.1:8080` and holds every key. `/api/*` requires an `X-Deck: 1` header and a localhost Host, so other pages can't call it.
  - `server/upstream.ts` has one `call()` for every service: it adds the key and a timeout, and returns every failure as `{ok:false,error}`.
  - `web/main.tsx` is one Preact file with seven swipe pages. `usePoll` only polls the page on screen. The Ekko page turns `/trace` into turn cards (`turnsOf`).
  - Vite builds `web/` into `web/dist`. Node 22.18+ runs the TypeScript server directly, and tests use `node --test`.
- **Pi**: Raspberry Pi 4 (4 GB), Debian 13 trixie, labwc (Wayland), Chromium. It has had CPU problems, so pages redraw only when something changes, with no continuous animation.
- **Projector**: Sainyer Q100, 720p native, 200 ANSI lumens, on the Pi's HDMI. It may be mounted at an angle.
- **Camera**: a USB webcam next to the projector. Not bought yet.

## Reuse from ekko-deck

Copy these; don't share a package between the two apps.

- **Reuse:**
  - `server/upstream.ts`
  - the `X-Deck` and Host check, renamed `X-Desk`
  - the localhost-only `server/index.ts`
  - `turnsOf` and the `.turn` styles
  - the lucide `Icon` setup
  - `vite.config.ts`, `tsconfig.json`, and the package scripts
- **Don't reuse:**
  - **`Chat`:** its log lives only in that component's memory, it only shows what was typed on the deck, and it needs a keyboard.
  - **`ekko-map`:** it animates all the time.
  - **The swipe and page code.**

## Architecture

1. **The desk is its own app, not a page in ekko-deck.**
   - It has its own server on the Pi (`127.0.0.1:8081`), its own systemd unit, and its own Chromium profile on HDMI.
   - A desk crash, restart or deploy can't touch the deck.
2. **The tracker sends pinches as pointers, not gestures.**
   - It turns a noisy camera into clean "down/move/up at x,y" events.
   - Tap, drag, resize and dock live in the page, in one handler the mouse also uses. The mouse is the simulator, so there's no simulator code.
3. **Connections point toward the Pi.**
   - The tracker connects out to the desk server.
   - The page only talks to its own server on the Pi, which is the deck's pattern, so no key is ever stored in a page.
4. **The tracker owns calibration.**
   - It makes the ArUco marker image, sends it to the page to show, and keeps the camera-to-projector mapping (the homography).
   - The page never knows there's a camera.
5. **The chat card reads Ekko's `/trace`.** It's a read-only feed of every channel's turns: Telegram, glasses and deck.
6. **Notes are created through Ekko, from any channel.** The desk has no keyboard, so it only moves and deletes them.

### Where things run

| Piece | Runs on | Container? |
|---|---|---|
| Tracker (Python, `tracker/`) | PC, native | No. Docker Desktop on Windows can't see a USB webcam, which is also why Ekko's PcAgent runs natively. |
| Desk server and page | Pi, systemd | No. Docker would cost RAM and CPU the Pi doesn't have, and the deck isn't in a container either. Isolation comes from systemd: its own process and Chromium profile, with a CPU cap (`systemd-run --user --scope -p CPUQuota=100% chromium ...`) so it can't starve the deck. |
| `add_desk_note` | Ekko's Brain container | It's already in a container. |

**Rejected: the desk server as a container on the PC.**
- The page would then live on the PC and need a key typed into a kiosk with no keyboard.
- The desk would also go blank whenever the PC is off.

### Repo layout

This repo holds both sides because they're one feature joined by one message format, so a format change lands in one PR.
- **TypeScript app:** open it in WebStorm. The Pi runs only this.
- **`tracker/`:** open it in PyCharm.

## Message format

See [PROTOCOL.md](PROTOCOL.md): tracker → desk server → page, and page → desk server.

## Sticky-note API (for Ekko's Brain)

The request, the answers and the placement are in [PROTOCOL.md](PROTOCOL.md) ("Ekko's Brain → desk server").

- **Brain side (done, DR-39):** `add_desk_note(text)` in the `desk` domain, marked Reversible (dragging the note to the trash undoes it). It works from Telegram, the glasses and the deck with no extra work.
- **Later:** `GET` and `DELETE /api/notes` wait until Ekko needs "what's on my desk?" or "take that off".

## Files on the desk (Ekko's DR-40)

You send Ekko a photo or PDF, from Telegram now and from the deck's Chat later. Ekko keeps it in Ekko.Files on the PC (`127.0.0.1:5095`). The desk shows it when you tap it in the Files card, or when you tell Ekko "put it on my desk" or "show the invoice on my desk".

**Ekko's side is done:**
- **DR-40:** Ekko.Files, Telegram saving to it, and the Brain's `show_file_on_desk`.
- **DR-41:** Ekko.Files also lists the photos and PDFs in the PC's Downloads folder, marked `"from": "pc"`, in the same newest-first list.
  - So `""` means the newest file, whether you sent it or downloaded it.
  - If a Downloads file is deleted or changed, its old id gets 404.

**Keys:**
- `FILES_URL` and `FILES_KEY` (the desk's own key to Ekko.Files) live in `.env`.
- The page never holds `FILES_KEY`.
- `FILES_URL` becomes the PC's tailnet address in phase 4.

**Brain → desk: `POST /api/files/show {"name":"invoice"}`**
- **Checks:**
  - `X-Api-Key` must be `DESK_BRAIN_KEY`, otherwise 401.
  - `name` must be a string of 0–60 characters, otherwise 400. `""` means the newest file.
- **Lookup:** the desk asks Ekko.Files for `GET /files?q=<name>&limit=1`, or `/files?limit=1` for `""`. The timeout is 8 s, so the answer lands inside the Brain's 10 s.
- **Card:**
  - It opens a viewer card, or brings the one already open to the front, undocked if it was a chip.
  - The card is highlighted for 10 s, like a new note.
  - The answer goes back at once; the bytes are copied afterwards.
- **Answers:** Ekko reads them out word for word (PROTOCOL.md):
  - 200: opened.
  - 404: no match. There are two wordings, one for when `name` is `""`.
  - 502: the store isn't answering.
  - 409: five files are already open.

**The Files card:** a fourth default card. It's added to an existing `desk.json` on load, in the first free spot.
- **Contents:** the last 20 files, newest first, each with its name, when it came in, and where from (`pc` shows as "PC").
- **Refresh:** every 5 s, but only while the card is out and a page is open. Like the chat card, it's pushed to the page only when it changes.
- **Tap:** tapping a row opens that file. Tracker taps aren't clicks, so the page finds the row with `elementFromPoint` at the tap's spot.
- **Store down:** the card says "Ekko's file store isn't answering."

**The viewer card:**
- **Saved as:** `kind: "viewer"` with id `file-<fileId>`, saved in `desk.json` with `file`, `name`, `type` and `page`.
- **Size and limit:** 0.3 × 0.8, at the top centre, on top of the other cards. At most 5 are open.
- **Photos:** an `<img>`, loaded from a blob URL.
- **PDFs:**
  - Drawn with pdf.js (`pdfjs-dist` 6.5), loaded only when a PDF opens.
  - **Workers:** both of pdf.js's workers are on, one parsing and one drawing, so drawing a page never stalls a drag.
  - **Eval:** 6.5 dropped the `isEvalSupported` option. It has no eval left: its builds contain no `eval(` or `new Function(`.
  - Only the current page is drawn, fitted to the card, with "2 / 7" under it.
  - PDFs whose fonts aren't embedded draw with a substitute font, because the extra font files aren't bundled.
- **Taps:**
  - A tap on the left or right third turns the page, and the new page is saved.
  - A failed load shows the error, and any tap on the card retries.
  - A Downloads file that's gone before the Pi has its copy shows "That file isn't there anymore." A file the Pi already has keeps showing.
- **Resizing:** during a resize the drawn page only stretches (CSS). It's redrawn once, when the new size is saved.
- **Closing:** the trash takes viewers too. It removes the card and the Pi's copy, but never the file in Ekko.Files.

**The bytes:**
- **Copy on the Pi:**
  - The desk server fetches `GET /files/{id}` from Ekko.Files and keeps the file at `data/files/<id>` (temp file, then rename).
  - So an open file still shows when the PC is off.
- **Serving to the page:**
  - The page fetches `GET /api/desk/files/<id>` with the `X-Desk` header, then makes a blob URL (photos) or passes the ArrayBuffer to pdf.js (PDFs). An `<img src>` can't send `X-Desk`.
  - That route serves only open files, with their stored type and `nosniff`.
- **Checks:**
  - An id must be 16 lowercase hex characters before it goes into a path or URL.
  - Only the five types are accepted (JPEG, PNG, GIF, WebP and PDF).
  - Anything over 20 MB is refused.
- **Cleanup:** copies of files that are no longer open are deleted at start-up and on every desk change.

**Done when:** with `npm start` running, I send the bot a PDF ("Saved “x.pdf”."), then text "put it on my desk", and it opens.

**Built (2026-11-03):**
- `server/files.ts` and its test, with a mock Ekko.Files.
- `DELETE /api/desk/notes/:id` became `/api/desk/widgets/:id`, for notes and viewers.
- The chat card's poll loop moved to `upstream.ts` as `poll()`, shared with the Files card.
- On a z tie, a pinch now grabs the card drawn on top.

**Checked** against a stand-in store:
- Ekko's answers come back word for word.
- Bytes are served with their type and `nosniff`.
- Photos and PDFs show, and pages turn and stop at the last one.
- A Files row opens its file.
- A resize redraws once, when it's saved.
- The trash closes a viewer and deletes its copy.
- A missing Downloads file says so.
- After a reload, the page and size come back.

**Checked end to end (2026-11-04):** a PDF sent to the bot opened on the desk after "put it on my desk".

## Gestures and smoothing

**In the page (`web/gestures.ts`):**
- **Tap:** released within 350 ms after moving less than 1%. This starts or pauses the timer, or picks a preset.
- **Drag:** one pointer on a card. The position is saved on release.
- **Resize:** two pointers on one card, scaled by the change in distance between them. The mouse wheel stands in for this.
- **Dock:** release in the bottom strip to shrink the card to a chip; drag the chip out to restore it.
- **Delete (notes only):** hold over the trash for 600 ms.
- **Stacking:** the last card touched goes on top.

**In the tracker (`tracker/pinch.py`):**
- **Pinch measure:** the 3D distance from thumb tip to index tip, using world landmarks, divided by palm size (wrist to index knuckle).
- **Hysteresis:** a pinch starts after 2 frames below 0.25 and ends above 0.40. These are starting values to tune from recordings.
- **Smoothing:** a One Euro filter on the point, which is steady when your hand is slow and low-lag when it's fast.
- **Lost hand:** a 250 ms grace period, then `cancel`.
- **Edges:** pinches that start outside the projection are ignored.

## Phases

Phases 0–3 need no new hardware.

### Phase 0: before buying

- **Projector size:** image width is roughly mount distance ÷ throw ratio. Check the Q100's throw ratio against the mount height, and look for input lag in reviews.
- **Light:** 200 lumens needs a dim room and a light, matte desk mat.
- **Camera:** a standard USB (UVC) webcam with 720p at 60 fps, manual exposure and focus, and a field of view wider than the projection from the same mount.
- **Camera cable:** it plugs into the PC. Measure the run from the mount to the PC: a plain USB cable is good to about 5 m, and past that you need a powered (active) extension.
- **Free test:** plug any monitor into the Pi's second HDMI port. That tests two displays at once, touch mapping and window placement before spending anything. Unplugging it puts things back.

### Phase 1: one card moved by a real pinch (PC only)

- **Tracker:**
  - The webcam feeds MediaPipe's hand landmarker (2 hands), which feeds pinch detection with hysteresis.
  - The camera frame maps straight to 0–1, mirrored, with no calibration yet. Events go to the desk server over WebSocket.
- **Desk:** the server passes tracker events to the page, which shows one card the mouse can also drag.
- **Done when:** pinching over the desk in front of the PC webcam drags the card in a 1280x720 browser window.

### Phase 2: make it feel right (PC only)

- **Record and replay:** `--record` saves raw landmarks, and `--replay` feeds them back through pinch detection and on to the desk.
  - Tune the thresholds and the filter on real data.
  - The tests replay those recordings.
- **Calibration:**
  - Print the ArUco image and lay it on the desk in place of the projector.
  - The homography goes to `calibration.json`, and the error is reported in px.
  - Test without a camera: warp the image by a known homography and check it's recovered within 2 px.
- **Gestures:** tap, two-hand resize, dock, and stacking.
- **Saving:** `data/desk.json`.
- **Built:**
  - `data/desk.json` starts with empty `chat` and `timer` cards that phase 3 fills in, so the file never needs migrating. Until then a tap shows as a tap count on the card.
  - The dock strip is the bottom 10% of the page. A second pointer resizes about the card's centre, and the one left after a resize carries on dragging.
  - Calibration uses 15 markers (4x4 dictionary). A synthetic warp comes back within 1.1 px.
  - The One Euro filter starts at a 1 Hz minimum cutoff and a beta of 10 (positions are 0–1, so speeds are pages per second).
- **Still to do:** record the five clips listed in the README, tune `START`, `END` and the filter until `test_pinch.py` passes on them, then calibrate on the printed sheet.

### Phase 3: widgets and Ekko (PC only)

- Notes, the timer, and the chat card. The desk server polls `/trace` every 2 s while the chat card is out, with its own Brain key `Api__Keys__desk`.
- Ekko's `desk` domain and DR-39 (see "Changes in EkkoHomeAgent").
- **Done when:** "put a note on my desk: call mom" sent from Telegram appears on the desk running on the PC.
- **Built:**
  - `POST /api/notes` checks `DESK_BRAIN_KEY` and nothing else, since the Brain's Host is `host.docker.internal` now and the tailnet name later. The page's routes moved under `/api/desk/` with the `X-Desk` check.
  - Notes are 0.16 × 0.2, placed in the first free spot row by row from the top, and outlined for 10 s. The trash is the strip's bottom-right corner: hold a note there 600 ms, then let go.
  - The timer has 5, 15 and 25 minute presets along its bottom. Tapping the time pauses, resumes, or clears "done". It redraws once a second only while running, and a new note's highlight ends with one redraw, so nothing runs while the desk is still.
  - Tracker taps aren't DOM clicks, so a tap carries where it landed in the card (0–1) and the page hit-tests with that.
  - The chat card shows the last 10 turns, cut to 80 and 160 characters, polled only while it's out and a page is open.
- **Checked:** with the live Brain the chat card shows real turns; a note posted with the Brain's key lands at the top; the timer starts, pauses, resumes and counts down; a quick drop on the trash docks a note, and a 600 ms hold deletes it.
- **Checked end to end (2026-11-03):** a note asked for on Telegram appeared on the desk.

### Phase 4: the Pi's second screen (Pi plus any monitor)

- HDMI at 1280x720, touch mapped to DSI-1, and labwc window rules.
- The desk's Chromium in its own profile with a CPU cap, and `ekko-desk.service`.
- `tailscale serve` on the Pi for `/api/notes` and `/ws/tracker`, with the tracker and the Brain pointed at it.
- **Done when:**
  - the deck works exactly as before;
  - the desk comes up full screen on HDMI after a reboot;
  - a pinch drags a card there;
  - the Pi's load and temperature on the deck's Activity page stay normal while dragging.

### Phase 5: projector and camera mounted

- **Setup:** mount everything, fix keystone (the projector's own setting, or mount it straighter), then calibrate. Calibrate after keystone, so the homography includes it.
- **Testing and tuning:** lock the camera's exposure, test tracking over an all-white screen, measure lag with phone slow-motion video, then retune.

### Later

- **Tracker on the Pi:** the same code with `--source 0`, pointed at `ws://127.0.0.1:8081/ws/tracker`, at about 15 fps.
- **Idle mode:** the tracker drops to 5 fps after 10 s with no hands in view.

## Files

```
PLAN.md                      this file
PROTOCOL.md                  the message format
package.json, tsconfig.json, vite.config.ts, .env.example, README.md
server/index.ts              127.0.0.1:8081 + WebSocket upgrade (`ws`: Node has no WebSocket server, and @hono/node-ws needs @hono/node-server 1.x)
server/app.ts                X-Desk + Host check for page routes; Host + Origin check on /ws/page; X-Api-Key on /api/notes and /ws/tracker
server/app.test.ts
server/desk.ts               widgets in data/desk.json: load, change, safe save (temp file + rename), push state to pages
server/ekko.ts               polls the Brain's /trace; pushes new turns
server/upstream.ts           copied from ekko-deck, plus the poll loop the chat and Files cards share
server/files.ts              Ekko.Files: the Files card's list, opening viewers, the Pi's copy of each open file
server/desk.test.ts, server/ekko.test.ts, server/files.test.ts
web/index.html               <title>Ekko Desk</title> (the labwc window rule matches it)
web/main.tsx, web/style.css  desk and cards; redraws only on messages and drags; black background, no blur, shadows or transitions
web/gestures.ts (+ test)     pointers → tap / drag / resize / dock / trash
ops/ekko-desk.service        systemd unit; README holds the labwc and tailscale steps
tracker/requirements.txt     mediapipe, websockets (pinned)
tracker/main.py              --source 0|url  --desk url  --record/--replay file  --calibrate  --preview
tracker/pinch.py (+ test)    landmarks → down/move/up/cancel
tracker/calibrate.py (+ test) ArUco image, detection, homography (RANSAC), error in px
tracker/recordings/          the clips the tests replay (*.jsonl.gz)
```

**Python setup (checked 2026-11-03):**
- **Version:** MediaPipe 1.2.0 (released 2026-10-27) supports Python 3.9–3.14. Its wheels don't depend on the Python version, and it ships them for Windows x64 and Linux ARM64. The PC's Python 3.14 is fine: `py -3.14 -m venv .venv`.
- **Dependencies:** MediaPipe already installs `opencv-contrib-python`, which includes ArUco. Don't also add `opencv-python`: having both breaks `import cv2`.
- **API check (done in phase 1):** 1.2.0 still has the Tasks API (`mp.tasks.vision.HandLandmarker`, VIDEO mode, `detect_for_video`) with `hand_landmarks`, `hand_world_landmarks` and `handedness`. It installs OpenCV 5.0 with ArUco.
- **Model file:** the hand model is downloaded once and kept out of git; the README says where to get it.

## Changes in EkkoHomeAgent (phase 3, done: DR-39 there)

- `Ekko.Brain/Tools/Tool.cs`: add `Domain.Desk`.
- `Ekko.Brain/Desk/DeskService.cs`: calls `POST /api/notes`.
- `Ekko.Brain/Desk/DeskTools.cs`: `add_desk_note(text)`, marked Reversible.
- `Ekko.Brain/EkkoServices.cs` and `appsettings.json`: wiring and the `Desk` section.
- `Ekko.Brain/Pipeline/Router.cs`: a `desk:` line.
- `Ekko.Brain.Tests/DeskTests.cs` and desk eval cases.
- `compose.yaml`: `Desk__BaseUrl` from `.env`, which keeps the tailnet name out of git.
- `.env`: `Desk_BaseUrl`, `Desk__ApiKey` and `Api__Keys__desk`.
- `docs/ARCHITECTURE.md`: DR-39, a catalog row, and 9 domains.

ekko-deck needs no code changes. The Pi only needs config:
- labwc `rc.xml`:
  - `<touch mapToOutput="DSI-1"/>`;
  - a window rule pinning the deck to DSI-1;
  - a rule sending "Ekko Desk" to HDMI-A-1 at full screen.
- The desk's Chromium launch line next to the deck's.
- The HDMI mode.

## Risks

| Risk | Handling |
|---|---|
| **Lag** | My estimate is 100–250 ms from pinch to light: the camera frame, MediaPipe, about 2 ms of network, the Pi's frame, and the projector's input lag, which is unknown. Capture at 60 fps, send every frame at once, use the One Euro filter, and move cards with CSS transforms only. Measure with slow-motion video. |
| **Projection on hands** | A black background and dim cards keep light off hands. Lock exposure. Test tracking over an all-white screen first. The fallback is an IR camera, which can't see the projection. |
| **Pinch seen from above** | The thumb and index can hide under the palm. Use 3D world landmarks scaled by palm size, angle the camera slightly, and add hysteresis tuned from recordings. |
| **Two displays on the Pi 4** | Run HDMI at native 720p so nothing is scaled. The second Chromium costs about 300 MB of RAM and is CPU-capped. Redraw only on change. Watch temperature on the deck's Activity page. |
| **Chromium on the right screen** | Use labwc window rules that match the page title. Also pin the deck to DSI-1, so plugging in HDMI can't move it. The fallback is running that window under XWayland with `--window-position`. |
| **Deck touch broken by the second screen** | Add `<touch mapToOutput="DSI-1"/>` in `rc.xml`. |
| **Accidental grabs or deletes** | Two-frame start and hysteresis, a 250 ms grace period for a lost hand, and a 600 ms hold over the trash. |
| **Lens distortion and parallax** | Use many markers with RANSAC. If the error at the edges is over about 10 px, calibrate the camera once with OpenCV. Pinch near the desk surface, because points in the air map slightly off. |
| **Brain container → Pi** | This path is untested, since every Brain call so far stays on the PC. Test it from inside ekko-brain in phase 4. If tailnet names don't resolve inside Docker, `extra_hosts` with the Pi's tailnet IP keeps HTTPS valid. |
| **SD card wear** | Save on release, never during drags, and write atomically. |

## Decisions

**Decided (2026-11-03):**
- **Camera connection:** it plugs into the PC, and the tracker reads it directly. `--source` still accepts a stream URL if that ever changes.
- **Repo:** one repo, with `tracker/` inside.
- **Camera type:** a regular webcam. IR is considered only if phase 5 shows the projection breaks tracking.
- **Desk state:** it lives on the Pi. Notes and the timer survive with the PC off, but Ekko can't add a note while the Pi is off; it says so.
- **Chat card:** a read-only feed of all channels.
- **Containers:** none new, as set out in "Where things run".

**Not checked yet:**
   - the Pi's actual labwc and autostart setup (SSH to the Pi hangs);
   - the projector's throw ratio and input lag;
   - whether the Pi's OS is 64-bit (MediaPipe's Linux wheel is ARM64 only; only matters for tracking on the Pi later).
