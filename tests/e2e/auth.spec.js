import { test, expect } from '@playwright/test';
import { newUser, makeAccount, create, api, openEditor, watchErrors, noErrors, adminH, API } from './helpers.js';

test('로그인 안 하면 로그인 화면으로 (돌아갈 주소 유지)', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?next=%2F$/);
  await page.goto('/edit?id=0123456789abcdef0123456789abcdef');
  await expect(page).toHaveURL(/\/login\?next=%2Fedit%3Fid%3D/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/);
});

test('회원가입 → 홈 → 로그아웃 → 로그인', async ({ page }) => {
  const errors = watchErrors(page);
  const uname = 's_' + Math.random().toString(36).slice(2, 10);
  await page.goto('/login');
  await page.click('[data-tab="signup"]');
  const f = page.locator('#signup-form');
  await f.locator('[name=username]').fill(uname);
  await f.locator('[name=name]').fill('가입테스트');
  await f.locator('[name=password]').fill('password123');
  await f.locator('[name=password2]').fill('password999');
  await f.locator('button[type=submit]').click();
  await expect(page.locator('#err')).toHaveText('비밀번호 확인이 다릅니다');
  await f.locator('[name=password2]').fill('password123');
  await f.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#me-name')).toHaveText('가입테스트');
  await expect(page.locator('#empty')).toBeVisible();

  await page.click('#account-btn');
  await expect(page.locator('#admin-link')).toBeHidden();
  await page.click('[data-a="logout"]');
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);

  const lf = page.locator('#login-form');
  await lf.locator('[name=username]').fill(uname);
  await lf.locator('[name=password]').fill('wrongwrong');
  await lf.locator('button[type=submit]').click();
  await expect(page.locator('#err')).toContainText('아이디 또는 비밀번호');
  await lf.locator('[name=password]').fill('password123');
  await lf.locator('button[type=submit]').click();
  await expect(page.locator('#me-name')).toHaveText('가입테스트');
  // 틀린 비밀번호 로그인의 401 응답은 브라우저가 콘솔에 찍는 정상 동작
  noErrors(errors.filter((e) => !/status of 401/.test(e)));
});

test('로그인 후 원래 가려던 문서로 돌아감', async ({ page }) => {
  const acc = await makeAccount('돌아가기');
  const f = await create(acc, 'docx');
  await page.goto(`/edit?id=${f.id}`);
  await expect(page).toHaveURL(/\/login/);
  await page.locator('#login-form [name=username]').fill(acc.username);
  await page.locator('#login-form [name=password]').fill(acc.password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page).toHaveURL(new RegExp(`/edit\\?id=${f.id}`));
  await expect(page.locator('#loading')).toHaveCount(0, { timeout: 120_000 });
});

test('다른 사이트로 튕기는 next 무시', async ({ page }) => {
  const acc = await makeAccount();
  await page.goto('/login?next=//evil.example/x');
  await page.locator('#login-form [name=username]').fill(acc.username);
  await page.locator('#login-form [name=password]').fill(acc.password);
  await page.locator('#login-form button[type=submit]').click();
  await expect(page).toHaveURL(/myoffice\.p-e\.kr\/$/);
});

test('관리자 페이지: 일반 사용자는 못 들어감', async ({ browser }) => {
  const u = await newUser(browser);
  await u.page.goto('/admin');
  await expect(u.page).toHaveURL(/\/$/);
});

test('관리자 페이지: 목록·사용 중지·재개', async ({ browser }) => {
  const victim = await makeAccount('중지대상');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto('/login');
  await page.locator('#login-form [name=username]').fill('admin');
  await page.locator('#login-form [name=password]').fill(process.env.ADMIN_PASSWORD);
  await page.locator('#login-form button[type=submit]').click();
  await page.click('#account-btn');
  await page.click('#admin-link');
  await expect(page).toHaveURL(/\/admin$/);
  const row = page.locator(`tr:has-text("@${victim.username}")`);
  await expect(row).toContainText('사용 중');
  await row.locator('[data-a="disable"]').click();
  await expect(row).toContainText('중지됨');
  expect((await fetch(`${API}/api/auth/me`, { headers: victim.H })).status).toBe(401);
  await row.locator('[data-a="enable"]').click();
  await expect(row).toContainText('사용 중');
  noErrors(errors);
});

test('사용자에게 공유(보기) → 상대 "공유받은 파일"에서 열기, 권한 바꾸기', async ({ browser }) => {
  const owner = await newUser(browser, '주인');
  const friend = await newUser(browser, '친구');
  const f = await create(owner, 'docx');
  await openEditor(owner.page, `id=${f.id}`);
  await owner.page.click('#share');
  await owner.page.fill('#grant-user', 'nobody_xyz');
  await owner.page.click('#grant-add');
  await expect(owner.page.locator('.toast.err')).toContainText('없습니다');
  await owner.page.fill('#grant-user', friend.username);
  await owner.page.selectOption('#grant-role', 'view');
  await owner.page.click('#grant-add');
  await expect(owner.page.locator('#grant-list li')).toContainText(['친구']);

  await friend.page.goto('/');
  await friend.page.click('[data-scope="shared"]');
  const row = friend.page.locator('.row', { hasText: '새 워드' });
  await expect(row).toContainText('보기만');
  await expect(row).toContainText('주인');
  await row.locator('[data-act="menu"]').click();
  await expect(friend.page.locator('.menu [data-m="delete"]')).toHaveCount(0);
  await friend.page.mouse.click(5, 300);
  await row.locator('[data-act="open"]').click();
  await expect(friend.page.locator('#loading')).toHaveCount(0, { timeout: 120_000 });
  await expect(friend.page.locator('#status')).toContainText('보기 전용');
  await expect(friend.page.locator('#share')).toBeHidden();

  // 편집으로 올리면 다시 열 때 편집 모드
  await owner.page.locator('#grant-list select').selectOption('edit');
  await expect.poll(async () => (await api(friend, `/api/files/${f.id}`)).role).toBe('edit');
  // 해제
  await owner.page.click('#grant-list [data-remove]');
  await expect(owner.page.locator('#grant-list')).toContainText('아직 공유한 사람이 없습니다');
  await friend.page.goto('/');
  await friend.page.click('[data-scope="shared"]');
  await expect(friend.page.locator('#empty')).toContainText('공유받은 파일이 없습니다');
  noErrors(owner.errors);
});

test('편집기 PDF 버튼 → PDF 내려받기', async ({ browser }) => {
  const u = await newUser(browser);
  const f = await create(u, 'pptx');
  await openEditor(u.page, `id=${f.id}`);
  const [dl] = await Promise.all([u.page.waitForEvent('download', { timeout: 60_000 }), u.page.click('#pdf')]);
  expect(dl.suggestedFilename()).toBe('새 파워포인트.pdf');
  const buf = await (await import('node:fs')).promises.readFile(await dl.path());
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  noErrors(u.errors);
});

test('홈 메뉴 PDF로 다운로드 (한글)', async ({ browser }) => {
  const u = await newUser(browser);
  await create(u, 'hwpx');
  await u.page.goto('/');
  await u.page.locator('.row [data-act="menu"]').click();
  const [dl] = await Promise.all([u.page.waitForEvent('download', { timeout: 60_000 }), u.page.click('.menu [data-m="pdf"]')]);
  expect(dl.suggestedFilename()).toMatch(/\.pdf$/);
});
