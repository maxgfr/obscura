# Security

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/maxgfr/obscura/security/advisories/new).

## What obscura protects

obscura is a recording studio that runs entirely in your browser. The goals:

1. **Nothing leaves the device.** Captures, recordings, layouts and passphrases are
   never sent anywhere. The site is static (GitHub Pages) and has no backend,
   analytics or third-party code.
2. **Recordings at rest can be sealed** with a passphrase, so a copied disk,
   a synced folder or a shared file reveals nothing without it.
3. **Nothing is recorded by accident.** Every live capture is listed with its
   own stop button, and privacy masks always sit on top.

## Who sees what

| | Sees |
|---|---|
| GitHub Pages | That the static files were downloaded (like any website). Never a capture, a recording or a layout: a shared layout lives in the link's `#fragment`, which browsers never send. |
| The recording page | Only what you choose to capture. Its policy forbids any connection (`connect-src 'self'`), so it could not upload even if it tried. |
| The live page (`live.html`) | Only when you go live: the WHIP endpoint **you** enter receives the program (video and mixed audio) and your token. Nothing else. |
| Room relays (public Nostr relays) | Only while a room is open or a friend is joining: the IP addresses that connect, a random one-time key per page, an opaque topic and the timing and size of sealed messages. Not the links' secrets, names, addresses inside the connection details, or any audio or video. |
| STUN (Google, Cloudflare) | While connecting to a friend: your public IP address, like any video call. |
| Your friends | Guests and viewers see the program you send them, and each peer sees the other's IP address (WebRTC is peer to peer). Guests send their camera and microphone to you only. |
| This browser's storage | Recordings (sealed if you chose to) in the site's private file system; layouts and preferences in `localStorage`. Never a passphrase, a token, a device id or a device name. |

## Browser hardening

- A strict Content Security Policy in each page: `default-src 'none'`, scripts,
  styles and workers from the site only, `base-uri` and `form-action` set to
  `'none'`, **Trusted Types required** for every script URL (workers, worklets,
  service worker), and no inline script or style. The build refuses any inline
  code and any external URL. `'wasm-unsafe-eval'` is only there for the opt-in
  RNNoise WebAssembly, never for JavaScript.
- The studio page has **no network**: `connect-src 'self'`, and nothing in the
  code except live mode makes a request. The build tests check both. Live mode is a
  separate page whose policy only adds `https:` (WHIP) and `wss:` (room relays) connections.
- `no-referrer`; the page blanks itself when framed (clickjacking), since a meta CSP
  cannot set `frame-ancestors`.
- No HTML is ever injected: the UI renders text as text, and a test fails on any use of
  `innerHTML`-like sinks.
- Untrusted input is validated strictly: layouts read back from storage or a link
  are checked field by field (unknown fields refused, bounds enforced, decompression
  capped), and the sealed header's costs are bounded before any key is derived.
- Dependencies are pinned by lockfile (six runtime packages: Preact, Preact
  Signals, Mediabunny, @noble/hashes, @noble/curves for room relays, RNNoise), and GitHub
  Actions are pinned by commit SHA.

## Recordings

- **Streaming to disk.** A dedicated worker writes each recording to the
  origin-private file system with a synchronous access handle, in place and
  flushed every second. A crash leaves a playable `.part` file (fragmented MP4 or
  append-only WebM), not a lost one. Saving elsewhere copies the file disk to disk.
- **Metadata.** MP4 creation and modification times are zeroed, file names carry
  only the local date and time, and no device, title or location is written.
- **Encryption** ([FORMAT.md](FORMAT.md)): Argon2id (64 MiB, 3 passes) stretches
  the passphrase in a worker. The key is imported into WebCrypto as non-extractable
  and the raw bytes are wiped. Chunks are AES-256-GCM with the index, the
  "last chunk" flag and the header bound in, so wrong keys, tampering, reordering
  and truncation are all detected. The CLI implements the same format and is
  tested against the same vectors.

## Rooms

- A room link is the key: anyone who has the guest link can ask to join, and anyone who has the
  viewer link can watch, so share them like a meeting link. Closing the room makes both links
  useless; a new room has new links.
- The two secrets are generated in the host's page, kept in memory, and only ever leave it inside
  the links. From each secret come a topic (SHA-256) and a message key (HKDF-SHA256 to
  AES-256-GCM, the topic bound in as associated data).
- Messages carry a timestamp and are refused after two minutes, so an old message replayed by a
  relay is ignored. Guests always wait for the host's approval; codes pasted by hand count as
  approval.
- Relay signatures are not trusted for anything: authenticity comes from the room key.

## Known limits

- A sealed recording is only as strong as its passphrase. There is no recovery: lose
  the passphrase and the recording is gone.
- The passphrase is in the page's memory while the session lasts. Malware on the
  machine, or a malicious browser extension, can read the screen and the page anyway.
- While recording, the file exists unsealed only inside the encoder's memory, never on disk.
  The `.part` file of an interrupted sealed recording is itself sealed.
- Pixelated masks can sometimes be reversed on text. Use solid masks for secrets.
- Browser storage can be cleared by the user or, under pressure, by the browser.
  obscura asks for persistent storage, but save what matters elsewhere.
- Live streaming sends the program to a third party of your choice, in clear to that
  party. WHIP uses WebRTC encryption (DTLS-SRTP) in transit.
- In a room, a guest or viewer can record what they receive, as in any call.
