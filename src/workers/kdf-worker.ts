/** Argon2id off the main thread, so the studio keeps rendering while a passphrase is stretched. */
import { deriveKeyBytes } from "../crypto/kdf";

interface Req {
  passphrase: string;
  salt: Uint8Array;
  kdf: { m: number; t: number; p: number };
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const post = (m: unknown, t: Transferable[] = []) =>
    (self as unknown as Worker).postMessage(m, t);
  try {
    const { passphrase, salt, kdf } = e.data;
    const key = await deriveKeyBytes(passphrase, salt, kdf, (p) => post({ progress: p }));
    post({ key }, [key.buffer]);
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
