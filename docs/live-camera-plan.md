<!-- Status: PLANNED, Phase 0 (the test with the real camera) next. Written 2026-10-31 against main 974a46a (installed app 1.4.2); committed 2026-11-02 at 1.4.4. Phase 0 decides Phase 4 and may stop the whole thing. -->

# Live picture from the camera — plan

**What the owner asked (31.10.2026):** the live picture of the Osmo Action, over **Wi-Fi**, in a **window of its own** next to the notebook (a second screen, or beside it), and the **Clip** button (the Pre-Rec trigger) in that window too.

---

## 1. Summary

- In the **installed desktop app** (Linux, Windows, macOS), a **Live** window shows what the camera films, 1–3 s behind (to be measured), at up to 1080p30.
- The app already talks to the camera over Bluetooth for Clip. Over the same link it tells the camera to **join a Wi-Fi network** and **stream to the laptop** (RTMP). The app receives the stream itself. No phone app, no server, no internet: the picture goes from camera to laptop and nowhere else.
- The Live window has a big **Clip** button. A clip lands in the notebook as today, as a line at the writing position.
- If the camera stops its Pre-Rec while it streams (Phase 0 tells), the app keeps the **last 30 s of the stream** itself and Clip cuts the clip from that instead. That clip is ready at once, in 1080p H.264, with no card import after the match.
- **Not** on the website, the iPad or the iPhone: a browser cannot receive a stream. Android can come later (§10).

## 2. Decisions

### 2.1 Taken (owner, 31.10.2026)

| # | Decision | Consequence |
|---|---|---|
| O1 | Wi-Fi, not the USB webcam mode | Camera can stand at the court; desktop app only |
| O2 | A window of its own, not inside the notebook | Tauri second window `live`; drag it to a second screen |
| O3 | Clip in the Live window too | The window sends the tap to the main window, which owns the camera and the notebook (§7.2) |

### 2.2 Open — the owner decides

| # | Question | Proposal |
|---|---|---|
| D1 | Which Wi-Fi do camera and laptop share? | **Phone hotspot**: both join it, the laptop keeps internet. Laptop hotspot as the fallback (§9) |
| D2 | If Pre-Rec stops while streaming: clip from the stream? | **Yes** (Phase 4). Otherwise Clip would not work at all while Live is on |
| D3 | Sound | Received, **muted** by default, a speaker button in the window |
| D4 | Clip from the Live window while the notebook is closed | The line goes to the **newest page** (made if there is none), and a toast says where |
| D5 | Default quality | 1080p, 30 fps, 6 Mbit/s (DJI allows 2–20 Mbit/s, 480/720/1080p, 25/30 fps) |
| D6 | Android tablet (tablet as hotspot host) | Later, after the desktop works (§10) |

---

## 3. How it fits together

```
                  Bluetooth (one link, two protocols)
  Osmo Action  ── FFF5/FFF4  DJI R SDK (0xAA frames)  ─ status, Pre-Rec record  (exists: osmoProtocol.ts)
       │       ── FFF3/FFF4  DUML      (0x55 frames)  ─ pair, Wi-Fi, start/stop stream, battery   (new: osmoStream.ts)
       │
       │  Wi-Fi, RTMP push: H.264 + AAC
       ▼
  rtmp://<laptop LAN IP>:1935/live/<random key>
  ┌──────────────── installed app, Rust (new: src-tauri/src/live.rs) ───────────────┐
  │ RTMP receiver ──► ring buffer (last 30 s, from a keyframe) ──► clip → MP4 file   │
  │        └────────► FLV over ws://127.0.0.1:<port>/live.flv?t=<token>               │
  └───────────────────────────────────────────────────────────────────────────────┘
                              │
          Live window (mpegts.js → MSE <video>) ── "Clip" ──► event to the main window
          Main window: camera session, notebook, clips store (unchanged owners)
```

Each Tauri window is its own JavaScript world. The Bluetooth session and the notebook stay in the **main** window. The Live window only shows video and sends taps, over Tauri events.

---

## 4. Phase 0 — test with the camera (go / no-go, 1–2 h, needs the owner and the camera)

On the owner's laptop (fw13), with off-the-shelf tools and no app code:

- **mediamtx** (MIT, one binary, no install) receives RTMP on port 1935 and shows it in Chrome. That gives the delay.
- **node-osmo**'s example or **osmo-live** (both MIT) does the Bluetooth part: Wi-Fi name and password, RTMP address. They need Bluetooth rights (`sudo` or `setcap cap_net_raw`).

