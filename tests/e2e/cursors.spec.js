import { test, expect } from '@playwright/test';
import { newUser, newGuest, create, api, openEditor, noErrors } from './helpers.js';

for (const kind of ['hwp', 'docx']) {
  test(`공유 포인터: ${kind} 보기 전용 손님에게 소유자 이름 표시`, async ({ browser }) => {
    const owner = await newUser(browser, '김주인');
    const guest = await newGuest(browser, '이손님');
    const f = await create(owner, kind);
    const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'view' } });

    await openEditor(owner.page, `id=${f.id}`);
    await openEditor(guest.page, `s=${token}`);
    await expect(guest.page.locator('#people .avatar')).toHaveCount(2);

    let surface = owner.page.frameLocator('#hwp iframe').locator('#scroll-container');
    if (kind === 'docx') {
      const editorFrame = () => owner.page.frames().find((frame) => frame.name() === 'frameEditor');
      await expect.poll(() => Boolean(editorFrame())).toBe(true);
      surface = editorFrame().locator('#editor_sdk');
    }
    await expect(surface).toBeVisible();
    const box = await surface.boundingBox();
    const cursor = guest.page.locator(`.remote-cursor[data-uid="${owner.uid}"]`);
    await owner.page.bringToFront();

    // 프레임 연결을 기다리면서 문서 중앙에서 포인터를 조금씩 움직인다.
    let step = 0;
    await expect.poll(async () => {
      await owner.page.mouse.move(box.x + box.width / 2 + step++, box.y + box.height / 2);
      return cursor.isVisible();
    }, { timeout: 5000 }).toBe(true);
    await expect(cursor).toHaveText(owner.name);
    const avatar = guest.page.locator(`#people .avatar[data-uid="${owner.uid}"]`);
    const color = await avatar.evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect(cursor).toHaveCSS('color', color);
    await expect(owner.page.locator('.remote-cursor')).toHaveCount(0);
    await owner.page.locator('#title').hover();
    await expect(cursor).toHaveCount(0, { timeout: 5000 });
    noErrors(owner.errors);
    noErrors(guest.errors);
  });
}
