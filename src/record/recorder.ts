/**
 * Encodes the program with WebCodecs through Mediabunny: hardware H.264 when
 * the browser has it, else VP9/AV1, in fragmented MP4 or append-only WebM.
 * Video frames are taken from the canvas right after each render and audio
 * blocks from the mixer's tap, both stamped with the audio clock, so they
 * stay in sync and keep coming when the tab is hidden. (Mediabunny's
 * MediaStream sources would spawn blob: workers, which the CSP forbids.)
 * Browsers without WebCodecs fall back to MediaRecorder on the canvas and
 * mixer tracks. Loaded on the first recording only, precached for offline use.
 */
import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_VERY_HIGH,
  StreamTarget,
  type VideoCodec,
  WebMOutputFormat,
} from "mediabunny";
import type { AudioBlock } from "../audio/mixer";
import type { SealKey } from "../crypto/stream";
import { recordingName } from "./names";
import { appendOnlyStream, createPipeline, type Pipeline } from "./pipeline";
import { openSink, PART, type Saved, type Sink } from "./storage";

export type Container = "mp4" | "webm";

export interface RecordOptions {
  canvas: HTMLCanvasElement;
  /** Seconds on the audio clock. */
  clock: () => number;
  tap: (fn: (b: AudioBlock) => void) => Promise<() => void>;
  /** Registers the hook called after each rendered frame (null to remove it). */
  onFrame: (fn: (() => void) | null) => void;
  /** For the MediaRecorder fallback. */
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  width: number;
  height: number;
  fps: number;
  container: Container;
  quality: "standard" | "high";
  seal: SealKey | null;
}

export interface Recording {
  readonly name: string;
  readonly engine: "webcodecs" | "mediarecorder";
  readonly codec: string;
  readonly sink: Sink["kind"];
  bytes(): number;
  pause(): void;
  resume(): void;
  stop(): Promise<Saved>;
  /** Stops and deletes the partial file. */
  cancel(): Promise<void>;
  /** Rejects if encoding or writing fails mid-way. */
  readonly failed: Promise<never>;
}

const VIDEO: Record<Container, VideoCodec[]> = {
  mp4: ["avc", "hevc", "vp9", "av1"],
  webm: ["vp9", "av1", "vp8"],
};

export async function startRecording(o: RecordOptions): Promise<Recording> {
  const sealed = o.seal !== null;
  if (typeof VideoEncoder !== "undefined") {
    const codec = await getFirstEncodableVideoCodec(VIDEO[o.container], {
      width: o.width,
      height: o.height,
      frameRate: o.fps,
    });
    if (codec) return startWebCodecs(o, codec, sealed);
  }
  return startMediaRecorder(o, sealed);
}

