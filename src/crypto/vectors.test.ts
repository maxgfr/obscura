import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeLink } from "../studio/scene";
import { deriveKeyBytes, importKey } from "./kdf";
import { openSealed } from "./stream";

const V = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../../cli/tests/vectors.json"), "utf8"),
);
const from64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

describe("shared vectors (also checked by the CLI)", () => {
  test("argon2id key", async () => {
    const k = V.kdf;
    const key = await deriveKeyBytes(k.passphrase, Buffer.from(k.salt, "hex"), k);
    expect(Buffer.from(key).toString("hex")).toBe(k.key);
  });

  test("sealed file opens, truncated one only with partial", async () => {
    const keyFor = async (h: { salt: Uint8Array; kdf: { m: number; t: number; p: number } }) =>
      importKey(await deriveKeyBytes(V.sealed.passphrase, h.salt, h.kdf));
    const res = await openSealed(from64(V.sealed.file), keyFor);
    expect(res.plaintext).toEqual(from64(V.sealed.plaintext));
    await expect(openSealed(from64(V.sealed.truncated), keyFor)).rejects.toThrow(/truncated/);
    const part = await openSealed(from64(V.sealed.truncated), keyFor, { partial: true });
    expect(part.plaintext).toEqual(from64(V.sealed.truncated_plaintext));
  });

  test("link", async () => {
    expect(await decodeLink(`#${V.link.fragment}`)).toEqual(V.link.doc);
  });
});
