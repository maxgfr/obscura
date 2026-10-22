/**
 * Signaling for rooms, with no server of our own: peers find each other
 * through public Nostr relays. Each message is an ephemeral event (relays
 * pass it on and keep nothing), tagged with a topic hashed from the link's
 * secret and sealed with AES-256-GCM under a key derived from that same
 * secret. A relay sees random one-time keys, an opaque topic, timing and
 * the IP addresses that connect to it, never what the messages say.
 * Audio and video then flow peer to peer, never through a relay.
 *
 * Only live.html can open these connections (its CSP allows wss:).
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://nostr.mom",
  "wss://relay.nostr.net",
  "wss://relay.damus.io",
];

/** Ephemeral kind (20000–29999): relays forward it to subscribers and store nothing. */
export const KIND = 25050;
/** Messages older than this, or this far in the future, are dropped (replays, bad clocks). */
export const MAX_SKEW_S = 120;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function isLocalHost(host = location.hostname): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** The relays to use. A local build may point at a test relay with ?relay=ws://…; the site cannot. */
export function relayUrls(): string[] {
  if (isLocalHost()) {
    const over = new URLSearchParams(location.search).getAll("relay");
    if (over.length) return over;
  }
  return RELAYS;
}

// ── Link secrets ──────────────────────────────────────────────────────────

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function newSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export interface Channel {
  /** What relays filter on: a hash of the secret, useless without it. */
  topic: string;
  key: CryptoKey;
}

/** One link secret → its relay topic and its message key (HKDF, separate labels). */
export async function channel(secret: Uint8Array<ArrayBuffer>): Promise<Channel> {
  if (secret.length !== 32) throw new Error("bad room secret");
  const topic = bytesToHex(sha256(concat(enc.encode("obscura/room/topic/v1\0"), secret)));
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("obscura/room/key/v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { topic, key };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** A signaling message, as sealed in an event or in a manual code. */
export interface Message {
  t: "offer" | "answer";
  /** Random per-session id of the sender. */
  from: string;
  /** The recipient, for answers. */
  to?: string;
  sdp: string;
  /** A guest's display name (at most 40 characters). */
  name?: string;
  /** Unix seconds. */
  ts: number;
}

export async function seal(ch: Channel, msg: Message): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(ch.topic) },
    ch.key,
    enc.encode(JSON.stringify(msg)),
  );
  return b64url(concat(iv, new Uint8Array(ct)));
}

/** Opens a sealed message; null when it is not for this channel, malformed or stale. */
export async function open(
  ch: Channel,
  text: string,
  now = Date.now() / 1000,
): Promise<Message | null> {
  try {
    const raw = unb64url(text);
    if (raw.length < 12 + 16 || raw.length > 64_000) return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode(ch.topic) },
      ch.key,
      raw.subarray(12),
    );
    const m = JSON.parse(dec.decode(pt)) as Partial<Message>;
    if (m.t !== "offer" && m.t !== "answer") return null;
    if (typeof m.from !== "string" || !/^[a-z0-9]{8,32}$/.test(m.from)) return null;
    if (m.to !== undefined && (typeof m.to !== "string" || !/^[a-z0-9]{8,32}$/.test(m.to)))
      return null;
    if (typeof m.sdp !== "string" || m.sdp.length > 32_000) return null;
    if (m.name !== undefined && (typeof m.name !== "string" || m.name.length > 40)) return null;
    if (typeof m.ts !== "number" || Math.abs(now - m.ts) > MAX_SKEW_S) return null;
    return m as Message;
  } catch {
    return null;
  }
}

// ── Nostr transport ───────────────────────────────────────────────────────

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function signEvent(
  sk: Uint8Array,
  topic: string,
  content: string,
  now = Date.now(),
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(now / 1000);
  const tags = [["x", topic]];
  const id = bytesToHex(
    sha256(enc.encode(JSON.stringify([0, pubkey, created_at, KIND, tags, content]))),
  );
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return { id, pubkey, created_at, kind: KIND, tags, content, sig };
}

type Listener = (content: string) => void;

/**
 * Connections to every relay at once: a message is published to all of them
 * and read from whichever delivers it first. Reconnects with backoff.
 */
