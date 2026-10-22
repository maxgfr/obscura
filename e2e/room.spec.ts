import type { Browser, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openCaptures, studio } from "./helpers";

const RELAY = "ws://localhost:4183/relay";

/** A friend opening a room link in their own browser (fake camera and microphone). */
async function friend(browser: Browser, link: string) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Trusted Type/i.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(link.replace("live.html?", "live.html?nosw&"));
  await page.getByTestId("join").waitFor();
  return { ctx, page, errors };
}

async function playing(page: Page, testid: string): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByTestId(testid)
        .evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.srcObject !== null),
    )
    .toBe(true);
}

test("live with friends: a guest joins on screen, a viewer watches, through the relay", async ({
  browser,
  request,
}) => {
  const host = await studio(browser, `/live.html?nosw&relay=${RELAY}`);
  const { page } = host;
  await openCaptures(page);
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("room-panel")).toContainText("1/1 relays");
  const guestLink = await page.getByTestId("guest-link").inputValue();
  const viewerLink = await page.getByTestId("viewer-link").inputValue();
  expect(guestLink).toMatch(/\/live\.html\?relay=.*#join=[A-Za-z0-9_-]{43}$/);
  expect(viewerLink).toMatch(/#watch=[A-Za-z0-9_-]{43}$/);

  // The guest waits until the host lets them in.
  const guest = await friend(browser, guestLink);
  await guest.page.getByTestId("guest-name").fill("Sam Lee");
  await guest.page.getByTestId("join-button").click();
  await expect(guest.page.getByTestId("join-status")).toContainText("Waiting for the host");
  await expect(page.getByTestId("guests")).toContainText("Sam Lee");
  await page.getByTestId("accept-guest").click();

  // They appear on the host's screen, which splits; they see the program.
  await expect(page.getByTestId("captures")).toContainText("Sam Lee");
  await expect(page.getByTestId("layers")).toContainText("Guest 1");
  await playing(guest.page, "program");

  // A viewer just watches.
  const viewer = await friend(browser, viewerLink);
  await viewer.page.getByTestId("join-button").click();
  await playing(viewer.page, "program");
  await expect(page.getByTestId("viewer-count")).toHaveText("1 watching");

  // The relay only ever saw sealed, ephemeral messages: opaque base64url, so no SDP, no
  // address and no name (which has a space) in the clear.
  const log = (await (await request.get("/relay?log")).json()) as {
    kind: number;
    content: string;
  }[];
  expect(log.length).toBeGreaterThan(2);
  for (const ev of log) {
    expect(ev.kind).toBe(25050);
    expect(ev.content).toMatch(/^[A-Za-z0-9_-]{100,}$/);
  }

  // When the guest leaves, their place goes away.
  await guest.page.getByTestId("leave").click();
  await expect(page.getByTestId("captures")).not.toContainText("Sam Lee");
  await expect(page.getByTestId("layers")).not.toContainText("Guest 1");

  expect([...host.errors, ...guest.errors, ...viewer.errors]).toEqual([]);
  await Promise.all([guest.ctx.close(), viewer.ctx.close(), host.ctx.close()]);
});

test("live with friends: codes copied by hand when no relay gets through", async ({ browser }) => {
  // Same origin (allowed by the policy), but nothing answers there.
  const dead = "ws://localhost:4183/no-relay";
  const host = await studio(browser, `/live.html?nosw&relay=${dead}`);
  const { page } = host;
  await page.getByTestId("open-room").click();
  await expect(page.getByTestId("room-panel")).toContainText("0/1 relays");
  const guestLink = await page.getByTestId("guest-link").inputValue();

  const guest = await friend(browser, guestLink);
  await guest.page.getByTestId("guest-name").fill("Alex");
  await guest.page.getByTestId("join-button").click();
  await guest.page.getByText("Not getting through?").click();
  await expect(guest.page.getByTestId("join-code")).toHaveValue(/^obscura-g\./);
  const code = await guest.page.getByTestId("join-code").inputValue();

  await page.getByText("Add someone by code").click();
  await page.getByTestId("peer-code").fill(code);
  await page.getByTestId("peer-code-add").click();
  const answer = await page.getByTestId("peer-answer").inputValue();
  expect(answer).toMatch(/^obscura-a\./);

  await guest.page.getByTestId("answer-input").fill(answer);
  await guest.page.getByTestId("answer-submit").click();
  await playing(guest.page, "program");
  await expect(page.getByTestId("captures")).toContainText("Alex");

  // The host can remove a guest; the guest is told.
  await page.getByRole("button", { name: "Remove Alex" }).click();
  await expect(guest.page.getByRole("alert")).toContainText("removed you");
  await expect(page.getByTestId("captures")).not.toContainText("Alex");

  expect([...host.errors, ...guest.errors]).toEqual([]);
  await Promise.all([guest.ctx.close(), host.ctx.close()]);
});
