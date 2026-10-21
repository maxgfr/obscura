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
  // A host page embeds the studio in a frame that may run scripts but not navigate the top window.
  await page.goto("/__frame");
  await page.waitForLoadState("load");
  const frame = page.frames().find((f) => f.url().includes("framed"));
  expect(frame).toBeTruthy();
  await page.waitForTimeout(500);
  const inside = await frame?.evaluate(() => ({
    scripts: performance.getEntriesByType("resource").some((e) => e.name.endsWith(".js")),
    elements: document.documentElement.childElementCount,
    stage: !!document.querySelector("[data-testid=stage]"),
  }));
  // The app's script loaded and ran, and refused to draw anything.
  expect(inside).toEqual({ scripts: true, elements: 0, stage: false });
  await ctx.close();
});
