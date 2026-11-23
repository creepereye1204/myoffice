// 알오피스 데스크톱 (우분투·윈도우) — 인터넷/서버 없이 기기 안에서 문서 편집
//   화면: resources/www (app/prepare.mjs 가 모은 파일) 를 https://app.myoffice.localhost/ 로 내준다.
//         (네트워크로 나가지 않고 앱이 직접 응답. 한글 편집기는 http(s) 주소만 받아서 https 를 가로챈다)
//   파일: 열기/저장 대화상자, 경로로 바로 읽고 쓰기 (preload.js 의 nativeBridge)
//   "이 앱으로 열기": 실행 인자 / 이미 켜져 있으면 두 번째 실행의 인자를 받아 연다.
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const HOST = 'app.myoffice.localhost';
const ORIGIN = `https://${HOST}`;
const WWW = app.isPackaged ? path.join(process.resourcesPath, 'www') : path.join(__dirname, '..', 'build', 'www');
const EXTS = ['hwp', 'hwpx', 'docx', 'doc', 'odt', 'rtf', 'txt', 'xlsx', 'xls', 'csv', 'ods', 'pptx', 'ppt', 'odp', 'pdf'];
const FILTERS = [
  { name: '모든 문서', extensions: EXTS },
  { name: '한글', extensions: ['hwp', 'hwpx'] },
  { name: '워드', extensions: ['docx', 'doc', 'odt', 'rtf', 'txt'] },
  { name: '엑셀', extensions: ['xlsx', 'xls', 'csv', 'ods'] },
  { name: '파워포인트', extensions: ['pptx', 'ppt', 'odp'] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: '모든 파일', extensions: ['*'] },
];

// ---------------------------------------------------------------- 앱 파일 내주기

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', ico: 'image/x-icon', webp: 'image/webp', wasm: 'application/wasm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
  woff2: 'font/woff2', txt: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf', map: 'application/json',
};
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
function resolve(urlPath) {
  const p = path.normalize(path.join(WWW, urlPath));
  if (p !== WWW && !p.startsWith(WWW + path.sep)) return null;
  for (const c of [p, path.join(p, 'index.html'), `${p}.html`]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 없음 */ }
  }
  return null;
}
function serve(req) {
  const url = new URL(req.url);
  if (url.host !== HOST) return net.fetch(req, { bypassCustomProtocolHandlers: true });  // 다른 주소는 그대로
  if (url.pathname === '/') return Response.redirect(`${ORIGIN}/myoffice/`, 302);
  const file = resolve(decodeURIComponent(url.pathname));
  if (!file) return new Response('not found', { status: 404, headers: HEADERS });
  const type = file.endsWith('x2t.wasm.br') ? 'application/wasm' : (MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream');
  const size = fs.statSync(file).size;
  // 큰 파일(글꼴·wasm)은 스트림으로
  const body = size > 1 << 20 ? require('node:stream').Readable.toWeb(fs.createReadStream(file)) : fs.readFileSync(file);
  return new Response(body, { headers: { ...HEADERS, 'Content-Type': type, 'Content-Length': String(size) } });
}

// ---------------------------------------------------------------- 파일
async function readDoc(p) {
  const bytes = await fsp.readFile(p);
  return { handle: p, name: path.basename(p), bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}
// 저장 도중 꺼져도 원래 파일이 깨지지 않게: 같은 폴더 임시 파일에 쓰고 바꿔치기
async function writeAtomic(p, bytes) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, Buffer.from(bytes));
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    // 일부 네트워크 드라이브는 rename 덮어쓰기가 안 됨 → 직접 쓰기
    if (e.code === 'EPERM' || e.code === 'EXDEV' || e.code === 'EBUSY') await fsp.writeFile(p, Buffer.from(bytes));
    else throw e;
  }
}
let lastDir = app.getPath('documents');

// ---------------------------------------------------------------- 창
const wins = new Set();
const pendingOpen = [];   // 창이 준비되기 전에 들어온 "이 앱으로 열기"
function docArgs(argv) {
  // 파일 관리자는 경로나 file:// 주소로 넘긴다 (.desktop 의 %U)
  return argv.slice(1)
    .map((a) => { try { return a.startsWith('file://') ? require('node:url').fileURLToPath(a) : a; } catch { return a; } })
    .filter((a) => !a.startsWith('-') && EXTS.includes(path.extname(a).slice(1).toLowerCase()) && fs.existsSync(a))
    .map((a) => path.resolve(a));
}

