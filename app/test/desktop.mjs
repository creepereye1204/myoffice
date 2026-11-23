#!/usr/bin/env node
// 데스크톱 앱(Electron) 실제 실행 확인. 파일 대화상자는 정해진 경로를 돌려주도록 바꿔 끼운다.
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
const hwpPath = path.join(tmp, '테스트 문서.hwp');
fs.copyFileSync(path.join(HERE, '../../tests/fixtures/sample.hwp'), hwpPath);
const orig = fs.readFileSync(hwpPath);

const launchOpts = exe
  ? { executablePath: exe, args: ['--no-sandbox', hwpPath] }
  : { executablePath: require.resolve('electron', { paths: [path.join(HERE, '../desktop')] }) && path.join(HERE, '../desktop/node_modules/electron/dist/electron'), args: ['--no-sandbox', path.join(HERE, '../desktop'), hwpPath] };
const app = await electron.launch({ ...launchOpts, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }, timeout: 60_000 });
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push([name, 'OK', `${((Date.now() - t) / 1000).toFixed(1)}s`]); } catch (e) { results.push([name, 'FAIL', e.message.split('\n')[0]]); }
};
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const clickDoc = async (fx = 0.5, fy = 0.45) => {
  const box = await page.locator('#editors').boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(400);
};

await step('실행 인자로 받은 hwp 열기 (파일 연결)', async () => {
  await page.waitForFunction(() => window.__app?.cur?.name === '테스트 문서.hwp', null, { timeout: 60_000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
  if (!(await page.evaluate(() => window.crossOriginIsolated))) throw new Error('crossOriginIsolated 아님');
});
await step('hwp 고쳐서 Ctrl+S → 같은 파일에 저장', async () => {
  await page.waitForTimeout(800);
  await clickDoc(0.5, 0.42);
  await page.keyboard.type('DESKTOPHWP', { delay: 40 });
  await page.waitForFunction(() => window.__app.dirty, null, { timeout: 10_000 });
  await page.keyboard.press('Control+s');
  await page.locator('.toast.ok').last().waitFor({ timeout: 30_000 });
  if (Buffer.compare(fs.readFileSync(hwpPath), orig) === 0) throw new Error('파일이 안 바뀜');
  if (fs.readdirSync(tmp).some((f) => f.endsWith('.tmp'))) throw new Error('임시 파일이 남음');
});
await step('새 워드 문서 → 다른 이름으로 저장 (대화상자)', async () => {
  const target = path.join(tmp, '새 보고서.docx');
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, target);
  await page.click('#home');
  await page.click('[data-new="docx"]');
  await page.frameLocator('#office').frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').waitFor({ timeout: 120_000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
  await page.waitForTimeout(1500);
  await clickDoc();
  await page.keyboard.type('DESKTOPWORD', { delay: 30 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+s');
  await page.locator('.toast.ok').last().waitFor({ timeout: 60_000 });
  const buf = fs.readFileSync(target);
  // document.xml 에 글자가 있는지 (zip 중앙 디렉터리)
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16); let found = false;
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nl) === 'word/document.xml') {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), cs = buf.readUInt32LE(p + 20);
      found = zlib.inflateRawSync(buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + cs)).toString().includes('DESKTOPWORD');
    }
    p += 46 + nl + xl + cl;
  }
  if (!found) throw new Error('저장된 docx 에 글자가 없음');
});
await step('최근 문서 목록에 두 파일', async () => {
  await page.click('#home');
  const n = await page.locator('#recent li[data-i]').count();
  if (n < 2) throw new Error(`최근 문서 ${n}개`);
});
await step('이미 켜진 앱에 두 번째 실행으로 파일 넘기기', async () => {
  // 처음 화면인 창에 hwp 가 열려야 함 (second-instance 경로를 직접 호출)
  await app.evaluate(({ app }, p) => app.emit('second-instance', {}, ['myoffice', p], ''), hwpPath);
  await page.waitForFunction(() => window.__app?.cur?.name === '테스트 문서.hwp', null, { timeout: 30_000 });
});
const SKIP_PRINT = process.env.SKIP_PRINT; if (!SKIP_PRINT) await step('한글 인쇄 → 앱 안에 인쇄 창 (바깥 브라우저 아님)', async () => {
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 60_000 });
  await app.evaluate(({ shell }) => { globalThis.__ext = []; shell.openExternal = async (u) => { globalThis.__ext.push(u); }; });
  const before = (await app.windows()).length;
  const f = page.frameLocator('#hwp iframe');
  await f.locator('.menu-item[data-menu="file"] > .menu-title').click();
  await page.waitForTimeout(300);
  await f.locator('[data-cmd="file:print"]').click();
  await page.waitForTimeout(4000);
  const ext = await app.evaluate(() => globalThis.__ext);
  if (ext.length) throw new Error(`바깥 브라우저로 열림: ${ext}`);
  const wins = await app.windows();
  if (wins.length <= before) throw new Error('인쇄 창이 안 열림');
  for (const w of wins.slice(before)) await w.close().catch(() => {});
  await page.bringToFront();
});
await step('수정 후 닫으면 저장 확인', async () => {
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 60_000 });
  await page.waitForTimeout(800);
  await clickDoc(0.5, 0.42);
  await page.keyboard.type('X', { delay: 40 });
  await page.waitForFunction(() => window.__app.dirty, null, { timeout: 10_000 });
  const asked = await app.evaluate(async ({ BrowserWindow, dialog }) => {
    let asked = false;
    dialog.showMessageBox = async () => { asked = true; return { response: 2 }; };   // 취소
    BrowserWindow.getAllWindows()[0].close();
    await new Promise((r) => setTimeout(r, 500));
    return asked && BrowserWindow.getAllWindows().length === 1;
  });
  if (!asked) throw new Error('확인 없이 닫힘');
});
await step('저장 안 함을 고르면 실제로 닫힘 (앱 종료)', async () => {
  const exited = app.waitForEvent('close', { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });   // 저장 안 함
    for (const w of BrowserWindow.getAllWindows()) setTimeout(() => w.close(), 0);
  });
  const t = Date.now();
  await exited;
  if (Date.now() - t > 5000) throw new Error(`닫히는 데 ${Date.now() - t}ms`);
});
await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
fs.rmSync(tmp, { recursive: true, force: true });
for (const r of results) console.log(r.join('\t'));
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '));
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
