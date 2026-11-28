import { api, download, exportAs, fileIcon, toast, kindOf, esc, setShare, getUser, setUserName, connectRoom, requireLogin, getToken } from './common.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let id = params.get('id');
let file;
let room;
let me = getUser();

function setStatus(text, kind = '') { const s = $('#status'); s.textContent = text; s.className = `status ${kind}`; }
function setLoading(msg) { const m = $('#loading-msg'); if (m) m.textContent = msg; }
function doneLoading() { $('#loading')?.remove(); }
function fail(msg) { setLoading(msg); $('.loading .bar')?.remove(); }
function banner(msg, btn, onClick) {
  $('#banner').hidden = !msg;
  $('#banner-msg').textContent = msg || '';
  const b = $('#banner-btn');
  b.hidden = !btn; b.textContent = btn || ''; b.onclick = onClick || null;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('편집기 서버에 연결할 수 없습니다'));
    document.head.appendChild(s);
  });
}

async function askName(force = false) {
  if (me.account) { if (force) toast('이름은 홈 화면 계정 메뉴에서 바꿀 수 있습니다'); return; }
  if (me.name && !force) return;
  const d = $('#name-dialog');
  $('#name-input').value = me.name || '';
  d.showModal();
  await new Promise((r) => d.addEventListener('close', r, { once: true }));
  const v = $('#name-input').value.trim();
  if (v) { setUserName(v); me.name = v; room?.send({ type: 'name', name: v }); }
  else if (!me.name) { setUserName(`손님${Math.floor(Math.random() * 900 + 100)}`); me.name = getUser().name; }
}

// ---------------------------------------------------------------- 접속자 표시
let presence = { users: [], lock: null };
function renderPeople() {
  const initials = (n) => [...(n || '?')].slice(0, n && /^[가-힣]/.test(n) ? 2 : 1).join('').toUpperCase();
  $('#people').innerHTML = presence.users.map((u) => `
    <span class="avatar ${u.uid === presence.lock && file.type === 'hwp' ? 'lock' : ''} ${u.uid === me.uid ? 'me' : ''}"
      style="--c:${u.color}" data-uid="${esc(u.uid)}"
      title="${esc(u.name)}${u.uid === me.uid ? ' (나 — 눌러서 이름 바꾸기)' : ''}${u.uid === presence.lock && file.type === 'hwp' ? ' · 편집 중' : ''}">${esc(initials(u.name))}</span>`).join('');
}
$('#people').addEventListener('click', (e) => { if (e.target.closest('.avatar.me')) askName(true); });

// ---------------------------------------------------------------- 마우스 포인터
const remoteCursors = new Map();
let cursorFrame = 0, cursorTimer = 0, cursorOnline = false;
let pendingCursor, lastCursor, lastCursorTime = -Infinity;

function flushCursor() {
  cursorTimer = 0;
  if (!cursorOnline || !pendingCursor || (document.hidden && pendingCursor.x !== null)) return;
  const pos = pendingCursor;
  pendingCursor = undefined;
  const key = JSON.stringify(pos);
  if (key === lastCursor) return;
  room.send({ type: 'cursor', ...pos });
  lastCursor = pos.x === null ? undefined : key;
  lastCursorTime = performance.now();
}

function queueCursor(pos) {
  if (!cursorOnline || (pos.x === null && !lastCursor && !pendingCursor)) return;
  pendingCursor = pos;
  if (cursorTimer) return;
  const delay = 50 - (performance.now() - lastCursorTime);
  if (delay <= 0) flushCursor();
  else cursorTimer = setTimeout(flushCursor, Math.ceil(delay));
}

function hideCursor() {
  if (lastCursor) queueCursor({ x: null });
  else pendingCursor = undefined;
}

// 중첩 iframe 좌표도 바깥 창 기준으로 맞춘다.
function cursorOrigin(win) {
  let x = 0, y = 0;
  while (win !== window) {
    const frame = win.frameElement;
    const rect = frame.getBoundingClientRect();
    x += rect.left + frame.clientLeft;
    y += rect.top + frame.clientTop;
    win = win.parent;
  }
  return { x, y };
}

function cursorEditorSurface(win) {
  const doc = win.document;
  const scroll = doc.querySelector('#scroll-container');
  if (file.type === 'hwp' && scroll && win.frameElement?.matches('#hwp iframe')) return scroll;
  if (win.frameElement?.name === 'frameEditor') return doc.querySelector('#editor_sdk');
  return null;
}

