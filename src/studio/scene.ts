/**
 * The studio document: scenes made of layers, laid out on a fixed canvas.
 * It holds layout only — never a device id, a label or a captured frame —
 * so it can be saved in localStorage and shared as a link. Anything read
 * back (storage, a link) is untrusted and goes through `validateDoc`.
 * The CLI mirrors these rules in cli/src/scene.rs.
 */

export const LAYER_KINDS = [
  "display",
  "camera",
  "image",
  "text",
  "color",
  "mask",
  "mic",
  "guest",
] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];
export const FONTS = ["sans", "serif", "mono"] as const;
export type Font = (typeof FONTS)[number];
export const FPS = [24, 25, 30, 50, 60] as const;
export const SIZES = [
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
  [1080, 1920],
  [1080, 1080],
] as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Chroma {
  color: string;
  similarity: number;
  smoothness: number;
}

export interface TextProps {
  value: string;
  font: Font;
  size: number;
  weight: 400 | 700;
  color: string;
  background: string | null;
  align: "left" | "center" | "right";
}

export interface MaskProps {
  mode: "solid" | "pixelate";
  color: string;
  block: number;
}

export interface AudioProps {
  gain: number;
  muted: boolean;
  /** Microphones only: the browser's suppression, or RNNoise (downloaded on first use). */
  noise: "off" | "browser" | "rnnoise";
}

export interface Layer {
  id: string;
  kind: LayerKind;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Fractions of the canvas. */
  rect: Rect;
  /** Fractions of the source cut from each side. */
  crop: Crop;
  opacity: number;
  /** Corner radius, as a fraction of the layer's shorter side. */
  radius: number;
  shape: "rect" | "circle";
  flip: boolean;
  chroma: Chroma | null;
  text?: TextProps;
  color?: string;
  mask?: MaskProps;
  audio?: AudioProps;
  /** Local image asset (OPFS); never part of a link. */
  image?: string;
  /**
   * Capture slot for screen, camera, microphone and guest layers: layers that share
   * it (the same camera in two scenes) share one capture. A random id, not a device
   * or a person.
   */
  source?: string;
}

export interface Scene {
  id: string;
  name: string;
  layers: Layer[];
}

export interface StudioDoc {
  v: 1;
  canvas: { width: number; height: number; fps: number };
  transition: { kind: "cut" | "fade"; ms: number };
  active: number;
  scenes: Scene[];
}

export const LIMITS = {
  scenes: 20,
  layers: 32,
  name: 60,
  text: 500,
  link: 16_000,
};

const ID = /^[a-z0-9]{1,16}$/;
const COLOR = /^#[0-9a-f]{6}$/;

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => (x % 36).toString(36)).join("");
}

const NAMES: Record<LayerKind, string> = {
  display: "Screen",
  camera: "Camera",
  image: "Image",
  text: "Text",
  color: "Color",
  mask: "Privacy mask",
  mic: "Microphone",
  guest: "Guest",
};

/** `aspect` is the canvas's width / height, so a camera bubble comes out round. */
export function newLayer(kind: LayerKind, aspect = 16 / 9, name = NAMES[kind]): Layer {
  const base: Layer = {
    id: newId(),
    kind,
    name,
    visible: true,
    locked: false,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    crop: { l: 0, t: 0, r: 0, b: 0 },
    opacity: 1,
    radius: 0,
    shape: "rect",
    flip: false,
    chroma: null,
  };
  switch (kind) {
    case "camera":
      return {
        ...base,
        source: newId(),
        rect: bubble(aspect),
        radius: 0.5,
        shape: "circle",
        flip: true,
      };
    case "text":
      return {
        ...base,
        rect: { x: 0.05, y: 0.05, w: 0.5, h: 0.12 },
        text: {
          value: "Hello",
          font: "sans",
          size: 64,
          weight: 700,
          color: "#ffffff",
          background: null,
          align: "left",
        },
      };
    case "color":
      return { ...base, color: "#1d1b26" };
    case "mask":
      return {
        ...base,
        rect: { x: 0.7, y: 0.02, w: 0.28, h: 0.14 },
        mask: { mode: "solid", color: "#000000", block: 24 },
      };
    case "mic":
      return { ...base, source: newId(), audio: { gain: 1, muted: false, noise: "browser" } };
    case "display":
    case "guest":
      return { ...base, source: newId(), audio: { gain: 1, muted: false, noise: "off" } };
    case "image":
      return { ...base, rect: { x: 0.35, y: 0.3, w: 0.3, h: 0.4 } };
  }
}

