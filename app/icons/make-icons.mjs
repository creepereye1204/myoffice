#!/usr/bin/env node
// 앱 아이콘 + 파일 종류별 아이콘을 만든다 (SVG → 크롬으로 PNG → ICO).
//   node app/icons/make-icons.mjs   → app/icons/out/{app,<ext>}.{svg,png,ico} 와 크기별 png
// 결과물은 저장소에 같이 넣어 둔다 (빌드할 때마다 만들 필요 없음).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, 'out');
const require = createRequire(path.join(HERE, '../../tests/e2e/package.json'));
const { chromium } = require('playwright');

// 연결할 형식 — 색은 앱 화면과 같게
export const TYPES = {
  hwp: { letter: '한', color: '#0f8fc6', name: '한글 문서' },
  hwpx: { letter: '한', color: '#0f8fc6', name: '한글 문서 (HWPX)' },
  docx: { letter: 'W', color: '#2b5bb8', name: '워드 문서' },
  doc: { letter: 'W', color: '#2b5bb8', name: '워드 97-2003 문서' },
  odt: { letter: 'W', color: '#2b5bb8', name: 'ODF 텍스트 문서' },
  rtf: { letter: 'W', color: '#2b5bb8', name: '서식 있는 텍스트' },
  xlsx: { letter: 'X', color: '#1e7d4a', name: '엑셀 통합 문서' },
  xls: { letter: 'X', color: '#1e7d4a', name: '엑셀 97-2003 통합 문서' },
  ods: { letter: 'X', color: '#1e7d4a', name: 'ODF 스프레드시트' },
  pptx: { letter: 'P', color: '#c8501f', name: '파워포인트 프레젠테이션' },
  ppt: { letter: 'P', color: '#c8501f', name: '파워포인트 97-2003 프레젠테이션' },
  odp: { letter: 'P', color: '#c8501f', name: 'ODF 프레젠테이션' },
};

const FONT = `font-family="'Noto Sans CJK KR','Noto Sans KR','Malgun Gothic',sans-serif"`;
const appSvg = fs.readFileSync(path.join(HERE, '../shell/icon.svg'), 'utf8');

// 파일 아이콘: 흰 종이(접힌 모서리) + 색 글자 + 아래 색 띠에 확장자
function fileSvg(ext, { letter, color }) {
  const label = ext.toUpperCase();
  const fs2 = label.length > 3 ? 10.5 : 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity=".25"/></filter></defs>
  <path filter="url(#s)" d="M14 3h26l14 14v42a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="#fff" stroke="#c9ced6" stroke-width="1"/>
  <path d="M40 3v11a3 3 0 0 0 3 3h11" fill="#e8ebf0" stroke="#c9ced6" stroke-width="1"/>
  <text x="32" y="37" text-anchor="middle" ${FONT} font-weight="800" font-size="${letter.length > 1 ? 15 : 22}" fill="${color}">${letter}</text>
  <rect x="7" y="43" width="50" height="15" rx="3" fill="${color}"/>
  <text x="32" y="54.5" text-anchor="middle" ${FONT} font-weight="700" font-size="${fs2}" fill="#fff" letter-spacing=".3">${label}</text>
</svg>`;
}

// PNG 여러 장 → ICO (PNG 그대로 넣는 방식, Windows Vista 이후 지원)
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p[1])]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
async function render(svg, size) {
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
for (const [name, svg] of [['app', appSvg], ...Object.entries(TYPES).map(([e, t]) => [e, fileSvg(e, t)])]) {
  fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
  const pngs = [];
  for (const s of SIZES) {
    const png = await render(svg, s);
    pngs.push([s, png]);
    if (s === 512) fs.writeFileSync(path.join(OUT, `${name}.png`), png);
    fs.mkdirSync(path.join(OUT, 'png', `${s}`), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'png', `${s}`, `${name}.png`), png);
  }
  fs.writeFileSync(path.join(OUT, `${name}.ico`), ico(pngs.filter(([s]) => s <= 256)));
}
fs.writeFileSync(path.join(OUT, 'types.json'), JSON.stringify(TYPES, null, 1));
await browser.close();
console.log('icons →', OUT);