function hwpCursorLayout(scroll) {
  const rect = scroll.getBoundingClientRect();
  const pages = [...scroll.querySelectorAll('canvas.document-page-canvas')].map((canvas) => {
    // 렌더 캐시 키의 페이지 번호·원본 폭으로 자동 배치와 맞춤 배율에서도 같은 종이 위치를 찾는다.
    const match = canvas.dataset.rhwpSurfaceCacheLookupKey?.match(/\|page:(\d+)\|geometry:([\d.]+)x/);
    const box = canvas.getBoundingClientRect();
    return { page: match ? Number(match[1]) : null, box, zoom: match ? box.width / Number(match[2]) : 0 };
  });
  const zoom = pages.find((p) => p.zoom > 0)?.zoom ||
    parseFloat(scroll.ownerDocument.querySelector('#sb-zoom-val')?.textContent) / 100;
  const left = pages.find((p) => p.box.bottom > rect.top && p.box.top < rect.bottom)?.box.left ?? rect.left;
  return { rect, pages, zoom, left };
}

function wordCursorDocument(win) {
  // 워드: WordControl 의 페이지 변환기가 현재 스크롤, 배율, 눈금자 위치를 반영한다.
  // 셀은 시트·틀 고정, 슬라이드는 현재 장표에 따라 기준이 달라 viewport 비율을 쓴다.
  if (file.type !== 'word') return null;
  const sdk = win.Asc?.editor || win.editor;
  const drawing = sdk?.WordControl?.m_oDrawingDocument;
  return typeof drawing?.ConvertCoordsFromCursor2 === 'function' &&
    typeof drawing.ConvertCoordsToCursor3 === 'function' ? drawing : null;
}

function cursorPosition(win, surface, x, y) {
  const rect = surface.getBoundingClientRect();
  const width = file.type === 'hwp' ? surface.clientWidth : rect.width;
  const height = file.type === 'hwp' ? surface.clientHeight : rect.height;
  if (!width || !height || x < rect.left || y < rect.top || x >= rect.left + width || y >= rect.top + height) return null;
  if (file.type === 'hwp') {
    const layout = hwpCursorLayout(surface);
    const page = layout.pages.find((p) => p.page !== null && p.zoom > 0 &&
      x >= p.box.left && x < p.box.right && y >= p.box.top && y < p.box.bottom);
    if (page) return { space: 'hwp', page: page.page, x: (x - page.box.left) / page.zoom, y: (y - page.box.top) / page.zoom };
    // 페이지 밖은 스크롤과 배율을 제거한 문서 좌표를 쓴다.
    if (!(layout.zoom > 0)) return null;
    return { space: 'hwp', x: (x - layout.left) / layout.zoom, y: (y - rect.top + surface.scrollTop) / layout.zoom };
  }
  const vx = (x - rect.left) / width, vy = (y - rect.top) / height;
  try {
    const point = wordCursorDocument(win)?.ConvertCoordsFromCursor2(x, y);
    if (Number.isInteger(point?.DrawPage) && point.DrawPage >= 0 && Number.isFinite(point.X) && Number.isFinite(point.Y)) {
      return { space: 'word', page: point.DrawPage, x: point.X, y: point.Y, vx, vy };
    }
  } catch { /* SDK 가 문서 화면을 아직 준비하는 중일 수 있다 */ }
  // 워드도 SDK 변환을 사용할 수 없는 화면에서는 흐리게 표시한다.
  return { space: 'viewport', x: vx, y: vy };
}

let cursorSurface;
const cursorDocs = new WeakSet();
function hookCursorWin(win) {
  const doc = win.document;
  const surface = cursorEditorSurface(win);
  if (surface) cursorSurface = { win, surface };
  if (cursorDocs.has(doc)) return;
  cursorDocs.add(doc);
  win.addEventListener('pointermove', (e) => {
    if (document.hidden || !e.isPrimary || !cursorSurface?.surface.isConnected) return;
    const { win: target, surface } = cursorSurface;
    const from = cursorOrigin(win), to = cursorOrigin(target);
    const pos = cursorPosition(target, surface, e.clientX + from.x - to.x, e.clientY + from.y - to.y);
    if (pos) queueCursor(pos); else hideCursor();
  }, true);
  doc.addEventListener('pointerout', (e) => { if (!e.relatedTarget) hideCursor(); }, true);
  win.addEventListener('blur', hideCursor);
  win.addEventListener('pagehide', hideCursor);
}

