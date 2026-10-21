import { expect, test } from "@playwright/test";
import { studio } from "./helpers";

test("fits the viewport and stays usable", async ({ browser }) => {
  const { page, errors, ctx } = await studio(browser);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("record")).toBeVisible();
  await expect(page.getByTestId("stage")).toBeVisible();
  // The preview never spills out of its area.
  const stage = await page.getByTestId("stage").boundingBox();
  const frame = await page.locator(".stage-frame").boundingBox();
  expect(
    frame && stage && frame.x >= stage.x - 1 && frame.x + frame.width <= stage.x + stage.width + 1,
  ).toBe(true);
  expect(errors).toEqual([]);
  await ctx.close();
});
