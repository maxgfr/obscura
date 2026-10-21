/**
 * Where recordings go. Crash-safe by default: written to disk as they are
 * made, in the origin-private file system (a folder only this site can see,
 * on this device), from which they are saved or downloaded. When the
 * browser has no OPFS (some private modes), they stay in memory until saved.
 * Nothing is ever uploaded.
 */
import { trustedScriptUrl } from "../security";

export const DIR = "recordings";
export const PART = ".part";

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
      worker.postMessage({ op: "open", dir: DIR, name });
    }).catch((err) => {
      worker.terminate();
      throw err;
    });
    return new OpfsSink(worker, mime);
  }

  private call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
    if (this.broken) return Promise.reject(this.broken);
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
    const r = await this.call({ op: "close", final: finalName });
    this.worker.terminate();
    if (r.op !== "closed") throw new Error("storage did not close");
    const dir = await recordingsDir();
    const raw = await (await dir.getFileHandle(r.name)).getFile();
    // The download is named after the final name, even when the browser could not rename.
    const file = new File([raw], finalName, { type: this.mime });
    return { name: r.name, size: r.size, file, kind: "opfs" };
  }

  async abort(): Promise<void> {
    await this.call({ op: "abort" }).catch(() => {});
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

export async function recordingsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
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
    .filter((n) => !n.endsWith(".done"))
    .map((n) => {
      const part = n.endsWith(PART);
      const done = part && set.has(`${n}.done`);
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
  await dir.removeEntry(`${name}.done`).catch(() => {});
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
