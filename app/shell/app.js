// 알오피스 앱 — 서버 없이 기기 안에서 한글(rhwp)·워드·엑셀·파워포인트(ONLYOFFICE + x2t WebAssembly) 편집
import { platform } from './platform.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- 형식
const KIND = {
  hwp: { short: '한', color: 'var(--hwp)', label: '한글' },
  word: { short: 'W', color: 'var(--word)', label: '워드' },
  cell: { short: 'X', color: 'var(--cell)', label: '엑셀' },
  slide: { short: 'P', color: 'var(--slide)', label: '파워포인트' },
  pdf: { short: 'PDF', color: 'var(--pdf)', label: 'PDF' },
  // 한셀·한쇼 문서는 xlsx/pptx 로 만든다 (한셀·한쇼에서 그대로 열림) — 아이콘·이름만 다르게
  hcell: { short: '셀', color: 'var(--hcell)', label: '한셀' },
  hshow: { short: '쇼', color: 'var(--hshow)', label: '한쇼' },
};
const APP_OF = { hcell: 'cell', hshow: 'slide' };   // 한셀 → 엑셀 편집기, 한쇼 → 파워포인트 편집기
const EXT_KIND = {
  hwp: 'hwp', hwpx: 'hwp',
  docx: 'word', doc: 'word', odt: 'word', rtf: 'word', txt: 'word',
  xlsx: 'cell', xls: 'cell', csv: 'cell', ods: 'cell',
  pptx: 'slide', ppt: 'slide', odp: 'slide',
  pdf: 'pdf',
};
// 원래 형식 그대로 다시 쓸 수 있는 것. 나머지는 저장할 때 OOXML 로 바꿔 새 파일로 저장.
const WRITABLE = new Set(['hwp', 'hwpx', 'docx', 'xlsx', 'pptx', 'csv']);
const SAVE_AS = { word: 'docx', cell: 'xlsx', slide: 'pptx', pdf: 'pdf' };
const NEW_DOCS = [
  { group: 'MS 오피스', items: [
    { id: 'docx', ext: 'docx', label: '워드' },
    { id: 'xlsx', ext: 'xlsx', label: '엑셀' },
    { id: 'pptx', ext: 'pptx', label: '파워포인트' },
  ] },
  { group: '한컴오피스', items: [
    { id: 'hwp', ext: 'hwp', label: '한글' },
    { id: 'hcell', ext: 'xlsx', app: 'hcell', label: '한셀', note: '한셀에서 바로 열림' },
    { id: 'hshow', ext: 'pptx', app: 'hshow', label: '한쇼', note: '한쇼에서 바로 열림' },
    { id: 'hwpx', ext: 'hwpx', label: '한글 (HWPX)' },
  ] },
];
export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const kindOf = (name) => EXT_KIND[extOf(name)];
const baseOf = (name) => name.replace(/\.[^.]+$/, '');
const icon = (name, sm, app) => {
  const k = KIND[app && APP_OF[app] === kindOf(name) ? app : kindOf(name)] || KIND.word;
  return `<span class="ficon${sm ? ' sm' : ''}" style="--c:${k.color}" aria-hidden="true"><b>${k.short}</b><i>${esc(extOf(name).toUpperCase())}</i></span>`;
};

// ---------------------------------------------------------------- 알림
function toast(msg, kind = '') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: msg });
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}
function setStatus(text, kind = '') { const s = $('#status'); s.textContent = text; s.className = kind; }
const clock = () => new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function setLoading(text) { $('#loading').hidden = !text; if (text) $('#loading p').textContent = text; }