function startCursors() {
  const scan = () => {
    // 편집기 아래의 같은 출처 프레임만 훑는다. 문서가 바뀌거나 늦게 만들어진 프레임도 다시 연결한다.
    for (const frame of document.querySelectorAll('#hwp iframe, #oo-holder iframe')) hookFrames(frame.contentWindow, hookCursorWin);
  };
  scan();
  setInterval(scan, 500);
  $('#stage').addEventListener('pointerleave', hideCursor);
  $('#stage').addEventListener('pointermove', hideCursor);
  window.addEventListener('blur', hideCursor);
  window.addEventListener('pagehide', hideCursor);
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideCursor(); });
}

function removeRemoteCursor(uid) {
  remoteCursors.get(uid)?.el.remove();
  remoteCursors.delete(uid);
}

function receiveCursor(msg) {
  if (msg.uid === me.uid) return;
  const user = presence.users.find((u) => u.uid === msg.uid);
  if (msg.x === null || !user) return removeRemoteCursor(msg.uid);
  let entry = remoteCursors.get(msg.uid);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.dataset.uid = msg.uid;
    el.hidden = true;
    el.innerHTML = '<svg viewBox="0 0 16 19"><path d="M2 1l12 11-6 1-3 5z" fill="currentColor" stroke="white" stroke-linejoin="round"/></svg><span></span>';
    $('#remote-cursors').appendChild(el);
    entry = { el, label: el.querySelector('span') };
    remoteCursors.set(msg.uid, entry);
  }
  entry.msg = msg;
  entry.expires = performance.now() + 10000;
  if (!cursorFrame) drawCursors(performance.now());
}

function drawCursors(now) {
  cursorFrame = 0;
  for (const [uid, entry] of remoteCursors) {
    const user = presence.users.find((u) => u.uid === uid);
    if (!user || now >= entry.expires) removeRemoteCursor(uid);
  }
  if (!remoteCursors.size) return;
  // 스크롤·확대 중에는 새 패킷이 없어도 현재 편집기 위치로 다시 그린다.
  cursorFrame = requestAnimationFrame(drawCursors);
  if (!cursorSurface?.surface.isConnected) {
    for (const { el } of remoteCursors.values()) el.hidden = true;
    return;
  }
  try {
    const { win, surface } = cursorSurface;
    const rect = surface.getBoundingClientRect(), origin = cursorOrigin(win);
    const layer = $('#remote-cursors').getBoundingClientRect();
    const hwp = file.type === 'hwp' ? hwpCursorLayout(surface) : null;
    const word = wordCursorDocument(win);
    const width = hwp ? surface.clientWidth : rect.width;
    const height = hwp ? surface.clientHeight : rect.height;
    for (const [uid, { el, label, msg }] of remoteCursors) {
      const user = presence.users.find((u) => u.uid === uid);
      let x, y;
      const approximate = msg.space === 'viewport' || (msg.space === 'word' && !word);
      if (approximate) {
        x = (msg.vx ?? msg.x) * width;
        y = (msg.vy ?? msg.y) * height;
      } else if (hwp && msg.space === 'hwp') {
        const page = hwp.pages.find((p) => p.page === msg.page && p.zoom > 0);
        if (page) {
          x = page.box.left - rect.left + msg.x * page.zoom;
          y = page.box.top - rect.top + msg.y * page.zoom;
        } else if (msg.page !== undefined) {
          const visible = hwp.pages.filter((p) => p.page !== null && p.box.bottom > rect.top && p.box.top < rect.bottom);
          x = width / 2;
          y = visible.length && msg.page < Math.min(...visible.map((p) => p.page)) ? -1 : height + 1;
        } else {
          x = hwp.left - rect.left + msg.x * hwp.zoom;
          y = msg.y * hwp.zoom - surface.scrollTop;
        }
      } else if (word && msg.space === 'word') {
        if (msg.page < word.m_lDrawingFirst || msg.page > word.m_lDrawingEnd) {
          x = width / 2;
          y = msg.page < word.m_lDrawingFirst ? -1 : height + 1;
        } else {
          const point = word.ConvertCoordsToCursor3(msg.x, msg.y, msg.page, true);
          if (point && !point.Error) { x = point.X - rect.left; y = point.Y - rect.top; }
        }
      }
      el.hidden = !width || !height || !Number.isFinite(x) || !Number.isFinite(y);
      if (el.hidden) continue;
      const side = hwp && (x < 0 || x >= width);
      const top = y < 0 || (side && y < height / 2);
      const bottom = y >= height || (side && y >= height / 2);
      el.classList.toggle('approx', approximate);
      el.classList.toggle('edge-top', top);
      el.classList.toggle('edge-bottom', bottom);
      x = Math.max(0, Math.min(width - (top || bottom ? 17 : 1), x)) + origin.x + rect.left - layer.left;
      y = (top ? 0 : bottom ? Math.max(0, height - 19) : y) + origin.y + rect.top - layer.top;
      el.classList.toggle('left-label', x > layer.width - 115);
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.setProperty('--cursor-color', user.color);
      if (label.textContent !== user.name) label.textContent = user.name;
    }
  } catch { /* 프레임 이동 중이면 다음 화면에서 다시 그린다 */ }
}