export function defaultDoc(): StudioDoc {
  const screen = newLayer("display");
  const cam = newLayer("camera");
  const mic = newLayer("mic");
  return {
    v: 1,
    canvas: { width: 1920, height: 1080, fps: 30 },
    transition: { kind: "fade", ms: 300 },
    active: 0,
    scenes: [
      { id: newId(), name: "Screen + camera", layers: [screen, cam, mic] },
      {
        id: newId(),
        name: "Camera only",
        layers: [
          {
            ...newLayer("camera"),
            source: cam.source as string,
            rect: full(),
            radius: 0,
            shape: "rect",
          },
          { ...newLayer("mic"), source: mic.source as string },
        ],
      },
    ],
  };
}

function bubble(aspect: number): Rect {
  const w = 0.2;
  const h = Math.min(0.9, w * aspect);
  return { x: 1 - w - 0.025, y: 1 - h - 0.025 * aspect, w, h };
}

function full(): Rect {
  return { x: 0, y: 0, w: 1, h: 1 };
}

// ── Split screen ──────────────────────────────────────────────────────────

/**
 * Lays out the people of a scene (cameras and guests) in tiles. With a screen
 * in the scene, the screen keeps most of the canvas and the people line up
 * beside it (below it on a vertical canvas); without one, they share the
 * canvas in a grid. Other layers are left as they are.
 */