| # | Question | How | If the answer is bad |
|---|---|---|---|
| T1 | Does the **Action 5 Pro** stream at all with these commands? (osmo-live only tested an Action 4) | Start a stream to mediamtx | Stop here |
| T2 | **Delay** | Film a stopwatch on the laptop screen | > 3 s: still useful? owner decides |
| T3 | Does the camera **record to its card / keep Pre-Rec** while streaming? | Press record on the camera during the stream; then check the card | Phase 4 becomes required (D2) |
| T4 | Does the camera keep **Bluetooth** up while streaming, and take our R SDK commands on the same link? | Phase 0 can only show the first half; the second is checked first thing in Phase 1 | Clip only from the stream |
| T5 | **Phone hotspot**: can the camera reach the laptop through it? (owner's phone) | Both on the hotspot, stream to the laptop's IP | Laptop hotspot instead (D1) |
| T6 | **2 GHz / 5 GHz**: which bands does the camera join? | Hotspot on 5 GHz only, then 2.4 GHz | Guidance text only |
| T7 | **2 hours** on a power bank: does it hold, how hot does it get, how much battery? | Leave it running | Guidance (power bank), or a warning in the window |
| T8 | **Wi-Fi drop**: does the camera resume by itself? | Hotspot off for 30 s, on again | The app restarts the stream over Bluetooth (§6) |
| T9 | Pairing: does the DUML pairing ask for a confirmation on the camera again? | Watch the camera screen | Text in the setup dialog |

**Gate:** T1 must pass; T3 decides Phase 4; the others shape the text and the error handling.

---

## 5. Phase 1 — Bluetooth stream commands (~2 days)

**New `src/lib/osmoStream.ts`** (pure, like osmoProtocol.ts: bytes in, bytes out):
- DUML frame: `55 | len | 04 | CRC-8` header, then target, transaction id, type, payload, CRC-16 LE (both CRCs as in node-osmo `src/message.ts`).
- Messages: pair (PIN), stop stream, preparing to livestream, set up Wi-Fi (SSID, password), configure (stabilisation; the Action 5 Pro flag), start stream (RTMP URL, resolution byte 480p/720p/1080p, fps byte 25/30, kbit/s), and the Action 5 Pro's confirm-start. Battery from type `0x020d00`, byte 20.
- Ported from node-osmo (MIT): the header names it and keeps its copyright line. Add a `THIRD_PARTY` note. (osmoProtocol.ts stays as it is: written from DJI's documents, nothing copied.)
- Model from the advert: bytes 2–3 of the DJI manufacturer data (`15 00` = Action 5 Pro).

**`osmoLink.ts`**: write to **FFF3** as well as FFF5, on the web as well as natively (`conn.send(uuid16(0xfff3), …)`). Notifications on FFF4 go by their first byte: `0xAA` to the existing parser, `0x55` to the stream parser.

**`osmoCamera.ts`**: a `live` state (`off | starting | live | stopping | error`) with the steps of the camera's sequence. Each step has a timeout and an error code like the existing ones (`camErr…` strings in notepadStrings.ts). Add battery to the camera state.

**First check in this phase (T4):** with our own R SDK session open, run the DUML sequence and then a Pre-Rec record. Both must work on one link.

**Tests:** a rule spec, byte for byte, against frames that node-osmo encodes (generated once, checked in as fixtures), in the style of the existing DJI frame spec.

## 6. Phase 2 — the receiver, in Rust (~3–4 days)

**New `src-tauri/src/live.rs`**, desktop only (`cfg(not(mobile))` for now):
- **RTMP receiver**: tokio `TcpListener` on `0.0.0.0:1935` (the next free port if taken), handshake and session via `rml_rtmp` (MIT/Apache). It takes only a publish on `live/<key>`, where the key is 128 random bits new for each start, and only one publisher.
- **To the window**: FLV header + tags (the RTMP payloads with their timestamps, starting with the AVC/AAC sequence headers) over a WebSocket on `127.0.0.1` only, with a one-time token. Client: **mpegts.js** (Apache-2.0, MSE), live mode, latency chasing on. Loaded only in the Live window.
- **Ring buffer**: the last 30 s of tags, cut at keyframes, in memory (6 Mbit/s × 30 s ≈ 23 MB).
- **Clip from the buffer** (`live_clip(tapMs, preSeconds, postSeconds = 1)`): waits `postSeconds`, takes the tags from the keyframe at or before `tap − pre`, and writes an MP4 (crate `mp4`, or a small fMP4 writer) into `<app data>/clips/<clipId>.mp4`. The asset scope and the clip ids work as in clipfiles.rs today.
- **Commands / events**:
  - `live_prepare()` returns the LAN IPv4 addresses (crate `if-addrs`, private ranges, Wi-Fi interface first) and the key.
  - `live_stop()`
  - `live://status` events: publisher connected, fps, bit rate, last frame, and how far behind the window plays.
- **Security**: RTMP has to listen on the LAN, so it takes only the random key and drops everything else. The WebSocket listens on localhost only and needs the token. Nothing is sent anywhere.
- **CSP**: `csp` is `null` today. If one is added later, it needs `connect-src ws://127.0.0.1:*`.
- **Tests**: `cargo test` pushes a short recorded FLV fixture through an RTMP client (rml_rtmp's client side) and checks the WebSocket bytes and a clip MP4 (duration, starts on a keyframe).

## 7. Phase 3 — the Live window (~2–3 days)

### 7.1 Window and setup
- **Opening it**: a **Live** button next to **Camera** in the notebook toolbar, shown only when the camera option is on and in the desktop app. A **Live picture** row in Options says how it works.
- **Setup dialog** (first time, then remembered on this device):
  - Wi-Fi name and password.
  - Where the OS allows it, the name is filled in from the laptop's current Wi-Fi: `nmcli` on Linux, `netsh wlan show interfaces` on Windows.
  - Quality (D5).
  - A short hotspot guide (§9).
  - The password stays on this device only: never sent to the server, never in a log. It is kept under the key name `password`, which the logger's `SECRET_KEY` already redacts.
- **The window**: Tauri `WebviewWindow` with the label `live`, loading the same bundle with `index.html?window=live`, so no new route is needed. It remembers its size and position. It has an "always on top" toggle and closes with the main window.

### 7.2 Inside the window
- The video, plus a status line: camera name, battery, Wi-Fi/stream state, delay.
- **Clip**: a big button, plus the space bar while the window has focus. The tap sends the event `live:clip {at}` to the main window, which does what CameraButton does today:
  - with camera Pre-Rec: R SDK record, as now;
  - otherwise: `live_clip` (Phase 4).
  
  Either way it writes the line with `insertLine`, or follows D4 when the notebook is closed. The window flashes "Clip n".
- **Stop** ends the stream over Bluetooth and stops the receiver. Closing the window does the same.
- When the stream stalls (T8): the window shows "reconnecting …", and after 10 s without frames the main window restarts the stream over Bluetooth.
- The strings go in `notepadStrings.ts` (DE + EN).

## 8. Phase 4 — clips from the stream (~1–2 days; required if T3 fails)

- `Clip` gets `source: 'camera' | 'stream'`. A stream clip has its file at once: `file.path` points to the MP4 from `live_clip`, and `seconds` = the pre-seconds used (default 10, or the camera's Pre-Rec length if the R SDK reports it).
- If the camera did record too, the existing card auto-import still finds the original after the match. The stream file then becomes the **light copy** (`proxyPath`, the slot the .LRF uses today), and the original becomes the main file.
- The player already skips the frozen start of Pre-Rec files. Stream clips have no frozen start, so the skip must apply to `source: 'camera'` only.

## 9. Network — what the coach does

1. **Recommended — phone hotspot** (if T5 passes): turn on the hotspot, connect the laptop to it, and type its name and password into the setup once. The laptop keeps internet, so the notebook keeps syncing.
2. **Laptop hotspot** (Linux: Settings → Wi-Fi → Hotspot; Windows: Mobile hotspot): the camera joins the laptop directly. While it runs the laptop usually loses its own Wi-Fi internet. That is fine, because the app works offline and syncs later.
3. **Hall Wi-Fi**: not recommended. These networks often block devices from reaching each other.

- **Firewall**: Windows asks once on the first start ("Allow"). macOS asks to accept incoming connections. On Linux, only an active `ufw` needs port 1935 opened; the dialog says so when no frames arrive.

## 10. Later, not in this plan

- **Android tablet**: the same Rust receiver compiles for Android. The tablet runs the hotspot and the camera joins it. The app needs mobile builds of `live.rs`, a foreground service so it isn't killed, and mpegts.js in the Android WebView (Chromium, MSE fine).
- **Recording the whole match** from the stream (1080p) onto the laptop: a small step once the receiver exists.
- Website, iPad, iPhone: not possible (no stream reception, no Web Bluetooth on iOS).

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The stream commands are **reverse-engineered** (node-osmo / Moblin), not documented by DJI; a camera firmware update can change them | Live stops working after an update | Clear error message; Clip by Pre-Rec stays independent of it; protocol spec + fixtures make a fix quick |
| Pre-Rec stops while streaming (T3) | Clip needs the stream buffer | Phase 4 |
| WebKitGTK needs GStreamer H.264/AAC decoders for MSE | Black window on Linux | The .deb already Recommends `gstreamer1.0-libav` and `-plugins-bad`; check on fw13; the window names the missing package |
| Phone hotspot isolates its clients | No stream | Laptop hotspot (§9) |
| Camera heat / battery over 2 h | Stream stops mid-match | Power bank; battery shown in the window; T7 |
| One Bluetooth link carrying two protocols | Clip and Live interfere | Checked first in Phase 1 (T4) |
| The .deb does not update itself (fw13 sat on 1.3.7 until 31.10) | Coaches miss the feature | Release note says to download the .deb again, or switch to the AppImage |

## 12. Effort and order

| Phase | Work | Size |
|---|---|---|
| 0 | Test with the camera (owner present) | 1–2 h |
| 1 | Bluetooth stream commands + spec | ~2 days |
| 2 | Rust receiver, ring buffer, clip writer + tests | ~3–4 days |
| 3 | Live window, setup, Clip button, strings | ~2–3 days |
| 4 | Clips from the stream (if T3 fails) | ~1–2 days |
| 5 | Playwright check of the window with a fake FLV feed; manual run on fw13 (`npx tauri build --no-bundle`, scp); release desktop 1.5.0 | ~2 days |

About two weeks of work after a Phase 0 that passes. Frontend + desktop app only: no server or DB change.