// ---------------------------------------------------------------- 최근 문서
const RECENT_KEY = 'myoffice.recent';
function recentList() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function saveRecent(list) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 30))); } catch { /* 저장 공간 없음 */ } }
function addRecent(handle, name, app) {
  if (!platform.canRecent || !handle) return;
  saveRecent([{ handle, name, app: app || undefined, time: Date.now() }, ...recentList().filter((r) => r.handle !== handle)]);
}
function dropRecent(handle) { saveRecent(recentList().filter((r) => r.handle !== handle)); }
function where(handle) {
  if (handle.startsWith('content://')) return decodeURIComponent(handle.split('/').pop()).replace(/^[^:]*:/, '');
  return handle.replace(/[\\/][^\\/]*$/, '');
}
function renderRecent() {
  const list = recentList();
  $('#recent').innerHTML = list.length ? list.map((r, i) => `
    <li data-i="${i}" tabindex="0">${icon(r.name, false, r.app)}
      <span class="meta"><b>${esc(r.name)}</b><small>${esc(where(r.handle))} · ${new Date(r.time).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</small></span>
      <button type="button" class="x" data-drop="${i}" title="목록에서 빼기" aria-label="목록에서 빼기">✕</button></li>`).join('')
    : `<li class="none">${platform.canRecent ? '아직 연 문서가 없습니다' : '파일 열기로 문서를 여세요'}</li>`;
}
$('#recent').addEventListener('click', async (e) => {
  const list = recentList();
  const x = e.target.closest('[data-drop]');
  if (x) { dropRecent(list[+x.dataset.drop].handle); renderRecent(); return; }
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const r = list[+li.dataset.i];
  try {
    const f = await platform.read(r.handle);
    await openDoc({ handle: r.handle, name: f.name || r.name, bytes: f.bytes, app: r.app });
  } catch (err) {
    toast(`열 수 없습니다: ${err.message}`, 'err');
    dropRecent(r.handle);
    renderRecent();
  }
});
$('#recent').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('li[data-i]')?.click(); });

// ---------------------------------------------------------------- 현재 문서
let cur = null;          // { handle, name, kind, engine }
let dirty = false, busy = false, opening = false;
function setDirty(d) {
  dirty = d;
  platform.setDirty(d);
  if (d) setStatus('수정됨');
}
function showDoc() {
  const on = !!cur;
  $('#start').hidden = on;
  $('#editors').hidden = !on;
  $('#doc').hidden = !on;
  $('#doc-actions').hidden = !on;
  if (on) {
    $('#doc-icon').innerHTML = icon(cur.name, true, cur.app);
    $('#doc-name').textContent = cur.name;
    $('#doc-name').title = cur.handle || '저장 안 된 새 문서';
    $('[data-act="pdf"]').hidden = cur.engine !== 'office';
    platform.setTitle(`${cur.name} - 알오피스`);
  } else {
    platform.setTitle('알오피스');
    renderRecent();
  }
}
async function confirmDiscard() {
  return !dirty || confirm(`'${cur.name}'의 바뀐 내용을 저장하지 않았습니다. 저장하지 않고 닫을까요?`);
}

// ---------------------------------------------------------------- 한글 (rhwp)
let hwp = null, hwpSeq = -1;
async function hwpEditor() {
  if (hwp) return hwp;
  const { createEditor } = await import('/vendor/rhwp-editor/index.js');
  hwp = await createEditor('#hwp', { studioUrl: '/rhwp/', requestTimeoutMs: 120000 });
  hookKeys(hwp.element.contentWindow);
  setInterval(async () => {
    if (!cur || cur.engine !== 'hwp' || busy) return;
    try {
      const st = await hwp.getDocumentState();
      if (st.dirty !== dirty || (st.dirty && st.changeSeq !== hwpSeq)) { hwpSeq = st.changeSeq; if (st.dirty !== dirty) setDirty(st.dirty); }
    } catch { /* 편집기 준비 중 */ }
  }, 800);
  return hwp;
}

