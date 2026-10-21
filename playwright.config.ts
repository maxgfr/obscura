import { defineConfig, devices } from "@playwright/test";

const PORT = 4183;
const media = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun test/e2e-server.ts",
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: media } },
      testIgnore: /layout\.spec\.ts/,
    },
    {
      // Studio basics and recording on Safari's engine (WebCodecs, OPFS, WebGL 2).
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: /(studio|layout)\.spec\.ts/,
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"], launchOptions: { args: media } },
      testMatch: /layout\.spec\.ts/,
    },
  ],
});
