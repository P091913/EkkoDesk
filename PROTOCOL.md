# Ekko Desk: message format

The tracker (PC) and the desk server and page (Pi) are updated separately, so every receiver ignores a `v` or `type` it doesn't know.

## Tracker → desk server

The tracker connects to `/ws/tracker` with `X-Api-Key` on the WebSocket upgrade (the `DESK_TRACKER_KEY` value). A missing or wrong key gets HTTP 403. The server passes these messages on unchanged to every open desk page, except `heard`, which is for the server itself. A message over 1 MB closes the connection.

```jsonc
{"v":1,"type":"pointer","phase":"down","id":41,"hand":"right","x":0.412,"y":0.661,"t":1762190000123}
{"v":1,"type":"calibrate","png":"<base64 1280x720 PNG>"}   // show full screen, on top of everything
{"v":1,"type":"calibrate","png":null}                       // hide it
{"v":1,"type":"heard","text":"Put a note on my desk, buy milk."}   // Ask Ekko: what speaches heard ("" for silence)
{"v":1,"type":"heard","error":"I can't open the PC's microphone."} // or why there's nothing
```

- **`phase`:** `down`, `move`, `up`, or `cancel` (the hand was lost mid-pinch).
- **`id`:** a new number for each pinch, so two hands pinching means two live ids.
- **`x`, `y`:** 0 to 1 across the projected page, measured from the top-left, to 3 decimals.
  - They've already been through the One Euro filter, and the homography from `calibration.json`. With no calibration yet, the camera frame is used mirrored.
  - They don't depend on resolution, so the projector and a dev browser window both work.
- **`hand`:** for information only. MediaPipe's left/right label flips easily.
- **`t`:** the tracker's clock, in ms. Only the gaps between events are used, because the PC and Pi clocks differ.
- **`move`** is sent only while pinched, only when the point moved, and at most once per camera frame.
  - There's no hover stream: your fingertip is the cursor, and a hover stream would make the Pi redraw constantly.
- **`heard`** answers a `listen` (below), once per question.
  - The recording is sent to speaches on the PC: `POST /v1/audio/transcriptions`, as Ekko's glasses and Telegram do.
  - The tracker's `--speech` and `--speech-model` settings default to `http://127.0.0.1:8000` and `Systran/faster-distil-whisper-small.en`.
  - `error` is one of "I can't open the PC's microphone." or "I couldn't transcribe that right now."

## Desk server → tracker

Sent on the same WebSocket, to the newest tracker only. The tracker ignores anything else.

```jsonc
{"v":1,"type":"listen","on":true}    // start recording the PC's default microphone
{"v":1,"type":"listen","on":false}   // stop, and send back `heard`
```

- **Recording:** the tracker stops by itself after 15 s, and still sends `heard`.
- **Format:** 16-bit mono at the microphone's own rate; speaches resamples it.
- **Privacy:** the audio stays in memory and is never written to disk.

## Desk server → page

The page connects to `/ws/page`, localhost only. Browsers can't add a custom header such as `X-Desk` to a WebSocket upgrade, so the server checks that both `Host` and `Origin` are `127.0.0.1` or `localhost` instead. Anything else gets HTTP 403.

```jsonc
{"type":"tracker","connected":true}   // on connect and whenever it changes
{"type":"state","widgets":[{"id":"chat","kind":"chat","x":0.05,"y":0.08,"w":0.25,"h":0.45,"z":1,"docked":false},
                           {"id":"timer","kind":"timer","x":0.7,"y":0.08,"w":0.2,"h":0.2,"z":2,"docked":false,"endsAt":1793755345248,"leftMs":null},
                           {"id":"files","kind":"files","x":0.7,"y":0.32,"w":0.2,"h":0.5,"z":3,"docked":false},
                           {"id":"note-mw1fg1g5-4824474a","kind":"note","x":0.38,"y":0.02,"w":0.16,"h":0.2,"z":4,"docked":false,"text":"call mom","added":1793755045248},
                           {"id":"file-0123456789abcdef","kind":"viewer","x":0.35,"y":0.04,"w":0.3,"h":0.8,"z":5,"docked":false,
                            "file":"0123456789abcdef","name":"invoice.pdf","type":"application/pdf","page":1,"added":1793755105248}]}
{"type":"turns","turns":[{"id":"…","channel":"telegram","at":"2026-11-03T18:24:00Z","said":"…","reply":"…","state":"ok"}],"error":"Ekko unavailable"}
{"type":"files","files":[{"id":"0123456789abcdef","name":"invoice.pdf","type":"application/pdf","from":"pc","at":"2026-11-03T18:00:00Z"}],"error":"Ekko's file store isn't answering."}
{"type":"ask","state":"listening","note":null}
{"type":"today","day":{"total":1240},"usual":{"foods":[{"name":"coffee","caloriesEach":5}]},
 "glance":{"status":"ok","message":"3 bills left.","billsLeft":3,"leftToPay":1850,"next":{"item":"Rent","amount":1200,"date":"2026-11-05"}}}
```