// ---------------------------------------------------------------- 워드·엑셀·피피티 (ONLYOFFICE, iframe 안에서 x2t wasm 으로 변환)
let office = null;
const pending = new Map();
let reqSeq = 0;
function officeFrame() {
  if (office) return office;
  office = new Promise((resolve, reject) => {
    const f = $('#office');
    const t = setTimeout(() => reject(new Error('편집기를 불러오지 못했습니다')), 60000);
    const onMsg = (e) => {
      if (e.source !== f.contentWindow) return;
      const { id, type, payload } = e.data || {};
      if (typeof type !== 'string' || !type.startsWith('document:')) return;
      // 'document:ready' 은 편집기 load 이벤트 시점에 따라 안 올 때가 있어서, get-state 응답으로 준비를 확인한다
      if (type === 'document:ready' || id === 'ping') { clearTimeout(t); clearInterval(ping); resolve(f.contentWindow); return; }
      if (type === 'document:dirty-changed') { if (cur?.engine === 'office') setDirty(!!payload?.dirty); return; }
      const w = pending.get(id);
      if (!w) return;
      pending.delete(id);
      if (type === 'document:error') w.reject(new Error(payload?.message || '편집기 오류')); else w.resolve(payload || {});
    };
    let ping = 0;
    window.addEventListener('message', onMsg);
    f.src = `/editor.html?embed=1&locale=ko-KR&embedOrigin=${encodeURIComponent(location.origin)}`;
    f.addEventListener('load', () => {
      hookKeys(f.contentWindow);
      ping = setInterval(() => f.contentWindow.postMessage({ id: 'ping', type: 'document:get-state', payload: {} }, location.origin), 250);
    });
  });
  office.catch(() => { office = null; });
  return office;
}
async function officeCmd(type, payload = {}, ms = 120000) {
  const win = await officeFrame();
  const id = `c${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('시간이 너무 오래 걸립니다')); }, ms);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    win.postMessage({ id, type, payload }, location.origin);
  });
}

// ---------------------------------------------------------------- 열기
async function openDoc({ handle, name, bytes, app }) {
  const kind = kindOf(name);
  if (!kind) { toast(`지원하지 않는 형식입니다: ${name}`, 'err'); return; }
  if (cur && !(await confirmDiscard())) return;
  const engine = kind === 'hwp' ? 'hwp' : 'office';
  cur = { handle, name, kind, engine, app: app && APP_OF[app] === kind ? app : undefined };
  dirty = false;
  platform.setDirty(false);
  showDoc();
  setStatus('');
  $('#hwp').hidden = engine !== 'hwp';
  $('#office').hidden = engine !== 'office';
  setLoading('문서를 여는 중…');
  opening = true;
  try {
    if (engine === 'hwp') {
      const ed = await hwpEditor();
      await ed.loadFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name, { skipUnsavedGuard: true });
      hwpSeq = -1;
    } else {
      await officeCmd('document:open-buffer', { fileName: name, buffer: bytes, readonly: false });
      hookKeys($('#office').contentWindow);
    }
    addRecent(handle, name, cur.app);
    if (handle && !WRITABLE.has(extOf(name))) setStatus(`저장하면 ${SAVE_AS[kind].toUpperCase()}로 새로 저장됩니다`);
  } catch (e) {
    console.error(e);
    toast(`문서를 열지 못했습니다: ${e.message}`, 'err');
    cur = null;
    showDoc();
  } finally {
    setLoading(null);
    opening = false;
    dirty = false;
    platform.setDirty(false);
  }
}
async function openPicked() {
  try {
    const f = await platform.pickOpen();
    if (f) await openDoc(f);
  } catch (e) { toast(e.message, 'err'); }
}
async function newDoc(id) {
  const d = NEW_DOCS.flatMap((g) => g.items).find((x) => x.id === id) || { ext: id, label: KIND[EXT_KIND[id]].label };
  if (cur && !(await confirmDiscard())) return;
  dirty = false;
  const r = await fetch(`templates/blank.${d.ext}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  await openDoc({ handle: null, name: `새 ${d.label.replace(/ \(.*\)$/, '')} 문서.${d.ext}`, bytes, app: d.app });
}

