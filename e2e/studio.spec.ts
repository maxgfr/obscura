import { expect, test } from "@playwright/test";
import { studio } from "./helpers";

test("scenes and sources: add, switch, persist, share", async ({ browser }) => {
  const { page, errors, ctx } = await studio(browser);
  await expect(page.getByTestId("scenes").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("layers").getByRole("listitem")).toHaveCount(3);

  await page.getByTestId("add-source").click();
  await page.getByTestId("add-text").click();
  await expect(page.getByTestId("layers").getByRole("listitem")).toHaveCount(4);
  await page.getByTestId("text-value").fill("Recorded with obscura");

  await page.getByTestId("add-scene").click();
  await expect(page.getByTestId("scenes").getByRole("listitem")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await page.locator("body").press("2");
  await expect(page.getByTestId("scene-1")).toHaveAttribute("aria-current", "true");

  // Layouts survive a reload (localStorage), without any device id in them.
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => localStorage.getItem("obscura.studio.v1") ?? "");
  expect(saved).toContain("Recorded with obscura");
  expect(saved).not.toMatch(/deviceId|groupId|label/);
  await page.reload();
  await expect(page.getByTestId("scenes").getByRole("listitem")).toHaveCount(3);

  // A shared link carries the layout to a fresh browser.
  await page.getByTestId("open-share").click();
  await expect(page.getByTestId("share-link")).toHaveValue(/#s=[A-Za-z0-9_-]+$/);
  const link = await page.getByTestId("share-link").inputValue();
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(link.replace(/^https?:\/\/[^/]+/, "").replace(/^\/#/, "/?nosw#"));
  await expect(p2.getByTestId("scenes").getByRole("listitem")).toHaveCount(3);
  await p2.getByTestId("scene-0").click();
  await expect(p2.getByTestId("layers")).toContainText("Text");
  expect(p2.url()).not.toContain("#s=");
  await other.close();

  expect(errors).toEqual([]);
  await ctx.close();
});

test("a layout link made by the CLI opens in the studio", async ({ browser }) => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const bin = "cli/target/debug/obscura";
  test.skip(!existsSync(bin), "build the CLI first (cargo build --manifest-path cli/Cargo.toml)");
  const link = execFileSync(bin, ["new", "--base", "http://localhost:4183/?nosw"])
    .toString()
    .trim();
  const { page, errors, ctx } = await studio(browser, "/?nosw");
  await page.goto(link.replace("http://localhost:4183", ""));
  await expect(page.getByTestId("scenes").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("layers").getByRole("listitem")).toHaveCount(3);
  expect(errors).toEqual([]);
  await ctx.close();
});
