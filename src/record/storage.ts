/**
 * Where recordings go. Crash-safe by default: written to disk as they are
 * made, in the origin-private file system (a folder only this site can see,
 * on this device), from which they are saved or downloaded. When the
 * browser has no OPFS (some private modes), they stay in memory until saved.
 * Nothing is ever uploaded.
 *
 * The live site shares its origin (maxgfr.github.io) with other projects, and
 * OPFS belongs to the origin, not the path: every folder obscura keeps lives
 * under its own `obscura/` folder, never at the top where another site's
 * folder of the same name could be.
 */
import { trustedScriptUrl } from "../security";

/** obscura's folder at the top of the origin-private file system. */
export const ROOT = "obscura";
export const DIR = "recordings";
export const PART = ".part";
export const DONE = ".done";

export interface Sink {
  readonly kind: "opfs" | "memory";
  write(data: Uint8Array): Promise<void>;
  /** Commits the file under its final name. */
  close(finalName: string): Promise<Saved>;
  abort(): Promise<void>;
}

export interface Saved {
  name: string;
  size: number;
  /** Disk-backed for OPFS, in memory otherwise. */
  file: File;
  kind: Sink["kind"];
}

type Reply =
  | { op: "opened" }
  | { op: "ack"; id: number; size: number }
  | { op: "closed"; id: number; name: string; size: number }
  | { op: "aborted"; id: number }
  | { op: "error"; id: number; message: string };

class OpfsSink implements Sink {
  readonly kind = "opfs";
  private seq = 0;
  private pending = new Map<number, { ok: (r: Reply) => void; fail: (e: Error) => void }>();
  private broken: Error | null = null;

  private constructor(
    private readonly worker: Worker,
    private readonly mime: string,
  ) {
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const r = e.data;
      if (r.op === "opened") return;
      const p = this.pending.get(r.id);
      if (r.op === "error") {
        this.broken = new Error(r.message);
        if (p) p.fail(this.broken);
        else for (const q of this.pending.values()) q.fail(this.broken);
        if (!p) this.pending.clear();
      } else p?.ok(r);
      this.pending.delete(r.id);
    };
  }

  static async open(name: string, mime: string): Promise<OpfsSink> {
    const worker = new Worker(trustedScriptUrl(__OPFS_WORKER_URL__) as string, { type: "module" });
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("storage worker did not start")), 5000);
      worker.onmessage = (e: MessageEvent<Reply>) => {
        clearTimeout(t);
        if (e.data.op === "opened") ok();
        else fail(new Error(e.data.op === "error" ? e.data.message : "storage failed"));
      };
      worker.onerror = () => fail(new Error("storage worker failed"));
      worker.postMessage({ op: "open", dir: [ROOT, DIR], name });
    }).catch((err) => {
      worker.terminate();
      throw err;
    });
    return new OpfsSink(worker, mime);
  }

  /** `force`: sent even after a write failed (to release or delete the file). */
  private call(
    msg: Record<string, unknown>,
    transfer: Transferable[] = [],
    force = false,
  ): Promise<Reply> {
    if (this.broken && !force) return Promise.reject(this.broken);
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async write(data: Uint8Array): Promise<void> {
    // A private copy: the caller's buffer may be reused, and this one is transferred.
    const copy = data.slice();
    await this.call({ op: "write", data: copy.buffer }, [copy.buffer]);
  }

  async close(finalName: string): Promise<Saved> {
    let r: Reply;
    try {
      r = await this.call({ op: "close", final: finalName });
    } catch (err) {
      // Keep what was written (listed as interrupted), but let go of the file:
      // a handle left open would lock it until the tab closes, even against deleting.
      await this.settle({ op: "release" });
      throw err;
    }
    this.worker.terminate();
    if (r.op !== "closed") throw new Error("storage did not close");
    const dir = await recordingsDir();
    const raw = await (await dir.getFileHandle(r.name)).getFile();
    // The download is named after the final name, even when the browser could not rename.
    const file = new File([raw], finalName, { type: this.mime });
    return { name: r.name, size: r.size, file, kind: "opfs" };
  }

  async abort(): Promise<void> {
    // Even after a failed write (storage full): a cancelled recording is deleted.
    await this.settle({ op: "abort" });
  }

  /** Last message to the worker, answered or not within a few seconds, then the worker goes. */
  private async settle(msg: Record<string, unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((ok) => {
      timer = setTimeout(ok, 5000);
    });
    await Promise.race([this.call(msg, [], true).catch(() => {}), late]);
    clearTimeout(timer);
    this.worker.terminate();
  }
}