// ---------------------------------------------------------------- 저장
// 엑셀에서 셀에 입력하던 중(Enter 전)에 저장하면 그 셀도 넣는다
function commitCellEdit(win = $('#office').contentWindow) {
  let done = false;
  try {
    const api = win.Asc?.editor || win.editor;
    if (api && typeof api.asc_closeCellEditor === 'function') { api.asc_closeCellEditor(false); done = true; }
    for (let i = 0; i < win.frames.length; i++) done = commitCellEdit(win.frames[i]) || done;
  } catch { /* 다른 출처 */ }
  return done;
}
async function exportBytes(ext) {
  if (cur.engine === 'hwp') return ext === 'hwpx' ? hwp.exportHwpx() : hwp.exportHwp();
  if (cur.kind === 'cell' && commitCellEdit()) await new Promise((r) => setTimeout(r, 300));
  const r = await officeCmd('document:save', { targetExt: ext.toUpperCase() });
  return new Uint8Array(await r.file.arrayBuffer());
}
async function save({ as = false, ext: wanted } = {}) {
  if (!cur || busy) return;
  if (opening) { toast('문서를 여는 중입니다. 잠시 후 다시 저장해 주세요'); return; }
  const ext = extOf(cur.name);
  const target = wanted || (WRITABLE.has(ext) ? ext : SAVE_AS[cur.kind]);
  const needPick = as || !cur.handle || target !== ext;
  busy = true;
  setStatus('저장 중…');
  try {
    const bytes = await exportBytes(target);
    if (needPick) {
      const r = await platform.pickSave(`${baseOf(cur.name)}.${target}`, bytes);
      if (!r) { setStatus(dirty ? '수정됨' : ''); return; }
      cur.handle = r.handle;
      cur.name = r.name;
      if (kindOf(r.name) !== cur.kind) toast('확장자가 달라도 내용은 원래 형식으로 저장됩니다');
      showDoc();
    } else {
      await platform.write(cur.handle, bytes);
    }
    if (cur.engine === 'hwp') { try { await hwp.notifySaved(cur.name); } catch { /* 옛 편집기 */ } }
    setDirty(false);
    addRecent(cur.handle, cur.name, cur.app);
    setStatus(`저장됨 · ${clock()}`, 'ok');
    toast('저장했습니다', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('저장 실패', 'err');
    toast(`저장하지 못했습니다: ${e.message}`, 'err');
  } finally {
    busy = false;
  }
}
async function exportPdf() {
  if (!cur || cur.engine !== 'office' || busy) return;
  busy = true;
  setStatus('PDF 만드는 중…');
  try {
    const bytes = await exportBytes('pdf');
    const r = await platform.pickSave(`${baseOf(cur.name)}.pdf`, bytes);
    setStatus(r ? `PDF 저장됨 · ${clock()}` : (dirty ? '수정됨' : ''), r ? 'ok' : '');
    if (r) toast('PDF로 저장했습니다', 'ok');
  } catch (e) {
    setStatus('PDF 실패', 'err');
    toast(`PDF를 만들지 못했습니다: ${e.message}`, 'err');
  } finally { busy = false; }
}
async function closeDoc() {
  if (!cur || !(await confirmDiscard())) return false;
  cur = null;
  setDirty(false);
  $('#hwp').hidden = true;
  $('#office').hidden = true;
  showDoc();
  return true;
}

// ---------------------------------------------------------------- 편집기 안의 동작을 앱으로 돌리기
// 편집기(iframe)는 같은 출처라 직접 손댈 수 있다. 편집기 자체 기능 중 파일을 다루는 것은 앱의 열기/저장으로 바꾼다.
// 그대로 두면 편집기 안에서 다른 파일을 연 뒤 앱의 '저장'이 이전 파일을 덮어쓰는 사고가 난다.
const isSaveKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyS' || e.key?.toLowerCase() === 's');
const isOpenKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyO' || e.key?.toLowerCase() === 'o');
const isNewKey = (e) => e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN';   // 한글 편집기의 '새 문서'
function onKey(e) {
  if (isSaveKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); save({ as: e.shiftKey }); }
  else if (isOpenKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); openPicked(); }
  else if (isNewKey(e) && cur) { e.preventDefault(); e.stopImmediatePropagation(); closeDoc(); }
}
// 한글 편집기 '파일' 메뉴 → 앱 동작
const HWP_FILE_CMDS = {
  'file:new-doc': () => closeDoc(),
  'file:open': () => openPicked(),
  'file:save': () => save(),
  'file:save-as': () => save({ as: true }),
  'file:save-as-hwp': () => save({ as: true, ext: 'hwp' }),
  'file:save-as-hwpx': () => save({ as: true, ext: 'hwpx' }),
};
// 안드로이드 WebView 는 인쇄 창을 못 연다
if (platform.name === 'android') {
  HWP_FILE_CMDS['file:print'] = HWP_FILE_CMDS['file:print-to-pdf'] = () => toast('안드로이드 앱에서는 한글 문서 인쇄를 아직 지원하지 않습니다');
}
// 편집기가 내려받기(a[download])로 내보내는 파일 → 앱의 저장 대화상자
async function saveDownload(href, name) {
  try {
    const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
    const r = await platform.pickSave(name || 'document', bytes);
    if (r) toast(`${r.name} 로 저장했습니다`, 'ok');
  } catch (e) { toast(`저장하지 못했습니다: ${e.message}`, 'err'); }
}
const DOC_EXTS = new Set(Object.keys(EXT_KIND));
async function dropFiles(files) {
  const f = [...files].find((x) => DOC_EXTS.has(extOf(x.name)));
  if (!f) return false;
  const path = window.nativeBridge?.pathForFile?.(f) || null;
  openDoc({ handle: path, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  return true;
}
const hooked = new WeakSet();
function hookKeys(win) {
  try {
    if (!win || hooked.has(win)) return;
    hooked.add(win);
    win.addEventListener('keydown', onKey, true);
    if (win === window) return;
    const doc = win.document;
    // 파일 메뉴 항목
    const onCmd = (e) => {
      const item = e.target.closest?.('[data-cmd]');
      const run = item && HWP_FILE_CMDS[item.dataset.cmd];
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') {
        // 메뉴 닫기 (편집기는 바깥 누름/Esc 로 닫는다)
        doc.querySelectorAll('.menu-item.open, .menu-item.active').forEach((m) => m.classList.remove('open', 'active'));
        doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        run();
      }
    };
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) win.addEventListener(t, onCmd, true);
    // 편집기 안 '최근 문서'(앱이 모르는 파일 목록)는 숨김 — 앱 처음 화면의 최근 문서를 쓴다
    const style = doc.createElement('style');
    style.textContent = '.md-sub[data-recent],[data-cmd="file:open-recent"],[data-cmd="file:clear-recent"]{display:none!important}';
    (doc.head || doc.documentElement).appendChild(style);
    // 내려받기 → 앱 저장. 파일 저장 창 API 는 숨겨서 편집기가 내려받기 방식을 쓰게 한다
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
      try { Object.defineProperty(win, k, { value: undefined, configurable: true }); } catch { /* 무시 */ }
    }
    const A = win.HTMLAnchorElement.prototype, origClick = A.click;
    A.click = function () {
      if (this.hasAttribute('download') && /^(blob|data):/.test(this.href)) { saveDownload(this.href, this.getAttribute('download')); return; }
      return origClick.call(this);
    };
    win.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[download]');
      if (a && /^(blob|data):/.test(a.href)) { e.preventDefault(); e.stopImmediatePropagation(); saveDownload(a.href, a.getAttribute('download')); }
    }, true);
    // 문서 파일을 편집기 위에 끌어다 놓으면 앱에서 연다 (그림 등은 편집기에 그대로)
    win.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }, true);
    win.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files && [...files].some((x) => DOC_EXTS.has(extOf(x.name)))) { e.preventDefault(); e.stopImmediatePropagation(); dropFiles(files); }
    }, true);
  } catch { /* 다른 출처 */ }
}
// ONLYOFFICE 는 iframe 안에 또 iframe 을 만든다 → 주기적으로 같은 출처 frame 을 모두 찾아 건다
function hookAll(win = window) {
  try {
    hookKeys(win);
    for (let i = 0; i < win.frames.length; i++) hookAll(win.frames[i]);
  } catch { /* 다른 출처 */ }
}
setInterval(() => { if (cur) hookAll(); }, 1000);

