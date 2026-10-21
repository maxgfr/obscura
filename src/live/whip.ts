/**
 * Live streaming over WHIP (RFC 9725): the program's video and audio are
 * sent with WebRTC to an ingest URL the user provides. This is the only
 * code that talks to the network, and it is only reachable from live.html,
 * whose CSP allows https: connections; the recording page does not.
 */
import { signal } from "@preact/signals";

export type LiveState =
  | { kind: "off" }
  | { kind: "connecting" }
  | { kind: "live"; since: number }
  | { kind: "error"; message: string };

export const live = signal<LiveState>({ kind: "off" });

export function isLivePage(): boolean {
  return document.documentElement.dataset.mode === "live";
}

export function checkEndpoint(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Enter a full WHIP URL (https://…).");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:"))
    throw new Error("WHIP endpoints must use https.");
  if (u.username || u.password) throw new Error("Put credentials in the token field, not the URL.");
  return u;
}

/** Prefers H.264 (what most ingests expect), keeping the others as fallbacks. */
export function preferH264<T extends { mimeType: string }>(codecs: T[]): T[] {
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264");
  return [...h264, ...codecs.filter((c) => c.mimeType.toLowerCase() !== "video/h264")];
}

let pc: RTCPeerConnection | null = null;
let resource: string | null = null;
let bearer = "";

function waitForIce(peer: RTCPeerConnection, ms = 3000): Promise<void> {
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

export async function goLive(
  endpoint: string,
  token: string,
  video: MediaStreamTrack,
  audio: MediaStreamTrack | null,
): Promise<void> {
  if (pc) return;
  let url: URL;
  try {
    url = checkEndpoint(endpoint);
  } catch (err) {
    live.value = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }
  live.value = { kind: "connecting" };
  bearer = token;
  const peer = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  pc = peer;
  try {
    const stream = new MediaStream(audio ? [video, audio] : [video]);
    const vt = peer.addTransceiver(video, { direction: "sendonly", streams: [stream] });
    if (audio) peer.addTransceiver(audio, { direction: "sendonly", streams: [stream] });
    const caps = RTCRtpSender.getCapabilities?.("video");
    if (caps && "setCodecPreferences" in vt) vt.setCodecPreferences(preferH264(caps.codecs));
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIce(peer);
    const offer = peer.localDescription?.sdp;
    if (!offer) throw new Error("could not create an offer");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/sdp",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: offer,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (res.status !== 201 && res.status !== 200)
      throw new Error(`the ingest answered ${res.status} ${res.statusText}`.trim());
    const loc = res.headers.get("location");
    resource = loc ? new URL(loc, url).href : null;
    await peer.setRemoteDescription({ type: "answer", sdp: await res.text() });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "connected" && live.value.kind === "connecting")
        live.value = { kind: "live", since: performance.now() };
      if (peer.connectionState === "failed") {
        live.value = { kind: "error", message: "The connection to the ingest failed." };
        void stopLive(false);
      }
    });
  } catch (err) {
    await stopLive(false);
    live.value = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function stopLive(resetState = true): Promise<void> {
  const peer = pc;
  pc = null;
  peer?.close();
  const res = resource;
  resource = null;
  if (res) {
    // WHIP: deleting the session resource ends the stream on the server side.
    await fetch(res, {
      method: "DELETE",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  }
  bearer = "";
  if (resetState) live.value = { kind: "off" };
}
