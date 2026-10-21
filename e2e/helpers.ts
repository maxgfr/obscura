import type { Browser, BrowserContext, Page } from "@playwright/test";

export const BASE = "http://localhost:4183";

export interface Studio {
  ctx: BrowserContext;
  page: Page;
  /** Uncaught errors, and any CSP or Trusted Types violation: tests assert it stays empty. */
  errors: string[];
}

/** A fresh studio: its own storage, fake camera and microphone, a fake screen to share. */
export async function studio(
  browser: Browser,
  path = "/?nosw",
  o: { offline?: boolean } = {},
): Promise<Studio> {
  const isChromium = browser.browserType().name() === "chromium";
  const ctx = await browser.newContext({
    ...(isChromium ? { permissions: ["camera", "microphone"] } : {}),
    acceptDownloads: true,
    ...(o.offline ? { serviceWorkers: "allow" as const } : {}),
  });
  await ctx.addInitScript(fakeDisplayMedia);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Content Security Policy|Trusted Type|TrustedScriptURL/i.test(m.text())
    )
      errors.push(m.text());
  });
  await page.goto(path);
  await page.getByTestId("stage").waitFor();
  return { ctx, page, errors };
}

/** Replaces the screen picker with an animated canvas (headless browsers have no screen). */
export function fakeDisplayMedia(): void {
  if (!navigator.mediaDevices) return;
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("No 2D canvas for the fake screen");
    let n = 0;
    const draw = () => {
      n++;
      g.fillStyle = "#1d3557";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#f1faee";
      g.font = "48px sans-serif";
      g.fillText(`Shared screen, frame ${n}`, 40, 100);
      g.fillRect((n * 8) % canvas.width, canvas.height / 2, 80, 80);
    };
    draw();
    const timer = setInterval(draw, 66);
    const stream = canvas.captureStream(15);
    for (const track of stream.getVideoTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => {
        clearInterval(timer);
        stop();
      };
    }
    return stream;
  };
}

export interface StoredFile {
  name: string;
  size: number;
  head: number[];
}

/** The recordings folder in the origin-private file system. */
export async function storedRecordings(page: Page): Promise<StoredFile[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("recordings", { create: true });
    const out: { name: string; size: number; head: number[] }[] = [];
    for await (const [name, h] of dir as unknown as AsyncIterable<[string, FileSystemFileHandle]>) {
      if (h.kind !== "file") continue;
      const f = await h.getFile();
      out.push({
        name,
        size: f.size,
        head: [...new Uint8Array(await f.slice(0, 64).arrayBuffer())],
      });
    }
    return out;
  });
}

/** A whole stored recording, as bytes. */
export async function recordingBytes(page: Page, name: string): Promise<Buffer> {
  const b64 = await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("recordings");
    const f = await (await dir.getFileHandle(n)).getFile();
    const bytes = new Uint8Array(await f.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  return Buffer.from(b64, "base64");
}

export const text = (head: number[], from: number, to: number) =>
  String.fromCharCode(...head.slice(from, to));

/** Records for `ms` with the Record button (a real click: audio needs a user gesture). */
export async function recordFor(page: Page, ms: number): Promise<void> {
  await page.getByTestId("record").click();
  await page.getByTestId("stop").waitFor();
  await page.waitForTimeout(ms);
  await page.getByTestId("stop").click();
  await page.getByTestId("saved").waitFor();
}

/** Opens the screen and camera of the default scene. */
export async function openCaptures(page: Page): Promise<void> {
  await page.getByTestId("pick-display").click();
  await page.getByTestId("pick-camera").click();
  await page.getByTestId("captures").getByRole("listitem").nth(1).waitFor();
}
