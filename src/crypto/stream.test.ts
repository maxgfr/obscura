import { describe, expect, test } from "bun:test";
import { decodeHeader, encodeHeader, FormatError, type Header } from "./format";
import { deriveKeyBytes, importKey } from "./kdf";
import { concat, newHeader, openSealed, Sealer } from "./stream";

const FAST = { m: 64, t: 1, p: 1 };

async function key(): Promise<CryptoKey> {
  return importKey(crypto.getRandomValues(new Uint8Array(32)));
}

async function sealAll(
  k: CryptoKey,
  header: Header,
  pieces: Uint8Array[],
): Promise<{ bytes: Uint8Array; writes: Uint8Array[] }> {
  const writes: Uint8Array[] = [];
  const s = await Sealer.create(k, header, async (b) => {
    writes.push(b);
  });
  for (const p of pieces) await s.push(p);
  await s.finish();
  return { bytes: concat(writes), writes };
}

const random = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
};

describe("header", () => {
  test("round-trips", () => {
    const h = newHeader("video/mp4", FAST, 10);
    const bytes = encodeHeader(h);
    const { header, length } = decodeHeader(bytes);
    expect(length).toBe(bytes.length);
    expect(header).toEqual(h);
  });

  test("rejects bad magic, unknown kdf and out-of-bounds parameters", () => {
    const bytes = encodeHeader(newHeader("video/webm", FAST, 10));
    const bad = (mutate: (b: Uint8Array) => void) => {
      const b = bytes.slice();
      mutate(b);
      return () => decodeHeader(b);
    };
    expect(bad((b) => (b[0] = 0x41))).toThrow(/magic/);
    expect(bad((b) => (b[8] = 2))).toThrow(/key derivation/);
    expect(bad((b) => new DataView(b.buffer).setUint32(9, 0xffffffff))).toThrow(/memory/);
    expect(bad((b) => new DataView(b.buffer).setUint32(13, 1000))).toThrow(/iterations/);
    expect(bad((b) => (b[41] = 40))).toThrow(/chunk size/);
    expect(() => decodeHeader(bytes.subarray(0, 20))).toThrow(FormatError);
  });
});

describe("sealed stream", () => {
  for (const size of [0, 1, 1023, 1024, 1025, 4096, 10_000]) {
    test(`round-trips ${size} bytes in 1 KiB chunks`, async () => {
      const k = await key();
      const data = random(size);
      // Uneven pushes, to cross chunk boundaries at odd offsets.
      const pieces = [];
      for (let o = 0; o < size; o += 333) pieces.push(data.subarray(o, o + 333));
      const { bytes } = await sealAll(k, newHeader("video/mp4", FAST, 10), pieces);
      const res = await openSealed(bytes, async () => k);
      expect(res.complete).toBe(true);
      expect(res.plaintext).toEqual(data);
      expect(res.header.mime).toBe("video/mp4");
    });
  }

  test("the last chunk is never empty unless the stream is", async () => {
    const k = await key();
    const { writes } = await sealAll(k, newHeader("video/mp4", FAST, 10), [random(2048)]);
    // header, chunk 0 (full), chunk 1 (full, last).
    expect(writes.map((w) => w.length).slice(1)).toEqual([1040, 1040]);
  });

  test("a wrong key fails on the first chunk", async () => {
    const { bytes } = await sealAll(await key(), newHeader("video/mp4", FAST, 10), [random(50)]);
    const other = await key();
    await expect(openSealed(bytes, async () => other)).rejects.toThrow(/wrong passphrase/);
  });

  test("tampering anywhere is detected", async () => {
    const k = await key();
    const h = newHeader("video/mp4", FAST, 10);
    const { bytes } = await sealAll(k, h, [random(3000)]);
    for (const at of [20, 50, 60 + 1040, bytes.length - 1]) {
      const b = bytes.slice();
      b[at] = (b[at] as number) ^ 1;
      await expect(openSealed(b, async () => k)).rejects.toThrow();
    }
  });

  test("truncation at a chunk boundary is detected, and recoverable with partial", async () => {
    const k = await key();
    const h = newHeader("video/webm", FAST, 10);
    const data = random(5000);
    const { bytes, writes } = await sealAll(k, h, [data]);
    const headerLen = (writes[0] as Uint8Array).length;
    const cut = bytes.subarray(0, headerLen + 2 * 1040);
    await expect(openSealed(cut, async () => k)).rejects.toThrow(/truncated/);
    const res = await openSealed(cut, async () => k, { partial: true });
    expect(res.complete).toBe(false);
    expect(res.plaintext).toEqual(data.subarray(0, 2048));
    // Cut mid-chunk: everything up to the last whole chunk.
    const mid = bytes.subarray(0, headerLen + 2 * 1040 + 100);
    const res2 = await openSealed(mid, async () => k, { partial: true });
    expect(res2.plaintext).toEqual(data.subarray(0, 2048));
  });

  test("dropping or swapping chunks fails", async () => {
    const k = await key();
    const h = newHeader("video/mp4", FAST, 10);
    const { writes } = await sealAll(k, h, [random(4000)]);
    const [head, c0, c1, ...rest] = writes as [Uint8Array, Uint8Array, Uint8Array];
    await expect(openSealed(concat([head, c1, c0, ...rest]), async () => k)).rejects.toThrow();
    await expect(openSealed(concat([head, c1, ...rest]), async () => k)).rejects.toThrow();
  });
});

describe("kdf", () => {
  test("argon2id is deterministic for a passphrase and salt", async () => {
    const salt = new Uint8Array(16).fill(7);
    const a = await deriveKeyBytes("correct horse", salt, FAST);
    const b = await deriveKeyBytes("correct horse", salt, FAST);
    const c = await deriveKeyBytes("correct horse!", salt, FAST);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(32);
  });
});
