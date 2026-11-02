import { afterEach, describe, expect, test } from "bun:test";
import { appDir, migrateLegacyDir, moveFile, orphans } from "./storage";

/** Just enough of OPFS for the migration: folders, files, move, remove. */
class FakeFile {
  readonly kind = "file";
  constructor(
    public parent: FakeDir,
    public name: string,
    public data: Uint8Array,
    movable: boolean,
  ) {
    if (!movable) this.move = undefined;
  }
  async getFile(): Promise<File> {
    return new File([this.data as BlobPart], this.name);
  }
  move: ((to: FakeDir, name: string) => Promise<void>) | undefined = async (to, name) => {
    this.parent.entries.delete(this.name);
    to.entries.set(name, this);
    this.parent = to;
    this.name = name;
  };
  async createWritable(): Promise<WritableStream<Uint8Array>> {
    const chunks: Uint8Array[] = [];
    return new WritableStream({
      write: (c) => {
        chunks.push(c);
      },
      close: () => {
        this.data = new Uint8Array(Buffer.concat(chunks));
      },
    });
  }
}

class FakeDir {
  readonly kind = "directory";
  entries = new Map<string, FakeDir | FakeFile>();
  constructor(private readonly movable = true) {}
  async getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    const e = this.entries.get(name);
    if (e instanceof FakeDir) return e;
    if (e || !o.create) throw new DOMException(name, "NotFoundError");
    const d = new FakeDir(this.movable);
    this.entries.set(name, d);
    return d;
  }
  async getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    const e = this.entries.get(name);
    if (e instanceof FakeFile) return e;
    if (e || !o.create) throw new DOMException(name, "NotFoundError");
    const f = new FakeFile(this, name, new Uint8Array(), this.movable);
    this.entries.set(name, f);
    return f;
  }
  async removeEntry(name: string, o: { recursive?: boolean } = {}): Promise<void> {
    const e = this.entries.get(name);
    if (!e) throw new DOMException(name, "NotFoundError");
    if (e instanceof FakeDir && e.entries.size && !o.recursive)
      throw new DOMException(name, "InvalidModificationError");
    this.entries.delete(name);
  }
  file(name: string, text: string): this {
    this.entries.set(name, new FakeFile(this, name, new TextEncoder().encode(text), this.movable));
    return this;
  }
  names(): string[] {
    return [...this.entries.keys()].sort();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<[string, FakeDir | FakeFile]> {
    yield* [...this.entries];
  }
}

function useRoot(root: FakeDir): void {
  Object.defineProperty(navigator, "storage", {
    value: { getDirectory: async () => root },
    configurable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "storage");
});

describe("OPFS folders on a shared origin", () => {
  test("obscura's folders live under obscura/", async () => {
    const root = new FakeDir();
    useRoot(root);
    await appDir("recordings");
    expect(root.names()).toEqual(["obscura"]);
    expect((await root.getDirectoryHandle("obscura")).names()).toEqual(["recordings"]);
  });

  test("moves obscura's recordings out of the old top-level folder, and leaves the rest", async () => {
    const root = new FakeDir();
    const legacy = await root.getDirectoryHandle("recordings", { create: true });
    legacy
      .file("obscura-1.mp4", "one")
      .file("obscura-2.mp4.part", "two")
      .file("obscura-2.mp4.part.done", "")
      .file("someone-else.wav", "not ours");
    useRoot(root);

    await migrateLegacyDir("recordings", (n) => n.startsWith("obscura-"));

    const moved = await (await root.getDirectoryHandle("obscura")).getDirectoryHandle("recordings");
    expect(moved.names()).toEqual([
      "obscura-1.mp4",
      "obscura-2.mp4.part",
      "obscura-2.mp4.part.done",
    ]);
    expect(await (await (await moved.getFileHandle("obscura-1.mp4")).getFile()).text()).toBe("one");
    // Another site's file stays where it was, and so does its folder.
    expect(legacy.names()).toEqual(["someone-else.wav"]);
    expect(root.names()).toEqual(["obscura", "recordings"]);
  });

  test("removes the old folder once empty, and is a no-op the second time", async () => {
    const root = new FakeDir();
    (await root.getDirectoryHandle("recordings", { create: true })).file("obscura-1.webm", "x");
    useRoot(root);

    await migrateLegacyDir("recordings", (n) => n.startsWith("obscura-"));
    await migrateLegacyDir("recordings", (n) => n.startsWith("obscura-"));

    expect(root.names()).toEqual(["obscura"]);
  });

  test("never overwrites a file already in the new folder", async () => {
    const root = new FakeDir();
    (await root.getDirectoryHandle("recordings", { create: true })).file("obscura-1.mp4", "old");
    useRoot(root);
    (
      await (
        await root.getDirectoryHandle("obscura", { create: true })
      ).getDirectoryHandle("recordings", { create: true })
    ).file("obscura-1.mp4", "new");

    await migrateLegacyDir("recordings", (n) => n.startsWith("obscura-"));

    const kept = await (await appDir("recordings")).getFileHandle("obscura-1.mp4");
    expect(await (await kept.getFile()).text()).toBe("new");
    expect((await root.getDirectoryHandle("recordings")).names()).toEqual(["obscura-1.mp4"]);
  });

  test("copies then deletes where the browser cannot move", async () => {
    const root = new FakeDir(false);
    const from = (await root.getDirectoryHandle("a", { create: true })).file("f", "bytes");
    const to = await root.getDirectoryHandle("b", { create: true });

    await moveFile(from as unknown as FileSystemDirectoryHandle, to as never, "f");

    expect(from.names()).toEqual([]);
    expect(await (await (await to.getFileHandle("f")).getFile()).text()).toBe("bytes");
  });
});

describe("orphaned bookkeeping", () => {
  const now = 10 * 60_000;
  const old = now - 5 * 60_000;

  test("drops done markers without their recording, and old empty files", () => {
    expect(
      orphans(
        [
          { name: "obscura-1.mp4.part.done", size: 0, modified: old },
          { name: "obscura-2.mp4.part", size: 0, modified: old },
          { name: "obscura-3.mp4.part", size: 0, modified: now - 1000 },
          { name: "obscura-4.mp4.part", size: 4096, modified: old },
          { name: "obscura-5.webm.part", size: 10, modified: old },
          { name: "obscura-5.webm.part.done", size: 0, modified: old },
        ],
        now,
      ),
    ).toEqual(["obscura-1.mp4.part.done", "obscura-2.mp4.part"]);
  });

  test("never drops an interrupted recording: it is playable", () => {
    expect(orphans([{ name: "obscura-4.mp4.part", size: 1, modified: 0 }], now)).toEqual([]);
  });
});
