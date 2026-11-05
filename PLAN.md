# Ekko Desk: plan

A projector above the desk shows widgets on the desk surface. A camera watches your hands, and pinch gestures grab, move, resize and tap the widgets.

Status: phases 1, 2 and 3 built (2026-11-03), and phase 3 checked from Telegram. Phase 2 still needs the recordings and a calibration run (README). Files on the desk (DR-40/41) is built and checked from Telegram (2026-11-04). Ask Ekko by voice is built and checked end to end (2026-11-04). The Today card and quick food log (DR-43) are built (2026-11-04) and need their test with the live services. The toys (a ball and two fighters) are built (2026-11-04) and need watching on a real screen. Every decision is made (see Decisions at the end).

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

## Ask Ekko by voice

An **Ask Ekko** button along the bottom of the chat card. Tap it, speak, tap again to send. Your words and Ekko's whole answer show in the chat card as a `desk` turn.

**Where the microphone is:** the PC's, recorded by the tracker.
- The page moves to the Pi in phase 4, and the Pi's Chromium can't use the PC's microphone.
- The tracker stays on the PC next to the camera, and it's already connected to the desk server.
- So nothing new runs on the Pi.

**The flow** (messages in PROTOCOL.md):
1. A tap on the button sends `POST /api/desk/ask {"action":"start"}`. The desk server tells the tracker `listen` on.
2. The tracker records the default microphone, 16-bit mono at the microphone's own rate (speaches resamples). It stops on the second tap (`listen` off) or after 15 s. Audio stays in memory and is never written to disk.
3. The tracker sends the WAV to speaches on the PC (`/v1/audio/transcriptions`), the same server as Ekko's glasses and Telegram, and sends back `heard` with the text.
   - Its `--speech` and `--speech-model` settings default to `http://127.0.0.1:8000` and `Systran/faster-distil-whisper-small.en`.
   - Localhost stays right in phase 4, because the tracker stays on the PC.
4. The desk server posts the text to the Brain's `/message` with the desk's key: `{"text":…,"channel":"desk","conversationId":"desk"}`. One conversation, like the glasses, so follow-ups work.
5. The Brain answers `{"text":…,"requestId":…}`. The desk server puts that whole text into the turn with that id in the chat card.
   - `/trace` keeps only a reply's first line, cut to 160 characters, so `/trace` alone can't show a long answer.

