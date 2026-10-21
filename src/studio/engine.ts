/**
 * The running studio: captures by slot, the compositor, the mixer and the
 * render clock. The document (store.ts) says what to show; the engine owns
 * what is live — and releases a capture as soon as no layer uses it.
 */
import { signal } from "@preact/signals";
import { Mixer } from "../audio/mixer";
import { captureError, openDevice, openDisplay } from "../capture/capture";
import { Compositor, type LayerSource } from "../render/compositor";
import { renderText } from "../render/text";
import { trustedScriptUrl } from "../security";
import { loadImage } from "./assets";
import type { Layer, LayerKind } from "./scene";
import { activeScene, doc, sourcesIn, transition } from "./store";

export interface Capture {
  source: string;
  kind: "display" | "camera" | "mic";
  label: string;
  stream: MediaStream;
  video: HTMLVideoElement | null;
  hasAudio: boolean;
}

/** Live captures, for the indicator and the inspector. */
export const captures = signal<Capture[]>([]);
export const captureErrors = signal<Record<string, string>>({});
/** Session device choices; never saved. */
export const devices = signal<{ camera: string; mic: string }>({ camera: "", mic: "" });
export const monitors = signal<Set<string>>(new Set());
export const renderStats = signal({ fps: 0, lost: false });

interface Picture {
  el: TexImageSource;
  width: number;
  height: number;
  version: number;
}

