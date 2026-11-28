import { test, expect } from '@playwright/test';
import { newUser } from './helpers.js';

test('홈: 브라우저 오류 비콘 수집', async ({ browser, baseURL }) => {
  test.skip(!['www.myoffice.p-e.kr', 'www.rhwp.p-e.kr'].includes(new URL(baseURL).hostname),
    '오류 수집은 운영 호스트에서 활성화됩니다');
  const { page } = await newUser(browser);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.reportClientError === 'function');
  const response = page.waitForResponse((res) => {
    const request = res.request();
    return new URL(res.url()).pathname === '/api/client-errors'
      && request.method() === 'POST' && request.postData()?.includes('E2E_TEST_ERROR');
  });
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('E2E_TEST_ERROR ' + Date.now()); });
  });
  expect((await response).status()).toBe(204);
});
