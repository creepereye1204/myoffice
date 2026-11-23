import { test, expect } from '@playwright/test';
import { newUser, newGuest, create, api, openEditor, hwpType, uploadFixture, textOf, noErrors, watchSaveKey, ctrlS } from './helpers.js';

test('한글: 새 문서 열기 (오류 없음)', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await create(u, 'hwp');
  await openEditor(u.page, `id=${f.id}`);
  await expect(u.page.locator('#save')).toBeVisible();
  await expect(u.page.locator('#banner')).toBeHidden();
  noErrors(u.errors);
});

test('한글: hwpx 새 문서 열기', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await create(u, 'hwpx');
  await openEditor(u.page, `id=${f.id}`);
  await expect(u.page.locator('#save')).toBeVisible();
  noErrors(u.errors);
});

test('한글: 새 hwpx 문서도 저장됨 (빈 템플릿 글자 모양 누락 회귀)', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await create(u, 'hwpx');
  await openEditor(u.page, `id=${f.id}`);
  await hwpType(u.page, 'NEWHWPX42');
  await u.page.keyboard.press('Control+s');
  await expect(u.page.locator('.toast.ok')).toContainText('저장했습니다');
  expect((await api(u, `/api/files/${f.id}`)).version).toBeGreaterThan(1);
  noErrors(u.errors);
});

test('한글: 입력 → 자동 저장 → 다시 열어도 내용 유지', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await uploadFixture(u, 'sample.hwp');
  await openEditor(u.page, `id=${f.id}`);
  await hwpType(u.page, 'HWPAUTO5566');
  await expect(u.page.locator('#status')).toContainText('자동 저장됨', { timeout: 30_000 });
  const meta = await api(u, `/api/files/${f.id}`);
  expect(meta.version).toBeGreaterThan(1);
  expect(await textOf(u, f.id, ['docx'])).toContain('HWPAUTO5566');
  // 새로 열어도 그대로
  await u.page.reload();
  await expect(u.page.locator('#loading')).toHaveCount(0, { timeout: 120_000 });
  await expect(u.page.locator('#status')).not.toContainText('수정됨');
  noErrors(u.errors);
});

test('한글: 수동 저장 버튼 / Ctrl+S', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await uploadFixture(u, 'sample.hwp');
  await openEditor(u.page, `id=${f.id}`);
  await hwpType(u.page, 'X');
  await u.page.keyboard.press('Control+s');
  await expect(u.page.locator('.toast.ok')).toContainText('저장했습니다');
  await hwpType(u.page, 'Y');
  await u.page.click('#save');
  await expect.poll(async () => (await api(u, `/api/files/${f.id}`)).version).toBeGreaterThanOrEqual(3);
});

test('한글 공동 작업: 잠금 · 보기 모드 · 실시간 갱신 · 편집 넘기기', async ({ browser }) => {
  const owner = await newUser(browser, '김주인');
  const f = await uploadFixture(owner, 'sample.hwp');
  const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'edit' } });
  const guest = await newGuest(browser, '이손님');

  await openEditor(owner.page, `id=${f.id}`);
  await openEditor(guest.page, `s=${token}`);

  // 먼저 들어온 주인이 편집, 손님은 보기 모드
  await expect(guest.page.locator('#banner')).toContainText('김주인님이 편집 중');
  await expect(guest.page.locator('#save')).toBeHidden();
  await expect(owner.page.locator('#save')).toBeVisible();
  await expect(owner.page.locator('#people .avatar')).toHaveCount(2);
  await expect(owner.page.locator('#people .avatar.lock')).toHaveCount(1);

  // 손님 입력은 막힘 → 서버 버전 그대로
  const v0 = (await api(owner, `/api/files/${f.id}`)).version;
  await hwpType(guest.page, 'GUESTBLOCKED');
  await guest.page.waitForTimeout(8000);
  expect((await api(owner, `/api/files/${f.id}`)).version).toBe(v0);

  // 주인이 쓰면 자동 저장 → 손님 화면 자동 갱신
  await hwpType(owner.page, 'OWNERLIVE');
  await expect(owner.page.locator('#status')).toContainText('자동 저장됨', { timeout: 30_000 });
  await expect(guest.page.locator('#status')).toContainText('김주인님이 저장한 최신 내용', { timeout: 15_000 });

  // 손님이 편집 요청 → 주인에게 안내 → 넘기기 → 손님이 편집 가능
  await guest.page.click('#banner-btn');
  await expect(owner.page.locator('#banner')).toContainText('이손님님이 편집을 요청');
  await owner.page.click('#banner-btn');
  await expect(guest.page.locator('#save')).toBeVisible({ timeout: 15_000 });
  await expect(guest.page.locator('#banner')).toBeHidden();
  await expect(owner.page.locator('#banner')).toContainText('이손님님이 편집 중');

  // 이제 손님 입력이 저장되고, 주인 쪽이 갱신
  await hwpType(guest.page, 'GUESTNOW');
  await expect(guest.page.locator('#status')).toContainText('자동 저장됨', { timeout: 30_000 });
  await expect(owner.page.locator('#status')).toContainText('이손님님이 저장한 최신 내용', { timeout: 15_000 });
  const text = await textOf(owner, f.id, ['docx']);
  expect(text).toContain('OWNERLIVE');
  expect(text).toContain('GUESTNOW');
  expect(text).not.toContain('GUESTBLOCKED');

  // 손님이 나가면 주인이 다시 편집
  await guest.ctx.close();
  await expect(owner.page.locator('#save')).toBeVisible({ timeout: 20_000 });
  noErrors(owner.errors);
  noErrors(guest.errors);
});

test('한글: 보기 전용 공유는 편집 불가', async ({ browser }) => {
  const owner = await newUser(browser);
  const f = await create(owner, 'hwp');
  const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'view' } });
  const g = await newGuest(browser);
  await openEditor(g.page, `s=${token}`);
  await expect(g.page.locator('#banner')).toContainText('보기 전용');
  await expect(g.page.locator('#save')).toBeHidden();
  await hwpType(g.page, 'NOPE');
  await g.page.waitForTimeout(7000);
  expect((await api(owner, `/api/files/${f.id}`)).version).toBe(1);
  noErrors(g.errors);
});

test('한글: Ctrl+S — 로딩 중·제목 칸·한글 입력 상태에서도 브라우저 저장 창이 뜨지 않음', async ({ browser }) => {
  const u = await newUser(browser);
  await watchSaveKey(u.ctx);
  const f = await uploadFixture(u, 'sample.hwp');
  await u.page.goto(`/edit?id=${f.id}`);
  await u.page.keyboard.press('Control+s');            // 로딩 중
  await expect(u.page.locator('#loading')).toHaveCount(0, { timeout: 120_000 });
  await hwpType(u.page, 'Z');
  await u.page.keyboard.press('Control+s');            // 문서 안
  await expect(u.page.locator('.toast.ok')).toContainText('저장했습니다');
  await u.page.click('#title');
  // 한글 자판 상태: key 는 'ㄴ', code 는 KeyS
  const cdp = await u.ctx.newCDPSession(u.page);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 'ㄴ', code: 'KeyS', windowsVirtualKeyCode: 83 });
  }
  await expect.poll(async () => (await ctrlS(u.page)).length).toBeGreaterThanOrEqual(3);
  const presses = await ctrlS(u.page);
  expect(presses.length).toBeGreaterThanOrEqual(3);
  expect(presses.every(Boolean), JSON.stringify(presses)).toBe(true);
  noErrors(u.errors);
});
