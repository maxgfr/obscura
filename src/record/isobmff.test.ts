import { describe, expect, test } from "bun:test";
import { InitScrubber } from "./isobmff";

function box(t: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(t), 4);
  out.set(body, 8);
  return out;
}

const cat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

/** A full box: version, flags, then creation/modification times filled with 0xAB. */
function timed(t: string, version: 0 | 1): Uint8Array {
  const n = version === 1 ? 16 : 8;
  const body = new Uint8Array(4 + n + 20).fill(0xcd);
  body[0] = version;
  body.fill(0xab, 4, 4 + n);
  return box(t, body);
}

function sample() {
  const ftyp = box("ftyp", new TextEncoder().encode("isom\0\0\0\0"));
  const moov = box(
    "moov",
    cat(
      timed("mvhd", 0),
      box(
        "trak",
        cat(timed("tkhd", 1), box("mdia", cat(timed("mdhd", 0), box("hdlr", new Uint8Array(12))))),
      ),
    ),
  );
  const moof = box("moof", new Uint8Array(32).fill(0xab));
  return { ftyp, moov, moof };
}

describe("InitScrubber", () => {
  test("zeroes every header time in moov and leaves everything else", () => {
    const { ftyp, moov, moof } = sample();
    const s = new InitScrubber();
    const input = cat(ftyp, moov, moof);
    const out = cat(...s.push(input));
    expect(out.length).toBe(input.length);
    const before = [...input];
    const after = [...out];
    // Only the 8 + 16 + 8 time bytes changed, all to zero.
    const changed = after.map((b, i) => (b !== before[i] ? i : -1)).filter((i) => i >= 0);
    expect(changed).toHaveLength(32);
    for (const i of changed) expect(after[i]).toBe(0);
    // The fragment that follows passes untouched.
    expect([...cat(...s.push(moof))]).toEqual([...moof]);
  });

  test("holds bytes until moov is complete, across odd splits", () => {
    const { ftyp, moov, moof } = sample();
    const input = cat(ftyp, moov, moof);
    for (const split of [3, 9, ftyp.length, ftyp.length + 10, ftyp.length + moov.length - 1]) {
      const s = new InitScrubber();
      const first = s.push(input.subarray(0, split));
      expect(first).toEqual([]);
      const out = cat(...s.push(input.subarray(split)));
      expect(out.length).toBe(input.length);
      expect(out.includes(0xab)).toBe(true); // the moof's bytes
      expect(out.subarray(ftyp.length, ftyp.length + moov.length).includes(0xab)).toBe(false);
    }
  });

  test("flush returns held bytes when the stream ends early", () => {
    const s = new InitScrubber();
    const part = new Uint8Array([0, 0, 0, 40, 0x66, 0x74]);
    expect(s.push(part)).toEqual([]);
    expect(cat(...s.flush())).toEqual(part);
  });
});
