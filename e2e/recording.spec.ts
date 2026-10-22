import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openCaptures, recordFor, recordingBytes, storedRecordings, studio, text } from "./helpers";

test("records the program to fragmented MP4, written to disk as it goes", async ({ browser }) => {
  const { page, errors, ctx } = await studio(browser);
  await openCaptures(page);
  // The microphone is on by default.
  await expect(page.getByTestId("captures").getByRole("listitem")).toHaveCount(3);

  const started = Date.now();
  await page.getByTestId("record").click();
  await page.getByTestId("stop").waitFor();
  await page.waitForTimeout(1500);
  // While recording, the .part file already holds data.
  const live = await storedRecordings(page);
  expect(live).toHaveLength(1);
  expect(live[0]?.name).toMatch(/^obscura-\d{8}-\d{6}\.mp4\.part$/);
  await page.getByTestId("pause").click();
  await page.waitForTimeout(500);
  await page.getByTestId("pause").click();
  await page.waitForTimeout(1500);
  await page.getByTestId("stop").click();
  const wall = (Date.now() - started) / 1000;
  await page.getByTestId("saved").waitFor();

  const files = await storedRecordings(page);
  expect(files).toHaveLength(1);
  const f = files[0] as NonNullable<(typeof files)[0]>;
  expect(f.name).toMatch(/^obscura-\d{8}-\d{6}\.mp4$/);
  expect(text(f.head, 4, 8)).toBe("ftyp");
  expect(f.size).toBeGreaterThan(5_000);

  // It plays, at the canvas size.
  const meta = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("recordings");
    const file = await (await dir.getFileHandle(name)).getFile();
    const v = document.createElement("video");
    v.muted = true;
    v.src = URL.createObjectURL(file);
    await new Promise((ok, ko) => {
      v.onloadedmetadata = ok;
      v.onerror = () => ko(new Error(v.error?.message ?? "no playback"));
    });
    return { w: v.videoWidth, h: v.videoHeight };
  }, f.name);
  expect(meta).toEqual({ w: 1280, h: 720 });

  // About the time recorded, pause excluded, with both tracks (read by the CLI).
  const CLI = "cli/target/debug/obscura";
  if (existsSync(CLI)) {
    const path = join(mkdtempSync(join(tmpdir(), "obscura-e2e-")), f.name);
    writeFileSync(path, await recordingBytes(page, f.name));
    const info = JSON.parse(execFileSync(CLI, ["inspect", "--json", path]).toString());
    expect(info.complete).toBe(true);
    expect(info.duration).toBeGreaterThan(2);
    // The half-second pause is not in the file.
    expect(info.duration).toBeLessThan(wall - 0.3);
    expect(info.tracks.map((t: { kind: string }) => t.kind).sort()).toEqual(["audio", "video"]);
  }

  // Releasing a capture from the indicator stops it.
  await page.getByRole("button", { name: /Stop capturing .*(audio|microphone)/i }).click();
  await expect(page.getByTestId("captures").getByRole("listitem")).toHaveCount(2);
  // A microphone the user stopped stays off until turned back on.
  await page.keyboard.press("2");
  await page.keyboard.press("1");
  await expect(page.getByTestId("captures").getByRole("listitem")).toHaveCount(2);
  await page.getByTestId("mic-on").click();
  await expect(page.getByTestId("captures").getByRole("listitem")).toHaveCount(3);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("records WebM when chosen", async ({ browser }) => {
  const { page, errors, ctx } = await studio(browser);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("container").selectOption("webm");
  await page.keyboard.press("Escape");
  await openCaptures(page);
  await recordFor(page, 2000);
  const [f] = await storedRecordings(page);
  expect(f?.name).toMatch(/\.webm$/);
  expect(f?.head.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  expect(errors).toEqual([]);
  await ctx.close();
});