// ---------------------------------------------------------------- ONLYOFFICE (실시간 공동 편집은 ONLYOFFICE 자체 WebSocket)
async function openOnlyOffice() {
  const mobile = matchMedia('(max-width: 700px)').matches;
  const q = new URLSearchParams({ mobile, uid: me.uid, name: me.name });
  const { config, apiUrl } = await api(`/api/files/${id}/onlyoffice?${q}`);
  setLoading('문서를 여는 중…');
  await loadScript(apiUrl);
  config.events = {
    // 편집기 자체 진행률(%)이 튀는 대신, 문서가 실제로 준비될 때까지 우리 로딩 화면 유지
    onDocumentReady: () => { ooReady = true; doneLoading(); },
    onAppReady: () => {
      // 편집기 안에서 누른 Ctrl+S: 브라우저 저장 창만 막고 키는 편집기에도 전달 (엑셀은 입력 중인 셀을 먼저 확정해야 함)
      // → 잠시 뒤 서버 저장 확인. 보기 전용이면 안내만.
      try {
        document.querySelector('iframe[name="frameEditor"]').contentWindow.addEventListener('keydown', (e) => {
          if (!isSaveKey(e)) return;
          e.preventDefault();
          if (config.editorConfig.mode !== 'edit' || file.role === 'view') { e.stopImmediatePropagation(); saveNow(); }
          else saveNow(true);  // 키는 편집기에도 전달 → 엑셀은 입력 중인 셀을 확정
        }, true);
      } catch {}
    },
    onDocumentStateChange: (e) => {
      // e.data=true: 아직 서버(문서 서버)로 안 보낸 변경이 있음 → false 가 되면 다 보냄
      ooPending = !!e.data;
      if (!ooPending) ooFlushed.splice(0).forEach((r) => r());
      if (config.editorConfig.mode === 'edit' && !ooSaving) setStatus(e.data ? '수정 중…' : '자동 저장됨', e.data ? '' : 'ok');
    },
    onError: (e) => { doneLoading(); toast(`편집기 오류: ${e.data?.errorDescription || e.data?.errorCode}`, 'err'); },
  };
  setTimeout(doneLoading, 60000);
  // eslint-disable-next-line no-undef
  new DocsAPI.DocEditor('oo', config);
  if (!file.editable) setStatus('보기 전용 — docx/xlsx/pptx로 변환하면 편집할 수 있습니다');
  else if (file.role === 'view') setStatus('보기 전용 공유');
}

// ---------------------------------------------------------------- 편집기(iframe) 안의 파일 기능을 이 화면으로
// 한글 편집기 '파일' 메뉴의 새로 만들기·열기는 편집기 안에서 다른 파일을 열어, 이어지는 저장이 지금 파일을 덮어쓴다.
// → 저장은 이 화면의 저장으로, 다른 형식 저장은 내려받기로, 새로 만들기·열기는 홈 화면에서 하게 한다.
async function hwpExport(ext) {
  const bytes = ext === 'hwpx' ? await editor.exportHwpx() : await editor.exportHwp();
  const name = `${file.name.replace(/\.[^.]+$/, '')}.${ext}`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes])), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}
