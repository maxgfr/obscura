/**
 * Live with friends: the host opens a room and shares two links. A guest
 * link puts the friend on screen (their camera and microphone come in as a
 * guest source, and the scene splits into tiles); a viewer link only
 * watches the program. Each link carries its own secret in the #fragment,
 * so a viewer cannot join as a guest, and guests wait for the host to let
 * them in. Joiners make the offer; the host answers through the relays
 * (signal.ts) or, when no relay gets through, by codes copied by hand.
 */
import type { Engine } from "../studio/engine";
import { MAX_GUESTS, MAX_VIEWERS, type Peer, peers, type Role, room } from "./room-state";
import {
  b64url,
  type Channel,
  channel,
  iceServers,
  isLocalHost,
  type Message,
  manualCode,
  newSecret,
  open,
  peerId,
  presence,
  Relays,
  readManualCode,
  seal,
  waitForIce,
} from "./signal";

interface Session {
  peer: Peer;
  offer: Message;
  pc: RTCPeerConnection | null;
  source: string | null;
}

let relays: Relays | null = null;
let guestCh: Channel | null = null;
let viewerCh: Channel | null = null;
let host: Engine | null = null;
let turn: RTCIceServer | null = null;
const sessions = new Map<string, Session>();

function publish(): void {
  peers.value = [...sessions.values()].map((s) => ({ ...s.peer }));
}

/** Builds a join link for this page, keeping a local test relay when there is one. */
export function joinLink(role: Role, secret: Uint8Array): string {
  const u = new URL("live.html", location.href);
  u.search = "";
  if (isLocalHost())
    for (const r of new URLSearchParams(location.search).getAll("relay"))
      u.searchParams.append("relay", r);
  u.hash = `${role === "guest" ? "join" : "watch"}=${b64url(secret)}`;
  return u.href;
}

export async function startRoom(
  engine: Engine,
  turnServer: RTCIceServer | null = null,
): Promise<void> {
  if (room.value.kind !== "off") return;
  room.value = { kind: "starting" };
  host = engine;
  turn = turnServer;
  const gs = newSecret();
  const vs = newSecret();
  [guestCh, viewerCh] = await Promise.all([channel(gs), channel(vs)]);
  const r = new Relays();
  relays = r;
  const guestLink = joinLink("guest", gs);
  const viewerLink = joinLink("viewer", vs);
  gs.fill(0);
  vs.fill(0);
  const show = (relaysUp: number, total: number) => {
    if (relays === r) room.value = { kind: "on", guestLink, viewerLink, relays: relaysUp, total };
  };
  r.onStatus = show;
  show(0, r.total);
  const g = guestCh;
  const v = viewerCh;
  window.addEventListener("pagehide", stopRoom);
  r.subscribe(g.topic, (c) => void open(g, c).then((m) => m && onOffer(m, "guest", false)));
  r.subscribe(v.topic, (c) => void open(v, c).then((m) => m && onOffer(m, "viewer", false)));
}

export function stopRoom(): void {
  window.removeEventListener("pagehide", stopRoom);
  for (const id of [...sessions.keys()]) drop(id);
  relays?.close();
  relays = null;
  guestCh = viewerCh = null;
  host = null;
  turn = null;
  room.value = { kind: "off" };
}

function count(role: Role): number {
  return [...sessions.values()].filter((s) => s.peer.role === role).length;
}

/** An offer from a joiner. Guests wait for the host; viewers are let in while there is room. */
function onOffer(m: Message, role: Role, manual: boolean): Promise<string | null> | null {
  if (m.t !== "offer" || m.to) return null;
  const known = sessions.get(m.from);
  if (known) {
    // Joiners repeat their offer until answered; answer again if the answer was lost.
    if (known.pc && !manual) void answer(known);
    return null;
  }
  if (count(role) >= (role === "guest" ? MAX_GUESTS : MAX_VIEWERS)) return null;
  const name = role === "guest" ? (m.name ?? "").trim().slice(0, 40) || "Guest" : "Viewer";
  const s: Session = {
    peer: { id: m.from, role, name, state: "asking", manual },
    offer: m,
    pc: null,
    source: null,
  };
  sessions.set(m.from, s);
  publish();
  // A pasted code is the host letting them in; viewers need no approval.
  if (manual || role === "viewer") return accept(m.from);
  return null;
}

