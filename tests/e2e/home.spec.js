import { test, expect } from '@playwright/test';
import path from 'node:path';
import { newUser, create, api, FIX, noErrors } from './helpers.js';

test('홈: 새로 만들기 카드와 탭 이름', async ({ browser }) => {
  const u = await newUser(browser);
  await u.page.goto('/');
  await expect(u.page.locator('.new-card .t')).toHaveText(['워드', '엑셀', '파워포인트', '한글', '한셀', '한쇼']);
  await expect(u.page.locator('.tabs button')).toHaveText(['전체', '워드', '엑셀', '파워포인트', '한글', '한셀', '한쇼']);
  await expect(u.page.locator('#empty')).toBeVisible();
  // 로딩 화면에 '문서'·'스프레드시트' 같은 옛 이름이 남아 있지 않아야
  const body = await u.page.locator('main').innerText();
  for (const old of ['스프레드시트', '프레젠테이션', '한글 문서']) expect(body).not.toContain(old);
  noErrors(u.errors);
});

test('홈: 업로드 → 목록·필터·검색·이름 바꾸기·삭제', async ({ browser }) => {
  const u = await newUser(browser);
  const p = u.page;
  await create(u, 'hcell');
  await create(u, 'docx');
  await p.goto('/');
  await p.setInputFiles('#file-input', path.join(FIX, 'sample.hwp'));
  await expect(p.locator('.row')).toHaveCount(3);
  await expect(p.locator('.row', { hasText: 'sample.hwp' })).toContainText('한글');
  await expect(p.locator('.row', { hasText: '새 한셀' })).toContainText('한셀');

  await p.click('.tabs [data-f="hcell"]');
  await expect(p.locator('.row')).toHaveCount(1);
  await p.click('.tabs [data-f="cell"]');
  await expect(p.locator('.row')).toHaveCount(0);
  await p.click('.tabs [data-f="all"]');
  await p.fill('#q', 'sample');
  await expect(p.locator('.row')).toHaveCount(1);
  await p.fill('#q', '');

  const row = p.locator('.row', { hasText: 'sample.hwp' });
  p.once('dialog', (d) => d.accept('바뀐 보고서'));
  await row.locator('[data-act="menu"]').click();
  await p.click('.menu [data-m="rename"]');
  await expect(p.locator('.row', { hasText: '바뀐 보고서.hwp' })).toHaveCount(1);

  p.once('dialog', (d) => d.accept());
  await p.locator('.row', { hasText: '바뀐 보고서' }).locator('[data-act="menu"]').click();
  await p.click('.menu [data-m="delete"]');
  await expect(p.locator('.row')).toHaveCount(2);
  expect((await api(u, '/api/files')).length).toBe(2);
  noErrors(u.errors);
});

test('홈: 변환 메뉴로 PDF 만들기', async ({ browser }) => {
  const u = await newUser(browser);
  await create(u, 'docx');
  await u.page.goto('/');
  await u.page.locator('.row [data-act="menu"]').click();
  await u.page.click('.menu [data-to="pdf"]');
  await expect(u.page.locator('.row', { hasText: '.pdf' })).toHaveCount(1, { timeout: 60_000 });
  noErrors(u.errors);
});

test('홈: 잘못된 형식 업로드는 안내', async ({ browser }) => {
  const u = await newUser(browser);
  await u.page.goto('/');
  await u.page.setInputFiles('#file-input', { name: 'x.cell', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await expect(u.page.locator('.toast.err')).toContainText('xlsx/pptx');
});

test('모바일: 가로 스크롤 없음, 카드 3열', async ({ browser }) => {
  const u = await newUser(browser);
  await create(u, 'hwp');
  await u.page.setViewportSize({ width: 360, height: 780 });
  await u.page.goto('/');
  await expect(u.page.locator('.row')).toHaveCount(1);
  const over = await u.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  const tops = await u.page.locator('.new-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(2);
  noErrors(u.errors);
});
