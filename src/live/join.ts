/**
 * The friend's side of a room link: a guest sends their camera and
 * microphone and receives the program (without their own voice); a viewer
 * only receives it. The joiner makes the offer and repeats it on the relays
 * until the host answers. If no relay gets through, the same offer becomes
 * a code to send the host by hand, and the host's answer a code to paste.
 */
import { signal } from "@preact/signals";
import type { Role } from "./room-state";
import {
  type Channel,
  channel,
  iceServers,
  manualCode,
  open,
  peerId,
  presence,
  Relays,
  readManualCode,
  seal,
  unb64url,
  waitForIce,
} from "./signal";

export type JoinState =
  | { kind: "idle" }
  | { kind: "waiting"; relays: number; total: number; since: number }
  | { kind: "connecting" }
  | { kind: "connected"; program: MediaStream }
  | { kind: "ended"; message: string };

export const joinState = signal<JoinState>({ kind: "idle" });
/** The offer as a code, for when the relays do not get through. */
export const joinCode = signal<string | null>(null);

/** Reads #join=… (guest) or #watch=… (viewer). */
export function readJoinLink(
  hash = location.hash,
): { role: Role; secret: Uint8Array<ArrayBuffer> } | null {
  const m = /^#(join|watch)=([A-Za-z0-9_-]{43})$/.exec(hash);
  if (!m) return null;
  try {
    return { role: m[1] === "join" ? "guest" : "viewer", secret: unb64url(m[2] as string) };
  } catch {
    return null;
  }
}

const REPEAT_MS = 3000;

let pc: RTCPeerConnection | null = null;
let relays: Relays | null = null;
let ch: Channel | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// Closing the page hangs up cleanly, so the host sees it at once.
window.addEventListener("pagehide", () => leave(false));

export async function join(opts: {
  role: Role;
  secret: Uint8Array<ArrayBuffer>;
  name: string;
  /** The guest's camera and microphone (none for a viewer). */
  media: MediaStream | null;
}): Promise<void> {
  leave(false);
  const me = peerId();
  ch = await channel(opts.secret);
  const peer = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: "max-bundle" });
  pc = peer;
  const video = opts.media?.getVideoTracks()[0];
  const audio = opts.media?.getAudioTracks()[0];
  const send = opts.role === "guest";
  const streams = opts.media ? [opts.media] : [];
  peer.addTransceiver(video && send ? video : "video", {
    direction: video && send ? "sendrecv" : "recvonly",
    streams,
  });
  peer.addTransceiver(audio && send ? audio : "audio", {
    direction: audio && send ? "sendrecv" : "recvonly",
    streams,
  });
  const dc = presence(peer);
  dc.onclose = () => {
    if (pc === peer && peer.connectionState !== "new")
      end("The host ended the live, or removed you.");
  };
  const program = new MediaStream();
  peer.ontrack = (e) => program.addTrack(e.track);
  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    if (peer.connectionState === "connected") {
      stopAsking();
      joinState.value = { kind: "connected", program };
    }
    if (peer.connectionState === "failed")
      end("The connection failed. A firewall may block it; the host can add a TURN server.");
    if (peer.connectionState === "disconnected") {
      // Give the network a moment before calling it over.
      setTimeout(() => {
        if (pc === peer && peer.connectionState === "disconnected") end("The host left.");
      }, 5000);
    }
  };
  await peer.setLocalDescription(await peer.createOffer());
  await waitForIce(peer);
  const sdp = peer.localDescription?.sdp;
  if (!sdp || pc !== peer) return;
  const msg = {
    t: "offer" as const,
    from: me,
    sdp,
    ...(send && opts.name.trim() ? { name: opts.name.trim().slice(0, 40) } : {}),
  };
  const sealedNow = () => seal(ch as Channel, { ...msg, ts: Math.floor(Date.now() / 1000) });
  joinCode.value = manualCode(send ? "g" : "w", await sealedNow());

  const r = new Relays();
  relays = r;
  const since = performance.now();
  const status = (up: number, total: number) => {
    const s = joinState.value;
    if (relays === r && (s.kind === "waiting" || s.kind === "idle"))
      joinState.value = { kind: "waiting", relays: up, total, since };
  };
  r.onStatus = status;
  status(0, r.total);
  const c = ch;
  r.subscribe(c.topic, (content) => {
    void open(c, content).then((m) => {
      if (m && m.t === "answer" && m.to === me) void onAnswer(m.sdp);
    });
  });
  const ask = async () => {
    if (relays !== r) return;
    r.publish(c.topic, await sealedNow());
    // The manual code is kept fresh too (messages expire after two minutes).
    joinCode.value = manualCode(send ? "g" : "w", await sealedNow());
  };
  void ask();
  timer = setInterval(() => void ask(), REPEAT_MS);
}

async function onAnswer(sdp: string): Promise<void> {
  const peer = pc;
  if (peer?.signalingState !== "have-local-offer") return;
  joinState.value = { kind: "connecting" };
  try {
    await peer.setRemoteDescription({ type: "answer", sdp });
  } catch {
    end("The host's answer did not fit this offer. Reload the page to try again.");
  }
}

/** The host's code, pasted by hand. */
export async function pasteAnswer(code: string): Promise<void> {
  const c = readManualCode(code);
  if (c?.role !== "a") throw new Error("This is not the host's answer code.");
  if (!ch) throw new Error("Join first.");
  const m = await open(ch, c.sealed);
  if (m?.t !== "answer") throw new Error("This code is not for this room, or it is too old.");
  await onAnswer(m.sdp);
}

function stopAsking(): void {
  if (timer) clearInterval(timer);
  timer = null;
  relays?.close();
  relays = null;
}

function end(message: string): void {
  leave(false);
  joinState.value = { kind: "ended", message };
}

export function leave(reset = true): void {
  stopAsking();
  pc?.close();
  pc = null;
  ch = null;
  joinCode.value = null;
  if (reset) joinState.value = { kind: "idle" };
}
