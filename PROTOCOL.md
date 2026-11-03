# Ekko Desk: message format

The tracker (PC) and the desk server and page (Pi) are updated separately, so every receiver ignores a `v` or `type` it doesn't know.

## Tracker → desk server

The tracker connects to `/ws/tracker` with `X-Api-Key` on the WebSocket upgrade (the `DESK_TRACKER_KEY` value). A missing or wrong key gets HTTP 403. The server passes these messages on unchanged to every open desk page; a message over 1 MB closes the connection.

```jsonc
{"v":1,"type":"pointer","phase":"down","id":41,"hand":"right","x":0.412,"y":0.661,"t":1762190000123}
{"v":1,"type":"calibrate","png":"<base64 1280x720 PNG>"}   // show full screen, on top of everything
{"v":1,"type":"calibrate","png":null}                       // hide it
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

## Desk server → page

The page connects to `/ws/page`, localhost only. Browsers can't add a custom header such as `X-Desk` to a WebSocket upgrade, so the server checks that both `Host` and `Origin` are `127.0.0.1` or `localhost` instead. Anything else gets HTTP 403.

```jsonc
{"type":"tracker","connected":true}   // on connect and whenever it changes
{"type":"state","widgets":[{"id":"note-7","kind":"note","x":0.1,"y":0.2,"w":0.14,"h":0.14,"z":3,"docked":false,"text":"call mom"},
                           {"id":"timer","kind":"timer","x":0.7,"y":0.1,"w":0.2,"h":0.12,"z":1,"docked":false,"presets":[5,15,25],"endsAt":null,"leftMs":null}]}
{"type":"turns","turns":[{"id":"…","channel":"telegram","at":"…","said":"…","reply":"…","state":"ok"}]}   // phase 3
```

- The full state goes out on connect and after every change. A dozen widgets is tiny, so there's no diffing.
- Every widget has `id`, `kind`, `x`, `y`, `w`, `h`, `z` and `docked`; kinds add their own fields (`text`, `presets`, … in phase 3).
- A docked widget is drawn as a chip at its `x`, `y`; `w` and `h` are kept for when it comes back out.
- When the tracker disconnects, the page cancels its live pinches, since no `up` will come, and hides the calibration image.

## Page → desk server

Plain HTTP behind the `X-Desk` check (header `X-Desk: 1` and a local `Host`, or 403):
- `PATCH /api/desk/widgets/:id` with any of `{x,y,w,h,z,docked}`. It's sent on release, not during the drag.
  - `x`, `y` 0–1; `w`, `h` 0.02–1; `z` a whole number ≥ 0; `docked` true/false. Anything else is 400 `{"ok":false,"error":"…"}`; an unknown id is 404.
  - On success, 200 `{"ok":true}`, and every page gets the new `state`.
- Phase 3: `POST /api/desk/timer` with `{"action":"start","minutes":15}`, `{"action":"pause"}` or `{"action":"reset"}`.
- Phase 3: `DELETE /api/desk/notes/:id`.
