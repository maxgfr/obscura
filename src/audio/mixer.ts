/**
 * One AudioContext mixes every audible source into the program's audio
 * track: per source, input → (RNNoise) → gain → meter → bus. A source is
 * audible when a visible layer of the active scene uses it and it is not
 * muted. Everything stays on the device.
 */
import { trustedScriptUrl } from "../security";

export const SAMPLE_RATE = 48_000;

interface Channel {
  input: MediaStreamAudioSourceNode;
  denoise: AudioNode | null;
  gain: GainNode;
  analyser: AnalyserNode;
  monitor: GainNode;
  buf: Float32Array<ArrayBuffer>;
  destroy: (() => void) | null;
}

/** Peak of a block of samples, in dBFS (-Infinity for silence). */
export function peakDb(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;
}

/** dBFS → 0..1 for a meter spanning -60..0 dB. */
export function meterLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

let rnnoiseBinary: Promise<ArrayBuffer> | null = null;

/** A block of the program's audio: planar stereo, stamped with the audio clock (seconds). */
export interface AudioBlock {
  time: number;
  frames: number;
  sampleRate: number;
  data: Float32Array;
}

export class Mixer {
  readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly dest: MediaStreamAudioDestinationNode;
  private readonly channels = new Map<string, Channel>();
  private workletLoaded: Promise<void> | null = null;
  private tapNode: Promise<AudioWorkletNode> | null = null;
  private tapListeners = new Set<(b: AudioBlock) => void>();

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    this.bus = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.bus.connect(this.dest);
  }

  /** The program's audio. */
  get track(): MediaStreamTrack {
    const t = this.dest.stream.getAudioTracks()[0];
    if (!t) throw new Error("no mixer track");
    return t;
  }

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
  }

  /** Seconds on the audio clock, which also stamps the video while recording. */
  get now(): number {
    return this.ctx.currentTime;
  }

  /** Subscribes to the program's audio, block by block; returns the unsubscribe. */
  async tap(fn: (b: AudioBlock) => void): Promise<() => void> {
    this.tapNode ??= (async () => {
      await this.ctx.audioWorklet.addModule(trustedScriptUrl(__TAP_WORKLET_URL__) as string);
      const node = new AudioWorkletNode(this.ctx, "obscura-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      // Pulled by the graph through a silent node, so it runs without being heard.
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      this.bus.connect(node);
      node.connect(silent).connect(this.ctx.destination);
      node.port.onmessage = (e: MessageEvent<AudioBlock>) => {
        for (const l of this.tapListeners) l(e.data);
      };
      return node;
    })().catch((err) => {
      this.tapNode = null;
      throw err;
    });
    const node = await this.tapNode;
    this.tapListeners.add(fn);
    node.port.postMessage({ on: true });
    return () => {
      this.tapListeners.delete(fn);
      if (!this.tapListeners.size) node.port.postMessage({ on: false });
    };
  }

  has(source: string): boolean {
    return this.channels.has(source);
  }

  async add(source: string, track: MediaStreamTrack, rnnoise: boolean): Promise<void> {
    this.remove(source);
    const ctx = this.ctx;
    const input = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const monitor = ctx.createGain();
    monitor.gain.value = 0;
    let denoise: AudioNode | null = null;
    let destroy: (() => void) | null = null;
    if (rnnoise) {
      try {
        const node = await this.rnnoise();
        denoise = node;
        destroy = () => (node as unknown as { destroy(): void }).destroy();
      } catch {
        denoise = null;
      }
    }
    if (denoise) input.connect(denoise).connect(gain);
    else input.connect(gain);
    gain.connect(analyser);
    gain.connect(this.bus);
    gain.connect(monitor).connect(ctx.destination);
    this.channels.set(source, {
      input,
      denoise,
      gain,
      analyser,
      monitor,
      buf: new Float32Array(analyser.fftSize),
      destroy,
    });
  }

  private async rnnoise(): Promise<AudioNode> {
    const { loadRnnoise, RnnoiseWorkletNode } = await import("@sapphi-red/web-noise-suppressor");
    rnnoiseBinary ??= loadRnnoise({
      url: __NOISE_ASSETS__.wasm,
      simdUrl: __NOISE_ASSETS__.simd,
    }).catch((err) => {
      rnnoiseBinary = null;
      throw err;
    });
    this.workletLoaded ??= this.ctx.audioWorklet
      .addModule(trustedScriptUrl(__NOISE_ASSETS__.worklet) as string)
      .catch((err) => {
        this.workletLoaded = null;
        throw err;
      });
    const [bin] = await Promise.all([rnnoiseBinary, this.workletLoaded]);
    return new RnnoiseWorkletNode(this.ctx, { maxChannels: 2, wasmBinary: bin.slice(0) });
  }

  remove(source: string): void {
    const c = this.channels.get(source);
    if (!c) return;
    c.input.disconnect();
    c.denoise?.disconnect();
    c.destroy?.();
    c.gain.disconnect();
    c.monitor.disconnect();
    this.channels.delete(source);
  }

  set(source: string, opts: { gain: number; audible: boolean; monitor: boolean }): void {
    const c = this.channels.get(source);
    if (!c) return;
    const now = this.ctx.currentTime;
    c.gain.gain.setTargetAtTime(opts.audible ? opts.gain : 0, now, 0.015);
    c.monitor.gain.setTargetAtTime(opts.monitor ? 1 : 0, now, 0.015);
  }

  /** Current peak of a source after its gain, 0..1 on a -60..0 dB scale. */
  level(source: string): number {
    const c = this.channels.get(source);
    if (!c) return 0;
    c.analyser.getFloatTimeDomainData(c.buf);
    return meterLevel(peakDb(c.buf));
  }

  close(): void {
    for (const s of [...this.channels.keys()]) this.remove(s);
    void this.ctx.close().catch(() => {});
  }
}