const goHomeMsg = () => toast('홈 화면에서 새로 만들거나 업로드해 주세요');
const HWP_FILE_CMDS = {
  'file:new-doc': goHomeMsg,
  'file:open': goHomeMsg,
  'file:save': () => saveNow(),
  'file:save-as': () => hwpExport(file.ext),
  'file:save-as-hwp': () => hwpExport('hwp'),
  'file:save-as-hwpx': () => hwpExport('hwpx'),
};
const DOC_EXT = /\.(docx?|odt|rtf|txt|xlsx?|ods|csv|pptx?|odp|hwpx?|pdf)$/i;
const hookedWins = new WeakSet();
function hookWin(win) {
  try {
    if (!win || win === window || hookedWins.has(win)) return;
    hookedWins.add(win);
    const doc = win.document;
    win.addEventListener('keydown', onSaveKey, true);
    const onCmd = (e) => {
      const run = HWP_FILE_CMDS[e.target.closest?.('[data-cmd]')?.dataset.cmd];
      if (!run) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === 'click') {
        doc.querySelectorAll('.menu-item.open, .menu-item.active').forEach((m) => m.classList.remove('open', 'active'));
        doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        Promise.resolve(run()).catch((er) => toast(er.message, 'err'));
      }
    };
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) win.addEventListener(t, onCmd, true);
    const style = doc.createElement('style');
    style.textContent = '.md-sub[data-recent],[data-cmd="file:open-recent"],[data-cmd="file:clear-recent"]{display:none!important}';
    (doc.head || doc.documentElement).appendChild(style);
    // 문서 파일을 편집기 위에 끌어다 놓으면 편집기 안에서 열리는 것을 막는다 (그림 등은 그대로)
    win.addEventListener('drop', (e) => {
      if ([...(e.dataTransfer?.files || [])].some((f) => DOC_EXT.test(f.name))) {
        e.preventDefault(); e.stopImmediatePropagation();
        toast('문서는 홈 화면에 끌어다 놓아 업로드하세요');
      }
    }, true);
  } catch { /* 다른 출처 */ }
}
// ONLYOFFICE 는 iframe 안에 또 iframe 을 만든다 → 같은 출처 frame 을 주기적으로 찾아 건다
function hookFrames(win = window, hook = hookWin) {
  try {
    hook(win);
    for (let i = 0; i < win.frames.length; i++) hookFrames(win.frames[i], hook);
  } catch { /* 다른 출처 */ }
}

// ---------------------------------------------------------------- Ctrl+S
// 어디에 초점이 있든(제목칸, 로딩 중, 편집기 안) 브라우저의 '페이지를 HTML로 저장'이 뜨지 않게 하고 서버에 저장.
// 한글 입력 상태에서는 e.key 가 'ㄴ' 이라 e.code 로도 확인.
const isSaveKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's');
let ooSaving = false, ooReady = false, ooPending = false;
const ooFlushed = [], ooSavedWaiters = [];
const waitFor = (list, ms) => Promise.race([new Promise((r) => list.push(r)), new Promise((r) => setTimeout(r, ms))]);
async function saveNow(fromEditor = false) {
  if (!file) return;
  if (file.role === 'view' || (file.type !== 'hwp' && !file.editable)) return toast('보기 전용 문서입니다');
  if (file.type === 'hwp') {
    if (!editor) return toast('문서를 여는 중입니다');
    return canWrite ? saveHwp(true) : nudge();
  }
  if (ooSaving) return;
  if (!ooReady) return toast('문서를 여는 중입니다');
  ooSaving = true; setStatus('저장 중…');
  try {
    // 편집기가 방금 입력한 내용을 문서 서버로 다 보낼 때까지 기다린 뒤 (최대 10초) 저장소에 저장
    // 편집기 안에서 누른 Ctrl+S 는 편집기가 직접 저장한다 (엑셀은 입력 중인 셀을 확정한 뒤, ~1초).
    // 저장소에 반영되면 서버가 실시간 연결로 알려 준다. 바뀐 게 없으면 알림이 없으니 잠시 뒤 직접 확인.
    let done = false;
    if (fromEditor) done = await waitFor(ooSavedWaiters, 4000) === 'saved';
    if (!done) {
      if (ooPending) await waitFor(ooFlushed, 10000);
      const r = await api(`/api/files/${id}/save`, { method: 'POST', timeout: 30000 });
      if (!r.saved) throw new Error('저장을 확인하지 못했습니다 — 잠시 뒤 다시 시도해 주세요 (자동 저장은 계속됩니다)');
    }
    setStatus(`저장됨 · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'ok');
    toast('저장했습니다', 'ok');
  } catch (e) { setStatus('저장 실패', 'err'); toast(e.message, 'err'); } finally { ooSaving = false; }
}
function onSaveKey(e) { if (!isSaveKey(e)) return; e.preventDefault(); e.stopImmediatePropagation(); saveNow(); }
window.addEventListener('keydown', onSaveKey, true);

// ---------------------------------------------------------------- rhwp (HWP/HWPX) — 한 명 편집 + 나머지 실시간 보기
let editor, dirty = false, saving = false, version = 0, canWrite = false, guardOn = false, connected = false, connTimer;

let manualPending = false;
async function saveHwp(manual = false) {
  if (!editor || !canWrite) return;
  if (saving) { if (manual) manualPending = true; return; }  // 자동 저장 중에 누른 Ctrl+S 는 끝난 뒤 이어서
  saving = true;
  setStatus('저장 중…');
  try {
    const bytes = file.ext === 'hwpx' ? await editor.exportHwpx() : await editor.exportHwp();
    file = { ...file, ...(await api(`/api/files/${id}/content`, {
      method: 'PUT', body: bytes, timeout: 30000,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Client': me.uid, 'X-Base-Version': String(version) },
    })) };
    version = file.version;
    try { await editor.notifySaved(file.name); } catch {}
    dirty = false;
    setStatus(`${manual ? '저장됨' : '자동 저장됨'} · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'ok');
    if (manual) toast('저장했습니다', 'ok');
  } catch (e) {
    setStatus('저장 실패', 'err');
    toast(e.message, 'err');
    if (e.status === 409) await reloadHwp();
  } finally {
    saving = false;
    if (manualPending) {
      manualPending = false;
      if (dirty) saveHwp(true); else if ($('#status').classList.contains('ok')) toast('저장했습니다', 'ok');
    }
  }
}

