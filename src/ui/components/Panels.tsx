/** Scenes and layers of the active scene. */
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { canCaptureScreen } from "../../capture/capture";
import { storeImage } from "../../studio/assets";
import { captures, engine } from "../../studio/engine";
import { type LayerKind, LIMITS } from "../../studio/scene";
import {
  activeScene,
  addLayer,
  addScene,
  doc,
  duplicateScene,
  goToScene,
  mapScene,
  moveLayer,
  removeLayer,
  removeScene,
  selected,
  setLayer,
  update,
} from "../../studio/store";
import { toast } from "../toast";
import { Icon, KIND_ICON } from "./Icons";

export function ScenesPanel(): JSX.Element {
  const d = doc.value;
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <section class="panel" aria-labelledby="scenes-title">
      <header class="panel-head">
        <h2 id="scenes-title">Scenes</h2>
        <button
          type="button"
          class="icon-btn"
          aria-label="Add scene"
          title="Add scene"
          disabled={d.scenes.length >= LIMITS.scenes}
          onClick={addScene}
          data-testid="add-scene"
        >
          <Icon name="plus" />
        </button>
      </header>
      <ol class="list" data-testid="scenes">
        {d.scenes.map((s, i) => (
          <li key={s.id} class={i === d.active ? "row active" : "row"}>
            {editing === s.id ? (
              <input
                class="row-input"
                value={s.name}
                maxLength={LIMITS.name}
                aria-label="Scene name"
                ref={(el) => el?.focus()}
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && setEditing(null)}
                onInput={(e) => {
                  const name = e.currentTarget.value;
                  update((x) => mapScene(x, s.id, (sc) => ({ ...sc, name })));
                }}
              />
            ) : (
              <button
                type="button"
                class="row-main"
                onClick={() => goToScene(i)}
                onDblClick={() => setEditing(s.id)}
                aria-current={i === d.active ? "true" : undefined}
                data-testid={`scene-${i}`}
              >
                <span class="kbd">{i < 9 ? i + 1 : ""}</span>
                <span class="row-name">{s.name || "Untitled"}</span>
              </button>
            )}
            <div class="row-actions">
              <button
                type="button"
                class="icon-btn sm"
                aria-label={`Rename ${s.name}`}
                title="Rename"
                onClick={() => setEditing(s.id)}
              >
                <Icon name="text" size={15} />
              </button>
              <button
                type="button"
                class="icon-btn sm"
                aria-label={`Duplicate ${s.name}`}
                title="Duplicate"
                onClick={() => update((x) => duplicateScene(x, s.id))}
              >
                <Icon name="copy" size={15} />
              </button>
              <button
                type="button"
                class="icon-btn sm"
                aria-label={`Delete ${s.name}`}
                title="Delete"
                disabled={d.scenes.length <= 1}
                onClick={() => update((x) => removeScene(x, s.id))}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const ADDABLE: { kind: LayerKind; label: string }[] = [
  { kind: "display", label: "Screen, window or tab" },
  { kind: "camera", label: "Camera" },
  { kind: "mic", label: "Microphone" },
  { kind: "image", label: "Image" },
  { kind: "text", label: "Text" },
  { kind: "color", label: "Color" },
  { kind: "mask", label: "Privacy mask" },
];

export function LayersPanel(): JSX.Element {
  const scene = activeScene.value;
  const [menu, setMenu] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const live = new Set(captures.value.map((c) => c.source));
  const full = scene.layers.length >= LIMITS.layers;

  const add = async (kind: LayerKind) => {
    setMenu(false);
    if (kind === "image") {
      file.current?.click();
      return;
    }
    const layer = addLayer(kind);
    if (layer && (kind === "display" || kind === "camera" || kind === "mic"))
      await engine?.open(layer);
  };

  const onFile = async (e: JSX.TargetedEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!f) return;
    try {
      const id = await storeImage(f);
      const bmp = await createImageBitmap(f);
      const ratio = bmp.width / bmp.height;
      bmp.close();
      const d = doc.value;
      const canvasAspect = d.canvas.width / d.canvas.height;
      const w = Math.min(0.5, (0.5 * ratio) / canvasAspect);
      const h = (w * canvasAspect) / ratio;
      addLayer("image", {
        image: id,
        name: f.name.slice(0, LIMITS.name),
        rect: { x: (1 - w) / 2, y: (1 - h) / 2, w, h },
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add this image.", "error");
    }
  };

  // Front-most first, like any layer list.
  const ordered = scene.layers.slice().reverse();

  return (
    <section class="panel" aria-labelledby="layers-title">
      <header class="panel-head">
        <h2 id="layers-title">Sources</h2>
        <div class="menu-wrap">
          <button
            type="button"
            class="icon-btn"
            aria-label="Add source"
            title="Add source"
            aria-expanded={menu}
            aria-haspopup="menu"
            disabled={full}
            onClick={() => setMenu(!menu)}
            data-testid="add-source"
          >
            <Icon name="plus" />
          </button>
          {menu && (
            <div class="menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
              {ADDABLE.map((a) => (
                <button
                  key={a.kind}
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  disabled={a.kind === "display" && !canCaptureScreen()}
                  onClick={() => void add(a.kind)}
                  data-testid={`add-${a.kind}`}
                >
                  <Icon name={KIND_ICON[a.kind] ?? "plus"} />
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          onChange={onFile}
          data-testid="image-input"
        />
      </header>
      {ordered.length === 0 ? (
        <p class="empty">This scene is empty. Add a screen, a camera or some text.</p>
      ) : (
        <ol class="list" data-testid="layers">
          {ordered.map((l) => {
            const waiting = l.source && !live.has(l.source);
            return (
              <li key={l.id} class={l.id === selected.value ? "row active" : "row"}>
                <button
                  type="button"
                  class="row-main"
                  onClick={() => (selected.value = l.id)}
                  aria-pressed={l.id === selected.value}
                  data-testid={`layer-${l.kind}`}
                >
                  <Icon name={KIND_ICON[l.kind] ?? "layers"} size={16} />
                  <span class={l.visible ? "row-name" : "row-name dim"}>{l.name}</span>
                  {waiting && <span class="dot dot-warn" title="Not capturing" />}
                </button>
                <div class="row-actions">
                  <button
                    type="button"
                    class="icon-btn sm"
                    aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                    title={l.visible ? "Hide" : "Show"}
                    onClick={() => setLayer(l.id, { visible: !l.visible })}
                  >
                    <Icon name={l.visible ? "eye" : "eyeOff"} size={15} />
                  </button>
                  <button
                    type="button"
                    class="icon-btn sm"
                    aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
                    title={l.locked ? "Unlock" : "Lock"}
                    onClick={() => setLayer(l.id, { locked: !l.locked })}
                  >
                    <Icon name={l.locked ? "lock" : "unlock"} size={15} />
                  </button>
                  <button
                    type="button"
                    class="icon-btn sm"
                    aria-label={`Bring ${l.name} forward`}
                    title="Forward"
                    onClick={() => update((d) => moveLayer(d, l.id, +1))}
                  >
                    <Icon name="up" size={15} />
                  </button>
                  <button
                    type="button"
                    class="icon-btn sm"
                    aria-label={`Send ${l.name} backward`}
                    title="Backward"
                    onClick={() => update((d) => moveLayer(d, l.id, -1))}
                  >
                    <Icon name="down" size={15} />
                  </button>
                  <button
                    type="button"
                    class="icon-btn sm"
                    aria-label={`Remove ${l.name}`}
                    title="Remove"
                    onClick={() => removeLayer(l.id)}
                    data-testid={`remove-${l.kind}`}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
