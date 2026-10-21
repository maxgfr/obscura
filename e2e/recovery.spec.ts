import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openCaptures, recordingBytes, storedRecordings, studio, text } from "./helpers";

test("a recording cut by a closed tab is kept, playable up to the cut", async ({ browser }) => {
  const { page, ctx } = await studio(browser);
  await openCaptures(page);
  await page.getByTestId("record").click();
  await page.getByTestId("stop").waitFor();
  await page.waitForTimeout(3500);
  // The tab goes away mid-recording (no chance to finish the file).
  await page.reload();
  await page.getByTestId("stage").waitFor();
  await expect(page.getByText(/interrupted/i).first()).toBeVisible();

  const [f] = await storedRecordings(page);
  expect(f?.name).toMatch(/\.mp4\.part$/);
  expect(text(f?.head ?? [], 4, 8)).toBe("ftyp");
  await page.getByTestId("open-recordings").click();
  await expect(page.getByTestId("recordings")).toContainText("Interrupted");

  const CLI = "cli/target/debug/obscura";
  if (existsSync(CLI)) {
    const dir = mkdtempSync(join(tmpdir(), "obscura-e2e-"));
    const path = join(dir, "cut.mp4");
    writeFileSync(path, await recordingBytes(page, f?.name as string));
    const info = JSON.parse(execFileSync(CLI, ["inspect", "--json", path]).toString());
    expect(info.fragments).toBeGreaterThan(0);
    if (!info.complete) {
      const fixed = execFileSync(CLI, ["repair", path]).toString().trim();
      const again = JSON.parse(execFileSync(CLI, ["inspect", "--json", fixed]).toString());
      expect(again.complete).toBe(true);
    }
  }

  await page.getByTestId("delete-recording").click();
  await expect(page.getByTestId("recordings")).toHaveCount(0);
  await ctx.close();
});
