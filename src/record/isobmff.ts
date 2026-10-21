/**
 * Metadata hygiene for MP4: the muxer stamps the wall-clock time into the
 * movie, track and media headers. The init segment is held back until the
 * whole `moov` box has passed, those times are zeroed, and everything after
 * flows through untouched (fragmented MP4 never rewrites earlier bytes).
 */

const MAX_HOLD = 4 * 1024 * 1024;

function type(b: Uint8Array, at: number): string {
  return String.fromCharCode(
    b[at + 4] as number,
    b[at + 5] as number,
    b[at + 6] as number,
    b[at + 7] as number,
  );
}

/** Size of the box at `at`, or -1 when its header is not all there. */
function boxSize(b: Uint8Array, at: number, end: number): number {
  if (at + 8 > end) return -1;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = dv.getUint32(at);
  if (size === 1) {
    if (at + 16 > end) return -1;
    return Number(dv.getBigUint64(at + 8));
  }
  if (size === 0) return end - at;
  return size;
}

/** Zeroes creation/modification times of mvhd, tkhd and mdhd inside `moov` (in place). */
export function zeroMoovTimes(b: Uint8Array, start: number, end: number): number {
  let zeroed = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const walk = (from: number, to: number) => {
    let at = from;
    while (at + 8 <= to) {
      const size = boxSize(b, at, to);
      if (size < 8 || at + size > to) return;
      const t = type(b, at);
      const header = dv.getUint32(at) === 1 ? 16 : 8;
      if (t === "trak" || t === "mdia") walk(at + header, at + size);
      else if (t === "mvhd" || t === "tkhd" || t === "mdhd") {
        const body = at + header;
        const version = b[body] as number;
        const n = version === 1 ? 16 : 8;
        if (body + 4 + n <= at + size) {
          b.fill(0, body + 4, body + 4 + n);
          zeroed++;
        }
      }
      at += size;
    }
  };
  walk(start, end);
  return zeroed;
}

export class InitScrubber {
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private done = false;

  /** Returns what can be written now (possibly nothing while the init segment is incomplete). */
  push(data: Uint8Array): Uint8Array[] {
    if (this.done) return [data];
    this.held.push(data.slice());
    this.heldBytes += data.length;
    const buf = new Uint8Array(this.heldBytes);
    let o = 0;
    for (const p of this.held) {
      buf.set(p, o);
      o += p.length;
    }
    let at = 0;
    while (at < buf.length) {
      const size = boxSize(buf, at, buf.length);
      if (size < 0 || at + size > buf.length) break;
      if (size < 8) return this.release(buf);
      if (type(buf, at) === "moov") {
        zeroMoovTimes(buf, at + 8, at + size);
        return this.release(buf);
      }
      if (type(buf, at) === "moof" || type(buf, at) === "mdat") return this.release(buf);
      at += size;
    }
    if (this.heldBytes > MAX_HOLD) return this.release(buf);
    return [];
  }

  /** Whatever is still held (a stream that ended before its moov). */
  flush(): Uint8Array[] {
    if (this.done || !this.heldBytes) return [];
    const parts = this.held;
    this.held = [];
    this.done = true;
    return parts;
  }

  private release(buf: Uint8Array): Uint8Array[] {
    this.done = true;
    this.held = [];
    return [buf];
  }
}
