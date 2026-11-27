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
let pendingCursor, pendingRelease, lastCursor, lastCursorTime = -Infinity;
let pendingTextSelection, lastTextSelection, lastTextSelectionTime = -Infinity;

function flushCursor() {
  cursorTimer = 0;
  if (!cursorOnline) return;
  const next = pendingRelease ?? pendingCursor;
  const pos = document.hidden && next?.x !== null ? undefined : next;
  if (pendingRelease) pendingRelease = undefined;
  else pendingCursor = undefined;
  const payload = { type: 'cursor' };
  if (pos) {
    const key = JSON.stringify(pos);
    if (key !== lastCursor) Object.assign(payload, pos);
    lastCursor = pos.x === null ? undefined : key;
  }
  if (pendingTextSelection !== undefined) {
    payload.ts = pendingTextSelection;
    lastTextSelection = JSON.stringify(pendingTextSelection);
    lastTextSelectionTime = performance.now();
    pendingTextSelection = undefined;
  }
  if ('x' in payload || 'ts' in payload) {
    room.send(payload);
    lastCursorTime = performance.now();
  }
  if (pendingCursor) scheduleCursor();
}

function scheduleCursor() {
  if (cursorTimer) return;
  const delay = 50 - (performance.now() - lastCursorTime);
  if (delay <= 0) flushCursor();
  else cursorTimer = setTimeout(flushCursor, Math.ceil(delay));
}

function queueCursor(pos, release = false) {
  if (!cursorOnline || (pos.x === null && !lastCursor && !pendingCursor && !pendingRelease)) return;
  if (release) {
    pendingRelease = pos;
    pendingCursor = undefined;
  } else pendingCursor = pos;
  scheduleCursor();
}

function hideCursor() {
  if (document.hidden) pendingRelease = undefined;
  if (lastCursor || pendingRelease) queueCursor({ x: null });
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
  const drawing = officeSdk(win)?.WordControl?.m_oDrawingDocument;
  return typeof drawing?.ConvertCoordsFromCursor2 === 'function' &&
    typeof drawing.ConvertCoordsToCursor3 === 'function' ? drawing : null;
}

