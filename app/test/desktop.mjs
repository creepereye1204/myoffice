#!/usr/bin/env node
// 데스크톱 앱(Electron) 실제 실행 검사. 알오피스 폴더와 기기 파일은 임시 폴더를 쓰고, 파일 대화상자·휴지통은 바꿔 끼운다.
//   xvfb-run -a node app/test/desktop.mjs [실행파일]   (실행파일 없으면 app/desktop 개발 모드)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(HERE, '../../tests/e2e/package.json'));
const { _electron: electron } = require('playwright');

const exe = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myoffice-test-'));
const LIB = path.join(tmp, '알오피스');
const outside = path.join(tmp, '바탕화면');
fs.mkdirSync(outside);
const hwpPath = path.join(outside, '테스트 문서.hwp');
fs.copyFileSync(path.join(HERE, '../../tests/fixtures/sample.hwp'), hwpPath);
const orig = fs.readFileSync(hwpPath);

const env = { ...process.env, MYOFFICE_LIBRARY: LIB, MYOFFICE_NO_TRASH: '1' };
const launch = (args) => electron.launch(exe
  ? { executablePath: exe, args: ['--no-sandbox', ...args], env, timeout: 60_000 }
  : { executablePath: path.join(HERE, '../desktop/node_modules/electron/dist/electron'), args: ['--no-sandbox', path.join(HERE, '../desktop'), ...args], env, timeout: 60_000 });
const app = await launch([hwpPath]);
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push([name, 'OK', `${((Date.now() - t) / 1000).toFixed(1)}s`]); } catch (e) { results.push([name, 'FAIL', e.message.split('\n')[0]]); }
};
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const loaded = () => page.waitForFunction(() => window.__edit?.file && !document.querySelector('#loading'), null, { timeout: 120_000 });
const docxText = (buf) => {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nl) === 'word/document.xml') {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), cs = buf.readUInt32LE(p + 20);
      return zlib.inflateRawSync(buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + cs)).toString();
    }
    p += 46 + nl + xl + cl;
  }
  return '';
};

