import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { testEnvironment } from './e2e/environment';

const environment = testEnvironment();

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: environment.mode === 'existing-backend' ? 180_000 : 90_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(environment.artifactDirectory, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(environment.artifactDirectory, 'html-report'), open: 'never' }],
    ['json', { outputFile: resolve(environment.artifactDirectory, 'results.json') }],
  ],
  use: {
    baseURL: environment.webOrigin,
    channel: 'msedge',
    headless: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: environment.mode === 'existing-backend' ? 'off' : 'retain-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'desktop-edge',
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
