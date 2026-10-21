/**
 * The recording session: the optional passphrase key, the current
 * recording, and the library of recordings kept on this device.
 */
import { signal } from "@preact/signals";
import type { AudioBlock } from "../audio/mixer";
import { DEFAULT_KDF, SALT_LEN } from "../crypto/format";
import { importKey } from "../crypto/kdf";
import type { SealKey } from "../crypto/stream";
import { trustedScriptUrl } from "../security";
import { settings } from "../ui/settings";
import type { Recording } from "./recorder";
import {
  listRecordings,
  persistStorage,
  type Saved,
  type StoredRecording,
  storageEstimate,
} from "./storage";

export type RecState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "recording" | "paused";
      rec: Recording;
      startedAt: number;
      pausedMs: number;
      pausedAt: number | null;
    }
  | { kind: "stopping" };

export const rec = signal<RecState>({ kind: "idle" });
export const lastSaved = signal<Saved | null>(null);
export const recordings = signal<StoredRecording[]>([]);
export const storage = signal<{ usage: number; quota: number } | null>(null);
export const recError = signal<string | null>(null);

/** The session's encryption key; the passphrase itself is never kept. */
export const sealKey = signal<SealKey | null>(null);
export const deriving = signal<number | null>(null);

export async function setPassphrase(passphrase: string): Promise<void> {
  if (!passphrase) {
    sealKey.value = null;
    return;
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const kdf = DEFAULT_KDF;
  deriving.value = 0;
  const worker = new Worker(trustedScriptUrl(__KDF_WORKER_URL__) as string, { type: "module" });
  try {
    const raw = await new Promise<Uint8Array>((ok, fail) => {
      worker.onmessage = (
        e: MessageEvent<{ progress?: number; key?: Uint8Array; error?: string }>,
      ) => {
        if (e.data.progress !== undefined) deriving.value = e.data.progress;
        else if (e.data.key) ok(e.data.key);
        else fail(new Error(e.data.error ?? "key derivation failed"));
      };
      worker.onerror = () => fail(new Error("key derivation failed"));
      worker.postMessage({ passphrase, salt, kdf });
    });
    sealKey.value = { key: await importKey(raw), salt, kdf };
  } finally {
    worker.terminate();
    deriving.value = null;
  }
}

export async function refreshLibrary(): Promise<void> {
  try {
    recordings.value = await listRecordings();
  } catch {
    recordings.value = [];
  }
  storage.value = await storageEstimate();
}

let wakeLock: { release(): Promise<void> } | null = null;

async function holdWake(on: boolean): Promise<void> {
  try {
    if (on) {
      wakeLock =
        (await (
          navigator as {
            wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> };
          }
        ).wakeLock?.request("screen")) ?? null;
    } else {
      await wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

function guard(e: BeforeUnloadEvent): void {
  e.preventDefault();
}

export interface Program {
  canvas: HTMLCanvasElement;
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  clock: () => number;
  tap: (fn: (b: AudioBlock) => void) => Promise<() => void>;
  onFrame: (fn: (() => void) | null) => void;
  size: { width: number; height: number; fps: number };
}

export async function startRecording(p: Program): Promise<void> {
  if (rec.value.kind !== "idle") return;
  rec.value = { kind: "starting" };
  recError.value = null;
  try {
    void persistStorage();
    const { startRecording: start } = await import("./recorder");
    const s = settings.value;
    const r = await start({
      canvas: p.canvas,
      clock: p.clock,
      tap: p.tap,
      onFrame: p.onFrame,
      video: p.video,
      audio: p.audio,
      width: p.size.width,
      height: p.size.height,
      fps: p.size.fps,
      container: s.container,
      quality: s.quality,
      seal: s.encrypt ? sealKey.value : null,
    });
    rec.value = {
      kind: "recording",
      rec: r,
      startedAt: performance.now(),
      pausedMs: 0,
      pausedAt: null,
    };
    window.addEventListener("beforeunload", guard);
    void holdWake(true);
    r.failed.catch(async (err: unknown) => {
      if (rec.value.kind !== "recording" && rec.value.kind !== "paused") return;
      recError.value = `Recording stopped: ${err instanceof Error ? err.message : String(err)}. What was recorded is kept.`;
      await stopRecording();
    });
  } catch (err) {
    rec.value = { kind: "idle" };
    recError.value = err instanceof Error ? err.message : String(err);
  }
}

export function togglePause(): void {
  const s = rec.value;
  if (s.kind === "recording") {
    s.rec.pause();
    rec.value = { ...s, kind: "paused", pausedAt: performance.now() };
  } else if (s.kind === "paused") {
    s.rec.resume();
    rec.value = {
      ...s,
      kind: "recording",
      pausedMs: s.pausedMs + (performance.now() - (s.pausedAt ?? performance.now())),
      pausedAt: null,
    };
  }
}

export async function stopRecording(): Promise<void> {
  const s = rec.value;
  if (s.kind !== "recording" && s.kind !== "paused") return;
  rec.value = { kind: "stopping" };
  try {
    lastSaved.value = await s.rec.stop();
  } catch (err) {
    recError.value = `Could not finish the file: ${err instanceof Error ? err.message : String(err)}. The partial recording is listed under Recordings.`;
  } finally {
    window.removeEventListener("beforeunload", guard);
    void holdWake(false);
    rec.value = { kind: "idle" };
    await refreshLibrary();
  }
}

export function elapsed(s: RecState, now: number): number {
  if (s.kind !== "recording" && s.kind !== "paused") return 0;
  const paused = s.pausedMs + (s.pausedAt !== null ? now - s.pausedAt : 0);
  return Math.max(0, now - s.startedAt - paused);
}
