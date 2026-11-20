import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5187",
    headless: true,
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx tsx scripts/e2e-server.ts",
      url: "http://127.0.0.1:5017/api/health",
      timeout: 120000,
    },
    {
      command:
        "VITE_API_BASE_URL=http://127.0.0.1:5017 npm run dev -w client -- --port 5187",
      url: "http://localhost:5187",
      timeout: 30000,
    },
  ],
});
