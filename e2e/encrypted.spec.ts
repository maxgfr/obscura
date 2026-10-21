import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openCaptures, recordFor, recordingBytes, storedRecordings, studio, text } from "./helpers";

const CLI = "cli/target/debug/obscura";
const PASS = "a long and random enough passphrase";

test("sealed recordings: only the passphrase opens them, with the CLI", async ({ browser }) => {
  const { page, errors, ctx } = await studio(browser);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("encrypt").click();
  await page.getByTestId("passphrase").fill(PASS);
  await page.getByTestId("passphrase-confirm").fill(PASS);
  await page.getByTestId("passphrase-submit").click();
  await expect(page.getByTestId("passphrase-sheet")).not.toBeVisible();
  await page.keyboard.press("Escape");

  await openCaptures(page);
  await recordFor(page, 2500);
  const [f] = await storedRecordings(page);
  expect(f?.name).toMatch(/\.mp4\.obscura$/);
  expect(text(f?.head ?? [], 0, 8)).toBe("OBSCURA1");
  // Nothing of the MP4 is readable in the sealed file.
  const bytes = await recordingBytes(page, f?.name as string);
  expect(bytes.includes(Buffer.from("ftyp"))).toBe(false);
  expect(bytes.includes(Buffer.from("moof"))).toBe(false);
  expect(errors).toEqual([]);
  await ctx.close();

  test.skip(!existsSync(CLI), "build the CLI first (cargo build --manifest-path cli/Cargo.toml)");
  const dir = mkdtempSync(join(tmpdir(), "obscura-e2e-"));
  const sealed = join(dir, f?.name as string);
  writeFileSync(sealed, bytes);
  const env = { ...process.env, OBSCURA_PASSPHRASE: PASS };
  const report = JSON.parse(
    execFileSync(CLI, ["inspect", "--verify", "--json", sealed], { env }).toString(),
  );
  expect(report.mime).toBe("video/mp4");
  expect(report.verified.complete).toBe(true);
  const out = execFileSync(CLI, ["decrypt", sealed], { env }).toString().trim();
  expect(out).toBe(sealed.replace(/\.obscura$/, ""));
  const mp4 = readFileSync(out);
  expect(mp4.subarray(4, 8).toString()).toBe("ftyp");
  const info = JSON.parse(execFileSync(CLI, ["inspect", "--json", out]).toString());
  expect(info.complete).toBe(true);
  expect(info.duration).toBeGreaterThan(1.5);
  expect(info.tracks.map((t: { kind: string }) => t.kind).sort()).toEqual(["audio", "video"]);
  expect(() =>
    execFileSync(CLI, ["decrypt", "-f", "-o", join(dir, "x.mp4"), sealed], {
      env: { ...process.env, OBSCURA_PASSPHRASE: "wrong" },
      stdio: "pipe",
    }),
  ).toThrow(/wrong passphrase/);
});