async function startWebCodecs(o: RecordOptions, codec: VideoCodec, sealed: boolean) {
  const name = recordingName(new Date(), o.container, sealed);
  const mime = o.container === "mp4" ? "video/mp4" : "video/webm";
  const sink = await openSink(`${name}${PART}`, sealed ? "application/octet-stream" : mime);
  const pipeline = await createPipeline(sink, { mp4: o.container === "mp4", mime, seal: o.seal });
  const format =
    o.container === "mp4"
      ? new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 })
      : new WebMOutputFormat({ appendOnly: true, minimumClusterDuration: 1 });
  const output = new Output({ format, target: new StreamTarget(appendOnlyStream(pipeline)) });
  const quality = o.quality === "high" ? QUALITY_VERY_HIGH : QUALITY_HIGH;
  const video = new CanvasSource(o.canvas, {
    codec,
    quality,
    keyFrameInterval: 2,
    sizeChangeBehavior: "contain",
  });
  output.addVideoTrack(video, { frameRate: o.fps });
  const acodec = await getFirstEncodableAudioCodec(
    o.container === "mp4" ? ["aac", "opus"] : ["opus"],
    { numberOfChannels: 2, sampleRate: 48_000 },
  );
  const audio = acodec ? new AudioSampleSource({ codec: acodec, quality }) : null;
  if (audio) output.addAudioTrack(audio);

  let fail: (e: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = (e) => reject(e instanceof Error ? e : new Error(String(e)));
  });
  // Swallowed here, observed by the caller through `failed`.
  failed.catch(() => {});

  try {
    await output.start();
  } catch (err) {
    await sink.abort();
    throw err;
  }

  // One time base: the audio clock, minus time spent paused.
  const t0 = o.clock();
  let pausedTotal = 0;
  let pausedAt: number | null = null;
  let stopped = false;
  const at = (t: number) => t - t0 - pausedTotal;

  let pendingFrame: Promise<void> | null = null;
  let lastFrame = -1;
  const frame = () => {
    if (stopped || pausedAt !== null || pendingFrame) return; // encoder busy: drop this frame
    const ts = at(o.clock());
    if (ts <= lastFrame) return;
    lastFrame = ts;
    pendingFrame = video
      .add(ts, 1 / o.fps)
      .catch(fail)
      .finally(() => {
        pendingFrame = null;
      });
  };
  o.onFrame(frame);

  let audioChain = Promise.resolve();
  let audioEnd = 0;
  const untap = audio
    ? await o
        .tap((b) => {
          if (stopped || pausedAt !== null) return;
          const ts = at(b.time);
          // Blocks from before the start, or from a pause that has just ended, would overlap.
          if (ts < audioEnd - 0.001) return;
          audioEnd = ts + b.frames / b.sampleRate;
          const sample = new AudioSample({
            data: b.data,
            format: "f32-planar",
            numberOfChannels: 2,
            sampleRate: b.sampleRate,
            timestamp: ts,
          });
          audioChain = audioChain
            .then(() => audio.add(sample))
            .catch(fail)
            .finally(() => sample.close());
        })
        .catch(() => null)
    : null;

  const halt = async () => {
    stopped = true;
    o.onFrame(null);
    untap?.();
    await pendingFrame;
    await audioChain;
  };

  return {
    name,
    engine: "webcodecs" as const,
    codec,
    sink: sink.kind,
    failed,
    bytes: () => pipeline.written,
    pause() {
      if (pausedAt === null) pausedAt = o.clock();
    },
    resume() {
      if (pausedAt === null) return;
      pausedTotal += o.clock() - pausedAt;
      pausedAt = null;
    },
    async stop() {
      await halt();
      await output.finalize();
      await pipeline.finish();
      return sink.close(name);
    },
    async cancel() {
      await halt().catch(() => {});
      await output.cancel().catch(() => {});
      await sink.abort();
    },
  } satisfies Recording;
}

const RECORDER_MIMES: Record<Container, string[]> = {
  mp4: ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4"],
  webm: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
};

export function pickRecorderMime(
  isTypeSupported: (m: string) => boolean,
  preferred: Container,
): { mime: string; container: Container } | null {
  const other: Container = preferred === "mp4" ? "webm" : "mp4";
  for (const c of [preferred, other]) {
    const mime = RECORDER_MIMES[c].find((m) => isTypeSupported(m));
    if (mime) return { mime, container: c };
  }
  return null;
}

async function startMediaRecorder(o: RecordOptions, sealed: boolean): Promise<Recording> {
  if (typeof MediaRecorder === "undefined") throw new Error("this browser cannot record video");
  const pick = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m), o.container);
  if (!pick) throw new Error("this browser cannot record video");
  const name = recordingName(new Date(), pick.container, sealed);
  const mime = pick.container === "mp4" ? "video/mp4" : "video/webm";
  const sink = await openSink(`${name}${PART}`, sealed ? "application/octet-stream" : mime);
  // No metadata scrub here: MediaRecorder's MP4 is not fragmented the same way, and is passed as is.
  const pipeline: Pipeline = await createPipeline(sink, { mp4: false, mime, seal: o.seal });
  const stream = new MediaStream(o.audio ? [o.video, o.audio] : [o.video]);
  const rec = new MediaRecorder(stream, {
    mimeType: pick.mime,
    videoBitsPerSecond: o.quality === "high" ? 12_000_000 : 6_000_000,
  });
  let chain = Promise.resolve();
  let fail: (e: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    chain = chain
      .then(async () => pipeline.push(new Uint8Array(await e.data.arrayBuffer())))
      .catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
  };
  rec.onerror = () => fail(new Error("recording failed"));
  rec.start(1000);
  return {
    name,
    engine: "mediarecorder",
    codec: pick.mime,
    sink: sink.kind,
    failed,
    bytes: () => pipeline.written,
    pause: () => rec.state === "recording" && rec.pause(),
    resume: () => rec.state === "paused" && rec.resume(),
    async stop() {
      await new Promise<void>((ok) => {
        rec.addEventListener("stop", () => ok(), { once: true });
        rec.stop();
      });
      await chain;
      await pipeline.finish();
      return sink.close(name);
    },
    async cancel() {
      if (rec.state !== "inactive") rec.stop();
      await chain.catch(() => {});
      await sink.abort();
    },
  };
}