- **`state`:** the full state goes out on connect and after every change. A few dozen widgets is tiny, so there's no diffing.
  - Every widget has `id`, `kind`, `x`, `y`, `w`, `h`, `z` and `docked`. A docked widget is drawn as a chip at its `x`, `y`; `w` and `h` are kept for when it comes back out.
  - **Notes:** `text`, and `added` (ms since 1970). The page highlights a note for 10 s after `added`.
  - **Timer:** `endsAt` (ms since 1970) while running, `leftMs` while paused, both null when idle. Past `endsAt` it's done. The page and server share the Pi's clock, so the page counts down from `endsAt` itself.
  - **Viewers** (id `file-<file>`, at most 5):
    - `file` is the Ekko.Files id. `name` and `type` come from Ekko.Files.
    - `page` is the PDF page shown, from 1.
    - `added` is when it was last shown. The page highlights it for 10 s, like a new note.
  - **The Files card** (`files`) has only the layout fields. Its contents come in `files`.
- **`turns`:** the chat card's last 10 turns from Ekko's `/trace`, newest first, sent on connect and when they change.
  - `state` is `run`, `ok` or `err`. `said` is cut to 80 characters, ending in "…".
  - `reply` is what `/trace` gives: Ekko keeps only its first line, cut to 160 characters.
  - For a question asked from the desk, `reply` is instead the whole answer from `/message`, line breaks kept, up to 2000 characters. That way an approval question can be read in full before you answer it.
  - The page shows replies whole. A tap on the turns pages down, and back to the top after the last page.
  - `error` is there only while Ekko can't be reached; the last turns stay.
  - The server polls `/trace` every 2 s with `EKKO_KEY`, only while the chat card is out and a page is open.