export function tile(scene: Scene, aspect: number): Scene {
  const people = scene.layers.filter(
    (l) => l.visible && (l.kind === "camera" || l.kind === "guest"),
  );
  if (!people.length) return scene;
  const screen = scene.layers.find((l) => l.visible && l.kind === "display");
  const wide = aspect >= 1;
  const rects = new Map<string, Rect>();
  const n = people.length;
  if (screen) {
    const side = wide ? Math.min(0.3, 1 / Math.max(n, 3)) : Math.min(0.35, 1 / Math.max(n, 3));
    rects.set(
      screen.id,
      wide ? { x: 0, y: 0, w: 1 - side, h: 1 } : { x: 0, y: 0, w: 1, h: 1 - side },
    );
    people.forEach((l, i) => {
      rects.set(
        l.id,
        wide
          ? { x: 1 - side, y: i / n, w: side, h: 1 / n }
          : { x: i / n, y: 1 - side, w: 1 / n, h: side },
      );
    });
  } else {
    const cols = n === 1 ? 1 : n === 2 ? (wide ? 2 : 1) : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    people.forEach((l, i) => {
      const r = Math.floor(i / cols);
      // The last row is centered when it is not full.
      const inRow = r === rows - 1 ? n - r * cols : cols;
      const c = i - r * cols;
      const x0 = (cols - inRow) / (2 * cols);
      rects.set(l.id, { x: x0 + c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
    });
  }
  return {
    ...scene,
    layers: scene.layers.map((l) => {
      const rect = rects.get(l.id);
      if (!rect) return l;
      return l.kind === "display"
        ? { ...l, rect, crop: { l: 0, t: 0, r: 0, b: 0 } }
        : { ...l, rect, shape: "rect", radius: 0 };
    }),
  };
}

// ── Validation ────────────────────────────────────────────────────────────

export class SceneError extends Error {
  override name = "SceneError";
}

type Obj = Record<string, unknown>;

function obj(v: unknown, at: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new SceneError(`${at}: expected an object`);
  return v as Obj;
}

function only(o: Obj, keys: string[], at: string): void {
  for (const k of Object.keys(o))
    if (!keys.includes(k)) throw new SceneError(`${at}: unknown field "${k}"`);
}

function num(v: unknown, min: number, max: number, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new SceneError(`${at}: expected a number in [${min}, ${max}]`);
  return v;
}

function int(v: unknown, min: number, max: number, at: string): number {
  const n = num(v, min, max, at);
  if (!Number.isInteger(n)) throw new SceneError(`${at}: expected an integer`);
  return n;
}

function bool(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new SceneError(`${at}: expected a boolean`);
  return v;
}

function str(v: unknown, max: number, at: string): string {
  if (typeof v !== "string" || v.length > max)
    throw new SceneError(`${at}: expected a string of at most ${max} characters`);
  return v;
}

function oneOf<T extends string | number>(v: unknown, values: readonly T[], at: string): T {
  if (!values.includes(v as T)) throw new SceneError(`${at}: expected one of ${values.join(", ")}`);
  return v as T;
}

function color(v: unknown, at: string): string {
  if (typeof v !== "string" || !COLOR.test(v)) throw new SceneError(`${at}: expected #rrggbb`);
  return v;
}

function id(v: unknown, at: string): string {
  if (typeof v !== "string" || !ID.test(v)) throw new SceneError(`${at}: bad id`);
  return v;
}

function validateLayer(v: unknown, at: string): Layer {
  const o = obj(v, at);
  only(
    o,
    [
      "id",
      "kind",
      "name",
      "visible",
      "locked",
      "rect",
      "crop",
      "opacity",
      "radius",
      "shape",
      "flip",
      "chroma",
      "text",
      "color",
      "mask",
      "audio",
      "image",
      "source",
    ],
    at,
  );
  const kind = oneOf(o.kind, LAYER_KINDS, `${at}.kind`);
  const r = obj(o.rect, `${at}.rect`);
  only(r, ["x", "y", "w", "h"], `${at}.rect`);
  const c = obj(o.crop, `${at}.crop`);
  only(c, ["l", "t", "r", "b"], `${at}.crop`);
  const crop = {
    l: num(c.l, 0, 0.95, `${at}.crop.l`),
    t: num(c.t, 0, 0.95, `${at}.crop.t`),
    r: num(c.r, 0, 0.95, `${at}.crop.r`),
    b: num(c.b, 0, 0.95, `${at}.crop.b`),
  };
  if (crop.l + crop.r >= 0.98 || crop.t + crop.b >= 0.98)
    throw new SceneError(`${at}.crop: nothing left to show`);
  const layer: Layer = {
    id: id(o.id, `${at}.id`),
    kind,
    name: str(o.name, LIMITS.name, `${at}.name`),
    visible: bool(o.visible, `${at}.visible`),
    locked: bool(o.locked, `${at}.locked`),
    rect: {
      x: num(r.x, -2, 3, `${at}.rect.x`),
      y: num(r.y, -2, 3, `${at}.rect.y`),
      w: num(r.w, 0.005, 4, `${at}.rect.w`),
      h: num(r.h, 0.005, 4, `${at}.rect.h`),
    },
    crop,
    opacity: num(o.opacity, 0, 1, `${at}.opacity`),
    radius: num(o.radius, 0, 0.5, `${at}.radius`),
    shape: oneOf(o.shape, ["rect", "circle"] as const, `${at}.shape`),
    flip: bool(o.flip, `${at}.flip`),
    chroma: null,
  };
  if (o.chroma !== null) {
    const k = obj(o.chroma, `${at}.chroma`);
    only(k, ["color", "similarity", "smoothness"], `${at}.chroma`);
    layer.chroma = {
      color: color(k.color, `${at}.chroma.color`),
      similarity: num(k.similarity, 0, 1, `${at}.chroma.similarity`),
      smoothness: num(k.smoothness, 0, 1, `${at}.chroma.smoothness`),
    };
  }
  const need = (field: string, present: boolean) => {
    if (!present) throw new SceneError(`${at}: a ${kind} layer needs "${field}"`);
  };
  const forbid = (field: string) => {
    if (o[field] !== undefined)
      throw new SceneError(`${at}: "${field}" does not apply to a ${kind} layer`);
  };
  if (kind === "text") {
    need("text", o.text !== undefined);
    const t = obj(o.text, `${at}.text`);
    only(t, ["value", "font", "size", "weight", "color", "background", "align"], `${at}.text`);
    layer.text = {
      value: str(t.value, LIMITS.text, `${at}.text.value`),
      font: oneOf(t.font, FONTS, `${at}.text.font`),
      size: int(t.size, 8, 400, `${at}.text.size`),
      weight: oneOf(t.weight, [400, 700] as const, `${at}.text.weight`),
      color: color(t.color, `${at}.text.color`),
      background: t.background === null ? null : color(t.background, `${at}.text.background`),
      align: oneOf(t.align, ["left", "center", "right"] as const, `${at}.text.align`),
    };
  } else forbid("text");
  if (kind === "color") {
    need("color", o.color !== undefined);
    layer.color = color(o.color, `${at}.color`);
  } else forbid("color");
  if (kind === "mask") {
    need("mask", o.mask !== undefined);
    const m = obj(o.mask, `${at}.mask`);
    only(m, ["mode", "color", "block"], `${at}.mask`);
    layer.mask = {
      mode: oneOf(m.mode, ["solid", "pixelate"] as const, `${at}.mask.mode`),
      color: color(m.color, `${at}.mask.color`),
      block: int(m.block, 4, 128, `${at}.mask.block`),
    };
  } else forbid("mask");
  if (kind === "mic" || kind === "display" || kind === "guest") {
    need("audio", o.audio !== undefined);
    const a = obj(o.audio, `${at}.audio`);
    only(a, ["gain", "muted", "noise"], `${at}.audio`);
    layer.audio = {
      gain: num(a.gain, 0, 4, `${at}.audio.gain`),
      muted: bool(a.muted, `${at}.audio.muted`),
      noise: oneOf(a.noise, ["off", "browser", "rnnoise"] as const, `${at}.audio.noise`),
    };
  } else forbid("audio");
  if (kind === "image") {
    if (o.image !== undefined) layer.image = id(o.image, `${at}.image`);
  } else forbid("image");
  if (kind === "display" || kind === "camera" || kind === "mic" || kind === "guest") {
    need("source", o.source !== undefined);
    layer.source = id(o.source, `${at}.source`);
  } else forbid("source");
  return layer;
}

export function validateDoc(v: unknown): StudioDoc {
  const o = obj(v, "doc");
  only(o, ["v", "canvas", "transition", "active", "scenes"], "doc");
  if (o.v !== 1) throw new SceneError("doc.v: unsupported version");
  const c = obj(o.canvas, "doc.canvas");
  only(c, ["width", "height", "fps"], "doc.canvas");
  const t = obj(o.transition, "doc.transition");
  only(t, ["kind", "ms"], "doc.transition");
  if (!Array.isArray(o.scenes) || o.scenes.length < 1 || o.scenes.length > LIMITS.scenes)
    throw new SceneError(`doc.scenes: expected 1 to ${LIMITS.scenes} scenes`);
  const ids = new Set<string>();
  const scenes = o.scenes.map((sv, i) => {
    const at = `doc.scenes[${i}]`;
    const s = obj(sv, at);
    only(s, ["id", "name", "layers"], at);
    if (!Array.isArray(s.layers) || s.layers.length > LIMITS.layers)
      throw new SceneError(`${at}.layers: at most ${LIMITS.layers} layers`);
    const scene: Scene = {
      id: id(s.id, `${at}.id`),
      name: str(s.name, LIMITS.name, `${at}.name`),
      layers: s.layers.map((l, j) => validateLayer(l, `${at}.layers[${j}]`)),
    };
    for (const x of [scene.id, ...scene.layers.map((l) => l.id)]) {
      if (ids.has(x)) throw new SceneError(`${at}: duplicate id ${x}`);
      ids.add(x);
    }
    return scene;
  });
  const doc: StudioDoc = {
    v: 1,
    canvas: {
      width: int(c.width, 160, 3840, "doc.canvas.width"),
      height: int(c.height, 160, 3840, "doc.canvas.height"),
      fps: oneOf(c.fps, FPS, "doc.canvas.fps"),
    },
    transition: {
      kind: oneOf(t.kind, ["cut", "fade"] as const, "doc.transition.kind"),
      ms: int(t.ms, 0, 3000, "doc.transition.ms"),
    },
    active: int(o.active, 0, scenes.length - 1, "doc.active"),
    scenes,
  };
  if (doc.canvas.width % 2 || doc.canvas.height % 2)
    throw new SceneError("doc.canvas: width and height must be even");
  return doc;
}

// ── Links ─────────────────────────────────────────────────────────────────

/** A link carries layout only: local image assets stay on this device. */
export function shareable(doc: StudioDoc): StudioDoc {
  return {
    ...doc,
    scenes: doc.scenes.map((s) => ({
      ...s,
      layers: s.layers.map(({ image: _image, ...l }) => l),
    })),
  };
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new SceneError("link: not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeLink(doc: StudioDoc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(shareable(doc)));
  return `s=${toBase64Url(await pipe(json, new CompressionStream("deflate-raw")))}`;
}

/** Parses the `s=` part of a studio link (the #fragment, never sent to a server). */
export async function decodeLink(fragment: string): Promise<StudioDoc> {
  const m = /^#?s=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!m?.[1]) throw new SceneError("link: no scene in this link");
  if (m[1].length > LIMITS.link) throw new SceneError("link: too long");
  const raw = await pipeLimited(fromBase64Url(m[1]), 256 * 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new SceneError("link: not a scene");
  }
  return validateDoc(parsed);
}

/** Inflates with an output cap, so a crafted link cannot expand into gigabytes. */
async function pipeLimited(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        await reader.cancel();
        throw new SceneError("link: scene too large");
      }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof SceneError) throw e;
    throw new SceneError("link: corrupted");
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
