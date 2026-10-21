import { defineConfig, devices } from "@playwright/test";

const PORT = 4183;
const media = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  // OBSCURA_SOFTWARE_GL=1 renders like a GPU-less CI runner.
  ...(process.env.OBSCURA_SOFTWARE_GL ? ["--use-angle=swiftshader", "--disable-gpu"] : []),
];

export default defineConfig({
  testDir: "e2e",
  // CI runners have no GPU: WebGL and H.264 run in software, several times slower than a laptop.
  timeout: process.env.CI ? 180_000 : 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 1 : 3,
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