export class Engine {
  readonly compositor: Compositor;
  readonly mixer: Mixer;
  readonly program: MediaStream;
  private live = new Map<string, Capture>();
  private opening = new Map<string, Promise<void>>();
  private images = new Map<string, Picture>();
  private loadingImages = new Set<string>();
  private texts = new Map<string, { canvas: HTMLCanvasElement; key: string; version: number }>();
  private clock: Worker;
  private raf = 0;
  private lastFrame = 0;
  private frames = 0;
  private lastStat = performance.now();
  private disposers: (() => void)[] = [];
  /** Called right after each frame is drawn (the recorder takes it from the canvas then). */
  frameHook: (() => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
    this.mixer = new Mixer();
    const { width, height, fps } = doc.value.canvas;
    this.compositor.resize(width, height);
    this.program = canvas.captureStream(fps);
    this.clock = new Worker(trustedScriptUrl(__CLOCK_WORKER_URL__) as string, { type: "module" });
    // Animation frames pace the preview while the tab is visible; a hidden tab gets none, and its
    // timers are throttled, so the worker's clock takes over (and covers any long gap).
    this.clock.onmessage = () => {
      const interval = 1000 / doc.value.canvas.fps;
      if (
        document.visibilityState === "hidden" ||
        performance.now() - this.lastFrame > interval * 1.5
      )
        this.frame();
    };
    this.clock.postMessage({ fps });
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (now - this.lastFrame >= 1000 / doc.value.canvas.fps - 2) this.frame();
    };
    this.raf = requestAnimationFrame(loop);
    this.disposers.push(
      doc.subscribe((d) => {
        this.compositor.resize(d.canvas.width, d.canvas.height);
        this.clock.postMessage({ fps: d.canvas.fps });
        this.releaseUnused();
        this.syncAudio();
      }),
      monitors.subscribe(() => this.syncAudio()),
    );
  }

  get videoTrack(): MediaStreamTrack {
    const t = this.program.getVideoTracks()[0];
    if (!t) throw new Error("no program track");
    return t;
  }

  // ── Captures ────────────────────────────────────────────────────────────

  capture(source: string): Capture | undefined {
    return this.live.get(source);
  }

  /** Opens the capture behind a layer (asks the browser). */
  async open(layer: Layer, deviceId?: string): Promise<void> {
    const source = layer.source;
    if (!source || (layer.kind !== "display" && layer.kind !== "camera" && layer.kind !== "mic"))
      return;
    const pending = this.opening.get(source);
    if (pending) return pending;
    const kind = layer.kind;
    const task = (async () => {
      void this.mixer.resume();
      const fps = doc.value.canvas.fps;
      try {
        const stream =
          kind === "display"
            ? await openDisplay(fps)
            : await openDevice(
                kind,
                deviceId ?? (kind === "camera" ? devices.value.camera : devices.value.mic),
                {
                  fps,
                  noise: layer.audio?.noise ?? "browser",
                },
              );
        this.release(source);
        await this.attach(source, kind, stream, layer.audio?.noise === "rnnoise");
        const { [source]: _, ...rest } = captureErrors.value;
        captureErrors.value = rest;
      } catch (err) {
        captureErrors.value = { ...captureErrors.value, [source]: captureError(err) };
      }
    })();
    this.opening.set(source, task);
    try {
      await task;
    } finally {
      this.opening.delete(source);
    }
  }

  private async attach(
    source: string,
    kind: Capture["kind"],
    stream: MediaStream,
    rnnoise: boolean,
  ): Promise<void> {
    const vt = stream.getVideoTracks()[0];
    const at = stream.getAudioTracks()[0];
    let video: HTMLVideoElement | null = null;
    if (vt) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = new MediaStream([vt]);
      await video.play().catch(() => {});
    }
    if (at) await this.mixer.add(source, at, rnnoise);
    const cap: Capture = {
      source,
      kind,
      label: (vt ?? at)?.label || kind,
      stream,
      video,
      hasAudio: !!at,
    };
    for (const t of stream.getTracks())
      t.addEventListener("ended", () => {
        // The browser's "Stop sharing", or an unplugged device.
        if (stream.getTracks().every((x) => x.readyState === "ended")) this.release(source);
      });
    this.live.set(source, cap);
    captures.value = [...this.live.values()];
    this.syncAudio();
  }

  release(source: string): void {
    const cap = this.live.get(source);
    if (!cap) return;
    for (const t of cap.stream.getTracks()) t.stop();
    if (cap.video) cap.video.srcObject = null;
    this.mixer.remove(source);
    this.live.delete(source);
    captures.value = [...this.live.values()];
  }

  releaseAll(): void {
    for (const s of [...this.live.keys()]) this.release(s);
  }

  /** A capture no layer refers to any more is stopped at once. */
  private releaseUnused(): void {
    const used = sourcesIn(doc.value);
    for (const s of [...this.live.keys()]) if (!used.has(s)) this.release(s);
    const ids = new Set(doc.value.scenes.flatMap((s) => s.layers.map((l) => l.id)));
    for (const id of [...this.texts.keys()]) if (!ids.has(id)) this.texts.delete(id);
    this.compositor.prune(ids);
  }

  /** Audible: used by a visible, unmuted layer of the active scene. */
  syncAudio(): void {
    const scene = activeScene.value;
    const mon = monitors.value;
    for (const [source] of this.live) {
      const layer = scene.layers.find((l) => l.source === source && l.audio);
      this.mixer.set(source, {
        gain: layer?.audio?.gain ?? 1,
        audible: !!layer && layer.visible && !layer.audio?.muted,
        monitor: mon.has(source),
      });
    }
  }

  async reopenWithNoise(layer: Layer): Promise<void> {
    if (!layer.source || !this.live.has(layer.source)) return;
    await this.open(layer);
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  private sourceFor = (layer: Layer): LayerSource | null => {
    switch (layer.kind) {
      case "display":
      case "camera": {
        const v = layer.source ? this.live.get(layer.source)?.video : null;
        if (!v || v.readyState < 2 || !v.videoWidth) return null;
        return { el: v, width: v.videoWidth, height: v.videoHeight, dynamic: true, version: 0 };
      }
      case "image": {
        if (!layer.image) return null;
        const pic = this.images.get(layer.image);
        if (!pic) {
          this.loadPicture(layer.image);
          return null;
        }
        return { ...pic, dynamic: false };
      }
      case "text": {
        if (!layer.text) return null;
        const { width, height } = doc.value.canvas;
        const w = Math.round(layer.rect.w * width);
        const h = Math.round(layer.rect.h * height);
        const key = `${JSON.stringify(layer.text)}|${w}x${h}`;
        let t = this.texts.get(layer.id);
        if (!t) {
          t = { canvas: document.createElement("canvas"), key: "", version: 0 };
          this.texts.set(layer.id, t);
        }
        if (t.key !== key) {
          renderText(t.canvas, layer.text, w, h);
          t.key = key;
          t.version++;
        }
        return { el: t.canvas, width: w, height: h, dynamic: false, version: t.version };
      }
      default:
        return null;
    }
  };

  private loadPicture(id: string): void {
    if (this.loadingImages.has(id)) return;
    this.loadingImages.add(id);
    void loadImage(id).then((bmp) => {
      if (bmp) this.images.set(id, { el: bmp, width: bmp.width, height: bmp.height, version: 1 });
    });
  }

  private frame(): void {
    this.lastFrame = performance.now();
    const scene = activeScene.value;
    const tr = transition.value;
    let from: { scene: typeof scene; t: number } | undefined;
    if (tr) {
      const t = (performance.now() - tr.start) / Math.max(1, doc.value.transition.ms);
      if (t >= 1) transition.value = null;
      else from = { scene: tr.from, t };
    }
    this.compositor.render(scene, this.sourceFor, from);
    this.frameHook?.();
    // captureStream(fps) samples on its own; requestFrame makes sure a hidden tab's frames are taken.
    (this.videoTrack as MediaStreamTrack & { requestFrame?: () => void }).requestFrame?.();
    this.frames++;
    const now = performance.now();
    if (now - this.lastStat > 1000) {
      renderStats.value = {
        fps: Math.round((this.frames * 1000) / (now - this.lastStat)),
        lost: this.compositor.isLost,
      };
      this.frames = 0;
      this.lastStat = now;
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    cancelAnimationFrame(this.raf);
    this.clock.terminate();
    this.releaseAll();
    this.mixer.close();
    for (const t of this.program.getTracks()) t.stop();
    this.compositor.dispose();
  }
}

export function capturable(kind: LayerKind): kind is Capture["kind"] {
  return kind === "display" || kind === "camera" || kind === "mic";
}

export let engine: Engine | null = null;
export function setEngine(e: Engine | null): void {
  engine = e;
}
