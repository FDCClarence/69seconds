import { defineConfig, devices } from '@playwright/test';

const webOrigin = 'http://127.0.0.1:4173';
const serverOrigin = 'http://127.0.0.1:3101';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 100_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run e2e:fixture',
      url: `${serverOrigin}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -w @69-seconds/web -- --host 127.0.0.1 --port 4173',
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_SERVER_URL: serverOrigin },
    },
  ],
});
