import { expect, test } from "@playwright/test";
import { openCaptures, studio } from "./helpers";

test("live mode sends a WHIP offer with the bearer token, only to the given URL", async ({
  browser,
  request,
}) => {
  const { page, errors, ctx } = await studio(browser, "/live.html?nosw");
  await expect(page.getByTestId("live-panel")).toBeVisible();
  await openCaptures(page);
  await page.getByTestId("whip-url").fill("http://localhost:4183/whip/test");
  await page.getByTestId("whip-token").fill("secret-token");
  await page.getByTestId("go-live").click();
  // The mock ingest logs the offer, then refuses it (there is no media server behind it).
  await expect(page.getByRole("alert")).toContainText("503");
  const log = (await (await request.get("/whip/log")).json()) as {
    method: string;
    auth: string;
    type: string;
    body: string;
  }[];
  const offer = log.find((l) => l.method === "POST");
  expect(offer?.type).toBe("application/sdp");
  expect(offer?.auth).toBe("Bearer secret-token");
  expect(offer?.body.startsWith("v=0")).toBe(true);
  expect(offer?.body).toContain("m=video");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("live mode refuses plain http endpoints", async ({ browser }) => {
  const { page, ctx } = await studio(browser, "/live.html?nosw");
  await page.getByTestId("whip-url").fill("http://example.com/whip");
  await page.getByTestId("go-live").click();
  await expect(page.getByRole("alert")).toContainText("https");
  await ctx.close();
});
