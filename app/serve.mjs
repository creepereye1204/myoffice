#!/usr/bin/env node
// 앱 화면을 브라우저에서 확인/테스트할 때 쓰는 정적 서버. 앱 껍데기(데스크톱/안드로이드)가 하는 일과 같다:
//   교차 출처 격리 헤더(COOP/COEP — wasm 스레드에 필요), 확장자별 MIME.
// 사용: node app/serve.mjs [port]   (기본 8790, 127.0.0.1 에만 열림)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mimeOf, resolvePath, HEADERS } from './shell-server.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), 'build', 'www');
const port = +(process.argv[2] || 8790);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/edit') url.pathname = '/edit.html';
  const file = resolvePath(ROOT, decodeURIComponent(url.pathname));
  if (!file) { res.writeHead(404, HEADERS); res.end('not found'); return; }
  const stat = fs.statSync(file);
  res.writeHead(200, { ...HEADERS, 'Content-Type': mimeOf(file), 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