await step('실행 인자로 받은 hwp → 편집 화면 (파일 연결)', async () => {
  await page.waitForURL(/\/edit\?id=/, { timeout: 60_000 });
  await loaded();
  if ((await page.evaluate(() => window.__edit.file.name)) !== '테스트 문서.hwp') throw new Error('다른 파일이 열림');
  if (!(await page.evaluate(() => window.crossOriginIsolated))) throw new Error('crossOriginIsolated 아님');
});
await step('고쳐서 Ctrl+S → 그 자리 파일에 저장 (복사본 안 만듦)', async () => {
  await page.waitForTimeout(800);
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.42);
  await page.keyboard.type('DESKTOPHWP', { delay: 40 });
  await page.waitForFunction(() => window.__edit.dirty, null, { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  await page.locator('.toast.ok').first().waitFor({ timeout: 30_000 });
  if (Buffer.compare(fs.readFileSync(hwpPath), orig) === 0) throw new Error('파일이 안 바뀜');
  if (fs.readdirSync(outside).length !== 1) throw new Error(`바탕화면 폴더에 다른 파일이 생김: ${fs.readdirSync(outside)}`);
});
await step('홈 화면 목록에 "다른 폴더" 로 보임', async () => {
  await page.click('#back');
  await page.waitForURL(/\/$/);
  await page.locator('#list .row').first().waitFor();
  const txt = await page.locator('#list').textContent();
  if (!txt.includes('테스트 문서.hwp') || !txt.includes('다른 폴더')) throw new Error(txt);
});
await step('새 워드 → 알오피스 폴더에 파일 생김 → 입력·Ctrl+S', async () => {
  await page.click('.new-card[data-type="docx"]');
  await page.waitForURL(/\/edit\?id=/);
  await loaded();
  await page.waitForTimeout(1000);
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  await page.keyboard.type('DESKTOPWORD', { delay: 30 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
  const f = path.join(LIB, '새 워드.docx');
  if (!fs.existsSync(f)) throw new Error(`없음: ${fs.readdirSync(LIB)}`);
  if (!docxText(fs.readFileSync(f)).includes('DESKTOPWORD')) throw new Error('저장된 docx 에 글자 없음');
});
await step('제목 바꾸기 → 폴더의 파일 이름도 바뀜', async () => {
  await page.fill('#title', '보고서');
  await page.press('#title', 'Enter');
  await page.waitForTimeout(800);
  if (!fs.existsSync(path.join(LIB, '보고서.docx'))) throw new Error(`이름 안 바뀜: ${fs.readdirSync(LIB)}`);
});
await step('PDF → 저장 창으로 저장', async () => {
  const target = path.join(tmp, '보고서.pdf');
  await app.evaluate(({ dialog }, t) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: t }); }, target);
  await page.click('#pdf');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast.ok')].some((t) => /보고서\.pdf/.test(t.textContent)), null, { timeout: 60_000 });
  if (fs.readFileSync(target).subarray(0, 4).toString() !== '%PDF') throw new Error('PDF 아님');
});
await step('홈에서 삭제 → 폴더에서 지워짐', async () => {
  await page.click('#back');
  await page.waitForURL(/\/$/);
  page.once('dialog', (d) => d.accept());
  const row = page.locator('#list .row', { hasText: '보고서.docx' });
  await row.locator('[data-act="menu"]').click();
  await page.locator('.menu.floating [data-m="delete"]').click();
  await page.waitForTimeout(800);
  if (fs.existsSync(path.join(LIB, '보고서.docx'))) throw new Error('안 지워짐');
});
await step('한글 인쇄 → 앱 안에 인쇄 창 (바깥 브라우저 아님)', async () => {
  await page.locator('#list .row', { hasText: '테스트 문서.hwp' }).locator('[data-act="open"]').click();
  await loaded();
  await app.evaluate(({ shell }) => { globalThis.__ext = []; shell.openExternal = async (u) => { globalThis.__ext.push(u); }; });
  const before = (await app.windows()).length;
  const f = page.frameLocator('#hwp iframe');
  await f.locator('.menu-item[data-menu="file"] > .menu-title').click();
  await page.waitForTimeout(300);
  await f.locator('[data-cmd="file:print"]').click();
  await page.waitForTimeout(4000);
  if ((await app.evaluate(() => globalThis.__ext)).length) throw new Error('바깥 브라우저로 열림');
  const wins = await app.windows();
  if (wins.length <= before) throw new Error('인쇄 창이 안 열림');
  for (const w of wins.slice(before)) await w.close().catch(() => {});
});
await step('편집 중에 다른 파일을 "이 앱으로 열기" → 새 창', async () => {
  const other = path.join(outside, '두번째.hwp');
  fs.copyFileSync(path.join(HERE, '../../tests/fixtures/sample.hwp'), other);
  const before = (await app.windows()).length;
  await app.evaluate(({ app: a }, p) => a.emit('second-instance', {}, ['myoffice', p], ''), other);
  const deadline = Date.now() + 60_000;
  let ok = false;
  while (Date.now() < deadline && !ok) {
    for (const w of await app.windows()) {
      if ((await w.evaluate(() => window.__edit?.file?.name).catch(() => null)) === '두번째.hwp') ok = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ok) throw new Error('새 창에 안 열림');
  if ((await app.windows()).length <= before) throw new Error('새 창이 아님');
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('/edit') && w.getTitle().includes('두번째')) w.destroy(); });
});
await step('수정 후 닫으면 저장 확인 (취소하면 안 닫힘)', async () => {
  await page.bringToFront();
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.42);
  await page.keyboard.type('X', { delay: 40 });
  await page.waitForFunction(() => window.__edit.dirty, null, { timeout: 15_000 });
  await page.waitForTimeout(1200);   // 앱에 '수정됨' 이 전달될 시간
  const asked = await app.evaluate(async ({ BrowserWindow, dialog }) => {
    let asked = false;
    dialog.showMessageBox = async () => { asked = true; return { response: 2 }; };   // 취소
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/edit'));
    w.close();
    await new Promise((r) => setTimeout(r, 500));
    return asked && !w.isDestroyed();
  });
  if (!asked) throw new Error('확인 없이 닫힘');
});
await step('저장 안 함을 고르면 바로 닫힘 (앱 종료)', async () => {
  const exited = app.waitForEvent('close', { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
    for (const w of BrowserWindow.getAllWindows()) setTimeout(() => w.close(), 0);
  });
  const t = Date.now();
  await exited;
  if (Date.now() - t > 5000) throw new Error(`닫히는 데 ${Date.now() - t}ms`);
});
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
fs.rmSync(tmp, { recursive: true, force: true });
for (const r of results) console.log(r.join('\t'));
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '));
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