class MemorySink implements Sink {
  readonly kind = "memory";
  private parts: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly mime: string) {}

  async write(data: Uint8Array): Promise<void> {
    this.parts.push(data.slice());
    this.size += data.length;
  }

  async close(finalName: string): Promise<Saved> {
    const file = new File(this.parts as BlobPart[], finalName, { type: this.mime });
    this.parts = [];
    return { name: finalName, size: this.size, file, kind: "memory" };
  }

  async abort(): Promise<void> {
    this.parts = [];
  }
}

export function hasOpfs(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

/** OPFS when it works, memory otherwise. `name` is the in-progress (.part) name. */
export async function openSink(name: string, mime: string): Promise<Sink> {
  if (hasOpfs()) {
    try {
      return await OpfsSink.open(name, mime);
    } catch {
      // Private mode, or no sync access handles: keep it in memory.
    }
  }
  return new MemorySink(mime);
}

/** `obscura/<name>` in the origin-private file system. */
export async function appDir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle(ROOT, { create: true });
  return app.getDirectoryHandle(name, { create: true });
}

export function recordingsDir(): Promise<FileSystemDirectoryHandle> {
  return appDir(DIR);
}

type MovableFile = FileSystemFileHandle & {
  move?(to: FileSystemDirectoryHandle, name: string): Promise<void>;
  createWritable?(): Promise<WritableStream>;
};

/** Moves `name` from `from` to `to` (copies then deletes where `move` is missing). */
export async function moveFile(
  from: FileSystemDirectoryHandle,
  to: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const handle = (await from.getFileHandle(name)) as MovableFile;
  if (typeof handle.move === "function") {
    await handle.move(to, name);
    return;
  }
  const copy = (await to.getFileHandle(name, { create: true })) as MovableFile;
  try {
    if (typeof copy.createWritable !== "function") throw new Error("cannot copy");
    await (await handle.getFile()).stream().pipeTo(await copy.createWritable());
  } catch (err) {
    await to.removeEntry(name).catch(() => {});
    throw err;
  }
  await from.removeEntry(name);
}

/**
 * Earlier versions kept their folder at the top of OPFS (`/recordings`). Moves
 * the files `mine` recognises into `obscura/<name>`, then removes the old
 * folder if that left it empty. A file that cannot move now (locked by a tab
 * still recording into it, or no room to copy it) stays, and is retried on
 * the next start.
 */
export async function migrateLegacyDir(
  name: string,
  mine: (file: string) => boolean,
): Promise<void> {
  let root: FileSystemDirectoryHandle;
  let legacy: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
    legacy = await root.getDirectoryHandle(name);
  } catch {
    return; // nothing to migrate
  }
  const target = await appDir(name);
  const taken = new Set<string>();
  for await (const [n] of target as unknown as AsyncIterable<[string, FileSystemHandle]>)
    taken.add(n);
  const names: string[] = [];
  for await (const [n, h] of legacy as unknown as AsyncIterable<[string, FileSystemHandle]>)
    if (h.kind === "file" && mine(n) && !taken.has(n)) names.push(n);
  for (const n of names) await moveFile(legacy, target, n).catch(() => {});
  // Not recursive: only goes if empty, so another site's files there are never touched.
  await root.removeEntry(name).catch(() => {});
}

