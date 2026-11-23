#!/usr/bin/env node
// 앱에 넣을 정적 파일을 app/build/www 에 모은다 (도커 필요). 앱 화면은 웹 사이트 화면 그대로다.
//
//   www/                ← 이 저장소 frontend 이미지 (홈·편집 화면, rhwp-studio 한글 편집기 + 글꼴)
//                          common.js 의 LOCAL 을 켜서 서버 대신 기기 안에서 동작 (frontend/public/local/)
//   www/document/       ← 오프라인 ONLYOFFICE 편집기 (ranuts/document 공식 이미지, AGPL-3.0)
//                          editor.html + sdkjs + web-apps + fonts + x2t.wasm(문서 변환기를 WebAssembly 로)
//   www/templates/      ← 빈 문서 (이 저장소 api 이미지)
//
// 사용: node app/prepare.mjs [--keep-ai]
//   --keep-ai  오프라인 편집기의 AI 도우미 모델 엔진(수십 MB)을 지우지 않음. 기본은 지움 (앱에서는 안 씀)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// 고정한 버전 — 올릴 때는 digest 를 바꾸고 다시 테스트
export const OO_IMAGE = 'ghcr.io/ranuts/document@sha256:71796812a5184571def5881fd3df8744bea942f96d0741d692e0a92388c97f7c';

const APP = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(APP, '..');
const OUT = path.join(APP, 'build', 'www');
// 편집기는 스스로 /document/ 아래에 놓인 것을 알아보고 경로를 맞춘다 (다른 이름이면 일부 worker 경로가 틀어짐)
const OO = path.join(OUT, 'document');
const keepAi = process.argv.includes('--keep-ai');

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
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
function replaceIn(file, from, to) {
  const s = fs.readFileSync(file, 'utf8');
  if (!s.includes(from)) throw new Error(`${path.relative(OUT, file)} 에 '${from}' 가 없습니다 — 편집기 버전이 바뀌었나요?`);
  fs.writeFileSync(file, s.split(from).join(to));
}

fs.rmSync(OUT, { recursive: true, force: true });

// ---- 1. 웹 화면 + 한글 편집기 (frontend 이미지)
log('웹 화면 빌드 중 (처음엔 몇 분 걸림)');
sh('docker', ['build', '-q', '-t', 'myoffice-app-web', path.join(ROOT, 'frontend')]);
copyOut('myoffice-app-web', '/usr/share/nginx/html', OUT);
// 서버 전용 화면, 미리 압축한 .br/.gz, TTF 로 풀어 둔 woff/woff2 원본(편집기는 .woff.ttf 를 씀)은 앱에 필요 없음
for (const f of ['login.html', 'login.js', 'admin.html', 'admin.js', '50x.html']) fs.rmSync(path.join(OUT, f), { force: true });
walk(OUT, (p) => {
  if (/\.(br|gz)$/.test(p) || (/\.woff2?$/.test(p) && (fs.existsSync(`${p}.ttf`) || fs.existsSync(`${p}.otf`)))) fs.rmSync(p);
});
replaceIn(path.join(OUT, 'common.js'), '/*@LOCAL*/false', 'true');

// ---- 2. 오프라인 ONLYOFFICE 편집기 → /document/
log('오프라인 편집기 받는 중', OO_IMAGE);
sh('docker', ['pull', '-q', OO_IMAGE]);
copyOut(OO_IMAGE, '/public', OO);
// 웹사이트용 소개 페이지·다른 언어 소개 페이지는 필요 없음
for (const d of ['de', 'es', 'ja', 'pt', 'zh-CN', 'ko', 'help', 'convert', 'open', 'social']) fs.rmSync(path.join(OO, d), { recursive: true, force: true });
for (const f of fs.readdirSync(OO)) if (f.endsWith('.html') && f !== 'editor.html') fs.rmSync(path.join(OO, f));
for (const f of ['_headers', '_redirects', 'sitemap.xml', 'robots.txt', 'llms.txt', 'llms-full.txt']) fs.rmSync(path.join(OO, f), { force: true });
// 서비스 워커는 앱에서 쓸모없음 (파일이 이미 기기에 있음) → 아무 일도 안 하는 빈 워커
fs.writeFileSync(path.join(OO, 'sw.js'), "self.addEventListener('install',()=>self.skipWaiting());\n");
if (!keepAi) {
  let n = 0;
  for (const f of fs.readdirSync(path.join(OO, 'assets'))) {
    if (/^(wllama-.*\.wasm|webllm\.worker-.*\.js)$/.test(f)) { fs.rmSync(path.join(OO, 'assets', f)); n++; }
  }
  log(`AI 모델 엔진 ${n}개 제외`);
}
// 편집기 파일은 /document/ 기준으로 경로를 맞추는데 변환기 worker 하나만 절대 경로(/sdkjs/...)로 고정 → 고침
let patched = 0;
for (const f of fs.readdirSync(path.join(OO, 'assets'))) {
  const p = path.join(OO, 'assets', f);
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(p, 'utf8');
  if (s.includes('`/sdkjs/common/wasm/x2t/x2t.worker.js`')) { fs.writeFileSync(p, s.replace('`/sdkjs/common/wasm/x2t/x2t.worker.js`', '`/document/sdkjs/common/wasm/x2t/x2t.worker.js`')); patched++; }
}
if (patched !== 1) throw new Error(`x2t worker 경로를 ${patched}곳에서 고침 (1곳이어야 함) — 편집기 버전이 바뀌었나요?`);
// x2t.wasm.br 은 도커 이미지에서 gzip 으로 들어 있고 서버가 Content-Encoding 을 붙여 보낸다.
// 앱은 파일을 그대로 내주므로 미리 풀어 둔다 (이름은 편집기가 찾는 그대로).
const x2t = path.join(OO, 'sdkjs/common/wasm/x2t/x2t.wasm.br');
let raw = fs.readFileSync(x2t);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
else if (raw.subarray(0, 4).toString('latin1') !== '\0asm') raw = zlib.brotliDecompressSync(raw);
if (raw.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error('x2t 가 wasm 이 아닙니다');
fs.writeFileSync(x2t, raw);
log('x2t.wasm', `${(raw.length / 1048576).toFixed(1)}MB`);

// ---- 3. 빈 문서
log('빈 문서 템플릿 빌드 중');
sh('docker', ['build', '-q', '-t', 'myoffice-app-api', path.join(ROOT, 'api')]);
copyOut('myoffice-app-api', '/app/templates', path.join(OUT, 'templates'));

fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({ built: new Date().toISOString(), office: OO_IMAGE }, null, 1));
log('완료', OUT, du(OUT));