export class Relays {
  private sockets = new Map<string, WebSocket>();
  private topics = new Map<string, Listener>();
  private seen = new Set<string>();
  private sk = schnorr.utils.randomSecretKey();
  private closed = false;
  private retries = new Map<string, number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** The last message per topic, sent again to each relay as it (re)connects. */
  private latest = new Map<string, string>();
  /** Relays currently connected. */
  connected = 0;
  onStatus: ((connected: number, total: number) => void) | null = null;

  constructor(private readonly urls: string[] = relayUrls()) {
    for (const url of urls) this.connect(url);
  }

  get total(): number {
    return this.urls.length;
  }

  private status(): void {
    this.connected = [...this.sockets.values()].filter(
      (s) => s.readyState === WebSocket.OPEN,
    ).length;
    this.onStatus?.(this.connected, this.urls.length);
  }

  private connect(url: string): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      this.retries.set(url, 0);
      for (const topic of this.topics.keys()) this.req(ws, topic);
      for (const frame of this.latest.values()) ws.send(frame);
      this.status();
    };
    ws.onmessage = (m) => this.receive(m.data);
    ws.onclose = () => {
      this.status();
      if (this.closed) return;
      const n = (this.retries.get(url) ?? 0) + 1;
      this.retries.set(url, n);
      const t = setTimeout(
        () => {
          this.timers.delete(t);
          this.connect(url);
        },
        Math.min(30_000, 1000 * 2 ** n),
      );
      this.timers.add(t);
    };
    ws.onerror = () => {};
  }

  private req(ws: WebSocket, topic: string): void {
    const since = Math.floor(Date.now() / 1000) - 10;
    ws.send(JSON.stringify(["REQ", topic.slice(0, 16), { kinds: [KIND], "#x": [topic], since }]));
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || data.length > 100_000) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[0] !== "EVENT") return;
    const ev = msg[2] as Partial<NostrEvent> | undefined;
    if (!ev || ev.kind !== KIND || typeof ev.id !== "string" || typeof ev.content !== "string")
      return;
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > 2000) this.seen.clear();
    const topic = ev.tags?.find((t) => t[0] === "x")?.[1];
    const fn = topic ? this.topics.get(topic) : undefined;
    // Authenticity comes from the sealed content (AES-GCM under the room key), not the
    // relay signature, so the signature is not checked here.
    fn?.(ev.content);
  }

  subscribe(topic: string, fn: Listener): void {
    this.topics.set(topic, fn);
    for (const ws of this.sockets.values())
      if (ws.readyState === WebSocket.OPEN) this.req(ws, topic);
  }

  publish(topic: string, content: string): void {
    const ev = signEvent(this.sk, topic, content);
    this.seen.add(ev.id);
    const frame = JSON.stringify(["EVENT", ev]);
    this.latest.set(topic, frame);
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    this.topics.clear();
    this.status();
  }
}

// ── Manual codes (when no relay gets through) ─────────────────────────────

/** A sealed message to copy by hand: a role letter, then the sealed message. */
export function manualCode(role: "g" | "w" | "a", sealed: string): string {
  return `obscura-${role}.${sealed}`;
}

export function readManualCode(code: string): { role: "g" | "w" | "a"; sealed: string } | null {
  const m = /^obscura-([gwa])\.([A-Za-z0-9_-]+)$/.exec(code.trim().replace(/\s+/g, ""));
  return m ? { role: m[1] as "g" | "w" | "a", sealed: m[2] as string } : null;
}

export function peerId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => (x % 36).toString(36)).join("");
}

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];

/** Public STUN on the site; none locally, where peers reach each other directly. */
export function iceServers(turn?: RTCIceServer | null): RTCIceServer[] {
  const base = isLocalHost() ? [] : ICE_SERVERS;
  return turn ? [...base, turn] : base;
}

/**
 * A data channel both sides open before negotiating (so it needs no signaling
 * of its own): when the other side closes, it closes at once, long before
 * the connection itself would time out.
 */
export function presence(peer: RTCPeerConnection): RTCDataChannel {
  return peer.createDataChannel("presence", { negotiated: true, id: 0 });
}

/** Waits for ICE gathering (non-trickle signaling sends one complete description). */
export function waitForIce(peer: RTCPeerConnection, ms = 4000): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((ok) => {
    const done = () => {
      peer.removeEventListener("icegatheringstatechange", check);
      ok();
    };
    const check = () => peer.iceGatheringState === "complete" && done();
    peer.addEventListener("icegatheringstatechange", check);
    setTimeout(done, ms);
  });
}
