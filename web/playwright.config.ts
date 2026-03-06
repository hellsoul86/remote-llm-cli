import { defineConfig } from "@playwright/test";

const liveBaseURL = (process.env.E2E_BASE_URL ?? "").trim();
const useLocalDevServer = liveBaseURL === "";

export default defineConfig({
  testDir: "./e2e",
  timeout: useLocalDevServer ? 30_000 : 300_000,
  expect: {
    timeout: useLocalDevServer ? 10_000 : 120_000
  },
  use: {
    baseURL: useLocalDevServer ? "http://127.0.0.1:4173" : liveBaseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: useLocalDevServer
    ? {
        command: "npm run build && npm run preview:e2e",
        port: 4173,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI
      }
    : undefined
});
