#!/usr/bin/env node
// 안드로이드 앱 실제 실행 확인 (에뮬레이터/기기 + 디버그 APK).
//   ADB_SERIAL=emulator-5580 node app/test/android.mjs app/android/app/build/outputs/apk/debug/myoffice-1.0.0-debug.apk
// WebView 는 DevTools(CDP)로 조작하고, 시스템 저장/열기 화면은 uiautomator 로 누른다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(HERE, '../../tests/e2e/package.json'));
const { _android } = require('playwright');

const SERIAL = process.env.ADB_SERIAL || 'emulator-5580';
const ADB = process.env.ADB || path.join(os.homedir(), 'android-sdk/platform-tools/adb');
const PKG = 'kr.myoffice.app';
const apk = process.argv[2];
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { maxBuffer: 64 << 20 }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); results.push([name, 'OK', `${((Date.now() - t) / 1000).toFixed(1)}s`]); } catch (e) { results.push([name, 'FAIL', e.message.split('\n')[0]]); }
};

// 화면에서 글자로 버튼 찾아 누르기 (시스템 파일 화면). 화면이 바뀌는 중이면 dump 가 실패하므로 몇 번 다시 시도
let device;
async function tapText(re, tries = 30) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      const xml = adb('exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty');
      for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
        if (re.test(m[1])) {
          adb('shell', 'input', 'tap', String((+m[2] + +m[4]) >> 1), String((+m[3] + +m[5]) >> 1));
          return m[1];
        }
      }
      last = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).slice(0, 15).join('|');
    } catch (e) { last = String(e.stderr || e.message).slice(0, 120); }
    await sleep(1000);
  }
  throw new Error(`화면에서 ${re} 를 못 찾음 (${last})`);
}
function docxHas(buf, text) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nl) === 'word/document.xml') {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), cs = buf.readUInt32LE(p + 20);
      return zlib.inflateRawSync(buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + cs)).toString().includes(text);
    }
    p += 46 + nl + xl + cl;
  }
  return false;
}

