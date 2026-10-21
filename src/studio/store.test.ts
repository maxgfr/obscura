import { describe, expect, test } from "bun:test";
import { defaultDoc, newLayer, validateDoc } from "./scene";
import {
  copyLayerTo,
  duplicateScene,
  moveLayer,
  patchLayer,
  removeLayerFrom,
  removeScene,
  sourcesIn,
} from "./store";

describe("document updates", () => {
  test("patch, move and remove a layer; the result stays valid", () => {
    let d = defaultDoc();
    const [a, b] = d.scenes[0]?.layers ?? [];
    if (!a || !b) throw new Error("fixture");
    d = patchLayer(d, a.id, { opacity: 0.5 });
    expect(d.scenes[0]?.layers[0]?.opacity).toBe(0.5);
    d = moveLayer(d, a.id, +1);
    expect(d.scenes[0]?.layers.map((l) => l.id).slice(0, 2)).toEqual([b.id, a.id]);
    d = moveLayer(d, a.id, +99);
    expect(d.scenes[0]?.layers.at(-1)?.id).toBe(a.id);
    d = removeLayerFrom(d, a.id);
    expect(d.scenes[0]?.layers.some((l) => l.id === a.id)).toBe(false);
    expect(() => validateDoc(JSON.parse(JSON.stringify(d)))).not.toThrow();
  });

  test("a copied camera shares its capture, with a new layer id", () => {
    const d0 = defaultDoc();
    const cam = d0.scenes[0]?.layers.find((l) => l.kind === "camera");
    const target = d0.scenes[1];
    if (!cam || !target) throw new Error("fixture");
    const d = copyLayerTo(d0, cam.id, target.id);
    const copy = d.scenes[1]?.layers.at(-1);
    expect(copy?.source).toBe(cam.source as string);
    expect(copy?.id).not.toBe(cam.id);
    expect(() => validateDoc(JSON.parse(JSON.stringify(d)))).not.toThrow();
  });

  test("duplicate and remove scenes; the last scene stays", () => {
    let d = defaultDoc();
    const first = d.scenes[0]?.id as string;
    d = duplicateScene(d, first);
    expect(d.scenes).toHaveLength(3);
    expect(d.scenes[1]?.name).toMatch(/copy$/);
    expect(() => validateDoc(JSON.parse(JSON.stringify(d)))).not.toThrow();
    d = { ...d, active: 2 };
    d = removeScene(d, d.scenes[2]?.id as string);
    expect(d.active).toBe(1);
    for (const s of d.scenes.slice(1)) d = removeScene(d, s.id);
    d = removeScene(d, d.scenes[0]?.id as string);
    expect(d.scenes).toHaveLength(1);
  });

  test("lists capture slots", () => {
    const d = defaultDoc();
    d.scenes[0]?.layers.push(newLayer("text"));
    const kinds = [...sourcesIn(d).values()].sort();
    expect(kinds).toEqual(["camera", "display", "mic"]);
  });
});