**Approvals (Ekko's answer e):**
- A server-ops run asked for from the desk waits in the `desk` conversation, and its question ends "Say approve or deny."
- Saying "approve" or "deny" through Ask Ekko answers it. The deck still sees it in `/runs/waiting`.
- So replies are never cut on the desk:
  - every reply shows whole, with its line breaks;
  - a tap on the turns pages down, and back to the top after the last page;
  - "tap for more" shows while some of it is below the edge.
- Text is sized from the card, so a bigger card doesn't fit more; paging is how a long answer gets read.

**What the button says:**
- "Ask Ekko", "Listening… tap to send", "Working on it…" (transcribing), "Ekko is thinking…" (with the Brain).
- When something fails:
  - "The tracker isn't running, so I can't hear you."
  - "I can't open the PC's microphone."
  - "I didn't catch that." Silence isn't sent: the Brain would answer 400, which never reaches `/trace`.
  - "I couldn't transcribe that right now."
  - "That's longer than Ekko takes in one message." (over 500 characters, the Brain's limit)
  - "Ekko couldn't take that: <the Brain's error>." for a 400, worded as the glasses word it.
  - "Ekko refused the desk's key, so I couldn't pass that on." for a 401.
  - "Ekko isn't answering." for anything else.
- If no `heard` comes within 90 s, it gives up with "I couldn't transcribe that right now."

**Keys:** the desk's Brain key (`EKKO_KEY`) now also sends `/message`, not only reads `/trace`. From the desk you can ask anything that Telegram or the glasses can, through the same approvals.

**Ekko's side (DR-42 there, no Ekko code change):**
- The desk key works on `/message` as is.
- `desk`/`desk` matches the glasses.
- Calling speaches directly is right: Telegram and the glasses do the same, each with its own setting.
- The Brain doesn't shape replies per channel. It aims for one short sentence, but lists run longer.

**Left out:** Ekko speaking the reply (speaches also has Kokoro for that), a wake word, stopping on silence, and choosing a microphone.

**Done when:** with `npm start` and the tracker running, I tap Ask Ekko, say "put a note on my desk: buy milk", tap again, and the note appears.

**Built (2026-11-04):**
- `server/ask.ts` and its test, with a mock Brain. `call()` in `upstream.ts` takes a body for a JSON POST.
- `tracker/listen.py` and its test, with a mock speaches and microphone. The tracker now also receives on its WebSocket, in its own thread.
- `sounddevice` 0.5.6 in `tracker/requirements.txt`. It's loaded only when listening starts.
- `server/ekko.ts`:
  - `answer()` holds the whole answers for the last 10 desk questions;
  - `turnsOf` shows them in place of `/trace`'s line;
  - a turn whose answer came first is marked `ok` without waiting for `/trace`.
- **Page:**
  - replies are no longer clamped to two lines;
  - `Turns` pages by taps, shows "tap for more", and goes back to the top when a new turn comes in.

**Checked** with the real speaches, a stand-in Brain and a test desk on 8082:
- A clip spoken by speaches' own Kokoro voice came back as "Put a note on my desk, buy milk."
- The first request took 8.5 s while speaches loaded the model; after that a second of silence took 0.1 s.
- Clicking the button showed "Listening… tap to send", and a second click sent the text to the Brain with the desk's key, as `desk`/`desk`.
- With no tracker, the button said so.
- **A long approval answer:** the stand-in Brain answered like the real one, with a multi-line answer of several hundred characters ending "Say approve or deny.", and gave `/trace` its one cut line.
  - The card showed the whole answer with its line breaks.
  - With three of them, "tap for more" appeared. Taps paged down, the hint went at the end, and the next tap went back to the top.

**Checked end to end (2026-11-04):** with the real microphone and the real Brain, "put a note on my desk: buy milk" said through Ask Ekko put the note on the desk.

## Today card and quick food log (Ekko's DR-43)

Ekko's side is built: the desk reads Ekko.Food and Ekko.Budget directly, with its own keys. The desk server holds them, never the page.
- `FOOD_URL` and `BUDGET_URL` are `http://127.0.0.1:5085` and `:5080` on the PC, and the PC's tailnet name in phase 4.
- The keys are Ekko's `Food_DeskKey` and `Budget_DeskKey`. The budget key is read-only: anything but GET gets 403.

**Today card** (a fifth default card, at 0.05, 0.56, 0.25 × 0.32; an existing desk gets it there if that spot is free):
- **What it shows:**
  - calories so far, big ("1,240 cal");
  - the usual foods as buttons;
  - "3 bills left · $1,850.00 to pay";
  - "Next: Rent $1,200.00, due Nov 5". Past its date it's "overdue since Nov 1", in red.
  - With no tab for this month, or Google failing, Ekko's own sentence shows instead.
- **Refresh:** only while the card is out and a page is open.
  - Food every 2 minutes, because it also changes through Ekko and Telegram.
  - The budget is kept on the server and read at most every 10 minutes, because each glance reads the Google Sheet.
  - A tap on the card away from its buttons reads everything at once.

**Quick food log:** up to 6 usual foods (`/food/usual?limit=6`).
- **A tap** logs one through `/food/log`. Ekko's message shows with an Undo button for 10 s, and the total updates.
- **Taps:** a second tap while one is on its way is dropped, because tracker taps can misfire.
- **Checks on the server:**
  - only names in the current usual list are logged;
  - Undo is allowed once, within 15 s of the desk's own log, because `/food/undo` takes off today's last entry whoever logged it.
- **After that,** "undo that" said to Ekko still works.
- **With no usual foods yet:** "Log food with Ekko and your usual foods show up here."

**Done when** (Ekko's list; the ball is under Toys):
- the Today card shows today's calories and the next bill from the live services;
- after a food is logged through Ekko, it shows as a button, and a tap logs it, updates the total and can be undone;
- the ball can be thrown and settles.

**Built (2026-11-04):**
- **Server:** `server/today.ts` and its test (mock food and budget services); Today added to the default cards.
  - A default card missing from an older desk now goes to its own spot when that's free, and to the first free spot only when it isn't.
- **Page:** the Today card in `web/main.tsx`.

**Checked** on a test desk with stand-in food and budget services:
- The card showed 1,240 cal, four foods, "3 bills left · $1,850.00 to pay" and the overdue rent in red.
- Coffee logged (1,245, Undo shown), and Undo took it off (1,240).
- The live services answered the desk's keys (food "empty", budget "ok"), and refused a call without one (401).

**Still to do:** the done-when with the live services.

## Toys: a ball and two fighters

Things to play with while thinking, on the page alone: nothing about them goes to the server, and nothing is saved.
- **Their spots:** at the left end of the strip, as the trash is at the right. "ball" (0–0.08), then "fight" (0.08–0.16). Chips don't dock over them.
- **Who gets a pointer:** the ball first (the smaller target), then a figure, then the spots, then the cards.

**The shared physics** (`web/physics.ts`):
- **Bodies are circles.** Gravity pulls them toward the bottom of the page, assumed to be your side; if the projector's the other way round, it's one setting.
- **The floor** is the top of the strip, so nothing sits on chips or the trash.
- **Bounces:** off the page's edges and off cards, keeping part of their speed. Slower bounces just stop, so nothing hops forever.
- **Friction** brings them to rest.
- **Card tops:** things can rest on top of a card, and fall when it's moved away.
- **Fixed 1/120 s steps** carry leftover time between frames, so the path is the same at any frame rate.
- **Throws** take their speed from the hand's last 100 ms, so a hand held still first just drops what it holds. The fastest throw is 8 page heights a second.

**The ball** (`web/ball.ts`):
- A tap on its spot brings it out with a small hop, or puts it away.
- It keeps 60% of its speed per bounce.

**The fighters** (`web/fighters.ts`):
- **Two stick figures,** blue and red, 0.14 of the page high, fighting on their own. For collisions each one is a circle of radius 0.05, and the figure is drawn standing on its bottom edge.
- **What they do:**
  - They walk at each other, at 0.38 page heights a second.
  - **Punches and kicks:** a punch knocks back less, and a kick can floor a figure (45%).
  - **Knocked flying,** a figure bounces off cards and the page's edges like the ball, skids, and gets its balance back.
  - **Down:** it lies for a second, then gets up.
  - **No hitting someone who's down.**
- **Ragdoll** (`web/ragdoll.ts`): hit, knocked down, grabbed or thrown, a figure goes limp.
  - Its 11 joints become loose points joined by fixed-length bones (Verlet, 8 passes a step), swinging under gravity.
  - The hip is pulled along by the body's circle; the joints are kept out of cards and above the floor.
  - Its limbs start a little behind the body, so a knock makes them flop.
  - Coming out of it, it eases back to standing: 0.5 s getting up, 0.25 s after a flinch.
  - At the moment of a hard knock a bone can stretch up to about 30%, and it's back to length within a few steps.
- **Climbing:**
  - **Any card can be climbed:** notes, viewers, the chat, timer, Files and Today cards.
  - **Starting a climb:** a figure that walks or jumps into a card's side climbs it, at 0.4 page heights a second, and steps onto the top.
  - **What it holds onto:** the card itself, by id, so it moves with a dragged card and lets go if the card goes.
  - **Room on top:** it only climbs if there's room to stand up there, inside the page and with no other card in the way. Otherwise it tries to jump over now and then.
  - **On the default layout nothing is climbable:** the chat card sits right over Today, and the timer right over Files.
- **Getting around:**
  - **Up to the other one:** when the other figure is up on a card, a figure goes to the card's nearer side and climbs, or jumps if the card's bottom is above its head.
  - **Down to the other one:** from a card, it walks off the end toward the other figure.
  - **The high ground:** after taking a hit, 30% of the time it heads for the nearest card it can climb.
  - **Holding a card:** whoever has just climbed a card waits up there 1.5 s for the other one, and never walks off while the other is climbing up. Without that they chased each other up and down a note every couple of seconds.
  - **Stuck:** trying to move for 2 s without getting anywhere, it turns round and goes the other way for a while.
  - **Turning:** it only turns when the other figure is clearly to one side, so it doesn't spin on the spot right above or below it.
- **Fair fights:**
  - Both figures decide, then both move, and hits in the same step land together.
  - Before that, the left figure won 6 fights out of 6, and later the right figure got the first blow more often.
- **Rounds:**
  - The first down 3 times loses, and stays down; the winner raises both arms, and goes back to that pose if it was hit in the same moment.
  - A round lasts 60 s at most.
- **In 40 simulated fights per layout:**

  | Layout | Left won | Right won | Out of time | Median | Knocked into a card | Climbs |
  |---|---|---|---|---|---|---|
  | Empty desk | 20 | 12 | 8 | 42 s | 0 | 0 |
  | Default cards | 21 | 17 | 2 | 30 s | 17 a fight | 0 |
  | Plus a note in the middle | 13 | 24 | 3 | 35 s | 25 a fight | 10 a fight |
  | Notes as steps | 21 | 18 | 1 | 32 s | 36 a fight | 7 a fight |

  - Joints never went into a card or below the floor.
  - A made-up layout whose gaps are all narrower than a figure (0.071 against 0.1) trapped them, and every round ran out of time.
- **The fight spot:**
  - A tap brings them out and starts a round. After a round it says "again", and a tap starts the next.
  - Holding it 600 ms puts them away, the same hold as the trash.
- **You and the ball:**
  - **Grab and throw:** grab a figure with a pinch or the mouse; it hangs limp from your hand. Throw it, and it flies limp, lands and recovers.
  - **The ball hits them:** they bounce apart by mass (a figure is 3 times the ball), and the figure takes the knock. It flinches from 0.6 page heights a second, and goes down from 2.2.
- **Drawing:** each figure is one SVG path (body, arms, legs) and a filled head. It's posed for standing, walking, climbing, punching, kicking and winning, and drawn from the ragdoll while limp.

**The Pi:** these break the "no continuous animation" rule, on purpose and within limits. CLAUDE.md records the exception.
- **When frames run:** only while a toy moves, meaning from a throw until the ball rests, or through a round until both figures stand still.
- **Drawing each frame:** the ball is one circle moved with a transform, and each fighter is one path and one circle updated directly, all outside Preact.
- **At rest:** no frames at all.

**Done when:**
- the ball can be thrown and settles;
- the fighters fight a round to a knockout or the time limit, and the frames stop;
- the ball knocks a figure back;
- a knocked figure goes limp, and they climb cards after each other.

**Built (2026-11-04):**
- **Shared code:** `web/physics.ts` (taken out of `ball.ts`), `web/ball.ts`, `web/fighters.ts`, `web/ragdoll.ts`, and `web/toys.ts`, which runs them in the same steps so the ball can hit the figures.
- **Spots:** `BALL_SPOT` and `FIGHT_SPOT` in `web/gestures.ts`.
- **Tests:** `ball.test.ts` (unchanged after the physics moved) and `fighters.test.ts`:
  - the start of a round;
  - a whole round to the end, with the frames stopping;
  - a knock into a card;
  - grab, throw and put away;
  - the same fight at 30 and 120 frames a second;
  - the ball hitting a figure;
  - a pose standing on the floor;
  - going limp: in one piece, out of cards and the floor, then back up;
  - climbing after the other one, and not climbing a card with no room on top.
- **Config:** `web/tsconfig.json` allows `.ts` imports, so these modules run under both Vite and `node --test`.

**Checked** on a test desk:
- **The ball:**
  - it came out and was thrown;
  - it bounced off the timer card and the top edge, then rolled along the strip line to rest;
  - at rest it asked for no frames in 4 s;
  - the spot put it away.
- **The fighters:**
  - they came out facing each other on the strip line, with "fighting" and "hold: away" in their spot, and closed in;
  - the poses were drawn side by side and checked (idle, walk, punch, kick, hurt, down, getting up, win). Lying and getting up are lifted so nothing dips below the floor.
- **In simulation,** about 20 knocks into the Today and Files cards per fight.

**Still to do:** watching a whole round on a real screen, and on the Pi. Chrome ran the automated tab at 1–2 frames a second, so a round would have taken minutes there. The ragdoll and climbing are checked in simulation and tests only, not on screen.

## Gestures and smoothing

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
server/ask.ts                Ask Ekko: tells the tracker to listen, sends what it heard to the Brain
server/today.ts (+ test)     the Today card: Ekko.Food and Ekko.Budget, the food log and its one undo
server/desk.test.ts, server/ekko.test.ts, server/files.test.ts, server/ask.test.ts
web/index.html               <title>Ekko Desk</title> (the labwc window rule matches it)
web/main.tsx, web/style.css  desk and cards; redraws only on messages and drags; black background, no blur, shadows or transitions
web/gestures.ts (+ test)     pointers → tap / drag / resize / dock / trash
web/physics.ts               the toys' shared physics: gravity, bounces off edges and cards, rest, throws
web/ball.ts (+ test)         the toy ball
web/fighters.ts (+ test)     the two fighters: moves, hits, climbing, knockdowns, rounds, poses
web/ragdoll.ts               a fighter gone limp: loose joints on fixed-length bones
web/toys.ts                  runs the ball and fighters together, so the ball can hit them
ops/ekko-desk.service        systemd unit; README ("On the Pi") holds the labwc, kanshi and tailscale steps
ops/desk-browser.sh          the desk's Chromium at login: own profile, CPU-capped, waits for the server
ops/update.sh                on the Pi: pull main, install, build, restart (the page reloads itself)
tracker/requirements.txt     mediapipe, websockets, sounddevice (pinned)
tracker/main.py              --source 0|url  --desk url  --record/--replay file  --calibrate  --preview
tracker/pinch.py (+ test)    landmarks → down/move/up/cancel
tracker/calibrate.py (+ test) ArUco image, detection, homography (RANSAC), error in px
tracker/listen.py (+ test)   Ask Ekko: records the PC's microphone, then speaches turns it into text
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
