/** Properties of the selected layer, or of the canvas when nothing is selected. */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type DeviceInfo, listDevices } from "../../capture/capture";
import { rec } from "../../record/session";
import { captures, devices, engine } from "../../studio/engine";
import { FONTS, FPS, type Layer, LIMITS, SIZES } from "../../studio/scene";
import { activeScene, copyLayerTo, doc, selectedLayer, setLayer, update } from "../../studio/store";
import { Icon } from "./Icons";

function Field(props: {
  label: string;
  children: ComponentChildren;
  hint?: string | undefined;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in as children.
    <label class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="field-hint">{props.hint}</span>}
    </label>
  );
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
  format?: (v: number) => string;
}): JSX.Element {
  return (
    <label class="field">
      <span class="field-label">
        {props.label}
        <output class="tabular">{props.format ? props.format(props.value) : props.value}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      />
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Num(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}): JSX.Element {
  return (
    <label class="num">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step ?? 1}
        value={Math.round(props.value)}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

function Geometry({ layer }: { layer: Layer }): JSX.Element {
  const { width: W, height: H } = doc.value.canvas;
  const r = layer.rect;
  const set = (patch: Partial<typeof r>) => setLayer(layer.id, { rect: { ...r, ...patch } });
  return (
    <fieldset class="group">
      <legend>Position and size (px)</legend>
      <div class="grid4">
        <Num label="X" value={r.x * W} onChange={(v) => set({ x: v / W })} />
        <Num label="Y" value={r.y * H} onChange={(v) => set({ y: v / H })} />
        <Num label="W" value={r.w * W} onChange={(v) => set({ w: Math.max(2, v) / W })} />
        <Num label="H" value={r.h * H} onChange={(v) => set({ h: Math.max(2, v) / H })} />
      </div>
      <div class="btn-row">
        <button type="button" class="btn sm" onClick={() => set({ x: 0, y: 0, w: 1, h: 1 })}>
          Fill canvas
        </button>
        <button
          type="button"
          class="btn sm"
          onClick={() => set({ x: (1 - r.w) / 2, y: (1 - r.h) / 2 })}
        >
          Center
        </button>
      </div>
    </fieldset>
  );
}

function CaptureControls({ layer }: { layer: Layer }): JSX.Element | null {
  const cap = captures.value.find((c) => c.source === layer.source);
  const [list, setList] = useState<DeviceInfo[]>([]);
  const kind = layer.kind;
  useEffect(() => {
    if (kind !== "camera" && kind !== "mic") return;
    void listDevices()
      .then((d) => setList(kind === "camera" ? d.cams : d.mics))
      .catch(() => setList([]));
  }, [kind, cap?.label]);
  if (kind !== "display" && kind !== "camera" && kind !== "mic") return null;
  const current = kind === "camera" ? devices.value.camera : devices.value.mic;
  return (
    <fieldset class="group">
      <legend>Capture</legend>
      <p class="small">
        {cap ? (
          <>
            <span class="dot dot-live" /> {cap.label}
          </>
        ) : (
          <span class="muted">Not capturing</span>
        )}
      </p>
      {kind !== "display" && list.length > 0 && (
        <Field label={kind === "camera" ? "Camera" : "Microphone"}>
          <select
            value={current}
            onChange={(e) => {
              const id = e.currentTarget.value;
              devices.value = { ...devices.value, [kind === "camera" ? "camera" : "mic"]: id };
              void engine?.open(layer, id);
            }}
          >
            <option value="">System default</option>
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div class="btn-row">
        <button type="button" class="btn sm" onClick={() => void engine?.open(layer)}>
          <Icon name="refresh" size={15} />
          {cap ? (kind === "display" ? "Choose another" : "Reopen") : "Start"}
        </button>
        {cap && (
          <button
            type="button"
            class="btn sm"
            onClick={() => layer.source && engine?.release(layer.source)}
          >
            <Icon name="stop" size={15} /> Stop
          </button>
        )}
      </div>
    </fieldset>
  );
}

function LayerInspector({ layer }: { layer: Layer }): JSX.Element {
  const set = (patch: Partial<Layer>) => setLayer(layer.id, patch);
  const visual = layer.kind !== "mic";
  const others = doc.value.scenes.filter((s) => s.id !== activeScene.value.id);
  return (
    <div class="inspector-body" data-testid="inspector">
      <Field label="Name">
        <input
          value={layer.name}
          maxLength={LIMITS.name}
          onInput={(e) => set({ name: e.currentTarget.value })}
        />
      </Field>
      <CaptureControls layer={layer} />
      {layer.kind === "text" && layer.text && (
        <fieldset class="group">
          <legend>Text</legend>
          <textarea
            rows={3}
            maxLength={LIMITS.text}
            value={layer.text.value}
            aria-label="Text"
            onInput={(e) =>
              set({
                text: {
                  ...(layer.text as NonNullable<Layer["text"]>),
                  value: e.currentTarget.value,
                },
              })
            }
            data-testid="text-value"
          />
          <div class="grid2">
            <Field label="Font">
              <select
                value={layer.text.font}
                onChange={(e) =>
                  set({
                    text: {
                      ...(layer.text as NonNullable<Layer["text"]>),
                      font: e.currentTarget.value as (typeof FONTS)[number],
                    },
                  })
                }
              >
                {FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Size">
              <input
                type="number"
                min={8}
                max={400}
                value={layer.text.size}
                onChange={(e) => {
                  const size = Math.max(
                    8,
                    Math.min(400, Math.round(Number(e.currentTarget.value))),
                  );
                  if (Number.isFinite(size))
                    set({ text: { ...(layer.text as NonNullable<Layer["text"]>), size } });
                }}
              />
            </Field>
            <Field label="Color">
              <input
                type="color"
                value={layer.text.color}
                onInput={(e) =>
                  set({
                    text: {
                      ...(layer.text as NonNullable<Layer["text"]>),
                      color: e.currentTarget.value,
                    },
                  })
                }
              />
            </Field>
            <Field label="Align">
              <select
                value={layer.text.align}
                onChange={(e) =>
                  set({
                    text: {
                      ...(layer.text as NonNullable<Layer["text"]>),
                      align: e.currentTarget.value as "left" | "center" | "right",
                    },
                  })
                }
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </Field>
          </div>
          <label class="check">
            <input
              type="checkbox"
              checked={layer.text.weight === 700}
              onChange={(e) =>
                set({
                  text: {
                    ...(layer.text as NonNullable<Layer["text"]>),
                    weight: e.currentTarget.checked ? 700 : 400,
                  },
                })
              }
            />
            Bold
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={layer.text.background !== null}
              onChange={(e) =>
                set({
                  text: {
                    ...(layer.text as NonNullable<Layer["text"]>),
                    background: e.currentTarget.checked ? "#000000" : null,
                  },
                })
              }
            />
            Background
          </label>
          {layer.text.background !== null && (
            <Field label="Background color">
              <input
                type="color"
                value={layer.text.background}
                onInput={(e) =>
                  set({
                    text: {
                      ...(layer.text as NonNullable<Layer["text"]>),
                      background: e.currentTarget.value,
                    },
                  })
                }
              />
            </Field>
          )}
        </fieldset>
      )}
      {layer.kind === "color" && (
        <Field label="Color">
          <input
            type="color"
            value={layer.color}
            onInput={(e) => set({ color: e.currentTarget.value })}
          />
        </Field>
      )}
      {layer.kind === "mask" && layer.mask && (
        <fieldset class="group">
          <legend>Privacy mask</legend>
          <p class="small muted">
            Always drawn on top of everything. Solid is the safe choice: pixelated text can
            sometimes be recovered.
          </p>
          <fieldset class="segmented" aria-label="Mask style">
            {(["solid", "pixelate"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={layer.mask?.mode === m}
                onClick={() =>
                  set({ mask: { ...(layer.mask as NonNullable<Layer["mask"]>), mode: m } })
                }
              >
                {m === "solid" ? "Solid" : "Pixelate"}
              </button>
            ))}
          </fieldset>
          {layer.mask.mode === "solid" ? (
            <Field label="Color">
              <input
                type="color"
                value={layer.mask.color}
                onInput={(e) =>
                  set({
                    mask: {
                      ...(layer.mask as NonNullable<Layer["mask"]>),
                      color: e.currentTarget.value,
                    },
                  })
                }
              />
            </Field>
          ) : (
            <Slider
              label="Block size"
              value={layer.mask.block}
              min={4}
              max={128}
              step={1}
              onInput={(block) =>
                set({ mask: { ...(layer.mask as NonNullable<Layer["mask"]>), block } })
              }
            />
          )}
        </fieldset>
      )}
      {layer.audio && (
        <fieldset class="group">
          <legend>Audio</legend>
          <Slider
            label="Volume"
            value={layer.audio.gain}
            min={0}
            max={2}
            step={0.01}
            format={pct}
            onInput={(gain) =>
              set({ audio: { ...(layer.audio as NonNullable<Layer["audio"]>), gain } })
            }
          />
          {layer.kind === "mic" && (
            <Field
              label="Noise reduction"
              hint="Strong noise reduction runs RNNoise on this device."
            >
              <select
                value={layer.audio.noise}
                onChange={(e) => {
                  const noise = e.currentTarget.value as "off" | "browser" | "rnnoise";
                  const next = {
                    ...layer,
                    audio: { ...(layer.audio as NonNullable<Layer["audio"]>), noise },
                  };
                  set({ audio: next.audio });
                  void engine?.reopenWithNoise(next);
                }}
              >
                <option value="off">Off (raw)</option>
                <option value="browser">Browser</option>
                <option value="rnnoise">Strong (RNNoise)</option>
              </select>
            </Field>
          )}
        </fieldset>
      )}
      {visual && <Geometry layer={layer} />}
      {visual && layer.kind !== "mask" && (
        <fieldset class="group">
          <legend>Look</legend>
          <Slider
            label="Opacity"
            value={layer.opacity}
            min={0}
            max={1}
            step={0.01}
            format={pct}
            onInput={(opacity) => set({ opacity })}
          />
          <fieldset class="segmented" aria-label="Shape">
            {(["rect", "circle"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={layer.shape === s}
                onClick={() => set({ shape: s })}
              >
                {s === "rect" ? "Rectangle" : "Circle"}
              </button>
            ))}
          </fieldset>
          {layer.shape === "rect" && (
            <Slider
              label="Corner radius"
              value={layer.radius}
              min={0}
              max={0.5}
              step={0.01}
              format={pct}
              onInput={(radius) => set({ radius })}
            />
          )}
          {(layer.kind === "camera" ||
            layer.kind === "guest" ||
            layer.kind === "display" ||
            layer.kind === "image") && (
            <>
              <label class="check">
                <input
                  type="checkbox"
                  checked={layer.flip}
                  onChange={(e) => set({ flip: e.currentTarget.checked })}
                />
                Mirror
              </label>
              <details class="more">
                <summary>Crop</summary>
                {(["l", "t", "r", "b"] as const).map((k) => (
                  <Slider
                    key={k}
                    label={{ l: "Left", t: "Top", r: "Right", b: "Bottom" }[k]}
                    value={layer.crop[k]}
                    min={0}
                    max={0.45}
                    step={0.005}
                    format={pct}
                    onInput={(v) => set({ crop: { ...layer.crop, [k]: v } })}
                  />
                ))}
              </details>
              <details class="more">
                <summary>Chroma key</summary>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={layer.chroma !== null}
                    onChange={(e) =>
                      set({
                        chroma: e.currentTarget.checked
                          ? { color: "#00b140", similarity: 0.4, smoothness: 0.1 }
                          : null,
                      })
                    }
                  />
                  Remove a background color
                </label>
                {layer.chroma && (
                  <>
                    <Field label="Key color">
                      <input
                        type="color"
                        value={layer.chroma.color}
                        onInput={(e) =>
                          set({
                            chroma: {
                              ...(layer.chroma as NonNullable<Layer["chroma"]>),
                              color: e.currentTarget.value,
                            },
                          })
                        }
                      />
                    </Field>
                    <Slider
                      label="Similarity"
                      value={layer.chroma.similarity}
                      min={0}
                      max={1}
                      step={0.01}
                      format={pct}
                      onInput={(similarity) =>
                        set({
                          chroma: { ...(layer.chroma as NonNullable<Layer["chroma"]>), similarity },
                        })
                      }
                    />
                    <Slider
                      label="Smoothness"
                      value={layer.chroma.smoothness}
                      min={0}
                      max={1}
                      step={0.01}
                      format={pct}
                      onInput={(smoothness) =>
                        set({
                          chroma: { ...(layer.chroma as NonNullable<Layer["chroma"]>), smoothness },
                        })
                      }
                    />
                  </>
                )}
              </details>
            </>
          )}
        </fieldset>
      )}
      {others.length > 0 && (
        <Field label="Copy to scene" hint="Screens, cameras and microphones stay one capture.">
          <select
            value=""
            onChange={(e) => {
              const target = e.currentTarget.value;
              if (target) update((d) => copyLayerTo(d, layer.id, target));
              e.currentTarget.value = "";
            }}
          >
            <option value="">Choose a scene…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

function CanvasInspector(): JSX.Element {
  const d = doc.value;
  const busy = rec.value.kind !== "idle";
  const size = `${d.canvas.width}x${d.canvas.height}`;
  return (
    <div class="inspector-body">
      <p class="small muted">Select a source to edit it. These settings apply to every scene.</p>
      <Field label="Canvas" hint={busy ? "Locked while recording." : undefined}>
        <select
          value={size}
          disabled={busy}
          onChange={(e) => {
            const [w, h] = e.currentTarget.value.split("x").map(Number) as [number, number];
            update((x) => ({ ...x, canvas: { ...x.canvas, width: w, height: h } }));
          }}
          data-testid="canvas-size"
        >
          {SIZES.map(([w, h]) => (
            <option key={`${w}x${h}`} value={`${w}x${h}`}>
              {w} × {h}
              {h > w ? " (vertical)" : w === h ? " (square)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Frame rate">
        <select
          value={d.canvas.fps}
          disabled={busy}
          onChange={(e) => {
            const fps = Number(e.currentTarget.value);
            update((x) => ({ ...x, canvas: { ...x.canvas, fps } }));
          }}
        >
          {FPS.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </Field>
      <Field label="Scene transition">
        <select
          value={d.transition.kind}
          onChange={(e) => {
            const kind = e.currentTarget.value as "cut" | "fade";
            update((x) => ({ ...x, transition: { ...x.transition, kind } }));
          }}
        >
          <option value="cut">Cut</option>
          <option value="fade">Fade</option>
        </select>
      </Field>
      {d.transition.kind === "fade" && (
        <Slider
          label="Fade duration"
          value={d.transition.ms}
          min={100}
          max={2000}
          step={50}
          format={(v) => `${v} ms`}
          onInput={(ms) => update((x) => ({ ...x, transition: { ...x.transition, ms } }))}
        />
      )}
    </div>
  );
}

export function Inspector(): JSX.Element {
  const layer = selectedLayer.value;
  return (
    <section class="panel inspector" aria-labelledby="inspector-title">
      <header class="panel-head">
        <h2 id="inspector-title">{layer ? layer.name || "Source" : "Canvas"}</h2>
      </header>
      {layer ? <LayerInspector key={layer.id} layer={layer} /> : <CanvasInspector />}
    </section>
  );
}
