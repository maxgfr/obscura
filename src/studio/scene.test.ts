import { describe, expect, test } from "bun:test";
import {
  decodeLink,
  defaultDoc,
  encodeLink,
  LAYER_KINDS,
  type Layer,
  newLayer,
  type Scene,
  type StudioDoc,
  tile,
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

describe("split screen", () => {
  const people = (n: number, screen: boolean): Scene => ({
    id: "s1",
    name: "Live",
    layers: [
      ...(screen ? [newLayer("display")] : []),
      newLayer("camera"),
      ...Array.from({ length: n - 1 }, () => newLayer("guest")),
      newLayer("mic"),
    ],
  });
  const inside = (r: { x: number; y: number; w: number; h: number }) =>
    r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;
  const overlap = (a: Layer, b: Layer) =>
    a.rect.x < b.rect.x + b.rect.w - 1e-9 &&
    b.rect.x < a.rect.x + a.rect.w - 1e-9 &&
    a.rect.y < b.rect.y + b.rect.h - 1e-9 &&
    b.rect.y < a.rect.y + a.rect.h - 1e-9;

  for (const screen of [false, true])
    for (const aspect of [16 / 9, 9 / 16])
      for (let n = 1; n <= 4; n++)
        test(`${n} people${screen ? " beside a screen" : ""}, ${aspect > 1 ? "wide" : "tall"}: tiles fill the canvas without overlapping`, () => {
          const out = tile(people(n, screen), aspect);
          const tiles = out.layers.filter((l) => l.kind !== "mic");
          expect(tiles).toHaveLength(n + (screen ? 1 : 0));
          for (const t of tiles) expect(inside(t.rect)).toBe(true);
          for (const a of tiles)
            for (const b of tiles) if (a !== b) expect(overlap(a, b)).toBe(false);
          for (const t of tiles.filter((l) => l.kind !== "display")) expect(t.shape).toBe("rect");
          // Still a valid document.
          expect(() => validateDoc({ ...defaultDoc(), scenes: [out], active: 0 })).not.toThrow();
        });

  test("two people on a wide canvas sit side by side", () => {
    const out = tile(people(2, false), 16 / 9).layers.filter((l) => l.kind !== "mic");
    expect(out.map((l) => l.rect)).toEqual([
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ]);
  });

  test("hidden layers and other sources are left alone", () => {
    const s = people(2, false);
    const text = newLayer("text");
    const hidden = { ...newLayer("guest"), visible: false };
    const out = tile({ ...s, layers: [...s.layers, text, hidden] }, 16 / 9);
    expect(out.layers.find((l) => l.id === text.id)).toEqual(text);
    expect(out.layers.find((l) => l.id === hidden.id)).toEqual(hidden);
  });
});
