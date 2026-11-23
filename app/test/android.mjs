#!/usr/bin/env node
// 안드로이드 앱 실제 실행 검사 (에뮬레이터/기기 + 디버그 APK).
//   ADB_SERIAL=emulator-5580 node app/test/android.mjs app/android/app/build/outputs/apk/debug/myoffice-1.0.1-debug.apk
// WebView 는 playwright 안드로이드 연결로 조작하고, 시스템 파일 화면은 uiautomator 로 누른다.
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
const LIB = `/sdcard/Android/data/${PKG}/files/알오피스`;
const apk = process.argv[2];
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { maxBuffer: 64 << 20 }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { clearAnr(); } catch { /* 무시 */ }
  try { await fn(); results.push([name, 'OK', `${((Date.now() - t) / 1000).toFixed(1)}s`]); } catch (e) { results.push([name, 'FAIL', e.message.split('\n')[0]]); }
  console.log(results.at(-1).join('\t'));
};

// 느린 에뮬레이터(소프트웨어 그래픽)는 시스템 UI 가 '응답 없음' 창을 띄워 키·터치를 가로챈다 → '기다리기'
function clearAnr() {
  for (let i = 0; i < 3; i++) {
    if (!/Application Not Responding|Not Responding/.test(adb('shell', 'dumpsys', 'window').match(/mCurrentFocus=.*/)?.[0] || '')) return;
    const xml = adb('exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty');
    const m = xml.match(/resource-id="android:id\/aerr_wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m) adb('shell', 'input', 'tap', String((+m[1] + +m[3]) >> 1), String((+m[2] + +m[4]) >> 1));
    execFileSync('sleep', ['1']);
  }
}
const key = (k) => { clearAnr(); adb('shell', 'input', 'keyevent', k); };

// 시스템 파일 화면에서 글자로 찾아 누르기 (화면이 바뀌는 중이면 dump 가 실패하므로 다시 시도)
async function tapText(re, tries = 30) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      clearAnr();
      const xml = adb('exec-out', 'uiautomator', 'dump', '--compressed', '/dev/tty');
      for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
        if (re.test(m[1])) { adb('shell', 'input', 'tap', String((+m[2] + +m[4]) >> 1), String((+m[3] + +m[5]) >> 1)); return m[1]; }
      }
      last = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).slice(0, 15).join('|');
    } catch (e) { last = String(e.stderr || e.message).slice(0, 120); }
    await sleep(1000);
  }
  throw new Error(`화면에서 ${re} 를 못 찾음 (${last})`);
}
function zipText(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16), out = '';
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (/\.xml$/.test(name)) {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
      const d = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + cs);
      try { out += (method === 8 ? zlib.inflateRawSync(d) : d).toString(); } catch { /* 무시 */ }
    }
    p += 46 + nl + xl + cl;
  }
  return out;
}
adb('shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1');   // 검사 기기에서만
const pull = (remote) => { const l = path.join(os.tmpdir(), `and-${Date.now()}-${path.basename(remote)}`); adb('pull', remote, l); return fs.readFileSync(l); };

if (apk) { console.log('설치 중…'); adb('install', '-r', '-g', apk); }
adb('shell', 'pm', 'clear', PKG);   // 깨끗한 상태로
adb('shell', 'rm', '-rf', '/sdcard/Download/and-*');
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
await sleep(3000);
const device = (await _android.devices()).find((d) => d.serial() === SERIAL);
if (!device) throw new Error(`기기 없음: ${SERIAL}`);
const page = await (await device.webView({ pkg: PKG })).page();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
const loaded = () => page.waitForFunction(() => window.__edit?.file && !document.querySelector('#loading'), null, { timeout: 180_000 });
const tapDoc = async (fy = 0.4) => {
  clearAnr();
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * fy);
  await sleep(600);
};

