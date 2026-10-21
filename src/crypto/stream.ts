/**
 * Streaming AEAD (FORMAT.md): the recording is cut into fixed-size plaintext
 * chunks, each sealed with AES-256-GCM under a nonce made of a random prefix,
 * the chunk counter and a "last chunk" flag. Reordering, dropping or
 * truncating chunks makes opening fail; every chunk is bound to the header.
 */
import {
  chunkNonce,
  DEFAULT_CHUNK_LOG2,
  decodeHeader,
  encodeHeader,
  FormatError,
  type Header,
  type KdfParams,
  NONCE_PREFIX_LEN,
  SALT_LEN,
  TAG_LEN,
} from "./format";

export async function headerAad(header: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", header as BufferSource));
}

export function newHeader(mime: string, kdf: KdfParams, chunkLog2 = DEFAULT_CHUNK_LOG2): Header {
  return {
    kdf,
    salt: crypto.getRandomValues(new Uint8Array(SALT_LEN)),
    noncePrefix: crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_LEN)),
    chunkLog2,
    mime,
  };
}

async function seal(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource },
    key,
    data as BufferSource,
  );
  return new Uint8Array(ct);
}

/**
 * Turns a plaintext byte stream into a sealed one. `push` buffers, and emits
 * a chunk only once more than a chunk's worth is buffered, so the final chunk
 * (flagged last) is never empty unless the whole stream is.
 */
export class Sealer {
  private buf: Uint8Array;
  private fill = 0;
  private counter = 0;
  private headerOut: Uint8Array | null;
  private readonly size: number;
  private finished = false;

  private constructor(
    private readonly key: CryptoKey,
    private readonly header: Header,
    headerBytes: Uint8Array,
    private readonly aad: Uint8Array,
    private readonly emit: (bytes: Uint8Array) => Promise<void>,
  ) {
    this.size = 1 << header.chunkLog2;
    this.buf = new Uint8Array(this.size * 2);
    this.headerOut = headerBytes;
  }

  static async create(
    key: CryptoKey,
    header: Header,
    emit: (bytes: Uint8Array) => Promise<void>,
  ): Promise<Sealer> {
    const bytes = encodeHeader(header);
    return new Sealer(key, header, bytes, await headerAad(bytes), emit);
  }

  private async flushHeader(): Promise<void> {
    if (!this.headerOut) return;
    const h = this.headerOut;
    this.headerOut = null;
    await this.emit(h);
  }

  async push(data: Uint8Array): Promise<void> {
    if (this.finished) throw new Error("sealer finished");
    await this.flushHeader();
    let off = 0;
    while (off < data.length) {
      const n = Math.min(this.buf.length - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
      // Strictly more than a chunk buffered: the first chunk is not the last.
      while (this.fill > this.size) {
        const nonce = chunkNonce(this.header.noncePrefix, this.counter++, false);
        await this.emit(await seal(this.key, nonce, this.aad, this.buf.subarray(0, this.size)));
        this.buf.copyWithin(0, this.size, this.fill);
        this.fill -= this.size;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.flushHeader();
    const nonce = chunkNonce(this.header.noncePrefix, this.counter++, true);
    await this.emit(await seal(this.key, nonce, this.aad, this.buf.subarray(0, this.fill)));
    this.buf.fill(0);
  }
}

export interface OpenResult {
  header: Header;
  plaintext: Uint8Array;
  /** False when the stream ended before its last chunk (only with `partial`). */
  complete: boolean;
}

/**
 * Opens a whole sealed file in memory (tests, and small files in the app).
 * With `partial`, a stream cut at a chunk boundary (a crash) yields what was
 * authenticated so far instead of failing.
 */
export async function openSealed(
  bytes: Uint8Array,
  keyFor: (header: Header) => Promise<CryptoKey>,
  opts: { partial?: boolean } = {},
): Promise<OpenResult> {
  const { header, length } = decodeHeader(bytes);
  const aad = await headerAad(bytes.subarray(0, length));
  const key = await keyFor(header);
  const size = 1 << header.chunkLog2;
  const sealed = size + TAG_LEN;
  const parts: Uint8Array[] = [];
  let off = length;
  let counter = 0;
  for (;;) {
    const rest = bytes.length - off;
    if (rest === 0) {
      if (opts.partial) return { header, plaintext: concat(parts), complete: false };
      throw new FormatError("truncated: the last chunk is missing");
    }
    if (rest < TAG_LEN) {
      if (opts.partial) return { header, plaintext: concat(parts), complete: false };
      throw new FormatError("truncated chunk");
    }
    const last = rest <= sealed;
    const chunk = bytes.subarray(off, off + Math.min(rest, sealed));
    const open = (flag: boolean) => openChunk(key, header.noncePrefix, counter, flag, aad, chunk);
    const pt = await open(last);
    if (!pt && last && chunk.length === sealed) {
      // A full chunk at the very end that only opens as "not last": the stream was cut there.
      const cut = await open(false);
      if (cut) {
        if (opts.partial) return { header, plaintext: concat([...parts, cut]), complete: false };
        throw new FormatError("truncated: the last chunk is missing");
      }
    }
    if (!pt) {
      if (opts.partial && counter > 0) return { header, plaintext: concat(parts), complete: false };
      if (counter === 0) throw new FormatError("wrong passphrase, or not an intact recording");
      throw new FormatError(`chunk ${counter} failed to authenticate (truncated or tampered)`);
    }
    parts.push(pt);
    off += chunk.length;
    counter++;
    if (last) return { header, plaintext: concat(parts), complete: true };
  }
}

async function openChunk(
  key: CryptoKey,
  prefix: Uint8Array,
  counter: number,
  last: boolean,
  aad: Uint8Array,
  chunk: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: chunkNonce(prefix, counter, last) as BufferSource,
        additionalData: aad as BufferSource,
      },
      key,
      chunk as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A key derived from the session passphrase, with the salt and costs that recreate it. */
export interface SealKey {
  key: CryptoKey;
  salt: Uint8Array;
  kdf: KdfParams;
}

/** A header for one recording: the session's salt and costs, a fresh nonce prefix. */
export function headerFor(k: SealKey, mime: string, chunkLog2 = DEFAULT_CHUNK_LOG2): Header {
  return {
    kdf: k.kdf,
    salt: k.salt,
    noncePrefix: crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_LEN)),
    chunkLog2,
    mime,
  };
}
