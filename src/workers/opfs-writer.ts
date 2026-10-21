/**
 * Writes a recording into the origin-private file system as it is made,
 * through a synchronous access handle: bytes land in the file itself (no
 * swap file committed on close), so a crash or a closed tab leaves a
 * playable `.part` file up to the last flush. One file per worker.
 */
export {};

interface SyncHandle {
  write(data: Uint8Array, opts: { at: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
}

interface FileHandleWithSync extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>;
  move?(name: string): Promise<void>;
}

type Msg =
  | { op: "open"; dir: string; name: string }
  | { op: "write"; id: number; data: ArrayBuffer }
  | { op: "close"; id: number; final: string }
  | { op: "abort"; id: number };

const FLUSH_MS = 1000;

let dir: FileSystemDirectoryHandle | null = null;
let file: FileHandleWithSync | null = null;
let handle: SyncHandle | null = null;
let name = "";
let at = 0;
let lastFlush = 0;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    switch (m.op) {
      case "open": {
        const root = await navigator.storage.getDirectory();
        dir = await root.getDirectoryHandle(m.dir, { create: true });
        file = (await dir.getFileHandle(m.name, { create: true })) as FileHandleWithSync;
        handle = await file.createSyncAccessHandle();
        name = m.name;
        at = handle.getSize();
        lastFlush = performance.now();
        post({ op: "opened" });
        break;
      }
      case "write": {
        if (!handle) throw new Error("not open");
        const data = new Uint8Array(m.data);
        let off = 0;
        while (off < data.length) off += handle.write(data.subarray(off), { at: at + off });
        at += data.length;
        if (performance.now() - lastFlush > FLUSH_MS) {
          handle.flush();
          lastFlush = performance.now();
        }
        post({ op: "ack", id: m.id, size: at });
        break;
      }
      case "close": {
        if (!handle || !file || !dir) throw new Error("not open");
        handle.flush();
        handle.close();
        handle = null;
        let finalName = name;
        if (typeof file.move === "function") {
          await file.move(m.final);
          finalName = m.final;
        } else {
          // No rename here: an empty marker says the .part is complete.
          await dir.getFileHandle(`${name}.done`, { create: true });
        }
        post({ op: "closed", id: m.id, name: finalName, size: at });
        break;
      }
      case "abort": {
        handle?.close();
        handle = null;
        if (dir && name) await dir.removeEntry(name).catch(() => {});
        post({ op: "aborted", id: m.id });
        break;
      }
    }
  } catch (err) {
    post({
      op: "error",
      id: "id" in m ? m.id : -1,
      message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
};
