import { expect, test } from "@playwright/test";

test("works offline once loaded", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r));
  });
  await ctx.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("stage")).toBeVisible();
  await page.goto("/live.html");
  await expect(page.getByTestId("live-panel")).toBeVisible();
  await ctx.close();
});
