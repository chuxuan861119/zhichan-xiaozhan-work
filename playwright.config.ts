import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  reporter: [["line"]],
  use: {
    trace: "retain-on-failure",
  },
});
