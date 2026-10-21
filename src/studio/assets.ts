/** Image layers' pictures, kept in the origin-private file system next to the recordings. */
import { hasOpfs } from "../record/storage";
import { newId } from "./scene";

const DIR = "assets";
export const MAX_IMAGE = 20 * 1024 * 1024;
const memory = new Map<string, Blob>();

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function storeImage(file: Blob): Promise<string> {
  if (file.size > MAX_IMAGE) throw new Error("Images are limited to 20 MB.");
  if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type))
    throw new Error("Use a PNG, JPEG, WebP, GIF or AVIF image.");
  // Decoding first: what is stored is something the browser can draw.
  (await createImageBitmap(file)).close();
  const id = newId();
  if (hasOpfs()) {
    try {
      const h = await (await dir()).getFileHandle(id, { create: true });
      const w = await (
        h as FileSystemFileHandle & { createWritable(): Promise<WritableStream> }
      ).createWritable();
      await file.stream().pipeTo(w);
      return id;
    } catch {
      // Fall through: kept for this session only.
    }
  }
  memory.set(id, file);
  return id;
}

export async function loadImage(id: string): Promise<ImageBitmap | null> {
  try {
    const blob = memory.get(id) ?? (await (await (await dir()).getFileHandle(id)).getFile());
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Deletes pictures no layer uses any more. */
export async function pruneImages(used: Set<string>): Promise<void> {
  for (const id of memory.keys()) if (!used.has(id)) memory.delete(id);
  if (!hasOpfs()) return;
  try {
    const d = await dir();
    const names: string[] = [];
    for await (const [n] of d as unknown as AsyncIterable<[string, FileSystemHandle]>)
      names.push(n);
    for (const n of names) if (!used.has(n)) await d.removeEntry(n).catch(() => {});
  } catch {
    // Nothing to prune.
  }
}