function officeSdk(win) {
  return win.Asc?.editor || win.editor;
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

let cursorSurface, dragStart;
const cursorDocs = new WeakSet();
const selectionSdks = new WeakSet();
const hwpSelectionCache = new WeakMap();

function eventCursorPosition(win, e) {
  if (document.hidden || !e.isPrimary || !cursorSurface?.surface.isConnected) return null;
  const { win: target, surface } = cursorSurface;
  const from = cursorOrigin(win), to = cursorOrigin(target);
  return cursorPosition(target, surface, e.clientX + from.x - to.x, e.clientY + from.y - to.y);
}

function hwpSelectionRects(surface) {
  const highlights = surface.querySelectorAll('.selection-layer > .selection-highlight:not([style*="display: none"])');
  if (!highlights.length) return [];
  const { pages } = hwpCursorLayout(surface);
  const rects = [];
  // rhwp가 그린 선택 영역을 각 페이지의 원본 좌표로 되돌린다.
  for (const el of highlights) {
    if (el.style.display === 'none') continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const page = pages.find(({ page, box: p, zoom }) => page !== null && zoom > 0 &&
      box.left >= p.left - 1 && box.right <= p.right + 1 && box.top >= p.top - 1 && box.bottom <= p.bottom + 1);
    if (page) {
      const rect = [page.page, (box.left - page.box.left) / page.zoom, (box.top - page.box.top) / page.zoom,
        box.width / page.zoom, box.height / page.zoom];
      hwpSelectionCache.set(el, { style: el.style.cssText, rect });
      rects.push(rect);
    } else {
      // 스크롤로 캔버스가 반환되어도 같은 선택의 페이지 좌표는 유지한다.
      const cached = hwpSelectionCache.get(el);
      if (cached?.style === el.style.cssText) rects.push(cached.rect);
    }
    if (rects.length === 40) break;
  }
  return rects;
}

function captureOfficeSelection(drawing, draw) {
  const rects = [];
  const { AddPageSelection, TextMatrix, IsTextSelectionOutline } = drawing;
  // SDK의 그리기 경로에서 mm 좌표만 읽고 실제 오버레이에는 그리지 않는다.
  drawing.AddPageSelection = function (page, x, y, w, h) {
    if (rects.length >= 40 || !(w > 0 && h > 0)) return;
    const matrix = this.TextMatrix;
    if (!matrix) {
      rects.push([page, x, y, w, h]);
      return;
    }
    const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
    const xs = corners.map(([cx, cy]) => matrix.TransformPointX(cx, cy));
    const ys = corners.map(([cx, cy]) => matrix.TransformPointY(cx, cy));
    const left = Math.min(...xs), top = Math.min(...ys);
    rects.push([page, left, top, Math.max(...xs) - left, Math.max(...ys) - top]);
  };
  try {
    draw(rects);
  } finally {
    Object.assign(drawing, { AddPageSelection, TextMatrix, IsTextSelectionOutline });
  }
  return rects;
}

function wordSelectionRects(control) {
  const logic = control?.m_oLogicDocument, drawing = control?.m_oDrawingDocument;
  if (!logic || !(logic.IsSelectionUse?.() ?? drawing?.m_bIsSelection) || logic.IsSelectionEmpty?.()) return [];
  const { Start: start, End: end } = logic.GetSelectionBounds?.() || {};
  const hasBounds = Number.isInteger(start?.Page) && Number.isInteger(end?.Page);
  const first = hasBounds ? start.Page : drawing?.m_lDrawingFirst;
  const last = hasBounds ? end.Page : drawing?.m_lDrawingEnd;
  if (typeof drawing?.AddPageSelection === 'function' && typeof logic.DrawSelectionOnPage === 'function') {
    const rects = captureOfficeSelection(drawing, (result) => {
      for (let page = Math.max(0, first); page <= last && page < drawing.m_lPagesCount &&
           page < first + 40 && result.length < 40; page++) {
        logic.DrawSelectionOnPage(page);
      }
    });
    if (rects.length) return rects;
  }
  if (!hasBounds || first < 0 || last < first) return [];
  if (first === last && Math.abs(start.Y - end.Y) < .01) {
    return [[first, start.X, start.Y, end.X + end.W - start.X, start.H]];
  }
  const rects = [];
  // 줄별 좌표가 없는 SDK에서는 문서 여백과 양 끝 줄의 높이로 근사한다.
  for (let page = first; page <= last && page < first + 40 && rects.length < 40; page++) {
    const fields = logic.Get_PageFields?.(page);
    if (!fields) break;
    const height = page === last ? end.H : start.H;
    const bottom = page === last ? end.Y : fields.YLimit;
    if (!(height > 0)) break;
    let y = page === first ? start.Y : fields.Y;
    for (; y < bottom - .01 && rects.length < (page === last ? 39 : 40); y += height) {
      const x = page === first && y === start.Y ? start.X : fields.X;
      rects.push([page, x, y, fields.XLimit - x, Math.min(height, bottom - y)]);
    }
    if (page === last) rects.push([page, fields.X, end.Y, end.X + end.W - fields.X, end.H]);
  }
  return rects;
}

function slideSelectionRects(control) {
  const logic = control?.m_oLogicDocument, drawing = control?.m_oDrawingDocument;
  if (!drawing?.m_bIsSelection || typeof drawing.AddPageSelection !== 'function' ||
      logic?.IsFocusOnNotes?.() || logic?.IsFocusOnOutline?.()) return [];
  const slide = logic?.GetCurrentSlide?.();
  if (typeof slide?.drawSelect !== 'function') return [];
  // 첫 번째 그리기 단계는 도형 안의 글자 선택을 그린다.
  return captureOfficeSelection(drawing, () => slide.drawSelect(1))
    .filter(([page]) => page === drawing.SlideCurrent);
}

function activeWorksheet(win) {
  const sdk = officeSdk(win), sheet = sdk?.asc_getActiveWorksheetIndex?.();
  if (!Number.isInteger(sheet) || sheet < 0) return {};
  return { sheet, worksheet: sdk.wb?.getWorksheet?.(sheet, true) };
}

function cellSelectionBoxes(win, rect, selection) {
  const { sheet, worksheet } = activeWorksheet(win);
  const canvas = win.document.querySelector('#ws-canvas');
  const visible = worksheet?.getVisibleRange?.();
  if (sheet !== selection.sheet || !canvas?.width || !canvas.height || !visible ||
      typeof worksheet.getCellMetrics !== 'function') return [];
  const box = canvas.getBoundingClientRect();
  const sx = box.width / canvas.width, sy = box.height / canvas.height;
  const frozen = worksheet.getFrozenCell?.();
  const fc = frozen?.getCol0() || 0, fr = frozen?.getRow0() || 0;
  const c0 = worksheet._getFrozenScrollCol0?.() ?? 0, r0 = worksheet._getFrozenScrollRow0?.() ?? 0;
  const cols = [[visible.c1, visible.c2]], rows = [[visible.r1, visible.r2]];
  if (fc > c0) cols.unshift([c0, fc - 1]);
  if (fr > r0) rows.unshift([r0, fr - 1]);
  const rtl = worksheet.getRightToLeft?.();
  const px = (x) => box.left - rect.left + (rtl ? canvas.width - x : x) * sx;
  const py = (y) => box.top - rect.top + y * sy;
  const result = [];
  // 틀 고정 경계를 넘는 범위는 현재 보이는 각 구역에서 따로 그린다.
  for (const [r1, c1, r2, c2] of selection.ranges) {
    for (const [left, right] of cols) {
      for (const [top, bottom] of rows) {
        const c = Math.max(left, c1), r = Math.max(top, r1);
        const endCol = Math.min(right, c2), endRow = Math.min(bottom, r2);
        if (c > endCol || r > endRow) continue;
        const a = worksheet.getCellMetrics(c, r), b = worksheet.getCellMetrics(endCol, endRow);
        if (!a || !b) continue;
        const minX = left >= fc && fc > c0 ? worksheet._getColLeft(fc) - worksheet._getColLeft(c0) + worksheet.cellsLeft : worksheet.cellsLeft;
        const minY = top >= fr && fr > r0 ? worksheet._getRowTop(fr) - worksheet._getRowTop(r0) + worksheet.cellsTop : worksheet.cellsTop;
        const x = Math.max(a.left, minX), y = Math.max(a.top, minY);
        const x2 = Math.min(canvas.width, b.left + b.width), y2 = Math.min(canvas.height, b.top + b.height);
        if (x < x2 && y < y2) result.push([[px(x), py(y)], [px(x2), py(y2)]]);
      }
    }
  }
  return result;
}

function readTextSelection(win, surface) {
  const space = file.type;
  if (space === 'cell') {
    const { sheet, worksheet } = activeWorksheet(win);
    const selected = worksheet?._getSelection?.()?.ranges;
    if (!selected?.length) return null;
    const ranges = selected.slice(0, 20).map(({ r1, c1, r2, c2 }) => [r1, c1, r2, c2]);
    return { space, sheet, ranges };
  }
  const control = space !== 'hwp' && officeSdk(win)?.WordControl;
  let selection = [];
  if (space === 'hwp') selection = hwpSelectionRects(surface);
  else if (space === 'word') selection = wordSelectionRects(control);
  else if (space === 'slide') selection = slideSelectionRects(control);
  const rects = selection
    .filter(([page, x, y, w, h]) => Number.isInteger(page) && page >= 0 &&
      [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0)
    .map((r) => r.map((v) => Math.round(v * 1000) / 1000))
    .filter(([, , , w, h]) => w > 0 && h > 0);
  return rects.length ? { space, rects } : null;
}

function updateTextSelection(force = false) {
  if (!cursorOnline) return;
  try {
    const { win, surface } = cursorSurface || {};
    const ts = surface?.isConnected ? readTextSelection(win, surface) : null;
    const key = JSON.stringify(ts);
    // 선택을 유지하는 동안 만료되기 전에 한 번 더 보낸다.
    if (key === lastTextSelection && !(ts && (force || performance.now() - lastTextSelectionTime >= 30000))) {
      pendingTextSelection = undefined;
      return;
    }
    if (!ts && lastTextSelection === undefined) {
      pendingTextSelection = undefined;
      return;
    }
    pendingTextSelection = ts;
    scheduleCursor();
  } catch { /* 문서 전환 중에는 다음 확인까지 마지막 선택을 유지한다 */ }
}

function cancelCursorDrag() {
  dragStart = undefined;
  hideCursor();
}

function hookCursorWin(win) {
  const doc = win.document;
  const surface = cursorEditorSurface(win);
  if (surface) {
    cursorSurface = { win, surface };
    const sdk = file.type !== 'hwp' && officeSdk(win);
    if (sdk?.asc_registerCallback && !selectionSdks.has(sdk)) {
      selectionSdks.add(sdk);
      const sync = () => queueMicrotask(() => {
        if (cursorSurface?.win === win && surface.isConnected) updateTextSelection();
      });
      if (file.type === 'cell') sdk.asc_registerCallback('asc_onSelectionChanged', sync);
      if (file.type === 'word') {
        sdk.asc_registerCallback('asc_onSelectionEnd', sync);
        sdk.asc_registerCallback('asc_onSelectionCancel', sync);
      }
    }
  }
  if (cursorDocs.has(doc)) return;
  cursorDocs.add(doc);
  win.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !e.isPrimary) return;
    const pos = eventCursorPosition(win, e);
    dragStart = pos ? { pos, pointerId: e.pointerId, surface: cursorSurface.surface, moved: false } : undefined;
  }, true);
  win.addEventListener('pointermove', (e) => {
    if (!e.isPrimary) return;
    const pos = eventCursorPosition(win, e);
    if (dragStart?.pointerId === e.pointerId) {
      if (!(e.buttons & 1) || dragStart.surface !== cursorSurface?.surface) dragStart = undefined;
      else if (pos && dragStart.pos.space === pos.space) {
        const start = dragStart.pos;
        dragStart.moved ||= start.x !== pos.x || start.y !== pos.y || start.page !== pos.page;
        if (dragStart.moved) {
          pos.d = [start.x, start.y];
          if (start.page !== pos.page) pos.dp = start.page ?? null;
        }
      }
    }
    if (pos) queueCursor(pos);
    else hideCursor();
  }, true);
  win.addEventListener('pointerup', (e) => {
    if (!dragStart || dragStart.pointerId !== e.pointerId || e.button !== 0) return;
    const { moved, surface } = dragStart;
    dragStart = undefined;
    if (!moved) return;
    const pos = eventCursorPosition(win, e);
    if (!pos || surface !== cursorSurface.surface) return hideCursor();
    queueCursor(pos, true);
  }, true);
  win.addEventListener('pointercancel', cancelCursorDrag, true);
  doc.addEventListener('pointerout', (e) => { if (!e.relatedTarget) hideCursor(); }, true);
  win.addEventListener('blur', cancelCursorDrag);
  win.addEventListener('pagehide', cancelCursorDrag);
}

