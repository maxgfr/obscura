import { expect, test } from "@playwright/test";
import { studio } from "./helpers";

test("the studio page cannot send anything anywhere", async ({ browser }) => {
  const { page, ctx } = await studio(browser);
  const blocked = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      violations.push(e.violatedDirective),
    );
    const tries = [
      fetch("https://example.com/x").then(
        () => "fetched",
        () => "blocked",
      ),
      fetch("http://127.0.0.1:9/x").then(
        () => "fetched",
        () => "blocked",
      ),
      new Promise((r) => {
        try {
          const ws = new WebSocket("wss://example.com");
          ws.onerror = () => r("blocked");
          ws.onopen = () => r("opened");
        } catch {
          r("blocked");
        }
      }),
    ];
    const results = await Promise.all(tries);
    await new Promise((r) => setTimeout(r, 200));
    return { results, violations };
  });
  expect(blocked.results).toEqual(["blocked", "blocked", "blocked"]);
  expect(blocked.violations.every((v) => v.startsWith("connect-src"))).toBe(true);
  expect(blocked.violations.length).toBeGreaterThan(0);

  // Trusted Types: no string can become a script URL or HTML.
  const tt = await page.evaluate(() => {
    try {
      new Worker("data:text/javascript,1");
      return "ran";
    } catch (e) {
      return (e as Error).name;
    }
  });
  expect(tt).toBe("TypeError");
  await ctx.close();
});

test("framed, the studio blanks itself", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/?nosw");
  await page.evaluate(() => {
    document.body.replaceChildren();
    const f = document.createElement("iframe");
    f.src = "./?nosw";
    f.id = "f";
    document.body.append(f);
  });
  // The frame either navigates the top window away or stays empty: no studio inside a frame.
  await page.waitForTimeout(1500);
  const inner = page.frameLocator("#f").locator("[data-testid=stage]");
  await expect(inner).toHaveCount(0);
  await ctx.close();
});
