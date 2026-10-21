/**
 * Studio state: the document (scenes and layers), the selection and the
 * running transition. The document is saved to localStorage on change —
 * layout only (see scene.ts) — and validated when read back.
 */
import { computed, effect, signal } from "@preact/signals";
import {
  defaultDoc,
  type Layer,
  type LayerKind,
  LIMITS,
  newId,
  newLayer,
  type Scene,
  type StudioDoc,
  validateDoc,
} from "./scene";

export const STORAGE_KEY = "obscura.studio.v1";

function load(): StudioDoc {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) return validateDoc(JSON.parse(raw));
  } catch {
    // Corrupted or from a newer version: start over rather than run on bad data.
  }
  return defaultDoc();
}

export const doc = signal<StudioDoc>(load());
export const selected = signal<string | null>(null);
/** The scene being faded out, and when the fade started (performance.now()). */
export const transition = signal<{ from: Scene; start: number } | null>(null);

export const activeScene = computed(
  () => doc.value.scenes[doc.value.active] ?? (doc.value.scenes[0] as Scene),
);
export const aspect = computed(() => doc.value.canvas.width / doc.value.canvas.height);
export const selectedLayer = computed(
  () => activeScene.value.layers.find((l) => l.id === selected.value) ?? null,
);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  const d = doc.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(d));
    } catch {
      // Storage full or blocked: the studio keeps working, unsaved.
    }
  }, 250);
});

// ── Pure updates (tested) ─────────────────────────────────────────────────

export function mapScene(d: StudioDoc, sceneId: string, fn: (s: Scene) => Scene): StudioDoc {
  return { ...d, scenes: d.scenes.map((s) => (s.id === sceneId ? fn(s) : s)) };
}

export function patchLayer(d: StudioDoc, layerId: string, patch: Partial<Layer>): StudioDoc {
  return {
    ...d,
    scenes: d.scenes.map((s) =>
      s.layers.some((l) => l.id === layerId)
        ? { ...s, layers: s.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)) }
        : s,
    ),
  };
}

/** Moves a layer up (+1, towards the front) or down (-1) in its scene. */
export function moveLayer(d: StudioDoc, layerId: string, by: number): StudioDoc {
  return {
    ...d,
    scenes: d.scenes.map((s) => {
      const i = s.layers.findIndex((l) => l.id === layerId);
      if (i < 0) return s;
      const j = Math.max(0, Math.min(s.layers.length - 1, i + by));
      if (i === j) return s;
      const layers = s.layers.slice();
      const [l] = layers.splice(i, 1);
      layers.splice(j, 0, l as Layer);
      return { ...s, layers };
    }),
  };
}

export function removeLayerFrom(d: StudioDoc, layerId: string): StudioDoc {
  return {
    ...d,
    scenes: d.scenes.map((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== layerId) })),
  };
}

/** Copies a layer into another scene; screen/camera/mic copies share the capture. */
export function copyLayerTo(d: StudioDoc, layerId: string, sceneId: string): StudioDoc {
  const layer = d.scenes.flatMap((s) => s.layers).find((l) => l.id === layerId);
  if (!layer) return d;
  return mapScene(d, sceneId, (s) =>
    s.layers.length >= LIMITS.layers
      ? s
      : { ...s, layers: [...s.layers, structuredClone({ ...layer, id: newId() })] },
  );
}

export function duplicateScene(d: StudioDoc, sceneId: string): StudioDoc {
  const i = d.scenes.findIndex((s) => s.id === sceneId);
  const s = d.scenes[i];
  if (!s || d.scenes.length >= LIMITS.scenes) return d;
  const copy: Scene = {
    id: newId(),
    name: `${s.name} copy`.slice(0, LIMITS.name),
    layers: s.layers.map((l) => structuredClone({ ...l, id: newId() })),
  };
  const scenes = d.scenes.slice();
  scenes.splice(i + 1, 0, copy);
  return { ...d, scenes };
}

export function removeScene(d: StudioDoc, sceneId: string): StudioDoc {
  if (d.scenes.length <= 1) return d;
  const scenes = d.scenes.filter((s) => s.id !== sceneId);
  return { ...d, scenes, active: Math.min(d.active, scenes.length - 1) };
}

// ── Actions ───────────────────────────────────────────────────────────────

export function update(fn: (d: StudioDoc) => StudioDoc): void {
  doc.value = fn(doc.value);
}

export function setLayer(layerId: string, patch: Partial<Layer>): void {
  update((d) => patchLayer(d, layerId, patch));
}

export function addLayer(kind: LayerKind, extra: Partial<Layer> = {}): Layer | null {
  const scene = activeScene.value;
  if (scene.layers.length >= LIMITS.layers) return null;
  const layer = { ...newLayer(kind, aspect.value), ...extra };
  update((d) => mapScene(d, scene.id, (s) => ({ ...s, layers: [...s.layers, layer] })));
  selected.value = layer.id;
  return layer;
}

export function removeLayer(layerId: string): void {
  update((d) => removeLayerFrom(d, layerId));
  if (selected.value === layerId) selected.value = null;
}

export function addScene(): void {
  update((d) =>
    d.scenes.length >= LIMITS.scenes
      ? d
      : {
          ...d,
          scenes: [...d.scenes, { id: newId(), name: `Scene ${d.scenes.length + 1}`, layers: [] }],
        },
  );
}

export function goToScene(index: number): void {
  const d = doc.value;
  if (index === d.active || index < 0 || index >= d.scenes.length) return;
  const from = activeScene.value;
  transition.value =
    d.transition.kind === "fade" && d.transition.ms > 0 ? { from, start: performance.now() } : null;
  doc.value = { ...d, active: index };
  selected.value = null;
}

export function replaceDoc(next: StudioDoc): void {
  doc.value = next;
  selected.value = null;
  transition.value = null;
}

/** Every capture slot in use, with its kind. */
export function sourcesIn(d: StudioDoc): Map<string, LayerKind> {
  const out = new Map<string, LayerKind>();
  for (const s of d.scenes) for (const l of s.layers) if (l.source) out.set(l.source, l.kind);
  return out;
}
