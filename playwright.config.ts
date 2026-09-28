import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  },
  webServer: [
    {
      command: "npx tsx tests/e2e-server.ts",
      url: "http://127.0.0.1:3000/api/health",
      reuseExistingServer: false,
    },
    {
      command: "npx vite --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
