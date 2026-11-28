import { expect, test } from '@playwright/test';
import { adminH } from './helpers.js';

test('관리자 탭은 모바일에서 열리고 URL에 선택을 유지한다', async ({ page }) => {
  const { Authorization } = await adminH();
  await page.addInitScript((token) => localStorage.setItem('rhwp.token', token), Authorization.slice(7));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/admin#feedback');
  const nav = page.getByRole('navigation', { name: '관리자 메뉴' });
  await expect(nav.getByRole('link', { name: /^의견/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#feedback-range')).not.toBeEmpty();

  for (const [label, hash, content] of [
    ['개요', 'overview', '전체 사용자'], ['사용자', 'users', '새 회원가입 받기'], ['문서', 'documents', '공유 링크'],
    ['에러', 'errors', '테스트 기록 포함'], ['서버 상태', 'status', 'Grafana 열기'],
  ]) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#${hash}$`));
    await expect(page.locator(`#${hash}`).getByText(content, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  }

  await expect(page.getByRole('link', { name: 'Grafana 열기' })).toHaveAttribute('href', '/grafana/');
  await page.reload();
  await expect(nav.getByRole('link', { name: '서버 상태' })).toHaveAttribute('aria-current', 'page');
});