async function reloadHwp(by) {
  const res = await api(`/api/files/${id}/content`);
  version = +(res.headers.get('X-File-Version') || version);
  await editor.loadFile(await res.arrayBuffer(), file.name, { skipUnsavedGuard: true });
  dirty = false;
  if (by) setStatus(`${by}님이 저장한 최신 내용`, 'ok');
}

// 잠금이 없을 때 iframe 안 입력을 막는다 (같은 출처라 직접 접근 가능). 스크롤·복사·찾기는 허용.
function installGuard(frame) {
  const win = frame.contentWindow;
  const block = (e) => { if (!guardOn) return; e.preventDefault(); e.stopImmediatePropagation(); nudge(); };
  const allowKey = (e) => ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Escape'].includes(e.key)
    || ((e.ctrlKey || e.metaKey) && ['c', 'f', 'a'].includes(e.key.toLowerCase()));
  win.addEventListener('keydown', (e) => {
    // 문서 안에서 누른 Ctrl+S 도 편집기 자체 '파일로 저장' 대신 서버 저장으로
    if (isSaveKey(e)) return onSaveKey(e);
    if (guardOn && !allowKey(e)) block(e);
  }, true);
  for (const t of ['beforeinput', 'paste', 'cut', 'drop', 'compositionstart']) win.addEventListener(t, block, true);
  win.addEventListener('dblclick', block, true);
}
let nudged = 0;
function nudge() { if (Date.now() - nudged > 3000) { nudged = Date.now(); toast('지금은 보기 모드입니다 — 편집 요청을 눌러 주세요'); } }

async function applyLock() {
  if (file.type !== 'hwp' || !editor) return;
  const holder = presence.users.find((u) => u.uid === presence.lock);
  const was = canWrite;
  // 실시간 서버에 못 붙으면 혼자 편집하게 둔다 (저장 시 서버가 잠금을 다시 확인)
  canWrite = file.role !== 'view' && (presence.lock === me.uid || !connected);
  guardOn = !canWrite;
  $('#save').hidden = !canWrite;
  try { await editor.chrome.set({ menu: canWrite, toolbar: canWrite }); } catch {}
  if (canWrite) {
    banner(null);
    if (!was && presence.users.length > 1) { await reloadHwp(); toast('이제 편집할 수 있습니다', 'ok'); }
  } else if (file.role === 'view') {
    banner('보기 전용으로 공유된 문서입니다. 다른 사람이 저장하면 자동으로 갱신됩니다.');
  } else {
    const asked = presence.requests?.includes(me.uid);
    banner(`${holder ? holder.name : '다른 사람'}님이 편집 중입니다. 저장할 때마다 자동으로 최신 내용으로 바뀝니다.`,
      asked ? '요청함' : '편집 요청', () => { room.send({ type: 'request' }); toast('편집 요청을 보냈습니다'); });
  }
}

