import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ARGOS_PORT || 6103);

export default defineConfig({
  testDir: '.',
  testMatch: /percy-bridge\.spec\.ts/,
  fullyParallel: true,
  workers: Number(process.env.ARGOS_SPLIT || 4),
  retries: 0,
  timeout: 30 * 60 * 1000,
  reporter: process.env.CI ? [['list'], ['@argos-ci/playwright/reporter']] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: 'node argos/server.mjs',
    cwd: '..',
    url: `http://localhost:${PORT}/tests/index.html`,
    reuseExistingServer: false,
    timeout: 60 * 1000,
  },
});