if (apk) { console.log('설치 중…'); adb('install', '-r', '-g', apk); }
adb('shell', 'am', 'force-stop', PKG);
adb('shell', 'rm', '-f', '/sdcard/Download/AND*.docx', '/sdcard/Download/and-*.hwp');
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
await sleep(3000);
device = (await _android.devices()).find((d) => d.serial() === SERIAL);
if (!device) throw new Error(`기기 없음: ${SERIAL}`);
const webview = await device.webView({ pkg: PKG });
const page = await webview.page();
const browser = { close: () => device.close() };
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await step('앱 화면 뜸', async () => {
  await page.waitForFunction(() => !!window.__app, null, { timeout: 30_000 });
  console.log('  crossOriginIsolated =', await page.evaluate(() => window.crossOriginIsolated), '| 화면', await page.evaluate(() => `${innerWidth}x${innerHeight}`));
});
await step('새 워드 문서 열기 (오프라인 ONLYOFFICE)', async () => {
  await page.click('[data-new="docx"]');
  await page.frameLocator('#office').frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').waitFor({ timeout: 180_000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 180_000 });
  await sleep(2000);
});
await step('입력 후 저장 → 시스템 저장 화면 → 파일 생김', async () => {
  const box = await page.locator('#editors').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  await sleep(500);
  await page.keyboard.type('ANDROIDWORD', { delay: 50 });
  await sleep(800);
  // 문서 이름을 정해서 저장 화면을 연다
  await page.evaluate(() => { window.__app.cur.name = 'ANDTEST.docx'; window.__app.save(); });
  await sleep(2500);
  await tapText(/^(SAVE|Save|저장)$/);
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('저장됨'), null, { timeout: 60_000 });
  const ls = adb('shell', 'ls', '/sdcard/Download/');
  const name = ls.split(/\s+/).find((n) => /^ANDTEST.*\.docx$/.test(n));
  if (!name) throw new Error(`Download 에 파일 없음: ${ls}`);
  const local = path.join(os.tmpdir(), 'andtest.docx');
  adb('pull', `/sdcard/Download/${name}`, local);
  if (!docxHas(fs.readFileSync(local), 'ANDROIDWORD')) throw new Error('저장된 docx 에 글자 없음');
});
await step('같은 파일에 다시 저장 (Ctrl+S, 대화상자 없이)', async () => {
  await page.keyboard.type('AGAIN', { delay: 50 });
  await sleep(800);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent) && !window.__app.dirty, null, { timeout: 60_000 });
  const name = adb('shell', 'ls', '/sdcard/Download/').split(/\s+/).find((n) => /^ANDTEST.*\.docx$/.test(n));
  const local = path.join(os.tmpdir(), 'andtest2.docx');
  adb('pull', `/sdcard/Download/${name}`, local);
  if (!docxHas(fs.readFileSync(local), 'AGAIN')) throw new Error('덮어쓴 docx 에 추가 글자 없음');
});
await step('뒤로 가기 → 처음 화면, 최근 문서에 있음', async () => {
  // 키보드가 떠 있으면 첫 번째 뒤로 가기는 키보드만 닫는다 (안드로이드 기본 동작)
  for (let i = 0; i < 3 && (await page.evaluate(() => !!window.__app.cur)); i++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await sleep(1500);
  }
  if (await page.evaluate(() => !!window.__app.cur)) throw new Error('뒤로 가기로 문서가 안 닫힘');
  if ((await page.locator('#recent li[data-i]').count()) < 1) throw new Error('최근 문서 없음');
});
await step('최근 문서 다시 열기 (권한 유지)', async () => {
  await page.locator('#recent li[data-i]').first().click();
  await page.waitForFunction(() => window.__app.cur?.name?.startsWith('ANDTEST'), null, { timeout: 30_000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
});
await step('한글 문서: 기기에 넣은 hwp 를 "다음 앱으로 열기"', async () => {
  adb('push', path.join(HERE, '../../tests/fixtures/sample.hwp'), '/sdcard/Download/and-sample.hwp');
  adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Download/and-sample.hwp');
  await page.evaluate(() => window.__app.closeDoc());
  // 파일 앱(문서 UI)에서 고르는 것과 같은 경로: 열기 화면 → 파일 선택
  page.evaluate(() => document.querySelector('#open').click());
  await sleep(2500);
  await tapText(/and-sample\.hwp/);
  await page.waitForFunction(() => window.__app.cur?.name === 'and-sample.hwp', null, { timeout: 60_000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
  await sleep(1500);
  const box = await page.locator('#editors').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.4);
  await page.keyboard.type('HWPDROID', { delay: 60 });
  await page.waitForFunction(() => window.__app.dirty, null, { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
  const local = path.join(os.tmpdir(), 'and-sample.hwp');
  adb('pull', '/sdcard/Download/and-sample.hwp', local);
  if (Buffer.compare(fs.readFileSync(local), fs.readFileSync(path.join(HERE, '../../tests/fixtures/sample.hwp'))) === 0) throw new Error('hwp 가 안 바뀜');
});
await step('인텐트로 열기 (VIEW, 파일 관리자에서 누른 것과 같음)', async () => {
  await page.evaluate(() => window.__app.closeDoc());
  const uri = await page.evaluate(() => JSON.parse(localStorage.getItem('myoffice.recent')).find((r) => r.name === 'and-sample.hwp').handle);
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-t', 'application/x-hwp', '-d', uri, '-n', `${PKG}/.MainActivity`);
  await page.waitForFunction(() => window.__app.cur?.name === 'and-sample.hwp', null, { timeout: 30_000 });
});
await page.screenshot({ path: path.join(HERE, 'android-last.png') }).catch(() => {});
await browser.close().catch(() => {});
for (const r of results) console.log(r.join('\t'));
if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '));
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
