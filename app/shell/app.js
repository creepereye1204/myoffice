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
};
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
  { ext: 'hwp', label: '한글 문서' },
  { ext: 'hwpx', label: '한글 (HWPX)' },
  { ext: 'docx', label: '워드 문서' },
  { ext: 'xlsx', label: '엑셀 통합 문서' },
  { ext: 'pptx', label: '파워포인트' },
];
export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const kindOf = (name) => EXT_KIND[extOf(name)];
const baseOf = (name) => name.replace(/\.[^.]+$/, '');
const icon = (name, sm) => {
  const k = KIND[kindOf(name)] || KIND.word;
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
function addRecent(handle, name) {
  if (!platform.canRecent || !handle) return;
  saveRecent([{ handle, name, time: Date.now() }, ...recentList().filter((r) => r.handle !== handle)]);
}
function dropRecent(handle) { saveRecent(recentList().filter((r) => r.handle !== handle)); }
function where(handle) {
  if (handle.startsWith('content://')) return decodeURIComponent(handle.split('/').pop()).replace(/^[^:]*:/, '');
  return handle.replace(/[\\/][^\\/]*$/, '');
}
function renderRecent() {
  const list = recentList();
  $('#recent').innerHTML = list.length ? list.map((r, i) => `
    <li data-i="${i}" tabindex="0">${icon(r.name)}
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
    await openDoc({ handle: r.handle, name: f.name || r.name, bytes: f.bytes });
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
    $('#doc-icon').innerHTML = icon(cur.name, true);
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
async function openDoc({ handle, name, bytes }) {
  const kind = kindOf(name);
  if (!kind) { toast(`지원하지 않는 형식입니다: ${name}`, 'err'); return; }
  if (cur && !(await confirmDiscard())) return;
  const engine = kind === 'hwp' ? 'hwp' : 'office';
  cur = { handle, name, kind, engine };
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
    addRecent(handle, name);
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
async function newDoc(ext) {
  if (cur && !(await confirmDiscard())) return;
  dirty = false;
  const r = await fetch(`templates/blank.${ext}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  await openDoc({ handle: null, name: `새 ${KIND[EXT_KIND[ext]].label} 문서.${ext}`, bytes });
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
async function save({ as = false } = {}) {
  if (!cur || busy) return;
  if (opening) { toast('문서를 여는 중입니다. 잠시 후 다시 저장해 주세요'); return; }
  const ext = extOf(cur.name);
  const target = WRITABLE.has(ext) ? ext : SAVE_AS[cur.kind];
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
    addRecent(cur.handle, cur.name);
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

// ---------------------------------------------------------------- 단축키 (편집기 iframe 안에서 눌러도 브라우저/편집기 자체 저장 대신 여기서 저장)
const isSaveKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyS' || e.key?.toLowerCase() === 's');
const isOpenKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyO' || e.key?.toLowerCase() === 'o');
function onKey(e) {
  if (isSaveKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); save({ as: e.shiftKey }); }
  else if (isOpenKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); openPicked(); }
}
const hooked = new WeakSet();
function hookKeys(win) {
  try {
    if (!win || hooked.has(win)) return;
    hooked.add(win);
    win.addEventListener('keydown', onKey, true);
  } catch { /* 다른 출처 */ }
}
// ONLYOFFICE 는 iframe 안에 또 iframe 을 만든다 → 주기적으로 같은 출처 frame 을 모두 찾아 단축키를 건다
function hookAll(win = window) {
  try {
    hookKeys(win);
    for (let i = 0; i < win.frames.length; i++) hookAll(win.frames[i]);
  } catch { /* 다른 출처 */ }
}
setInterval(() => { if (cur) hookAll(); }, 1500);

// ---------------------------------------------------------------- 화면 연결
$('#new-list').innerHTML = NEW_DOCS.map((d) => `<button type="button" class="tile" data-new="${d.ext}">${icon(`a.${d.ext}`)}<span>${d.label}</span><small>.${d.ext}</small></button>`).join('');
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
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const path = window.nativeBridge?.pathForFile?.(f) || null;
  await openDoc({ handle: path, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
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
