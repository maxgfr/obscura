/**
 * The preview: the program canvas, scaled to fit, under a DOM overlay for
 * what must never be recorded — selection handles, guides, and prompts
 * for captures that are not open yet.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { capturable, captureErrors, captures, engine } from "../../studio/engine";
import type { Layer, Rect } from "../../studio/scene";
import { activeScene, doc, selected, setLayer } from "../../studio/store";
import { settings } from "../settings";
import { Icon } from "./Icons";

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN = 0.01;

/** Snaps an edge or centre to the canvas edges and centre lines. */
export function snap(v: number, threshold: number): number {
  for (const t of [0, 0.5, 1]) if (Math.abs(v - t) < threshold) return t;
  return v;
}

export function moveRect(r: Rect, dx: number, dy: number, tx: number, ty: number): Rect {
  let x = r.x + dx;
  let y = r.y + dy;
  // Snap whichever of left, centre, right is closest to a guide.
  const xs = [x, x + r.w / 2, x + r.w].map((v, i) => [snap(v, tx) - v, i] as const);
  const bx = xs.filter(([d]) => d !== 0).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0];
  if (bx) x += bx[0];
  const ys = [y, y + r.h / 2, y + r.h].map((v, i) => [snap(v, ty) - v, i] as const);
  const by = ys.filter(([d]) => d !== 0).sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0];
  if (by) y += by[0];
  return { ...r, x, y };
}

export function resizeRect(
  r: Rect,
  h: Exclude<Handle, "move">,
  dx: number,
  dy: number,
  keepAspect: boolean,
  canvasAspect: number,
): Rect {
  let { x, y, w, h: hh } = r;
  if (h.includes("e")) w = Math.max(MIN, r.w + dx);
  if (h.includes("w")) {
    w = Math.max(MIN, r.w - dx);
    x = r.x + r.w - w;
  }
  if (h.includes("s")) hh = Math.max(MIN, r.h + dy);
  if (h.includes("n")) {
    hh = Math.max(MIN, r.h - dy);
    y = r.y + r.h - hh;
  }
  if (keepAspect) {
    const ratio = (r.w * canvasAspect) / r.h;
    if (h === "n" || h === "s") w = (hh * ratio) / canvasAspect;
    else hh = (w * canvasAspect) / ratio;
    if (h.includes("w")) x = r.x + r.w - w;
    if (h.includes("n")) y = r.y + r.h - hh;
  }
  return { x, y, w, h: hh };
}

const PROMPT: Record<string, string> = {
  display: "Choose a screen, window or tab",
  camera: "Turn on the camera",
};

function hit(layers: Layer[], px: number, py: number): Layer | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i] as Layer;
    if (!l.visible || l.kind === "mic") continue;
    const r = l.rect;
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return l;
  }
  return null;
}

export function Stage(props: { canvas: HTMLCanvasElement | null }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const d = doc.value;
  const aspect = d.canvas.width / d.canvas.height;
  const scene = activeScene.value;
  const live = new Set(captures.value.map((c) => c.source));
  const errors = captureErrors.value;

  useEffect(() => {
    const c = props.canvas;
    const f = frame.current;
    if (c && f && c.parentElement !== f) f.prepend(c);
  }, [props.canvas]);

  // Fit the 16:9 (or any) frame inside the available space.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const W = entry.contentRect.width;
      const H = entry.contentRect.height;
      const w = Math.min(W, H * aspect);
      setBox({ w: Math.floor(w), h: Math.floor(w / aspect) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  const drag = useRef<{
    id: string;
    handle: Handle;
    x: number;
    y: number;
    rect: Rect;
    pointer: number;
  } | null>(null);

  const toFrac = (e: PointerEvent) => {
    const r = overlay.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const start = (e: PointerEvent, layer: Layer, handle: Handle) => {
    selected.value = layer.id;
    if (layer.locked) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toFrac(e);
    drag.current = { id: layer.id, handle, x: p.x, y: p.y, rect: layer.rect, pointer: e.pointerId };
    overlay.current?.setPointerCapture(e.pointerId);
  };

  const onDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (e.target !== overlay.current && !(e.target as HTMLElement).dataset.hit) return;
    const p = toFrac(e as unknown as PointerEvent);
    const l = hit(scene.layers, p.x, p.y);
    if (!l) {
      selected.value = null;
      return;
    }
    start(e as unknown as PointerEvent, l, "move");
  };

  const onMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || g.pointer !== e.pointerId) return;
    const p = toFrac(e as unknown as PointerEvent);
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    const tx = 6 / Math.max(1, box.w);
    const ty = 6 / Math.max(1, box.h);
    const next =
      g.handle === "move"
        ? e.altKey
          ? { ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy }
          : moveRect(g.rect, dx, dy, tx, ty)
        : resizeRect(g.rect, g.handle, dx, dy, e.shiftKey, aspect);
    setLayer(g.id, { rect: next });
  };

  const onUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };

  const sel = scene.layers.find((l) => l.id === selected.value && l.kind !== "mic");

  return (
    <div class="stage" ref={host} data-testid="stage">
      <div class="stage-frame" ref={frame} style={{ width: `${box.w}px`, height: `${box.h}px` }}>
        <div
          class="stage-overlay"
          ref={overlay}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {settings.value.guides && (
            <div class="guides" aria-hidden="true">
              <span class="guide-v" />
              <span class="guide-h" />
              <span class="guide-safe" />
            </div>
          )}
          {scene.layers.map((l) => {
            if (!l.visible || !capturable(l.kind) || l.kind === "mic" || !l.source) return null;
            if (live.has(l.source)) return null;
            const r = l.rect;
            return (
              <div
                key={l.id}
                class="placeholder"
                data-hit="1"
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
              >
                <button
                  type="button"
                  class="btn btn-ghost-stage"
                  data-testid={`pick-${l.kind}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void engine?.open(l)}
                >
                  <Icon name={l.kind === "display" ? "screen" : "camera"} />
                  <span>{PROMPT[l.kind]}</span>
                </button>
                {errors[l.source] && <p class="placeholder-error">{errors[l.source]}</p>}
              </div>
            );
          })}
          {sel && (
            <div
              class={sel.locked ? "selection locked" : "selection"}
              style={{
                left: `${sel.rect.x * 100}%`,
                top: `${sel.rect.y * 100}%`,
                width: `${sel.rect.w * 100}%`,
                height: `${sel.rect.h * 100}%`,
              }}
              onPointerDown={(e) => start(e as unknown as PointerEvent, sel, "move")}
            >
              {!sel.locked &&
                HANDLES.map((h) => (
                  <span
                    key={h}
                    class={`handle handle-${h}`}
                    onPointerDown={(e) => start(e as unknown as PointerEvent, sel, h)}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
