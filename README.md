# obscura

A light, private recording studio in the browser, in the spirit of OBS: scenes, a
screen, a camera, overlays and an audio mixer, recorded to MP4 or WebM. It is
frontend only: no account, no server, no upload. The recording page cannot connect
anywhere.

**→ [maxgfr.github.io/obscura](https://maxgfr.github.io/obscura/)** · installable as an app, works offline.
The [`obscura` CLI](#cli) opens encrypted recordings and repairs interrupted ones.

## How it works

1. **Compose.** Each scene stacks sources on a fixed canvas (720p to 1440p, vertical
   and square too). Drag, resize and crop them in the preview. Switch scenes with
   `1`–`9`, with a cut or a fade.
2. **Record.** The canvas is drawn with WebGL 2 and encoded with WebCodecs
   (hardware H.264 when available, else VP9/AV1) through
   [Mediabunny](https://mediabunny.dev). Audio is mixed with the Web Audio API.
   Frames and audio share one clock, so they stay in sync, and recording keeps
   going while you are in another window.
3. **Keep.** The file is written to disk as it is made, in the site's private
   storage (OPFS), as fragmented MP4 or append-only WebM. Close the tab or crash
   halfway, and the recording is still there, playable up to the cut. Save it
   wherever you want from **Recordings**.

| | |
|---|---|
| Sources | Screen, window or tab (with its audio); camera; microphone; image; text; solid color; **privacy mask** (a solid or pixelated box, always on top, to hide notifications or secrets). |
| Look | Position, size, crop, opacity, rounded corners or a circle (camera bubble), mirror, chroma key. |
| Audio | Per-source volume, mute, meters, headphone monitoring; browser or strong (RNNoise, on-device) noise reduction for microphones. |
| Recording | MP4 or WebM, standard or high quality, pause/resume, timer and size on disk, a floating mini control window (Chromium), the screen kept awake. |
| Encryption | Optional: recordings are sealed with AES-256-GCM under a key stretched from a passphrase (Argon2id). The passphrase lives in memory for the session only. |
| Layouts | Saved in the browser. **Share layout** gives a link that carries the scenes in its `#fragment`. It never reaches a server and holds no capture, device or image. |
| Live with friends | On [`live.html`](https://maxgfr.github.io/obscura/live.html), **Open a room** gives two links. Friends with the **guest link** join with their camera and microphone: once you let them in, they appear on screen and the scene splits into tiles (they hear everyone but themselves). Anyone with the **viewer link** watches the program live. Up to 3 guests and 8 viewers, peer to peer. |
| Live to a platform | Also on `live.html`: stream the program over **WHIP** (WebRTC ingest) to a URL you give. `live.html` is the only page allowed to use the network. |

Shortcuts: `R` record/stop, `P` pause, `1`–`9` scenes, arrows to nudge (with `Shift`, by 10 px),
`[` `]` to reorder, `Delete` to remove, `Esc` to deselect. In the preview, `Shift` keeps the aspect
ratio while resizing and `Alt` turns snapping off.

The security model and its limits are in [SECURITY.md](SECURITY.md), and the
encrypted file format is in [FORMAT.md](FORMAT.md).

### Live with friends, without a server

The site is static, so there is nothing of ours for browsers to meet on. Instead:

1. **Finding each other.** The friend's page and yours exchange connection details through a
   few public [Nostr](https://nostr.com) relays, as short-lived messages that relays do not
   store. Each link carries a random secret in its `#fragment` (never sent to any server): the
   relays only see an opaque topic derived from it and messages sealed with AES-256-GCM under a
   key derived from it.
2. **Media.** Video and audio then go directly between browsers (WebRTC, encrypted with
   DTLS-SRTP), never through a relay. A public STUN server tells each browser its public address.
3. **When relays are blocked**, the friend's page offers **codes** to copy by hand: they send you
   theirs, you paste it under **Add someone by code** and send back the answer.

Guest and viewer links have different secrets, so a viewer cannot join on screen, and guests
wait until you let them in. Some strict networks (some mobile carriers, corporate firewalls) block
direct connections; a TURN server (optional, in the room panel) relays the media for them.
Each viewer gets their own stream from your browser, so your upload limits how many can watch.

### What a browser cannot do

- **No RTMP.** Browsers cannot open raw TCP sockets, so there is no direct
  Twitch/YouTube RTMP. Use WHIP: some platforms and services accept it directly,
  for others you need a relay.
- **The screen picker comes first.** For privacy, the browser asks which screen,
  window or tab to share every session. A saved layout restores positions, never access.
- **System audio** is available on Windows and ChromeOS. On macOS a browser can
  only capture a tab's audio.
- No game capture, virtual camera, global hotkeys or native plugins.

## CLI

`obscura` works offline on what the web app produces.

```sh
brew install maxgfr/tap/obscura

obscura decrypt obscura-20261021-143005.mp4.obscura      # asks for the passphrase
obscura decrypt --partial cut.mp4.obscura                # recover a sealed recording cut by a crash
obscura inspect obscura-20261021-143005.mp4             # container, tracks, duration, whole or cut
obscura inspect --verify file.mp4.obscura               # check every encrypted chunk, write nothing
obscura repair cut.mp4                                  # keep everything up to the last whole fragment
obscura encrypt notes.webm                              # seal any file in the same format
obscura new                                             # a studio link with the default layout
obscura scene link layout.json                          # a layout file → a studio link (scene check/show too)
```

The passphrase can come from `OBSCURA_PASSPHRASE` instead of the prompt. Prebuilt
binaries for macOS and Linux are on the [releases page](https://github.com/maxgfr/obscura/releases).
WebM→MP4 remuxing is not built in, because the studio records MP4 directly.
`ffmpeg -i in.webm -c copy out.mkv` covers the rest.

Homebrew also has an unrelated `obscura` formula (a headless browser), so install this one
by its full name, `maxgfr/tap/obscura`. The two cannot be installed side by side.

## Development

Requirements: [Bun](https://bun.sh) 1.4+, and Rust (stable) for the CLI.

```sh
bun install
bun run dev          # http://localhost:5173 (live mode: /live.html, with a mock WHIP ingest)
bun run test         # unit tests, shared vectors, build checks
bun run test:e2e     # Playwright: Chromium (fake camera, mic and screen), rooms over a mock relay, WebKit, phones, CLI interop
bun run typecheck && bun run lint && bun run build && bun run check-size

cargo test --manifest-path cli/Cargo.toml
cargo build --release --manifest-path cli/Cargo.toml
bun run vectors      # regenerate cli/tests/vectors.json after a format change
```

```
src/
  studio/    scenes and layers (validated, shareable), state, the live engine
  render/    WebGL 2 compositor, shaders, text
  audio/     the mixer (Web Audio) and its tap for the encoder
  capture/   screen, camera, microphone
  record/    encoder (Mediabunny), OPFS storage, crash recovery, MP4 metadata scrub
  crypto/    the sealed format: Argon2id, chunked AES-256-GCM
  live/      WHIP, rooms and their relay signaling (live.html only)
  workers/   OPFS writer, key derivation, render clock, audio tap
  ui/        Preact components
cli/         the Rust CLI (same format, same layout rules)
```

The first screen's JavaScript is about 37 KB gzip, with a 60 KB budget enforced in CI. The
encoder loads on the first recording and is precached for offline use. The build refuses
inline scripts and styles and any external URL. Each page gets a strict Content Security
Policy with Trusted Types. On the studio page `connect-src` is `'self'` and nothing else.

## License

MIT
