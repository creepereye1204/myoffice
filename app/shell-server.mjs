// 앱 파일을 내줄 때 공통 규칙 (serve.mjs 와 데스크톱 앱이 같이 씀. 안드로이드는 Java 로 같은 규칙을 구현)
import fs from 'node:fs';
import path from 'node:path';

export const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json', map: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', ico: 'image/x-icon', webp: 'image/webp',
  wasm: 'application/wasm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf',
  docx: 'application/octet-stream', xlsx: 'application/octet-stream', pptx: 'application/octet-stream', hwp: 'application/octet-stream', hwpx: 'application/octet-stream',
};
export function mimeOf(file) {
  if (file.endsWith('x2t.wasm.br')) return 'application/wasm';  // 미리 풀어 둔 wasm (prepare.mjs)
  return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

// URL 경로 → 실제 파일 (ROOT 밖으로 못 나가게). 디렉터리는 index.html, 확장자 없으면 .html 도 찾아 봄 (/editor → editor.html)
export function resolvePath(root, urlPath) {
  const p = path.normalize(path.join(root, urlPath));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  for (const c of [p, path.join(p, 'index.html'), `${p}.html`]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 없음 */ }
  }
  return null;
}