- **`files`:** the Files card's last 20 files from Ekko.Files, newest first, sent on connect and when they change.
  - `from` is `telegram`, `deck` or `pc` (the PC's Downloads folder, DR-41). The page shows `pc` as "PC".
  - While the store can't be reached, the list is empty and `error` is set.
  - The server polls `GET /files?limit=20` every 5 s with `FILES_KEY`, only while the Files card is out and a page is open.
- **`ask`:** the chat card's Ask Ekko button, sent on connect and whenever it changes.
  - `state` is `idle`, `listening`, `working` (transcribing) or `thinking` (the Brain has the question).
  - `note` says why the last question failed, or is null. It's one of:
    - "The tracker isn't running, so I can't hear you."
    - the tracker's `heard` error;
    - "I didn't catch that." (silence: not sent, since the Brain would answer 400, which never reaches `/trace`)
    - "That's longer than Ekko takes in one message." (over 500 characters)
    - "I couldn't transcribe that right now." (no `heard` within 90 s)
    - "Ekko couldn't take that: <the Brain's error>." (a 400)
    - "Ekko refused the desk's key, so I couldn't pass that on." (a 401)
    - "Ekko isn't answering." (anything else)
  - **The question** goes to the Brain's `POST /message` with `EKKO_KEY`: `{"text":…,"channel":"desk","conversationId":"desk"}`. This is DR-42 on Ekko's side.
  - **The answer:** the Brain answers `{"text":…,"requestId":…}`. The whole text goes into that turn's `reply` in `turns`.
  - **Approvals:** a server-ops run asked for from the desk waits in the `desk` conversation. Saying "approve" or "deny" through Ask Ekko answers it.
- **`today`:** the Today card (Ekko's DR-43). It's sent on connect and when it changes. Each part is null until it's first read.
  - **`day`:** `{"total":…}` is today's calories from Ekko.Food's `/food/day`, or `{"error":"Ekko's food diary isn't answering."}`.
  - **`usual`:** `{"foods":[…]}` is up to 6 from `/food/usual?limit=6`, or the same error. An empty list shows "Log food with Ekko and your usual foods show up here."
  - **`glance`:** from Ekko.Budget's `/budget/glance`.
    - With `status` `ok`, it has `billsLeft`, `leftToPay` and `next` (`date` is `yyyy-MM-dd` or null; a date before today is shown as overdue).
    - Otherwise it has only `status` and `message`: Ekko's own sentence for `not_found` (no tab for this month) or `error` (Google failed), or "Ekko's budget isn't answering."
  - **Polling:** while the Today card is out and a page is open, food every 2 minutes, with `FOOD_KEY`.
  - **The budget** reads the Google Sheet, so it's kept on the server and read at most every 10 minutes, with `BUDGET_KEY` (read-only on Ekko's side). A tap on the card reads everything again at once.
- When the tracker disconnects, the page cancels its live pinches, since no `up` will come, and hides the calibration image.

## Page → desk server

Plain HTTP under `/api/desk/`, behind the `X-Desk` check (header `X-Desk: 1` and a local `Host`, or 403). Errors are 400 `{"ok":false,"error":"…"}`, and an unknown id is 404. On success every page gets the new `state`.
- `PATCH /api/desk/widgets/:id` with any of `{x,y,w,h,z,docked,page}`. It's sent on release, not during the drag.
  - `x`, `y` 0–1; `w`, `h` 0.02–1; `z` a whole number ≥ 0; `docked` true/false.
  - `page` is a whole number ≥ 1, for a viewer turned by a tap.
- `POST /api/desk/timer`:
  - `{"action":"start","minutes":15}` starts afresh (1–180 whole minutes); `{"action":"start"}` resumes a paused timer.
  - `{"action":"pause"}` and `{"action":"reset"}`.
- `DELETE /api/desk/widgets/:id`: notes and viewers only. Removing a viewer deletes the Pi's copy of its file, never the file in Ekko.Files.
- `POST /api/desk/viewers` `{"file":"<id>"}`: opens a file from the Files card's list, like `/api/files/show`.
- `POST /api/desk/ask` `{"action":"start"}` or `{"action":"stop"}`: Ask Ekko. It answers `{"ok":true}`, and how it went comes as `ask` messages.
  - A start while not idle, or a stop while not listening, changes nothing.
- `POST /api/desk/food/log` `{"food":"coffee"}`: logs one of a usual food through Ekko.Food's `/food/log`. These skip the Brain, so they don't show in the chat card.
  - **200** `{"ok":true,"message":"Logged coffee: 5 calories. 1,245 calories today."}`. With `ok` false, Ekko didn't log it (the food was removed meanwhile), and `message` says why.
  - **400** "That isn't one of your usual foods any more." when the name isn't in the current `usual` list.
  - **502** "Ekko's food diary isn't answering."
- `POST /api/desk/food/undo`: Ekko.Food's `/food/undo`, which takes off today's last entry, whoever logged it.
  - So it's allowed once, within 15 s of the desk's own log. The page shows Undo for 10 s.
  - Otherwise 409 "Too late to undo that here. Ask Ekko to undo it."
- `POST /api/desk/today/refresh`: a tap on the Today card away from its buttons. Everything is read again at once, the budget included.

The toys (the ball and the two fighters) are the page's alone: nothing about them goes to the server, and nothing is saved.
- `GET /api/desk/files/:id`: the bytes of an open viewer's file, with its stored `Content-Type` and `X-Content-Type-Options: nosniff`.
  - An `<img src>` can't send `X-Desk`, so the page fetches the bytes and uses a blob URL (photos) or the ArrayBuffer (pdf.js).
  - The server copies the file from Ekko.Files to `data/files/<id>` the first time, so it still shows with the PC off.
  - Answers:
    - 404 `{"ok":false,"error":"That file isn't there anymore."}` when Ekko.Files no longer has it (a changed or deleted Downloads file).
    - 502 `{"ok":false,"error":"Ekko's file store isn't answering."}` for any other failure.

## Ekko's Brain → desk server

`add_desk_note(text)` in Ekko's `desk` domain (DR-39 in EkkoHomeAgent) calls this. Ekko reads `message` and `error` to the user word for word, so both are full sentences.

```
POST /api/notes   X-Api-Key: <DESK_BRAIN_KEY>   {"text":"call mom"}
201 {"ok":true,"id":"note-mw1fg1g5-4824474a","message":"Put “call mom” on your desk."}
400 {"ok":false,"error":"A note needs some text."}   or   "A note can be at most 200 characters."
409 {"ok":false,"error":"Your desk already has 30 notes. Take some off first."}
401 {"ok":false,"error":"Wrong or missing X-Api-Key."}
```

- **No Host check:** the Brain calls through `host.docker.internal:8081` while the desk runs on the PC, and the Pi's tailnet name in phase 4. The key is the only check.
- **Placement:** the first free spot along the top, row by row, above the dock strip. With no free spot, it goes on top of the first one.
- **Ids:** `note-` plus the time in base 36 and 8 random hex characters, so two notes in the same millisecond can't collide.
- **Taking it off:** drag it to the trash (bottom-right of the strip) and hold it there 600 ms before letting go. A quicker drop just docks it.

`show_file_on_desk(name)` (DR-40 in EkkoHomeAgent) calls this. The same key check applies.

```
POST /api/files/show   X-Api-Key: <DESK_BRAIN_KEY>   {"name":"invoice"}
200 {"ok":true,"message":"Opened “invoice.pdf” on your desk."}
404 {"ok":false,"error":"I couldn't find a file called “invoice”."}
404 {"ok":false,"error":"You haven't sent me any photos or PDFs yet."}          (name "")
409 {"ok":false,"error":"Your desk already has 5 files open. Close one first."}
502 {"ok":false,"error":"Ekko's file store isn't answering, so I can't open that."}
400 {"ok":false,"error":"name must be text of at most 60 characters."}
401 {"ok":false,"error":"Wrong or missing X-Api-Key."}
```

- **Finding the file:**
  - `name` is passed to Ekko.Files as is: `GET /files?q=<name>&limit=1`, and the store does the matching.
  - `""` asks for `GET /files?limit=1`, the newest file sent or downloaded.
  - The lookup times out after 8 s, inside the Brain's 10 s.
- **Answering:**
  - The answer comes as soon as the viewer card exists. The bytes are copied afterwards.
  - A file that's already open comes to the front instead, out of the strip if it was docked.
- **Placement:** top centre, each further viewer 0.03 to the right of the last.
