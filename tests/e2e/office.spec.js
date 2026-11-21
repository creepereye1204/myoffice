import { test, expect } from '@playwright/test';
import { newUser, newGuest, create, api, openEditor, ooType, textOf, noErrors } from './helpers.js';

for (const kind of ['docx', 'xlsx', 'pptx', 'hcell', 'hshow']) {
  test(`ONLYOFFICE: ${kind} 새로 만들어 열기 (오류 없음, 편집 모드, 진행률 안 보임)`, async ({ browser }) => {
    const u = await newUser(browser);
    const f = await create(u, kind);
    const p = u.page;
    await p.goto(`/edit?id=${f.id}`);
    // 우리 로딩 화면이 걷힐 때까지 편집기 자체 '%' 진행률이 위에 드러나면 안 됨 → 걷힌 시점엔 문서 준비 완료
    await expect(p.locator('#loading')).toHaveCount(0, { timeout: 120_000 });
    const frame = p.frameLocator('iframe[name="frameEditor"]');
    await expect(frame.locator('#editor_sdk')).toBeVisible();
    await expect(frame.locator('.asc-loadmask')).toHaveCount(0);
    await expect(p.locator('#title')).toHaveValue(f.name.replace(/\.[^.]+$/, ''));
    await expect(p.locator('#share')).toBeVisible();
    await expect(p.locator('#people .avatar')).toHaveCount(1);
    noErrors(u.errors);
  });
}

test('ONLYOFFICE: 자동 저장 — 편집기를 닫지 않아도 저장소에 반영', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await create(u, 'docx');
  await openEditor(u.page, `id=${f.id}`);
  await ooType(u.page, 'AUTOSAVE7788');
  // 서버가 30초마다 강제 저장 → 최대 ~70초 안에 파일 내용에 들어가야
  await expect.poll(async () => (await textOf(u, f.id)).includes('AUTOSAVE7788'), { timeout: 90_000, intervals: [5000] }).toBe(true);
  noErrors(u.errors);
});

test('ONLYOFFICE: 두 사람 동시 편집 → 서로의 글이 합쳐져 저장', async ({ browser }) => {
  const owner = await newUser(browser, '김주인');
  const f = await create(owner, 'docx');
  const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'edit' } });
  const guest = await newGuest(browser, '이손님');

  await openEditor(owner.page, `id=${f.id}`);
  await openEditor(guest.page, `s=${token}`);
  // 접속자 2명 표시 (우리 WebSocket)
  await expect(owner.page.locator('#people .avatar')).toHaveCount(2);
  await expect(guest.page.locator('#people .avatar')).toHaveCount(2);
  await expect(guest.page.locator('#share')).toBeHidden();

  await ooType(owner.page, 'OWNERTEXT111');
  await ooType(guest.page, 'GUESTTEXT222');
  await expect.poll(async () => {
    const t = await textOf(owner, f.id);
    return t.includes('OWNERTEXT111') && t.includes('GUESTTEXT222');
  }, { timeout: 120_000, intervals: [5000] }).toBe(true);

  // 한쪽이 나가면 남은 쪽 접속자 1명
  await guest.ctx.close();
  await expect(owner.page.locator('#people .avatar')).toHaveCount(1, { timeout: 20_000 });
  noErrors(owner.errors);
  noErrors(guest.errors);
});

test('ONLYOFFICE: 보기 전용 공유', async ({ browser }) => {
  const owner = await newUser(browser);
  const f = await create(owner, 'xlsx');
  const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'view' } });
  const guest = await newGuest(browser);
  await openEditor(guest.page, `s=${token}`);
  await expect(guest.page.locator('#title')).toHaveJSProperty('readOnly', true);
  await expect(guest.page.locator('#status')).toContainText('보기 전용');
  await guest.page.waitForTimeout(4000);
  await expect(guest.page.locator('#status')).toContainText('보기 전용');
  noErrors(guest.errors);
});

test('공유 UI: 링크 켜기(편집) → 보기로 변경 → 끄기', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await create(u, 'docx');
  await openEditor(u.page, `id=${f.id}`);
  await u.page.click('#share');
  await expect(u.page.locator('#link-mode [data-mode="off"]')).toHaveClass(/on/);
  await expect(u.page.locator('#link-row')).toBeHidden();
  await u.page.click('#link-mode [data-mode="edit"]');
  await expect(u.page.locator('#share-url')).toHaveValue(/\/edit\?s=/);
  const link = await u.page.inputValue('#share-url');
  await u.page.click('#link-mode [data-mode="view"]');
  await expect(u.page.locator('#link-mode [data-mode="view"]')).toHaveClass(/on/);
  expect((await api(u, `/api/files/${f.id}`)).share.mode).toBe('view');
  expect(await u.page.inputValue('#share-url')).toBe(link);  // 모드만 바뀌고 링크는 그대로
  await u.page.click('#share-copy');
  expect(await u.page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  u.page.once('dialog', (d) => d.accept());
  await u.page.click('#link-mode [data-mode="off"]');
  await expect(u.page.locator('#link-row')).toBeHidden();
  const r = await fetch(`${process.env.API_URL || 'https://api.myoffice.p-e.kr'}/api/shared/${link.split('s=')[1]}`);
  expect(r.status).toBe(404);
  // 죽은 링크로 들어오면 안내
  const g = await newGuest(browser);
  await g.page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(g.page.locator('#loading-msg')).toContainText('열 수 없습니다');
  noErrors(u.errors);
});

test('이름 바꾸기: 편집 화면에서 바꾸면 다른 접속자 화면에도 반영', async ({ browser }) => {
  const owner = await newUser(browser);
  const f = await create(owner, 'pptx');
  const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'edit' } });
  const guest = await newGuest(browser);
  await openEditor(owner.page, `id=${f.id}`);
  await openEditor(guest.page, `s=${token}`);
  await owner.page.fill('#title', '분기 보고');
  await owner.page.press('#title', 'Enter');
  await expect(guest.page.locator('#title')).toHaveValue('분기 보고');
  expect((await api(owner, `/api/files/${f.id}`)).name).toBe('분기 보고.pptx');
});
