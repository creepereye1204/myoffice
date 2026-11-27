import { test, expect } from '@playwright/test';
import { newUser, newGuest, create, api, openEditor, noErrors, hwpType, ooType } from './helpers.js';

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
    if (kind === 'hwp') {
      const paper = surface.locator('canvas.document-page-canvas:visible').first();
      await expect(paper).toBeVisible();
      const pageBox = await paper.boundingBox();
      const left = Math.max(box.x, pageBox.x), top = Math.max(box.y, pageBox.y);
      const width = Math.min(box.x + box.width, pageBox.x + pageBox.width) - left;
      const height = Math.min(box.y + box.height, pageBox.y + pageBox.height) - top;
      const drag = guest.page.locator(`.remote-drag[data-uid="${owner.uid}"]`);
      await owner.page.mouse.move(left + width * .4, top + height * .4);
      await owner.page.mouse.down();
      await owner.page.mouse.move(left + width * .6, top + height * .55, { steps: 8 });
      await expect(drag).toBeVisible();
      await expect(drag).toHaveCSS('border-top-color', color);
      await expect(cursor).toBeVisible();
      await owner.page.mouse.up();
      await expect(drag).toBeHidden({ timeout: 2500 });
    }
    await owner.page.locator('#title').hover();
    await expect(cursor).toHaveCount(0, { timeout: 5000 });
    noErrors(owner.errors);
    noErrors(guest.errors);
  });
}

for (const kind of ['hwp', 'docx']) {
  test(`공유 글자 선택: ${kind} 드래그 중 표시하고 선택을 풀면 지운다`, async ({ browser }) => {
    const owner = await newUser(browser, '김주인');
    const guest = await newUser(browser, '이손님');
    const f = await create(owner, kind);
    const { token } = await api(owner, `/api/files/${f.id}/share`, { method: 'POST', json: { mode: 'view' } });
    await openEditor(owner.page, `id=${f.id}`);
    await owner.page.bringToFront();
    const hwp = kind === 'hwp';
    if (hwp) await expect(owner.page.locator('#save')).toBeVisible();
    await (hwp ? hwpType : ooType)(owner.page, 'Collaborative text selection');
    await owner.page.keyboard.press('Control+s');
    await expect(owner.page.locator('.toast.ok').first()).toContainText('저장했습니다', { timeout: 30_000 });
    await openEditor(guest.page, `s=${token}`);
    const avatar = guest.page.locator(`#people .avatar[data-uid="${owner.uid}"]`);
    await expect(avatar).toBeVisible();
    const color = await avatar.evaluate((el) => getComputedStyle(el).backgroundColor);
    const remote = guest.page.locator(`.remote-selection[data-uid="${owner.uid}"]`);
    await owner.page.bringToFront();

    // 먼저 키보드로 선택해 현재 배율에서 드래그할 글자 줄의 위치를 찾는다.
    const frame = owner.page.frameLocator(hwp ? '#hwp iframe' : 'iframe[name="frameEditor"]');
    const surface = frame.locator(hwp ? '#scroll-container' : '#editor_sdk');
    await surface.click({ position: { x: (await surface.boundingBox()).width / 2, y: 80 } });
    await owner.page.keyboard.press('Control+a');
    let line;
    if (hwp) {
      const highlight = surface.locator('.selection-layer > .selection-highlight:visible').first();
      await expect(highlight).toBeVisible();
      line = await highlight.boundingBox();
    } else {
      const local = await surface.evaluate((el) => {
        const win = el.ownerDocument.defaultView;
        const [[x, y], [, bottom], [right]] = (win.Asc?.editor || win.editor).asc_GetSelectionBounds();
        return { x, y, width: right - x, height: bottom - y };
      });
      const root = await surface.boundingBox();
      line = { ...local, x: local.x + root.x, y: local.y + root.y };
    }
    expect(line.width).toBeGreaterThan(20);
    const x = line.x + 2, y = line.y + line.height / 2;
    await expect(remote.first()).toBeVisible();
    await owner.page.mouse.click(x, y);
    await expect(remote).toHaveCount(0);
    // 바로 누르면 앞의 클릭과 합쳐져 더블클릭(단어 선택 모드)이 되어 드래그 선택이 안 된다
    await owner.page.waitForTimeout(700);
    await owner.page.mouse.move(x, y);
    await owner.page.mouse.down();
    await owner.page.mouse.move(x + line.width * .75, y, { steps: 12 });
    await expect(remote.first()).toBeVisible();
    await expect(remote.first()).toHaveCSS('color', color);
    await owner.page.mouse.up();
    await owner.page.waitForTimeout(3200);
    await expect(remote.first()).toBeVisible();
    await owner.page.mouse.click(x + line.width * .9, y);
    await expect(remote).toHaveCount(0);
    noErrors(owner.errors);
    noErrors(guest.errors);
  });
}
