import { test, expect } from '@playwright/test';
import { API, adminH, newUser } from './helpers.js';

test('홈: 이미지를 첨부한 의견을 보내면 완료 토스트가 표시된다', async ({ browser }) => {
  const { page, ctx } = await newUser(browser);
  let id;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '의견 보내기' }).click();
    const dialog = page.getByRole('dialog', { name: '의견 보내기' });
    await dialog.getByLabel('내용').fill(`API_TEST_FEEDBACK 홈 의견 ${Date.now()}`);
    await dialog.getByLabel('이미지 첨부').setInputFiles({
      name: 'screenshot.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgaPgPQhAKACX2Bf2gcp/LAAAAAElFTkSuQmCC', 'base64'),
    });
    await expect(dialog.getByRole('img', { name: '첨부 이미지 미리보기' })).toBeVisible();
    const pending = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/feedback'
      && res.request().method() === 'POST');
    await dialog.getByRole('button', { name: '보내기', exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(201);
    expect(response.request().headers()['content-type']).toMatch(/^multipart\/form-data;/);
    ({ id } = await response.json());
    await expect(page.getByText('의견을 보냈습니다. 고맙습니다!')).toBeVisible();
  } finally {
    await ctx.close();
    if (id) {
      const result = await fetch(`${API}/api/admin/feedback/${id}`, { method: 'DELETE', headers: await adminH() });
      expect(result.status).toBe(204);
    }
  }
});