function createWindow(openPaths = []) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 640, minHeight: 480,
    title: '알오피스',
    icon: path.join(__dirname, 'res', 'app.png'),
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.__dirty = false;
  win.__queue = [...openPaths];
  win.__ready = false;
  wins.add(win);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => wins.delete(win));
  // 바깥 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  // 닫기 전 저장 확인
  win.on('close', async (e) => {
    if (!win.__dirty || win.__closing) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['저장', '저장 안 함', '취소'], defaultId: 0, cancelId: 2, noLink: true,
      title: '알오피스', message: '바뀐 내용을 저장할까요?', detail: '저장하지 않으면 바뀐 내용이 사라집니다.',
    });
    if (response === 2) return;
    if (response === 0) {
      const ok = await win.webContents.executeJavaScript('window.__saveBeforeClose()').catch(() => false);
      if (!ok) return;
    }
    win.__closing = true;
    win.close();
  });
  win.loadURL(`${ORIGIN}/myoffice/`);
  return win;
}
async function openInWindow(paths) {
  if (!paths.length) return;
  // 문서가 열려 있지 않은 창이 있으면 거기서, 아니면 새 창
  const win = BrowserWindow.getFocusedWindow() || [...wins][0];
  const first = paths[0];
  const rest = paths.slice(1);
  if (!win) { createWindow(paths); return; }
  const busy = await win.webContents.executeJavaScript('!!window.__app?.cur').catch(() => true);
  if (busy) createWindow([first]); else deliver(win, first);
  for (const p of rest) createWindow([p]);
  if (win.isMinimized()) win.restore();
  win.focus();
}
async function deliver(win, p) {
  if (!win.__ready) { win.__queue.push(p); return; }
  try { win.webContents.send('open-request', await readDoc(p)); } catch (e) { dialog.showErrorBox('알오피스', `열 수 없습니다: ${p}\n${e.message}`); }
}

// ---------------------------------------------------------------- IPC (preload.js 와 짝)
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle('pickOpen', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), { defaultPath: lastDir, properties: ['openFile'], filters: FILTERS });
  if (r.canceled || !r.filePaths[0]) return null;
  lastDir = path.dirname(r.filePaths[0]);
  return readDoc(r.filePaths[0]);
});
ipcMain.handle('read', (_e, p) => readDoc(p));
ipcMain.handle('write', (_e, p, bytes) => writeAtomic(p, bytes));
ipcMain.handle('pickSave', async (e, name, bytes) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  const r = await dialog.showSaveDialog(winOf(e), {
    defaultPath: path.join(lastDir, name),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: '모든 파일', extensions: ['*'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (r.canceled || !r.filePath) return null;
  let p = r.filePath;
  if (!path.extname(p)) p += `.${ext}`;
  await writeAtomic(p, bytes);
  lastDir = path.dirname(p);
  return { handle: p, name: path.basename(p) };
});
ipcMain.on('setDirty', (e, d) => { const w = winOf(e); if (w) { w.__dirty = d; w.setDocumentEdited?.(d); } });
ipcMain.on('setTitle', (e, t) => winOf(e)?.setTitle(t));
ipcMain.on('showInFolder', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('ready', async (e) => {
  const w = winOf(e);
  if (!w) return;
  w.__ready = true;
  const q = w.__queue.splice(0);
  for (const p of q) await deliver(w, p);
});

// ---------------------------------------------------------------- 시작
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openInWindow(docArgs(argv)));
  app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openInWindow([p]); else pendingOpen.push(p); });
  app.whenReady().then(() => {
    protocol.handle('https', serve);
    Menu.setApplicationMenu(null);
    const first = [...docArgs(process.argv), ...pendingOpen];
    createWindow(first.slice(0, 1));
    for (const p of first.slice(1)) createWindow([p]);
  });
  app.on('window-all-closed', () => app.quit());
}
