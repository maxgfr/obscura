/** Image layers' pictures, kept in the origin-private file system next to the recordings (obscura/assets). */
import { appDir, hasOpfs, moveFile } from "../record/storage";
import { newId } from "./scene";

const DIR = "assets";
export const MAX_IMAGE = 20 * 1024 * 1024;
const memory = new Map<string, Blob>();

function dir(): Promise<FileSystemDirectoryHandle> {
  return appDir(DIR);
}

/**
 * A picture an earlier version kept in `/assets`, at the top of OPFS: moved
 * into obscura's folder the first time a layer asks for it. Only pictures a
 * layer names are taken, as another site of the origin may use `/assets` too;
 * the old folder goes once empty.
 */
async function fromLegacy(id: string): Promise<Blob> {
  const root = await navigator.storage.getDirectory();
  const legacy = await root.getDirectoryHandle(DIR);
  const target = await dir();
  try {
    await moveFile(legacy, target, id);
  } catch {
    return (await legacy.getFileHandle(id)).getFile();
  }
  await root.removeEntry(DIR).catch(() => {});
  return (await target.getFileHandle(id)).getFile();
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
    const blob =
      memory.get(id) ??
      (await (
        await dir()
      )
        .getFileHandle(id)
        .then((h) => h.getFile())
        .catch(() => fromLegacy(id)));
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
