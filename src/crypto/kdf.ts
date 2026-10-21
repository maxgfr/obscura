/**
 * Passphrase → AES-256-GCM key, with Argon2id (memory-hard). Runs in a
 * worker in the app (workers/kdf-worker.ts) so the studio keeps rendering;
 * the raw bytes are imported as a non-extractable key and wiped.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";
import type { KdfParams } from "./format";

export async function deriveKeyBytes(
  passphrase: string,
  salt: Uint8Array,
  kdf: KdfParams,
  onProgress?: (p: number) => void,
): Promise<Uint8Array> {
  // The passphrase is hashed as typed (UTF-8, no normalization), the same as the CLI.
  return argon2idAsync(new TextEncoder().encode(passphrase), salt, {
    m: kdf.m,
    t: kdf.t,
    p: kdf.p,
    dkLen: 32,
    asyncTick: 25,
    maxmem: (kdf.m + 1024) * 1024,
    ...(onProgress ? { onProgress } : {}),
  });
}

export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    raw.fill(0);
  }
}