await step('홈 화면 (웹과 같은 화면, 계정·공유 없음)', async () => {
  await page.waitForFunction(() => document.querySelector('.new-card') && document.querySelector('.account')?.hidden, null, { timeout: 30_000 });
  console.log('  crossOriginIsolated =', await page.evaluate(() => window.crossOriginIsolated), '| 화면', await page.evaluate(() => `${innerWidth}x${innerHeight}`));
});
await step('새 워드 → 앱 폴더에 파일 → 입력·저장', async () => {
  await page.click('.new-card[data-type="docx"]');
  await page.waitForURL(/\/edit\?id=/);
  await loaded();
  await sleep(1500);
  await tapDoc();
  await page.keyboard.type('ANDROIDWORD', { delay: 50 });
  await sleep(800);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
  if (!zipText(pull(`${LIB}/새 워드.docx`)).includes('ANDROIDWORD')) throw new Error('저장된 docx 에 글자 없음');
});
await step('수정하고 뒤로 가기 → 저장하고 홈으로', async () => {
  await tapDoc();
  await page.keyboard.type('BACKSAVE', { delay: 50 });
  await page.waitForFunction(() => window.__edit.dirty, null, { timeout: 15_000 });
  for (let i = 0; i < 3 && /\/edit/.test(page.url()); i++) { key('KEYCODE_BACK'); await sleep(2500); }   // 첫 번째는 키보드만 닫힘
  await page.waitForURL((u) => !/\/edit/.test(u.toString()), { timeout: 30_000 });
  if (!zipText(pull(`${LIB}/새 워드.docx`)).includes('BACKSAVE')) throw new Error('뒤로 가기 전에 저장 안 됨');
  await page.locator('#list .row').first().waitFor();
});
await step('새 한셀 → 셀 아이콘, 앱 폴더에 xlsx', async () => {
  await page.click('.new-card[data-type="hcell"]');
  await page.waitForURL(/\/edit\?id=/);
  await loaded();
  if (!(await page.evaluate(() => window.__edit.file.app === 'hcell' && window.__edit.file.ext === 'xlsx'))) throw new Error('한셀 아님');
  if (!adb('shell', 'ls', LIB).includes('새 한셀.xlsx')) throw new Error('파일 없음');
  for (let i = 0; i < 3 && /\/edit/.test(page.url()); i++) { key('KEYCODE_BACK'); await sleep(2500); }
  await page.waitForURL((u) => !/\/edit/.test(u.toString()), { timeout: 30_000 });
});
await step('열기 → 시스템 파일 화면에서 hwp 고르기 → 그 자리에 저장', async () => {
  adb('push', path.join(HERE, '../../tests/fixtures/sample.hwp'), '/sdcard/Download/and-sample.hwp');
  adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', 'file:///sdcard/Download/and-sample.hwp');
  page.click('#open-file').catch(() => {});
  await sleep(2500);
  await tapText(/and-sample\.hwp/);
  await page.waitForURL(/\/edit\?id=/, { timeout: 60_000 });
  await loaded();
  await sleep(1500);
  await tapDoc(0.42);
  await page.keyboard.type('HWPDROID', { delay: 60 });
  await page.waitForFunction(() => window.__edit.dirty, null, { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
  if (Buffer.compare(pull('/sdcard/Download/and-sample.hwp'), fs.readFileSync(path.join(HERE, '../../tests/fixtures/sample.hwp'))) === 0) throw new Error('hwp 가 안 바뀜');
});
await step('편집기 다운로드(ODT) → 시스템 저장 화면 → 파일 생김', async () => {
  await page.goto(await page.evaluate(() => location.origin + '/'));
  await page.locator('#list .row', { hasText: '새 워드.docx' }).locator('[data-act="open"]').click();
  await loaded();
  await sleep(2000);
  const fe = page.frameLocator('#oo-holder iframe').frameLocator('iframe[name="frameEditor"]');
  await fe.locator('#file, li[data-tab="file"]').first().click();
  await sleep(1000);
  await fe.locator('.btn-doc-format[format="67"]').first().click();
  await sleep(3000);
  await tapText(/^(SAVE|Save|저장)$/);
  await sleep(2000);
  if (!/\.odt/.test(adb('shell', 'ls', '/sdcard/Download/'))) throw new Error('odt 없음');
});
await step('"다음 앱으로 열기" (VIEW 인텐트) → 편집 화면', async () => {
  const handle = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('myoffice.index'))).map((e) => e.handle).find((h) => h.startsWith('content://')));
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-t', 'application/x-hwp', '-d', handle, '-n', `${PKG}/.MainActivity`);
  await page.waitForFunction(() => window.__edit?.file?.name === 'and-sample.hwp', null, { timeout: 60_000 });
});
await page.screenshot({ path: path.join(HERE, 'android-last.png') }).catch(() => {});
await device.close().catch(() => {});
console.log('');
for (const r of results) console.log(r.join('\t'));
if (errors.length) console.log('page errors:', [...new Set(errors)].slice(0, 5).join(' | '));
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
