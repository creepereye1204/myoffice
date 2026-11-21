import { api, download, fileIcon, toast, kindOf } from './common.js';

const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
let file;

function setStatus(text, kind = '') { const s = $('#status'); s.textContent = text; s.className = `status ${kind}`; }
function fail(msg) { $('#loading-msg').textContent = msg; $('.spinner')?.remove(); }

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('편집기 서버에 연결할 수 없습니다'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- ONLYOFFICE
async function openOnlyOffice() {
  const mobile = matchMedia('(max-width: 700px)').matches;
  const { config, apiUrl } = await api(`/api/files/${id}/onlyoffice?mobile=${mobile}`);
  await loadScript(apiUrl);
  config.events = {
    onAppReady: () => $('#loading').remove(),
    onDocumentStateChange: (e) => setStatus(e.data ? '변경 내용 저장 중…' : '모든 변경 내용 저장됨', e.data ? '' : 'ok'),
    onError: (e) => toast(`편집기 오류: ${e.data?.errorDescription || e.data?.errorCode}`, 'err'),
  };
  // eslint-disable-next-line no-undef
  new DocsAPI.DocEditor('oo', config);
  if (!file.editable) setStatus('보기 전용 — 메뉴에서 docx/xlsx/pptx로 변환하면 편집할 수 있습니다');
}

// ---------------------------------------------------------------- rhwp (HWP/HWPX)
let editor, dirty = false, saving = false;

async function saveHwp(manual = false) {
  if (!editor || saving) return;
  saving = true;
  setStatus('저장 중…');
  try {
    const bytes = file.ext === 'hwpx' ? await editor.exportHwpx() : await editor.exportHwp();
    file = await api(`/api/files/${id}/content`, {
      method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' },
    });
    try { await editor.notifySaved(file.name); } catch {}
    dirty = false;
    setStatus(`저장됨 · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
    if (manual) toast('저장했습니다', 'ok');
  } catch (e) {
    setStatus('저장 실패', 'err');
    toast(e.message, 'err');
  } finally { saving = false; }
}

async function openHwp() {
  $('#hwp-tools').hidden = false;
  const { createEditor } = await import('/vendor/rhwp-editor/index.js');
  const [mod, res] = await Promise.all([
    createEditor('#hwp', { studioUrl: '/rhwp/', requestTimeoutMs: 120000 }),
    api(`/api/files/${id}/content`),
  ]);
  editor = mod;
  const buf = await res.arrayBuffer();
  await editor.loadFile(buf, file.name);
  $('#loading').remove();
  setStatus('');

  // 변경 감지 (지원하는 Studio에서만)
  setInterval(async () => {
    try {
      const st = await editor.getDocumentState();
      if (st.dirty !== dirty) { dirty = st.dirty; if (dirty) setStatus('저장되지 않은 변경 있음'); }
    } catch {}
  }, 2500);
  // 자동 저장 (1분마다, 변경 있을 때만)
  setInterval(() => { if (dirty) saveHwp(); }, 60000);

  $('#save').addEventListener('click', () => saveHwp(true));
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveHwp(true); }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------------------------------------------------------------- 공통
async function main() {
  if (!id) { location.href = '/'; return; }
  try { file = await api(`/api/files/${id}`); } catch (e) { fail(`파일을 열 수 없습니다: ${e.message}`); return; }
  document.title = `${file.name} — 알오피스`;
  $('#ficon').innerHTML = fileIcon(kindOf(file), file.ext);
  const base = file.name.replace(/\.[^.]+$/, '');
  const t = $('#title');
  t.value = base;
  const commit = async () => {
    const v = t.value.trim();
    if (!v || v === file.name.replace(/\.[^.]+$/, '')) { t.value = file.name.replace(/\.[^.]+$/, ''); return; }
    try { file = await api(`/api/files/${id}`, { method: 'PATCH', body: { name: v } }); document.title = `${file.name} — 알오피스`; toast('이름을 바꿨습니다', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  t.addEventListener('change', commit);
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter') t.blur(); });

  $('#dl').addEventListener('click', async () => {
    if (file.type === 'hwp' && dirty) await saveHwp();
    download(id).catch((e) => toast(e.message, 'err'));
  });

  try {
    if (file.type === 'hwp') await openHwp();
    else await openOnlyOffice();
  } catch (e) { fail(e.message || '편집기를 불러오지 못했습니다'); }
}

main();
