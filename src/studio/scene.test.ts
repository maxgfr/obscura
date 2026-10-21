import { describe, expect, test } from "bun:test";
import {
  decodeLink,
  defaultDoc,
  encodeLink,
  LAYER_KINDS,
  newLayer,
  type StudioDoc,
  toBase64Url,
  validateDoc,
} from "./scene";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("validateDoc", () => {
  test("accepts the default document and every kind of layer", () => {
    const doc = defaultDoc();
    doc.scenes[0]?.layers.push(...LAYER_KINDS.map((k) => newLayer(k)));
    expect(validateDoc(clone(doc))).toEqual(doc);
  });

  test("a camera bubble is square in pixels", () => {
    const r = newLayer("camera", 16 / 9).rect;
    expect(r.w * 1920).toBeCloseTo(r.h * 1080, 5);
  });

  const broken: [string, (d: StudioDoc & Record<string, unknown>) => void, RegExp][] = [
    ["unknown top-level field", (d) => (d.extra = 1), /unknown field "extra"/],
    ["bad version", (d) => ((d as { v: number }).v = 2), /version/],
    ["no scenes", (d) => (d.scenes = []), /scenes/],
    ["active out of range", (d) => (d.active = 9), /active/],
    ["odd canvas", (d) => (d.canvas.width = 1921), /even|width/],
    ["bad fps", (d) => (d.canvas.fps = 29), /fps/],
    [
      "duplicate ids",
      (d) => {
        const s = d.scenes[0];
        if (s?.layers[0] && s.layers[1]) s.layers[1].id = s.layers[0].id;
      },
      /duplicate/,
    ],
    [
      "device id smuggled in",
      (d) => {
        (d.scenes[0]?.layers[0] as unknown as Record<string, unknown>).deviceId = "abc";
      },
      /unknown field "deviceId"/,
    ],
    [
      "text on a camera layer",
      (d) => {
        const l = d.scenes[0]?.layers[1];
        if (l) l.text = newLayer("text").text as NonNullable<typeof l.text>;
      },
      /does not apply/,
    ],
    [
      "crop hides everything",
      (d) => {
        const l = d.scenes[0]?.layers[0];
        if (l) l.crop = { l: 0.5, r: 0.5, t: 0, b: 0 };
      },
      /nothing left/,
    ],
    [
      "bad color",
      (d) => {
        d.scenes[0]?.layers.push({ ...newLayer("color"), color: "red" });
      },
      /#rrggbb/,
    ],
    [
      "NaN opacity",
      (d) => {
        const l = d.scenes[0]?.layers[0];
        if (l) l.opacity = Number.NaN;
      },
      /opacity/,
    ],
  ];
  for (const [name, mutate, err] of broken) {
    test(`rejects: ${name}`, () => {
      const d = clone(defaultDoc()) as StudioDoc & Record<string, unknown>;
      mutate(d);
      expect(() => validateDoc(JSON.parse(JSON.stringify(d)))).toThrow(err);
    });
  }
});

describe("links", () => {
  test("round-trip through the fragment, without local images", async () => {
    const doc = defaultDoc();
    doc.scenes[0]?.layers.push({ ...newLayer("image"), image: "abc123" });
    const link = await encodeLink(doc);
    expect(link).toMatch(/^s=[A-Za-z0-9_-]+$/);
    const back = await decodeLink(`#${link}`);
    expect(back.scenes[0]?.layers.at(-1)?.image).toBeUndefined();
    expect(back.scenes[1]).toEqual(doc.scenes[1] as NonNullable<(typeof doc.scenes)[1]>);
  });

  test("rejects garbage and decompression bombs", async () => {
    await expect(decodeLink("#s=!!")).rejects.toThrow();
    await expect(decodeLink("#x=abc")).rejects.toThrow(/no scene/);
    await expect(decodeLink("#s=AAAA")).rejects.toThrow();
    const bomb = new Response(
      new Blob([new Uint8Array(4 * 1024 * 1024)])
        .stream()
        .pipeThrough(new CompressionStream("deflate-raw")),
    );
    const b64 = toBase64Url(new Uint8Array(await bomb.arrayBuffer()));
    await expect(decodeLink(`#s=${b64}`)).rejects.toThrow(/too large|too long/);
  });
});
