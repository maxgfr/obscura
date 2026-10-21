/**
 * Taps the mixer's output for the encoder: stereo blocks of float samples,
 * stamped with the audio clock (the same clock the video frames are stamped
 * with), posted to the page. Runs on the audio thread, so no block is lost
 * while the page is busy.
 */
export {};

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const BLOCK = 2048;

class Tap extends AudioWorkletProcessor {
  private left = new Float32Array(BLOCK);
  private right = new Float32Array(BLOCK);
  private fill = 0;
  private startFrame = 0;
  private on = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ on: boolean }>) => {
      this.on = e.data.on;
      this.fill = 0;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.on) return true;
    const input = inputs[0] ?? [];
    const l = input[0];
    const r = input[1] ?? l;
    const n = l?.length ?? 128;
    if (this.fill === 0) this.startFrame = currentFrame;
    for (let i = 0; i < n; i++) {
      this.left[this.fill + i] = l ? (l[i] as number) : 0;
      this.right[this.fill + i] = r ? (r[i] as number) : 0;
    }
    this.fill += n;
    if (this.fill >= BLOCK) {
      const data = new Float32Array(this.fill * 2);
      data.set(this.left.subarray(0, this.fill), 0);
      data.set(this.right.subarray(0, this.fill), this.fill);
      this.port.postMessage(
        { time: this.startFrame / sampleRate, frames: this.fill, sampleRate, data },
        [data.buffer],
      );
      this.fill = 0;
    }
    return true;
  }
}

registerProcessor("obscura-tap", Tap);