/** Lets a waiting guest in (or a viewer). Returns the sealed answer. */
export async function accept(id: string): Promise<string | null> {
  const s = sessions.get(id);
  const en = host;
  if (!s || s.pc || !en) return null;
  s.peer.state = "connecting";
  publish();
  const pc = new RTCPeerConnection({ iceServers: iceServers(turn), bundlePolicy: "max-bundle" });
  s.pc = pc;
  const received: MediaStreamTrack[] = [];
  const dc = presence(pc);
  dc.onclose = () => {
    if (sessions.get(id) === s) drop(id);
  };
  pc.ontrack = (e) => received.push(e.track);
  pc.onconnectionstatechange = () => {
    if (sessions.get(id) !== s) return;
    if (pc.connectionState === "connected" && s.peer.state !== "connected") {
      s.peer.state = "connected";
      publish();
      if (s.source && received.length)
        void en.attachGuest(s.source, new MediaStream(received), s.peer.name).catch(() => drop(id));
    }
    if (pc.connectionState === "failed" || pc.connectionState === "closed") drop(id);
    if (pc.connectionState === "disconnected")
      setTimeout(() => {
        if (sessions.get(id) === s && pc.connectionState === "disconnected") drop(id);
      }, 8000);
  };
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: s.offer.sdp });
    const video = en.videoTrack;
    // Guests get a place on screen, and hear everyone but themselves; viewers hear the program.
    if (s.peer.role === "guest") s.source = en.reserveGuest();
    const audio = s.source ? en.mixer.minusTrack(s.source) : en.mixer.track;
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      await t.sender.replaceTrack(kind === "video" ? video : audio);
      t.direction = s.peer.role === "guest" ? "sendrecv" : "sendonly";
    }
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState !== "connected") return;
      // Text on a shared screen stays sharp: lower the frame rate before the resolution.
      for (const t of pc.getTransceivers()) {
        if (t.sender.track?.kind !== "video") continue;
        const p = t.sender.getParameters();
        void t.sender
          .setParameters({
            ...p,
            degradationPreference: "maintain-resolution",
          } as RTCRtpSendParameters)
          .catch(() => {});
      }
    });
    return await answer(s);
  } catch {
    drop(id);
    return null;
  }
}

async function answer(s: Session): Promise<string | null> {
  const pc = s.pc;
  const ch = s.peer.role === "guest" ? guestCh : viewerCh;
  if (!pc || !ch) return null;
  if (pc.signalingState === "have-remote-offer") {
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) return null;
  const sealed = await seal(ch, {
    t: "answer",
    from: hostId,
    to: s.peer.id,
    sdp,
    ts: Math.floor(Date.now() / 1000),
  });
  if (!s.peer.manual) relays?.publish(ch.topic, sealed);
  return manualCode("a", sealed);
}

const hostId = peerId();

/** Removes a peer: a guest leaves the screen, a viewer stops receiving. */
export function drop(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.pc?.close();
  if (s.source) {
    host?.mixer.dropMinus(s.source);
    host?.removeGuest(s.source);
  }
  publish();
}

/** The host pastes a joiner's code (no relay got through); returns the code to send back. */
export async function answerCode(code: string): Promise<string> {
  const c = readManualCode(code);
  if (!c || c.role === "a") throw new Error("This is not a join code.");
  const role: Role = c.role === "g" ? "guest" : "viewer";
  const ch = role === "guest" ? guestCh : viewerCh;
  if (!ch) throw new Error("Start the room first.");
  const m = await open(ch, c.sealed);
  if (!m) throw new Error("This code is not for this room, or it is too old.");
  const known = sessions.get(m.from);
  if (known) drop(m.from);
  const sealed = await onOffer(m, role, true);
  if (!sealed)
    throw new Error(`The room is full (${role === "guest" ? MAX_GUESTS : MAX_VIEWERS} ${role}s).`);
  return sealed;
}