/**
 * Bookkeeping nobody will use: a done marker whose recording is gone, and an
 * empty file left by a recording that failed to start (older than a minute,
 * as one that has only just started is empty too). Interrupted recordings
 * are never in this list: they are playable, and listed for the user.
 */
export function orphans(
  files: { name: string; size: number; modified: number }[],
  now: number,
): string[] {
  const names = new Set(files.map((f) => f.name));
  return files
    .filter((f) =>
      f.name.endsWith(DONE)
        ? !names.has(f.name.slice(0, -DONE.length))
        : f.size === 0 && now - f.modified > 60_000,
    )
    .map((f) => f.name);
}

let prepared: Promise<void> | null = null;

/** Once per page: brings recordings from the old folder, and drops orphaned bookkeeping. */
function prepare(): Promise<void> {
  prepared ??= (async () => {
    await migrateLegacyDir(DIR, (n) => n.startsWith("obscura-")).catch(() => {});
    const dir = await recordingsDir();
    const files: { name: string; size: number; modified: number }[] = [];
    for await (const [n, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
      if (h.kind !== "file") continue;
      const f = await (h as FileSystemFileHandle).getFile();
      files.push({ name: n, size: f.size, modified: f.lastModified });
    }
    // A file another tab is writing is locked: removing it fails, and it stays.
    for (const n of orphans(files, Date.now())) await dir.removeEntry(n).catch(() => {});
  })().catch(() => {});
  return prepared;
}

export interface StoredRecording {
  name: string;
  size: number;
  modified: number;
  /** A crash or a closed tab cut it short; playable up to its last fragment. */
  interrupted: boolean;
  sealed: boolean;
}

/** Pure part of the listing: which names are finished, interrupted, or bookkeeping. */
export function classify(
  names: string[],
): { name: string; interrupted: boolean; display: string }[] {
  const set = new Set(names);
  return names
    .filter((n) => !n.endsWith(DONE))
    .map((n) => {
      const part = n.endsWith(PART);
      const done = part && set.has(`${n}${DONE}`);
      return {
        name: n,
        interrupted: part && !done,
        display: part ? n.slice(0, -PART.length) : n,
      };
    })
    .sort((a, b) => b.display.localeCompare(a.display));
}

export async function listRecordings(): Promise<StoredRecording[]> {
  if (!hasOpfs()) return [];
  await prepare();
  const dir = await recordingsDir();
  const names: string[] = [];
  for await (const [n, h] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>)
    if (h.kind === "file") names.push(n);
  const out: StoredRecording[] = [];
  for (const c of classify(names)) {
    const f = await (await dir.getFileHandle(c.name)).getFile();
    out.push({
      name: c.name,
      size: f.size,
      modified: f.lastModified,
      interrupted: c.interrupted,
      sealed: c.display.endsWith(".obscura"),
    });
  }
  return out;
}

export async function readRecording(name: string): Promise<File> {
  const dir = await recordingsDir();
  const raw = await (await dir.getFileHandle(name)).getFile();
  const display = name.endsWith(PART) ? name.slice(0, -PART.length) : name;
  return new File([raw], display, { type: mimeOf(display) });
}

export async function deleteRecording(name: string): Promise<void> {
  const dir = await recordingsDir();
  await dir.removeEntry(name);
  await dir.removeEntry(`${name}${DONE}`).catch(() => {});
}

export function mimeOf(name: string): string {
  if (name.endsWith(".obscura")) return "application/octet-stream";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}

/** Asks the browser not to evict recordings under storage pressure. */
export async function persistStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

/** Saves a file where the user picks (streamed disk to disk), else downloads it. */
export async function saveFile(file: File): Promise<"saved" | "downloaded" | "cancelled"> {
  const picker = (
    window as {
      showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({ suggestedName: file.name });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      return download(file);
    }
    const writable = await (
      handle as FileSystemFileHandle & { createWritable(): Promise<WritableStream> }
    ).createWritable();
    await file.stream().pipeTo(writable);
    return "saved";
  }
  return download(file);
}

function download(file: File): "downloaded" {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