async function openHwp() {
  const { createEditor } = await import('/vendor/rhwp-editor/index.js');
  const [mod, res] = await Promise.all([
    createEditor('#hwp', { studioUrl: '/rhwp/', requestTimeoutMs: 120000 }),
    api(`/api/files/${id}/content`),
  ]);
  editor = mod;
  version = +(res.headers.get('X-File-Version') || file.version);
  setLoading('문서를 여는 중…');
  await editor.loadFile(await res.arrayBuffer(), file.name);
  installGuard(editor.element);
  hookFrames();
  doneLoading();
  setStatus('');
  await applyLock();

  // 자동 저장: 마지막 수정 후 5초 동안 손을 떼면 저장 (변경 감지는 문서 변경 번호로)
  let lastSeq = -1, lastChange = 0;
  setInterval(async () => {
    let st;
    try { st = await editor.getDocumentState(); } catch { return; }
    if (st.changeSeq !== lastSeq) { if (lastSeq !== -1 || st.changeSeq > 0) lastChange = Date.now(); lastSeq = st.changeSeq; }
    if (st.dirty !== dirty) { dirty = st.dirty; if (dirty && canWrite) setStatus('수정됨 — 곧 자동 저장'); }
    if (dirty && canWrite && !saving && Date.now() - lastChange >= 5000) saveHwp();
    window.__autosave = { dirty, canWrite, saving, seq: st.changeSeq, idle: Date.now() - lastChange };  // 진단용
  }, 1500);

  $('#save').addEventListener('click', () => saveHwp(true));
  window.addEventListener('beforeunload', (e) => { if (dirty && canWrite) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------------------------------------------------------------- 공유 (사용자 지정 + 링크)
const ROLE = { edit: '편집 가능', view: '보기만' };
async function openShare() {
  const d = $('#share-dialog');
  const renderGrants = (list) => {
    $('#grant-list').innerHTML = list.length ? list.map((g) => `
      <li><span class="avatar small" style="--c:var(--accent)">${esc([...g.name].slice(0, 2).join(''))}</span>
        <span class="who"><b>${esc(g.name)}</b> <small>@${esc(g.username)}</small></span>
        <select data-user="${esc(g.username)}"><option value="edit" ${g.role === 'edit' ? 'selected' : ''}>편집 가능</option><option value="view" ${g.role === 'view' ? 'selected' : ''}>보기만</option></select>
        <button type="button" class="icon-btn" data-remove="${esc(g.username)}" title="공유 해제" aria-label="공유 해제">✕</button></li>`).join('')
      : '<li class="none">아직 공유한 사람이 없습니다</li>';
  };
  const renderLink = () => {
    const mode = file.share ? file.share.mode : 'off';
    d.querySelectorAll('#link-mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#link-row').hidden = !file.share;
    $('#share-url').value = file.share ? `${location.origin}/edit?s=${file.share.token}` : '';
  };
  renderLink();
  renderGrants(await api(`/api/files/${id}/grants`));
  d.showModal();

  $('#grant-add').onclick = async () => {
    const u = $('#grant-user').value.trim().toLowerCase();
    if (!u) return;
    try { renderGrants(await api(`/api/files/${id}/grants`, { method: 'POST', body: { username: u, role: $('#grant-role').value } })); $('#grant-user').value = ''; toast(`@${u}님에게 공유했습니다`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('#grant-user').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#grant-add').click(); } };
  $('#grant-list').onchange = async (e) => {
    const sel = e.target.closest('select[data-user]');
    if (sel) renderGrants(await api(`/api/files/${id}/grants`, { method: 'POST', body: { username: sel.dataset.user, role: sel.value } }));
  };
  $('#grant-list').onclick = async (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) renderGrants(await api(`/api/files/${id}/grants/${encodeURIComponent(b.dataset.remove)}`, { method: 'DELETE' }));
  };
  d.querySelectorAll('#link-mode [data-mode]').forEach((b) => b.onclick = async () => {
    try {
      if (b.dataset.mode === 'off') {
        if (file.share && !confirm('링크 공유를 끌까요? 링크로 들어온 사람은 더 이상 열 수 없습니다.')) return;
        await api(`/api/files/${id}/share`, { method: 'DELETE' }); file.share = null;
      } else {
        file.share = await api(`/api/files/${id}/share`, { method: 'POST', body: { mode: b.dataset.mode } });
      }
      renderLink();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#share-copy').onclick = async () => { await navigator.clipboard.writeText($('#share-url').value); toast('링크를 복사했습니다', 'ok'); };
}

// ---------------------------------------------------------------- 시작
async function main() {
  const s = params.get('s');
  try {
    if (s) {
      // 링크 공유: 로그인 없이도 열림 (로그인돼 있으면 계정 이름으로 표시)
      setShare(s);
      if (getToken()) { try { await api('/api/auth/me'); } catch { /* 만료 무시 */ } }
      const info = await api(`/api/shared/${s}`);
      id = info.id;
      if (!getToken()) { $('#back').href = '/login'; $('#back').title = '로그인'; }
    } else {
      await requireLogin();
      me = getUser();
    }
    if (!id) { location.href = '/'; return; }
    file = await api(`/api/files/${id}`);
  } catch (e) { fail(`파일을 열 수 없습니다: ${e.message}`); return; }

  await askName();
  document.title = `${file.name} — 알오피스`;
  $('#ficon').innerHTML = fileIcon(kindOf(file), file.ext);
  $('#share').hidden = file.role !== 'owner';
  $('#share').addEventListener('click', () => openShare().catch((e) => toast(e.message, 'err')));

  const t = $('#title');
  const base = () => file.name.replace(/\.[^.]+$/, '');
  t.value = base();
  t.readOnly = file.role === 'view';
  t.addEventListener('change', async () => {
    const v = t.value.trim();
    if (!v || v === base()) { t.value = base(); return; }
    try { file = { ...file, ...(await api(`/api/files/${id}`, { method: 'PATCH', body: { name: v } })) }; document.title = `${file.name} — 알오피스`; toast('이름을 바꿨습니다', 'ok'); }
    catch (e) { toast(e.message, 'err'); t.value = base(); }
  });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter') t.blur(); });

  $('#pdf').hidden = file.ext === 'pdf';
  $('#pdf').addEventListener('click', async () => {
    const b = $('#pdf'); b.disabled = true;
    try {
      if (file.type === 'hwp' && dirty && canWrite) await saveHwp();
      toast('PDF 만드는 중…');
      await exportAs(id, 'pdf');
    } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; }
  });

  $('#dl').addEventListener('click', async () => {
    if (file.type === 'hwp' && dirty && canWrite) await saveHwp();
    download(id).catch((e) => toast(e.message, 'err'));
  });

  // 실시간 방 (접속자, 마우스 포인터, HWP 잠금, 저장 알림)
  room = connectRoom(id, async (m) => {
    if (m.type === 'presence') {
      const before = presence.users.length;
      presence = m; renderPeople();
      for (const uid of remoteCursors.keys()) if (!m.users.some((u) => u.uid === uid)) removeRemoteCursor(uid);
      if (before && m.users.length > before) toast(`${m.users[m.users.length - 1].name}님이 들어왔습니다`);
      if (file.type === 'hwp' && m.lock === me.uid && m.requests?.length) {
        const who = m.users.find((u) => u.uid === m.requests[0]);
        banner(`${who?.name || '다른 사람'}님이 편집을 요청했습니다.`, '저장하고 넘기기', async () => {
          if (dirty) await saveHwp(); room.send({ type: 'release' });
        });
      }
      if (file.type === 'hwp' && !(m.lock === me.uid && m.requests?.length)) applyLock();
    } else if (m.type === 'cursor') {
      receiveCursor(m);
    } else if (m.type === 'saved' && file.type === 'hwp' && editor && !canWrite) {
      reloadHwp(m.by).catch(() => {});
    } else if (m.type === 'oo-saved') {
      ooSavedWaiters.splice(0).forEach((r) => r('saved'));
    } else if (m.type === 'renamed') {
      file.name = m.name; if (document.activeElement !== t) t.value = base(); document.title = `${file.name} — 알오피스`;
    }
  }, (on) => {
    cursorOnline = on;
    if (!on) {
      clearTimeout(cursorTimer);
      cursorTimer = 0;
      pendingCursor = lastCursor = undefined;
      for (const uid of remoteCursors.keys()) removeRemoteCursor(uid);
    }
    clearTimeout(connTimer);
    if (on) connected = true; else connTimer = setTimeout(() => { connected = false; applyLock(); }, 8000);
    $('#conn').classList.toggle('on', on); $('#conn').title = on ? '실시간 연결됨' : '연결 끊김 — 다시 연결 중'; });

  startCursors();

  // 창을 닫거나 다른 페이지로 갈 때는 편집 잠금을 바로 넘긴다 (갑작스러운 끊김만 잠시 유지)
  window.addEventListener('pagehide', (e) => { if (!e.persisted) room.bye(); });

  try {
    if (file.type === 'hwp') await openHwp();
    else await openOnlyOffice();
  } catch (e) { fail(e.message || '편집기를 불러오지 못했습니다'); }
}

// 검사용 (브라우저 E2E)
window.__edit = { get file() { return file; }, get editor() { return editor; }, get dirty() { return dirty; } };

main();
