/**
 * Muxer output → (MP4 metadata scrub) → (sealing) → disk. The muxer is
 * configured to only ever append, which is what makes the file playable
 * while it grows, sealable as a stream, and recoverable after a crash: a
 * write anywhere but the end is a bug and fails the recording.
 */
import { headerFor, Sealer, type SealKey } from "../crypto/stream";
import { InitScrubber } from "./isobmff";
import type { Sink } from "./storage";

export interface Pipeline {
  push(data: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  /** Bytes received from the muxer. */
  readonly written: number;
}

export async function createPipeline(
  sink: Sink,
  opts: { mp4: boolean; mime: string; seal: SealKey | null },
): Promise<Pipeline> {
  const scrub = opts.mp4 ? new InitScrubber() : null;
  const sealer = opts.seal
    ? await Sealer.create(opts.seal.key, headerFor(opts.seal, opts.mime), (b) => sink.write(b))
    : null;
  const out = (b: Uint8Array) => (sealer ? sealer.push(b) : sink.write(b));
  let written = 0;
  return {
    get written() {
      return written;
    },
    async push(data) {
      written += data.length;
      for (const part of scrub ? scrub.push(data) : [data]) await out(part);
    },
    async finish() {
      for (const part of scrub?.flush() ?? []) await out(part);
      await sealer?.finish();
    },
  };
}

/** The muxer's target: positioned writes, accepted only at the current end. */
export function appendOnlyStream(
  p: Pipeline,
): WritableStream<{ type: "write"; data: Uint8Array; position: number }> {
  return new WritableStream({
    async write(chunk) {
      if (chunk.position !== p.written)
        throw new Error(`non-append write at ${chunk.position}, end is ${p.written}`);
      await p.push(chunk.data);
    },
  });
}
