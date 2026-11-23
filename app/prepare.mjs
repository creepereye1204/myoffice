#!/usr/bin/env node
// 앱에 넣을 정적 파일을 app/build/www 에 모은다 (도커 필요).
//
//   www/                  ← ranuts/document 의 공식 이미지에서 꺼낸 오프라인 ONLYOFFICE 편집기 (AGPL-3.0)
//                            editor.html + sdkjs + web-apps + fonts + x2t.wasm(문서 변환기를 WebAssembly 로)
//   www/rhwp/, www/vendor/ ← 이 저장소 frontend 이미지를 빌드해서 꺼낸 rhwp-studio (글꼴 TTF 변환까지 끝난 것)
//   www/myoffice/         ← 앱 화면 (app/shell) + 빈 문서 템플릿 (api 이미지에서)
//
// 사용: node app/prepare.mjs [--keep-ai]
//   --keep-ai  편집기의 AI 도우미용 모델 엔진(수십 MB)을 지우지 않음. 기본은 지움 (앱에서는 안 씀)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// 고정한 버전 — 올릴 때는 digest 를 바꾸고 다시 테스트
export const OO_IMAGE = 'ghcr.io/ranuts/document@sha256:71796812a5184571def5881fd3df8744bea942f96d0741d692e0a92388c97f7c';

const APP = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(APP, '..');
const OUT = path.join(APP, 'build', 'www');
const keepAi = process.argv.includes('--keep-ai');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts }).toString().trim();
const log = (...a) => console.log('[prepare]', ...a);

function copyOut(image, src, dest) {
  const id = sh('docker', ['create', image]);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    sh('docker', ['cp', `${id}:${src}`, dest]);
  } finally {
    sh('docker', ['rm', id]);
  }
}
function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn); else fn(p);
  }
}
function du(dir) { let n = 0; walk(dir, (p) => { n += fs.statSync(p).size; }); return `${(n / 1048576).toFixed(0)}MB`; }

fs.rmSync(path.join(APP, 'build'), { recursive: true, force: true });

// ---- 1. 오프라인 ONLYOFFICE 편집기
log('ONLYOFFICE 편집기 받는 중', OO_IMAGE);
sh('docker', ['pull', '-q', OO_IMAGE]);
copyOut(OO_IMAGE, '/public', OUT);
// 웹사이트용 소개 페이지·다른 언어 소개 페이지는 앱에 필요 없음
for (const d of ['de', 'es', 'ja', 'pt', 'zh-CN', 'ko', 'help', 'convert', 'open', 'social']) fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
for (const f of fs.readdirSync(OUT)) {
  if (f.endsWith('.html') && !['editor.html', '404.html'].includes(f)) fs.rmSync(path.join(OUT, f));
}
for (const f of ['_headers', '_redirects', 'sitemap.xml', 'robots.txt', 'llms.txt', 'llms-full.txt']) fs.rmSync(path.join(OUT, f), { force: true });
// 서비스 워커는 앱에서 쓸모없음 (파일이 이미 기기에 있음) → 등록돼도 아무 일도 안 하는 빈 워커로
fs.writeFileSync(path.join(OUT, 'sw.js'), "self.addEventListener('install',()=>self.skipWaiting());\n");
if (!keepAi) {
  let n = 0;
  for (const f of fs.readdirSync(path.join(OUT, 'assets'))) {
    if (/^(wllama-.*\.wasm|webllm\.worker-.*\.js)$/.test(f)) { fs.rmSync(path.join(OUT, 'assets', f)); n++; }
  }
  log(`AI 모델 엔진 ${n}개 제외`);
}
// x2t.wasm.br 은 도커 이미지에서 gzip 으로 들어 있고 서버가 Content-Encoding 을 붙여 보낸다.
// 앱은 파일을 그대로 내주므로 미리 풀어 둔다 (이름은 편집기가 찾는 그대로).
const x2t = path.join(OUT, 'sdkjs/common/wasm/x2t/x2t.wasm.br');
let raw = fs.readFileSync(x2t);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
else if (raw.subarray(0, 4).toString('latin1') !== '\0asm') raw = zlib.brotliDecompressSync(raw);
if (raw.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error('x2t 가 wasm 이 아닙니다');
fs.writeFileSync(x2t, raw);
log('x2t.wasm', `${(raw.length / 1048576).toFixed(1)}MB`);

// ---- 2. 한글 편집기 (rhwp-studio)
log('한글 편집기 빌드 중 (처음엔 몇 분 걸림)');
sh('docker', ['build', '-q', '-t', 'myoffice-app-web', path.join(ROOT, 'frontend')], { stdio: ['ignore', 'pipe', 'inherit'] });
copyOut('myoffice-app-web', '/usr/share/nginx/html/rhwp', path.join(OUT, 'rhwp'));
copyOut('myoffice-app-web', '/usr/share/nginx/html/vendor', path.join(OUT, 'vendor'));
// 미리 압축한 .br/.gz 와, TTF 로 풀어 둔 woff/woff2 원본(편집기는 .woff.ttf 를 씀)은 앱에 필요 없음
walk(path.join(OUT, 'rhwp'), (p) => {
  if (/\.(br|gz)$/.test(p) || (/\.woff2?$/.test(p) && (fs.existsSync(`${p}.ttf`) || fs.existsSync(`${p}.otf`)))) fs.rmSync(p);
});

// ---- 3. 앱 화면 + 빈 문서
fs.cpSync(path.join(APP, 'shell'), path.join(OUT, 'myoffice'), { recursive: true });
log('빈 문서 템플릿 빌드 중');
sh('docker', ['build', '-q', '-t', 'myoffice-app-api', path.join(ROOT, 'api')], { stdio: ['ignore', 'pipe', 'inherit'] });
copyOut('myoffice-app-api', '/app/templates', path.join(OUT, 'myoffice', 'templates'));

fs.writeFileSync(path.join(OUT, 'myoffice', 'build.json'), JSON.stringify({ built: new Date().toISOString(), office: OO_IMAGE }, null, 1));
log('완료', OUT, du(OUT));
