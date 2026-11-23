#!/usr/bin/env node
// 모든 문서 형식 자동 검사 (앱 모드, 브라우저 저장소). 형식마다:
//   ① 가져오기(업로드 버튼) → ② 편집 화면에서 오류 없이 열림 → ③ 한글 글자가 깨지지 않았는지
//      (편집기에서 OOXML/HML 로 꺼내 글자 확인 + 워드·엑셀·피피티는 PDF 로 꺼내 pdftotext 로 글자 확인)
//   → ④ 편집 가능한 형식은 글자를 넣고 Ctrl+S → 다시 열어 같은 형식 파일에 남았는지
//
//   app/test/make-corpus.sh                       # 검사 문서 만들기 (app/build/corpus)
//   node app/serve.mjs 8790 &
//   node app/test/formats.mjs [http://127.0.0.1:8790] [파일이름…]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(path.join(HERE, '../../tests/e2e/package.json'));
const { chromium } = require('playwright');
const CORPUS = path.join(HERE, '../build/corpus');
const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:8790';
const only = process.argv.slice(2).filter((a) => !a.startsWith('http'));

// 파일별 기대 글자 (원본에 있는 한글·영문)
const EXPECT = {
  word: ['가나다라', 'FMTWORD'], cell: ['가나다', 'FMTCELL'], slide: ['발표 제목', 'FMTSLIDE'],
  hangul: ['경상수입'], 'legacy-cp949': ['가나다', 'FMTCP949'],
};
const EDITABLE = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'hwp', 'hwpx']);
const OOXML = { word: 'docx', cell: 'xlsx', slide: 'pptx' };

// ---------------------------------------------------------------- 글자 꺼내기 (의존성 없이)
function zipEntries(buf) {
  const out = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return out;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10), cs = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + cs);
    try { out[name] = (method === 8 ? zlib.inflateRawSync(data) : data); } catch { /* 무시 */ }
    p += 46 + nl + xl + cl;
  }
  return out;
}
function textOf(buf, ext) {
  if (['txt', 'csv'].includes(ext)) return buf.toString('utf8');
  if (ext === 'pdf') {
    const f = path.join(os.tmpdir(), `fmt-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(f, buf);
    try { return execFileSync('pdftotext', ['-q', f, '-']).toString(); } finally { fs.rmSync(f, { force: true }); }
  }
  const z = zipEntries(buf);
  return Object.entries(z).filter(([n]) => /\.xml$/.test(n) && !/styles|theme|settings|fontTable|webSettings/.test(n))
    .map(([, d]) => d.toString('utf8').replace(/<[^>]+>/g, ' ')).join(' ').replace(/\s+/g, ' ');
}
const has = (text, words) => words.every((w) => text.replace(/\s+/g, '').includes(w.replace(/\s+/g, '')));

// ---------------------------------------------------------------- 검사
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
const files = fs.readdirSync(CORPUS).filter((f) => !only.length || only.includes(f)).sort();

for (const name of files) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const stem = path.basename(name, `.${ext}`);
  const expect = EXPECT[stem];
  const steps = [];
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  const note = (s) => steps.push(s);
  let ok = true;
  const check = (cond, msg) => { if (!cond) { ok = false; note(`✗ ${msg}`); } else note(`✓ ${msg}`); };
  try {
    // ① 가져오기
    await page.goto(`${BASE}/`);
    await page.locator('#file-input').setInputFiles(path.join(CORPUS, name));
    await page.locator('#list .row').first().waitFor({ timeout: 30_000 });
    // ② 열기
    await page.locator('#list .row [data-act="open"]').first().click();
    await page.waitForURL(/\/edit\?id=/);
    const type = await page.waitForFunction(() => window.__edit?.file?.type, null, { timeout: 30_000 }).then((h) => h.jsonValue());
    await page.waitForFunction(() => !document.querySelector('#loading'), null, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    const errToast = await page.locator('.toast.err').allTextContents();
    check(!errToast.length, `열림${errToast.length ? ` (오류: ${errToast.join(' / ')})` : ''}`);
    // ③ 글자 확인
    if (type === 'hwp') {
      const hwpx = await page.evaluate(async () => [...await window.__edit.editor.exportHwpx()]);
      check(has(textOf(Buffer.from(hwpx), 'hwpx'), expect), `한글 글자 (편집기에서 HWPX로 꺼내서: ${expect.join(', ')})`);
    } else {
      const outExt = type === 'pdf' ? 'pdf' : OOXML[type];
      const bytes = await page.evaluate(async (x) => [...(await window.__edit.office.save(x)).bytes], outExt);
      check(has(textOf(Buffer.from(bytes), outExt), expect), `글자 (${outExt.toUpperCase()}로 꺼내서: ${expect.join(', ')})`);
      if (type !== 'pdf') {
        const pdf = await page.evaluate(async () => [...(await window.__edit.office.save('pdf')).bytes]);
        const t = textOf(Buffer.from(pdf), 'pdf');
        check(has(t, expect), `PDF 글자 (${expect.join(', ')})`);
      }
    }
    // ④ 편집 → 저장 → 다시 열기
    if (EDITABLE.has(ext)) {
      const mark = `EDIT${ext.toUpperCase()}수정`;
      const box = await page.locator('#stage').boundingBox();
      if (type === 'cell') await page.mouse.click(box.x + 120, box.y + box.height * 0.45);
      else if (type === 'slide') { await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.36); await page.keyboard.press('End'); }   // 슬라이드 본문 글상자
      else await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.42);
      await page.waitForTimeout(400);
      await page.keyboard.type(mark, { delay: 25 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Control+s');
      await page.waitForFunction(() => /저장됨/.test(document.querySelector('#status').textContent), null, { timeout: 60_000 });
      await page.reload();
      await page.waitForFunction(() => window.__edit?.file && !document.querySelector('#loading'), null, { timeout: 120_000 });
      await page.waitForTimeout(1500);
      let text;
      {
        // 저장된 파일 자체(같은 형식)에서 확인
        const raw = await page.evaluate(async () => {
          const { readFile } = await import('/local/backend.js');
          return [...await readFile(new URLSearchParams(location.search).get('id'))];
        });
        // hwp 는 바이너리라 다시 연 편집기에서 HWPX 로 꺼내 확인
        text = ext === 'hwp' ? textOf(Buffer.from(await page.evaluate(async () => [...await window.__edit.editor.exportHwpx()])), 'hwpx') : textOf(Buffer.from(raw), ext);
      }
      check(has(text, [mark, ...expect]), `편집 저장 후 다시 열기 (${ext} 그대로, '${mark}' + 원래 글자)`);
    }
    check(!errors.length, `페이지 오류 없음${errors.length ? `: ${errors.slice(0, 2).join(' | ')}` : ''}`);
  } catch (e) {
    ok = false;
    note(`✗ ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(HERE, `fail-fmt-${name}.png`) }).catch(() => {});
  }
  results.push({ name, ok, time: ((Date.now() - t0) / 1000).toFixed(1), steps });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${steps.join('  ')}`);
  await ctx.close();
}
await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 통과`);
process.exit(bad.length ? 1 : 0);
