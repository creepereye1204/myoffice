#!/usr/bin/env node
// 앱 화면 동작 확인 (브라우저 + 가짜 파일 시스템). 데스크톱/안드로이드 껍데기와 같은 bridge 모양을 흉내 낸다.
//   node app/serve.mjs 8790 &  →  node app/test/smoke.mjs [http://127.0.0.1:8790] [검사이름...]
// 검사: docx, xlsx, pptx, hwp, hwpx, pdf, legacy, hcell, hshow, hwpmenu, download, drop
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(HERE, '../../tests/e2e/package.json'));
const { chromium } = require('playwright');

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:8790';
const only = process.argv.slice(2).filter((a) => !a.startsWith('http'));
const FIXTURE = path.join(HERE, '../../tests/fixtures/sample.hwp');

// zip 안 파일 하나 꺼내기 (중앙 디렉터리 읽기 — 의존성 없이)
function unzipEntry(buf, name) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const fname = buf.toString('utf8', p + 46, p + 46 + nl);
    if (fname === name || (name instanceof RegExp && name.test(fname))) {
      const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nl + xl + cl;
  }
  return null;
}
const zipText = (buf, re) => {
  const out = [];
  for (let i = 0; i < 400; i++) { /* 다 모으기 */ }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let p = buf.readUInt32LE(eocd + 16);
  const n = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < n; i++) {
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const fname = buf.toString('utf8', p + 46, p + 46 + nl);
    if (re.test(fname)) out.push(unzipEntry(buf, fname));
    p += 46 + nl + xl + cl;
  }
  return out.join('\n');
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // 가짜 bridge: 파일은 window.__fs (handle → bytes) 에. pickSave 는 다음에 쓸 이름을 __nextSave 로 받음
  await ctx.addInitScript(() => {
    const fs = (window.__fs = new Map());
    let dirty = false;
    window.nativeBridge = {
      platform: 'test',
      pickOpen: async () => { (window.__calls ||= []).push('pickOpen'); const f = window.__nextOpen; window.__nextOpen = null; return f; },
      read: async (h) => ({ name: h.split('/').pop(), bytes: fs.get(h) }),
      write: async (h, bytes) => { fs.set(h, new Uint8Array(bytes)); },
      pickSave: async (name, bytes) => { (window.__calls ||= []).push(`pickSave ${name}`); const h = `/saved/${window.__nextSave || name}`; fs.set(h, new Uint8Array(bytes)); window.__lastSave = h; return { handle: h, name: h.split('/').pop() }; },
      onOpenRequest: (cb) => { window.__open = cb; },
      setDirty: (d) => { dirty = d; window.__dirty = d; },
      setTitle: (t) => { document.title = t; },
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/myoffice/`);
  return { page, ctx, errors };
}
const getFile = (page, h) => page.evaluate((h) => Array.from(window.__fs.get(h) || []), h).then((a) => Buffer.from(a));
const toastOk = (page) => page.locator('.toast.ok').last().waitFor({ timeout: 60_000 });

async function waitOffice(page) {
  const outer = page.frameLocator('#office');
  await outer.frameLocator('iframe[name="frameEditor"]').locator('#editor_sdk').waitFor({ timeout: 120_000 });
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
  await page.waitForTimeout(1500);
}
async function clickDoc(page, fx = 0.5, fy = 0.45) {
  const box = await page.locator('#editors').boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(400);
}

const checks = {
  async docx(page) {
    await page.click('[data-new="docx"]');
    await waitOffice(page);
    await clickDoc(page);
    await page.keyboard.type('APPWORD123', { delay: 30 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+s');      // 새 문서 → 다른 이름으로 저장
    await toastOk(page);
    const h = await page.evaluate(() => window.__lastSave);
    const xml = unzipEntry(await getFile(page, h), 'word/document.xml');
    if (!xml?.includes('APPWORD123')) throw new Error('저장된 docx 에 입력한 글자가 없음');
    // 두 번째 Ctrl+S 는 같은 파일에 덮어쓰기
    await page.keyboard.type('MORE456', { delay: 30 });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__lastSave = null; });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('저장됨'), null, { timeout: 60_000 });
    await page.waitForTimeout(300);
    if (await page.evaluate(() => window.__lastSave)) throw new Error('두 번째 저장인데 다시 위치를 물음');
    const xml2 = unzipEntry(await getFile(page, h), 'word/document.xml');
    if (!xml2?.includes('MORE456')) throw new Error('덮어쓴 docx 에 추가 글자가 없음');
  },
  async xlsx(page) {
    await page.click('[data-new="xlsx"]');
    await waitOffice(page);
    await clickDoc(page, 0.2, 0.3);
    await page.keyboard.type('CELL777', { delay: 30 });   // Enter 없이 바로 저장
    await page.keyboard.press('Control+s');
    await toastOk(page);
    const h = await page.evaluate(() => window.__lastSave);
    const buf = await getFile(page, h);
    const txt = zipText(buf, /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/);
    if (!txt.includes('CELL777')) throw new Error('입력 중이던 셀이 저장되지 않음');
  },
  async pptx(page) {
    await page.click('[data-new="pptx"]');
    await waitOffice(page);
    await page.keyboard.press('Control+s');
    await toastOk(page);
    const buf = await getFile(page, await page.evaluate(() => window.__lastSave));
    if (!unzipEntry(buf, 'ppt/presentation.xml')) throw new Error('pptx 가 아님');
  },
  async pdf(page) {
    await page.click('[data-new="docx"]');
    await waitOffice(page);
    await clickDoc(page);
    await page.keyboard.type('PDFTEXT', { delay: 30 });
    await page.click('#more');
    await page.click('[data-act="pdf"]');
    await toastOk(page);
    const buf = await getFile(page, await page.evaluate(() => window.__lastSave));
    if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('PDF 가 아님');
  },
  async hwp(page) {
    const bytes = [...fs.readFileSync(FIXTURE)];
    await page.evaluate((b) => { window.__fs.set('/docs/sample.hwp', new Uint8Array(b)); window.__nextOpen = { handle: '/docs/sample.hwp', name: 'sample.hwp', bytes: new Uint8Array(b) }; }, bytes);
    await page.click('#open');
    await page.locator('#hwp iframe').waitFor();
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
    await page.waitForTimeout(1000);
    await clickDoc(page, 0.5, 0.42);
    await page.keyboard.type('HWPAPP', { delay: 40 });
    await page.waitForFunction(() => window.__dirty === true, null, { timeout: 10_000 });
    await page.keyboard.press('Control+s');
    await toastOk(page);
    const after = await getFile(page, '/docs/sample.hwp');
    if (Buffer.compare(after, Buffer.from(bytes)) === 0) throw new Error('hwp 파일이 바뀌지 않음');
    if (await page.evaluate(() => window.__dirty)) throw new Error('저장 후에도 수정됨 상태');
    // 다시 열어서 확인 (최근 문서 목록에서)
    await page.click('#home');
    await page.locator('#recent li[data-i]').first().click();
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
    const text = await page.evaluate(async () => {
      const ed = document.querySelector('#hwp iframe');
      return ed ? 'ok' : 'none';
    });
    if (text !== 'ok') throw new Error('다시 열기 실패');
  },
  async hwpx(page) {
    await page.click('[data-new="hwpx"]');
    await page.locator('#loading').waitFor({ state: 'visible' });
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
    await page.waitForTimeout(800);
    await clickDoc(page, 0.5, 0.3);
    await page.keyboard.type('HWPXNEW', { delay: 40 });
    await page.keyboard.press('Control+s');
    await toastOk(page);
    const buf = await getFile(page, await page.evaluate(() => window.__lastSave));
    if (!zipText(buf, /^Contents\/section\d+\.xml$/).includes('HWPXNEW')) throw new Error('hwpx 에 글자가 없음');
  },
  async legacy(page) {
    // 열기만 되는 형식(csv 는 쓰기 가능, ods 같은 건 xlsx 로 새로 저장) — csv 로 확인
    const csv = [...Buffer.from('이름,값\n가,1\n나,2\n')];
    await page.evaluate((b) => { window.__fs.set('/docs/t.csv', new Uint8Array(b)); window.__nextOpen = { handle: '/docs/t.csv', name: 't.csv', bytes: new Uint8Array(b) }; }, csv);
    await page.click('#open');
    await waitOffice(page);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('저장'), null, { timeout: 60_000 });
    const out = (await getFile(page, '/docs/t.csv')).toString('utf8');
    if (!out.includes('나')) throw new Error(`csv 저장 내용 이상: ${out.slice(0, 80)}`);
  },

  async hcell(page) {
    await page.click('[data-new="hcell"]');
    await waitOffice(page);
    if ((await page.locator('#doc-icon b').textContent()) !== '셀') throw new Error('한셀 아이콘 아님');
    await clickDoc(page, 0.2, 0.3);
    await page.keyboard.type('HCELL1', { delay: 30 });
    await page.keyboard.press('Control+s');
    await toastOk(page);
    const h = await page.evaluate(() => window.__lastSave);
    if (!h.endsWith('새 한셀 문서.xlsx')) throw new Error(`이름 이상: ${h}`);
    if (!zipText(await getFile(page, h), /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/).includes('HCELL1')) throw new Error('내용 없음');
    // 최근 문서에도 한셀로 표시
    await page.click('#home');
    if ((await page.locator('#recent li[data-i] .ficon b').first().textContent()) !== '셀') throw new Error('최근 문서 아이콘이 한셀이 아님');
  },
  async hshow(page) {
    await page.click('[data-new="hshow"]');
    await waitOffice(page);
    if ((await page.locator('#doc-icon b').textContent()) !== '쇼') throw new Error('한쇼 아이콘 아님');
    await page.keyboard.press('Control+s');
    await toastOk(page);
    const h = await page.evaluate(() => window.__lastSave);
    if (!h.endsWith('새 한쇼 문서.pptx') || !unzipEntry(await getFile(page, h), 'ppt/presentation.xml')) throw new Error(`한쇼 저장 이상: ${h}`);
  },
  async hwpmenu(page) {
    // 한글 편집기 자체 '파일' 메뉴가 앱의 열기/저장으로 가는지 (편집기 안에서 따로 열리면 앞 파일을 덮어쓰는 사고)
    const bytes = [...fs.readFileSync(FIXTURE)];
    await page.evaluate((b) => { window.__fs.set('/docs/m.hwp', new Uint8Array(b)); window.__nextOpen = { handle: '/docs/m.hwp', name: 'm.hwp', bytes: new Uint8Array(b) }; }, bytes);
    await page.click('#open');
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
    await page.waitForTimeout(1000);
    const f = page.frameLocator('#hwp iframe');
    const menu = async (cmd) => {
      const item = f.locator(`[data-cmd="${cmd}"]`);
      for (let i = 0; i < 3 && !(await item.isVisible()); i++) {
        await f.locator('.menu-item[data-menu="file"] > .menu-title').click();
        await page.waitForTimeout(300);
      }
      await item.click();
      await page.waitForTimeout(800);
      if (await item.isVisible()) throw new Error(`${cmd} 누른 뒤 메뉴가 안 닫힘`);
    };
    await f.locator('.menu-item[data-menu="file"] > .menu-title').click();
    await page.waitForTimeout(300);
    if (await f.locator('.md-sub[data-recent]').isVisible()) throw new Error('편집기 최근 문서 메뉴가 안 숨겨짐');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__calls = []; });
    await menu('file:open');
    await clickDoc(page, 0.5, 0.42);
    await page.keyboard.type('MENU1', { delay: 40 });
    await page.waitForFunction(() => window.__dirty === true, null, { timeout: 10_000 });
    await menu('file:save');
    await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent), null, { timeout: 30_000 });
    await menu('file:save-as-hwpx');
    await toastOk(page);
    const calls = await page.evaluate(() => window.__calls);
    if (calls[0] !== 'pickOpen') throw new Error(`열기 메뉴가 앱으로 안 감: ${calls}`);
    if (!calls.includes('pickSave m.hwpx')) throw new Error(`HWPX로 저장 메뉴 이상: ${calls}`);
    if (Buffer.compare(await getFile(page, '/docs/m.hwp'), Buffer.from(bytes)) === 0) throw new Error('메뉴 저장이 파일에 안 씀');
    if (!(await page.evaluate(() => window.__app.cur.name)).endsWith('.hwpx')) throw new Error('HWPX 로 저장 후 현재 문서 이름이 안 바뀜');
    // 바깥 스크롤바 없음 (이중 스크롤)
    const sc = await page.evaluate(() => { const e = document.querySelector('#hwp'); return e.scrollHeight - e.clientHeight; });
    if (sc > 1) throw new Error(`한글 화면 바깥 스크롤 ${sc}px`);
  },
  async download(page) {
    // 편집기 자체 '다운로드 방법'(ONLYOFFICE)·'HTML로 내보내기'(한글) → 앱 저장 대화상자
    await page.click('[data-new="docx"]');
    await waitOffice(page);
    const fe = page.frameLocator('#office').frameLocator('iframe[name="frameEditor"]');
    await page.evaluate(() => { window.__calls = []; });
    await fe.locator('#file, li[data-tab="file"]').first().click();
    await page.waitForTimeout(800);
    await fe.locator('.btn-doc-format[format="67"]').first().click();   // ODT
    await page.waitForFunction(() => (window.__calls || []).some((c) => c.endsWith('.odt')), null, { timeout: 30_000 });
    await page.evaluate(() => window.__app.closeDoc());
    await page.click('[data-new="hwp"]');
    await page.locator('#loading').waitFor({ state: 'visible' });
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
    const f = page.frameLocator('#hwp iframe');
    await f.locator('.menu-item[data-menu="file"] > .menu-title').click();
    await page.waitForTimeout(300);
    await f.locator('[data-cmd="file:export-html"]').click();
    await page.waitForFunction(() => (window.__calls || []).some((c) => /\.html?$/.test(c)), null, { timeout: 30_000 });
  },
  async drop(page) {
    // 문서 파일을 편집기 위에 놓으면 앱에서 연다 (편집기 안에서 열리면 앞 파일 핸들로 저장되는 사고)
    await page.click('[data-new="docx"]');
    await waitOffice(page);
    const bytes = [...fs.readFileSync(FIXTURE)];
    await page.frames().find((fr) => fr.name() === 'frameEditor').evaluate((b) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b)], 'dropped.hwp'));
      const t = document.querySelector('#editor_sdk') || document.body;
      t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, bytes);
    await page.waitForFunction(() => window.__app.cur?.name === 'dropped.hwp', null, { timeout: 30_000 });
    if (await page.evaluate(() => window.__app.cur.handle)) throw new Error('끌어다 놓은 파일에 핸들이 붙음 (브라우저에선 경로 없음)');
  },
};


for (const [name, fn] of Object.entries(checks)) {
  if (only.length && !only.includes(name)) continue;
  const t = Date.now();
  const { page, ctx, errors } = await newPage();
  try {
    await fn(page);
    results.push([name, 'OK', ((Date.now() - t) / 1000).toFixed(1) + 's', errors.slice(0, 3).join(' | ')]);
  } catch (e) {
    await page.screenshot({ path: path.join(HERE, `fail-${name}.png`) }).catch(() => {});
    results.push([name, 'FAIL', ((Date.now() - t) / 1000).toFixed(1) + 's', `${e.message.split('\n')[0]} ${errors.slice(0, 3).join(' | ')}`]);
  }
  await ctx.close();
}
await browser.close();
for (const r of results) console.log(r.join('\t'));
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