function startCursors() {
  const scan = () => {
    // 편집기 아래의 같은 출처 프레임만 훑는다. 문서가 바뀌거나 늦게 만들어진 프레임도 다시 연결한다.
    for (const frame of document.querySelectorAll('#hwp iframe, #oo-holder iframe')) hookFrames(frame.contentWindow, hookCursorWin);
  };
  scan();
  setInterval(scan, 500);
  let focused = false;
  setInterval(() => {
    const surface = cursorSurface?.surface;
    const hasFocus = surface?.isConnected && surface.ownerDocument.hasFocus();
    if (file.type === 'hwp' || hasFocus || focused ||
        (lastTextSelection && lastTextSelection !== 'null' && performance.now() - lastTextSelectionTime >= 30000)) {
      updateTextSelection();
    }
    focused = hasFocus;
  }, 150);
  $('#stage').addEventListener('pointerleave', hideCursor);
  $('#stage').addEventListener('pointermove', hideCursor);
  window.addEventListener('pointerup', (e) => {
    if (dragStart?.pointerId === e.pointerId && e.button === 0) cancelCursorDrag();
  }, true);
  window.addEventListener('blur', () => {
    // 편집기 iframe에 초점이 들어가는 경우에는 브라우저 창에 초점이 남아 있다.
    setTimeout(() => { if (!document.hasFocus()) cancelCursorDrag(); }, 0);
  });
  window.addEventListener('pagehide', cancelCursorDrag);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelCursorDrag(); });
}

