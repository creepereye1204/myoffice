import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  // ONLYOFFICE Community 변환기는 동시에 1건만 처리 — 테스트가 변환을 많이 하므로 병렬도를 낮춘다
  workers: 2,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './teardown.js',
  use: {
    baseURL: process.env.WEB_URL || 'https://www.myoffice.p-e.kr',
    viewport: { width: 1400, height: 900 },
    launchOptions: { executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] },
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
});