// ---------------------------------------------------------------- 화면 연결
$('#new-list').innerHTML = NEW_DOCS.map((g) => `<h3>${g.group}</h3><div class="tiles">${g.items.map((d) => `
  <button type="button" class="tile" data-new="${d.id}" title="${esc(d.note || '')}">${icon(`a.${d.ext}`, false, d.app)}<span>${d.label}</span><small>.${d.ext}${d.note ? ' · ' + d.note : ''}</small></button>`).join('')}</div>`).join('');
$('#new-list').addEventListener('click', (e) => { const b = e.target.closest('[data-new]'); if (b) newDoc(b.dataset.new); });
$('#open').addEventListener('click', openPicked);
$('#save').addEventListener('click', () => save());
$('#home').addEventListener('click', closeDoc);
$('#more').addEventListener('click', (e) => { e.stopPropagation(); $('#more-menu').hidden = !$('#more-menu').hidden; });
document.addEventListener('click', () => { $('#more-menu').hidden = true; });
$('#more-menu').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  $('#more-menu').hidden = true;
  if (act === 'save-as') save({ as: true });
  if (act === 'pdf') exportPdf();
  if (act === 'close') closeDoc();
});
window.addEventListener('keydown', onKey, true);

// 끌어다 놓기 (데스크톱은 실제 경로를 받아 그 파일에 바로 저장)
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  const files = e.dataTransfer?.files;
  if (files?.length && !(await dropFiles(files))) toast('열 수 있는 문서가 아닙니다', 'err');
});

// 안드로이드 뒤로 가기: 문서를 닫고 처음 화면으로 (처음 화면이면 앱이 알아서 끝냄)
window.__onBack = () => { if (!cur) return false; closeDoc(); return true; };
// 데스크톱 창 닫기 전 확인에서 "저장"을 고르면
window.__saveBeforeClose = async () => { await save(); return !dirty; };

platform.onOpenRequest((f) => openDoc(f));
showDoc();
// 편집기를 미리 띄워 두면 첫 문서가 빨리 열린다
setTimeout(() => { officeFrame().catch(() => {}); }, 300);

// 테스트용
window.__app = { get cur() { return cur; }, get hwp() { return hwp; }, get dirty() { return dirty; }, save, openDoc, newDoc, closeDoc, officeCmd };