function removeRemoteCursor(uid) {
  const entry = remoteCursors.get(uid);
  entry.el.remove();
  entry.dragEl.remove();
  for (const el of entry.selectionEls) el.remove();
  for (const el of entry.textEls) el.remove();
  remoteCursors.delete(uid);
}

function cursorRect(kind, uid) {
  const el = document.createElement('div');
  el.className = kind;
  el.dataset.uid = uid;
  el.hidden = true;
  $('#remote-cursors').appendChild(el);
  return el;
}

function receiveCursor(msg) {
  if (msg.uid === me.uid) return;
  const user = presence.users.find((u) => u.uid === msg.uid);
  let entry = remoteCursors.get(msg.uid);
  if (!user || (!entry && msg.x == null && !msg.ts)) return;
  if (!entry) {
    const el = cursorRect('remote-cursor', msg.uid);
    el.innerHTML = '<svg viewBox="0 0 16 19"><path d="M2 1l12 11-6 1-3 5z" fill="currentColor" stroke="white" stroke-linejoin="round"/></svg><span></span>';
    entry = {
      el, label: el.querySelector('span'), dragEl: cursorRect('remote-drag', msg.uid),
      selectionEls: [], textEls: [], msg: { x: null }, expires: 0,
    };
    remoteCursors.set(msg.uid, entry);
  }
  const now = performance.now();
  if ('x' in msg) {
    if (msg.d) entry.drag = { msg, fade: 0 };
    else if (entry.drag && !entry.drag.fade) {
      const start = entry.drag.msg;
      if (msg.space === start.space) {
        entry.drag.msg = { ...msg, d: start.d, dp: start.dp === undefined ? start.page ?? null : start.dp };
      }
      entry.drag.fade = now + 600;
    }
    entry.msg = msg;
    entry.expires = now + 10000;
  }
  if (msg.sel?.length) {
    for (const el of entry.selectionEls) el.remove();
    entry.selectionEls = msg.sel.map(() => cursorRect('remote-selection', msg.uid));
    entry.selection = { msg, expires: now + 3000 };
  }
  if ('ts' in msg) {
    entry.text = msg.ts ? { selection: msg.ts, expires: now + 60000 } : undefined;
    if (!entry.text) clearTextRects(entry);
  }
  if (!cursorFrame) drawCursors(now);
}

