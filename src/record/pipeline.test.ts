import { describe, expect, test } from "bun:test";
import { importKey } from "../crypto/kdf";
import { concat, openSealed } from "../crypto/stream";
import { recordingName } from "./names";
import { appendOnlyStream, createPipeline } from "./pipeline";
import type { Saved, Sink } from "./storage";
import { classify } from "./storage";

function memory(): Sink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    kind: "memory",
    async write(d) {
      parts.push(d.slice());
    },
    async close(name): Promise<Saved> {
      return { name, size: 0, file: new File([], name), kind: "memory" };
    },
    async abort() {},
    bytes: () => concat(parts),
  };
}

describe("pipeline", () => {
  test("passes bytes through, and rejects writes that are not appends", async () => {
    const sink = memory();
    const p = await createPipeline(sink, { mp4: false, mime: "video/webm", seal: null });
    const w = appendOnlyStream(p).getWriter();
    await w.write({ type: "write", data: new Uint8Array([1, 2]), position: 0 });
    await w.write({ type: "write", data: new Uint8Array([3]), position: 2 });
    await expect(
      w.write({ type: "write", data: new Uint8Array([9]), position: 0 }),
    ).rejects.toThrow(/non-append/);
    expect(sink.bytes()).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("seals with the session key; the CLI-compatible header names the mime", async () => {
    const sink = memory();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
    const kdf = { m: 64, t: 1, p: 1 };
    const p = await createPipeline(sink, {
      mp4: false,
      mime: "video/webm",
      seal: { key, salt, kdf },
    });
    const data = crypto.getRandomValues(new Uint8Array(65536));
    await p.push(data);
    await p.push(data);
    await p.finish();
    const res = await openSealed(sink.bytes(), async (h) => {
      expect(h.salt).toEqual(salt);
      expect(h.kdf).toEqual(kdf);
      return key;
    });
    expect(res.header.mime).toBe("video/webm");
    expect(res.plaintext).toEqual(concat([data, data]));
  });
});

describe("names and listing", () => {
  test("names carry the local time only", () => {
    const d = new Date(2026, 9, 21, 9, 5, 7);
    expect(recordingName(d, "mp4", false)).toBe("obscura-20261021-090507.mp4");
    expect(recordingName(d, "webm", true)).toBe("obscura-20261021-090507.webm.obscura");
  });

  test("a .part without its done marker is an interrupted recording", () => {
    const list = classify([
      "obscura-1.mp4",
      "obscura-2.mp4.part",
      "obscura-3.webm.part",
      "obscura-3.webm.part.done",
    ]);
    expect(list.map((r) => [r.display, r.interrupted])).toEqual([
      ["obscura-3.webm", false],
      ["obscura-2.mp4", true],
      ["obscura-1.mp4", false],
    ]);
  });
});
