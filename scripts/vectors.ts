/**
 * Writes cli/tests/vectors.json: sealed files and a studio link made by the
 * web app's code, which the Rust CLI must open byte for byte (cli/src/vectors.rs),
 * and which src/crypto/vectors.test.ts re-checks on the TypeScript side.
 * Run with `bun run vectors` after changing the format; commit the output.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveKeyBytes, importKey } from "../src/crypto/kdf";
import { concat, Sealer } from "../src/crypto/stream";
import { encodeLink, newLayer, type StudioDoc } from "../src/studio/scene";

const OUT = resolve(import.meta.dir, "../cli/tests/vectors.json");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Deterministic bytes, so regenerating only changes what the format changes. */
function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export async function makeVectors() {
  const passphrase = "correct horse battery staple";
  const kdf = { m: 256, t: 2, p: 1 };
  const salt = bytes(16, 1);
  const raw = await deriveKeyBytes(passphrase, salt, kdf);
  const keyHex = hex(raw);
  const key = await importKey(raw);
  const plaintext = bytes(3000, 2);
  const header = { kdf, salt, noncePrefix: bytes(7, 3), chunkLog2: 10, mime: "video/mp4" };
  const parts: Uint8Array[] = [];
  const s = await Sealer.create(key, header, async (b) => {
    parts.push(b);
  });
  await s.push(plaintext);
  await s.finish();
  const sealed = concat(parts);
  const headerLen = (parts[0] as Uint8Array).length;

  const doc: StudioDoc = {
    v: 1,
    canvas: { width: 1280, height: 720, fps: 30 },
    transition: { kind: "cut", ms: 0 },
    active: 0,
    scenes: [
      {
        id: "s1",
        name: "Vector scene ✓",
        layers: [
          { ...newLayer("display"), id: "l1", source: "src1" },
          { ...newLayer("text"), id: "l2" },
          { ...newLayer("mask"), id: "l3" },
        ],
      },
    ],
  };

  return {
    kdf: { passphrase, salt: hex(salt), ...kdf, key: keyHex },
    sealed: {
      passphrase,
      file: b64(sealed),
      plaintext: b64(plaintext),
      // Cut after two whole chunks: a crash; --partial recovers 2048 bytes.
      truncated: b64(sealed.subarray(0, headerLen + 2 * (1024 + 16))),
      truncated_plaintext: b64(plaintext.subarray(0, 2048)),
    },
    link: { fragment: await encodeLink(doc), doc },
  };
}

if (import.meta.main) {
  writeFileSync(OUT, `${JSON.stringify(await makeVectors(), null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}