function clearTextRects(entry) {
  for (const el of entry.textEls) el.remove();
  entry.textEls.length = 0;
}

function drawCursors(now) {
  cursorFrame = 0;
  for (const [uid, entry] of remoteCursors) {
    if (entry.drag && (now >= entry.expires || (entry.drag.fade && now >= entry.drag.fade))) {
      entry.drag = undefined;
      entry.dragEl.hidden = true;
    }
    if (entry.selection && now >= entry.selection.expires) {
      for (const el of entry.selectionEls) el.remove();
      entry.selectionEls = [];
      entry.selection = undefined;
    }
    if (entry.text && now >= entry.text.expires) {
      entry.text = undefined;
      clearTextRects(entry);
    }
    if (now >= entry.expires) entry.msg = { x: null };
    const user = presence.users.find((u) => u.uid === uid);
    if (!user || (entry.msg.x === null && !entry.drag && !entry.selection && !entry.text)) removeRemoteCursor(uid);
  }
  if (!remoteCursors.size) return;
  // 스크롤·확대 중에는 새 패킷이 없어도 현재 편집기 위치로 다시 그린다.
  cursorFrame = requestAnimationFrame(drawCursors);
  if (!cursorSurface?.surface.isConnected) {
    for (const { el, dragEl, selectionEls, textEls } of remoteCursors.values()) {
      el.hidden = dragEl.hidden = true;
      for (const highlight of selectionEls) highlight.hidden = true;
      for (const highlight of textEls) highlight.hidden = true;
    }
    return;
  }
  try {
    const { win, surface } = cursorSurface;
    const rect = surface.getBoundingClientRect(), origin = cursorOrigin(win);
    const layer = $('#remote-cursors').getBoundingClientRect();
    const hwp = file.type === 'hwp' ? hwpCursorLayout(surface) : null;
    const word = wordCursorDocument(win);
    const slide = file.type === 'slide' ? officeSdk(win)?.WordControl?.m_oDrawingDocument : null;
    const viewer = (word || slide) && win.document.querySelector('#id_viewer')?.getBoundingClientRect();
    const width = hwp ? surface.clientWidth : rect.width;
    const height = hwp ? surface.clientHeight : rect.height;
    const left = origin.x + rect.left - layer.left, top = origin.y + rect.top - layer.top;
    const textClip = viewer ? [viewer.left - rect.left, viewer.top - rect.top, viewer.right - rect.left, viewer.bottom - rect.top] :
      [0, 0, width, height];
    const project = (space, pageIndex, x, y) => {
      if (space === 'viewport') return [x * width, y * height];
      if (hwp && space === 'hwp') {
        if (pageIndex == null) return [hwp.left - rect.left + x * hwp.zoom, y * hwp.zoom - surface.scrollTop];
        const page = hwp.pages.find((p) => p.page === pageIndex && p.zoom > 0);
        if (page) return [page.box.left - rect.left + x * page.zoom, page.box.top - rect.top + y * page.zoom];
      }
      if (word && space === 'word') {
        const point = word.ConvertCoordsToCursor3(x, y, pageIndex, true);
        if (point && !point.Error) return [point.X - rect.left, point.Y - rect.top];
      }
      if (slide?.SlideCurrent === pageIndex && space === 'slide') {
        const point = slide.ConvertCoordsToCursor3?.(x, y, true);
        if (point && !point.Error) return [point.X - rect.left, point.Y - rect.top];
      }
      return [];
    };
    const drawRect = (el, a, b, color, opacity, minimum = 1) => {
      const [l, t, r, bot] = minimum ? [0, 0, width, height] : textClip;
      const x = Math.max(0, l, Math.min(a[0], b[0]));
      const y = Math.max(0, t, Math.min(a[1], b[1]));
      const w = Math.min(width, r, Math.max(a[0], b[0], x + minimum)) - x;
      const h = Math.min(height, bot, Math.max(a[1], b[1], y + minimum)) - y;
      el.hidden = !(w > 0 && h > 0) || Math.max(a[0], b[0]) < 0 || Math.max(a[1], b[1]) < 0;
      if (el.hidden) return;
      el.style.transform = `translate(${left + x}px, ${top + y}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.color = color;
      el.style.opacity = opacity;
    };
    for (const [uid, { el, label, msg, drag, dragEl, selection, selectionEls, text, textEls }] of remoteCursors) {
      const user = presence.users.find((u) => u.uid === uid);
      if (drag && !text) {
        const { msg: d, fade } = drag;
        const startPage = d.dp === undefined ? d.page : d.dp;
        drawRect(dragEl, project(d.space, startPage, ...d.d), project(d.space, d.page, d.x, d.y),
          user.color, (d.space === 'viewport' ? .72 : 1) * (fade ? (fade - now) / 600 : 1));
      } else dragEl.hidden = true;
      if (selection) {
        const { space, page, sel } = selection.msg;
        sel.forEach(([x, y, w, h], i) => {
          drawRect(selectionEls[i], project(space, page, x, y), project(space, page, x + w, y + h),
            user.color, space === 'viewport' ? .72 : 1);
        });
      }
      if (text) {
        const ts = text.selection;
        let boxes = [];
        if (ts.space === file.type) {
          boxes = ts.space === 'cell' ? cellSelectionBoxes(win, rect, ts) : ts.rects.map(([page, x, y, w, h]) => {
            if (word && (page < word.m_lDrawingFirst || page > word.m_lDrawingEnd)) return [[], []];
            return [project(ts.space, page, x, y), project(ts.space, page, x + w, y + h)];
          });
        }
        while (textEls.length > boxes.length) textEls.pop().remove();
        boxes.forEach(([a, b], i) => {
          textEls[i] ||= cursorRect('remote-selection', uid);
          drawRect(textEls[i], a, b, user.color, 1, 0);
        });
      }
      if (msg.x === null) {
        el.hidden = true;
        continue;
      }
      const approximate = msg.space === 'viewport' || (msg.space === 'word' && !word);
      let x, y;
      if (approximate) {
        [x, y] = project('viewport', null, msg.vx ?? msg.x, msg.vy ?? msg.y);
      } else if (word && msg.space === 'word' && (msg.page < word.m_lDrawingFirst || msg.page > word.m_lDrawingEnd)) {
        x = width / 2;
        y = msg.page < word.m_lDrawingFirst ? -1 : height + 1;
      } else {
        [x, y] = project(msg.space, msg.page, msg.x, msg.y);
        if (x === undefined && hwp && msg.space === 'hwp' && msg.page !== undefined) {
          const visible = hwp.pages.filter((p) => p.page !== null && p.box.bottom > rect.top && p.box.top < rect.bottom);
          x = width / 2;
          y = visible.length && msg.page < Math.min(...visible.map((p) => p.page)) ? -1 : height + 1;
        }
      }
      el.hidden = !width || !height || !Number.isFinite(x) || !Number.isFinite(y);
      if (el.hidden) continue;
      const side = hwp && (x < 0 || x >= width);
      const atTop = y < 0 || (side && y < height / 2);
      const atBottom = y >= height || (side && y >= height / 2);
      el.classList.toggle('approx', approximate);
      el.classList.toggle('edge-top', atTop);
      el.classList.toggle('edge-bottom', atBottom);
      x = Math.max(0, Math.min(width - (atTop || atBottom ? 17 : 1), x)) + left;
      y = (atTop ? 0 : atBottom ? Math.max(0, height - 19) : y) + top;
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
      if (before && m.users.length > before) {
        toast(`${m.users[m.users.length - 1].name}님이 들어왔습니다`);
        updateTextSelection(true);
      }
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
      pendingCursor = pendingRelease = lastCursor = dragStart = undefined;
      pendingTextSelection = lastTextSelection = undefined;
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
