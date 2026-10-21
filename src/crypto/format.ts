/**
 * The sealed recording header (FORMAT.md). Everything a reader needs to
 * derive the key and open the chunks, and nothing else: no device, no time,
 * no name. The CLI parses the same bytes (cli/src/seal.rs).
 */

export const MAGIC = "OBSCURA1";
export const KDF_ARGON2ID = 1;
export const NONCE_PREFIX_LEN = 7;
export const SALT_LEN = 16;
export const TAG_LEN = 16;
export const DEFAULT_CHUNK_LOG2 = 16;

export interface KdfParams {
  /** Memory cost, KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Lanes. */
  p: number;
}

/** 64 MiB, 3 passes, 1 lane: about a second in a browser worker. */
export const DEFAULT_KDF: KdfParams = { m: 64 * 1024, t: 3, p: 1 };

/** Bounds a reader accepts, so a forged header cannot make it allocate gigabytes or spin forever. */
export const KDF_LIMITS = { mMin: 8, mMax: 1024 * 1024, tMin: 1, tMax: 16, pMin: 1, pMax: 8 };
const CHUNK_LOG2_MIN = 10;
const CHUNK_LOG2_MAX = 24;
const MIME_MAX = 255;

export interface Header {
  kdf: KdfParams;
  salt: Uint8Array;
  noncePrefix: Uint8Array;
  chunkLog2: number;
  mime: string;
}

export class FormatError extends Error {
  override name = "FormatError";
}

const enc = new TextEncoder();

export function encodeHeader(h: Header): Uint8Array {
  const mime = enc.encode(h.mime);
  if (mime.length > MIME_MAX) throw new FormatError("mime too long");
  if (h.salt.length !== SALT_LEN) throw new FormatError("bad salt length");
  if (h.noncePrefix.length !== NONCE_PREFIX_LEN) throw new FormatError("bad nonce prefix length");
  checkParams(h.kdf, h.chunkLog2);
  const out = new Uint8Array(44 + mime.length);
  const dv = new DataView(out.buffer);
  out.set(enc.encode(MAGIC), 0);
  out[8] = KDF_ARGON2ID;
  dv.setUint32(9, h.kdf.m);
  dv.setUint32(13, h.kdf.t);
  out[17] = h.kdf.p;
  out.set(h.salt, 18);
  out.set(h.noncePrefix, 34);
  out[41] = h.chunkLog2;
  dv.setUint16(42, mime.length);
  out.set(mime, 44);
  return out;
}

/** Parses a header from the start of `bytes`; returns it with its encoded length. */
export function decodeHeader(bytes: Uint8Array): { header: Header; length: number } {
  if (bytes.length < 44) throw new FormatError("not a sealed recording (too short)");
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC)
    throw new FormatError("not a sealed recording (bad magic)");
  if (bytes[8] !== KDF_ARGON2ID) throw new FormatError(`unknown key derivation ${bytes[8]}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kdf = { m: dv.getUint32(9), t: dv.getUint32(13), p: bytes[17] as number };
  const chunkLog2 = bytes[41] as number;
  checkParams(kdf, chunkLog2);
  const mimeLen = dv.getUint16(42);
  if (mimeLen > MIME_MAX) throw new FormatError("mime too long");
  if (bytes.length < 44 + mimeLen) throw new FormatError("truncated header");
  const mime = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(44, 44 + mimeLen));
  return {
    header: {
      kdf,
      salt: bytes.slice(18, 34),
      noncePrefix: bytes.slice(34, 41),
      chunkLog2,
      mime,
    },
    length: 44 + mimeLen,
  };
}

function checkParams(k: KdfParams, chunkLog2: number): void {
  const L = KDF_LIMITS;
  if (!Number.isInteger(k.p) || k.p < L.pMin || k.p > L.pMax) throw new FormatError("bad lanes");
  if (!Number.isInteger(k.t) || k.t < L.tMin || k.t > L.tMax)
    throw new FormatError("bad iterations");
  if (!Number.isInteger(k.m) || k.m < Math.max(L.mMin, 8 * k.p) || k.m > L.mMax)
    throw new FormatError("bad memory cost");
  if (!Number.isInteger(chunkLog2) || chunkLog2 < CHUNK_LOG2_MIN || chunkLog2 > CHUNK_LOG2_MAX)
    throw new FormatError("bad chunk size");
}

/** prefix(7) ‖ counter u32 BE ‖ last(1). */
export function chunkNonce(prefix: Uint8Array, counter: number, last: boolean): Uint8Array {
  if (counter > 0xffffffff) throw new FormatError("too many chunks");
  const n = new Uint8Array(12);
  n.set(prefix, 0);
  new DataView(n.buffer).setUint32(7, counter);
  n[11] = last ? 1 : 0;
  return n;
}
