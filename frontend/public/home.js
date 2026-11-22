import { api, download, exportAs, fileIcon, toast, esc, fmtSize, fmtTime, TYPE_INFO, kindOf, requireLogin, setSession, getToken, logout } from './common.js';

const $ = (s) => document.querySelector(s);
let files = [];
let filter = 'all';
let scope = 'mine';
let me;

const CONVERT = {
  word: [['pdf', 'PDF'], ['docx', 'Word (.docx)']],
  cell: [['pdf', 'PDF'], ['xlsx', 'Excel (.xlsx)']],
  slide: [['pdf', 'PDF'], ['pptx', 'PowerPoint (.pptx)']],
  hwp: [['docx', 'Word (.docx)'], ['pdf', 'PDF']],
  pdf: [['docx', 'Word (.docx)']],
};
const ROLE = { edit: '편집 가능', view: '보기만' };

function openFile(id) { location.href = `/edit?id=${id}`; }

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const shown = files.filter((f) => (filter === 'all' || kindOf(f) === filter) && (!q || f.name.toLowerCase().includes(q)));
  $('#list').innerHTML = shown.map((f) => `
    <li class="row" data-id="${f.id}">
      <button class="open" data-act="open" title="열기">
        ${fileIcon(kindOf(f), f.ext)}
        <span class="meta">
          <span class="name">${esc(f.name)}${f.shared ? ' <span class="badge">공유 중</span>' : ''}${f.role ? ` <span class="badge">${ROLE[f.role]}</span>` : ''}</span>
          <span class="sub">${f.owner ? `${esc(f.owner)} · ` : ''}${TYPE_INFO[kindOf(f)]?.label || ''} · ${fmtSize(f.size)} · ${fmtTime(f.modified)}${f.editable ? '' : ' · 보기 전용'}</span>
        </span>
      </button>
      <div class="row-actions">
        <button class="icon-btn" data-act="download" title="다운로드" aria-label="다운로드"><svg viewBox="0 0 24 24"><path d="M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V4ZM5 18h14v2H5v-2Z"/></svg></button>
        <button class="icon-btn" data-act="menu" title="더보기" aria-label="더보기"><svg viewBox="0 0 24 24"><path d="M12 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg></button>
      </div>
    </li>`).join('');
  $('#empty').hidden = shown.length > 0;
  $('#empty').textContent = files.length ? '조건에 맞는 파일이 없습니다.'
    : scope === 'shared' ? '아직 공유받은 파일이 없습니다. 다른 사람이 내 아이디로 공유하면 여기에 나타납니다.'
    : '아직 파일이 없습니다. 새로 만들거나 파일을 올려 보세요.';
}

async function load() {
  try {
    files = await api(scope === 'shared' ? '/api/shared-with-me' : '/api/files');
    render();
    if (scope === 'mine') {
      const u = await api('/api/workspaces/me');
      $('#usage').textContent = `사용량 ${fmtSize(u.used)} / ${fmtSize(u.quota)} · 파일 ${u.files}개`;
    } else $('#usage').textContent = '';
  } catch (e) { toast(e.message, 'err'); }
}

// ---- 새로 만들기
document.querySelectorAll('.new-card').forEach((b) => b.addEventListener('click', async () => {
  b.disabled = true;
  try {
    const f = await api('/api/files/new', { method: 'POST', body: { type: b.dataset.type } });
    openFile(f.id);
  } catch (e) { toast(e.message, 'err'); b.disabled = false; }
}));

// ---- 업로드
async function upload(list) {
  for (const file of list) {
    const fd = new FormData();
    fd.append('file', file);
    toast(`${file.name} 올리는 중…`);
    try { await api('/api/files/upload', { method: 'POST', body: fd }); toast(`${file.name} 업로드 완료`, 'ok'); }
    catch (e) { toast(`${file.name}: ${e.message}`, 'err'); }
  }
  if (scope !== 'mine') setScope('mine'); else load();
}
$('#file-input').addEventListener('change', (e) => { upload([...e.target.files]); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) upload([...e.dataTransfer.files]);
});

// ---- 목록 동작
function closeMenus() { document.querySelectorAll('.menu.floating').forEach((m) => m.remove()); $('#account-menu').hidden = true; }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu, [data-act="menu"], #account-btn')) closeMenus(); });

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.row').dataset.id;
  const f = files.find((x) => x.id === id);
  const act = btn.dataset.act;
  if (act === 'open') return openFile(id);
  if (act === 'download') return download(id).catch((er) => toast(er.message, 'err'));
  if (act === 'menu') {
    closeMenus();
    const owner = scope === 'mine';
    const m = document.createElement('div');
    m.className = 'menu floating';
    m.innerHTML = `
      <button data-m="open">열기</button>
      ${f.ext !== 'pdf' ? '<button data-m="pdf">PDF로 다운로드</button>' : ''}
      ${owner ? '<button data-m="rename">이름 바꾸기</button>' : ''}
      ${owner ? (CONVERT[f.type] || []).filter(([t]) => t !== f.ext).map(([t, l]) => `<button data-m="conv" data-to="${t}">${l} 사본 만들기</button>`).join('') : ''}
      ${owner ? '<hr /><button data-m="delete" class="danger">삭제</button>' : ''}`;
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect();
    m.style.top = `${r.bottom + window.scrollY + 4}px`;
    m.style.left = `${Math.max(8, r.right + window.scrollX - m.offsetWidth)}px`;
    m.addEventListener('click', async (ev) => {
      const it = ev.target.closest('[data-m]');
      if (!it) return;
      closeMenus();
      try {
        if (it.dataset.m === 'open') openFile(id);
        if (it.dataset.m === 'pdf') { toast('PDF 만드는 중…'); await exportAs(id, 'pdf'); }
        if (it.dataset.m === 'rename') {
          const base = f.name.replace(/\.[^.]+$/, '');
          const n = prompt('새 이름', base);
          if (n && n !== base) { await api(`/api/files/${id}`, { method: 'PATCH', body: { name: n } }); load(); }
        }
        if (it.dataset.m === 'conv') {
          toast('변환 중…');
          const nf = await api(`/api/files/${id}/convert`, { method: 'POST', body: { to: it.dataset.to } });
          toast(`${nf.name} 생성됨`, 'ok');
          load();
        }
        if (it.dataset.m === 'delete' && confirm(`"${f.name}"을(를) 삭제할까요? 되돌릴 수 없습니다.`)) {
          await api(`/api/files/${id}`, { method: 'DELETE' });
          toast('삭제했습니다'); load();
        }
      } catch (er) { toast(er.message, 'err'); }
    });
  }
});

// ---- 범위/필터/검색
function setScope(s) {
  scope = s;
  document.querySelectorAll('[data-scope]').forEach((x) => x.classList.toggle('on', x.dataset.scope === s));
  files = []; render(); load();
}
document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => setScope(b.dataset.scope)));
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  filter = b.dataset.f; render();
}));
$('#q').addEventListener('input', render);

// ---- 계정 메뉴
function showMe() {
  $('#me-name').textContent = me.name;
  $('#me-avatar').textContent = [...me.name].slice(0, /^[가-힣]/.test(me.name) ? 2 : 1).join('').toUpperCase();
  $('#me-id').textContent = `@${me.username}`;
  $('#admin-link').hidden = !me.isAdmin;
}
$('#account-btn').addEventListener('click', () => { const m = $('#account-menu'); m.hidden = !m.hidden; });
$('#account-menu').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (!a) return;
  $('#account-menu').hidden = true;
  if (a === 'logout') return logout();
  if (a === 'password') { $('#pw-form').reset(); $('#pw-dialog').showModal(); }
  if (a === 'name') {
    const n = prompt('새 이름 (함께 편집할 때 보입니다)', me.name);
    if (n && n.trim() && n !== me.name) {
      try { me = await api('/api/auth/me', { method: 'PATCH', body: { name: n } }); setSession(getToken(), me); showMe(); toast('이름을 바꿨습니다', 'ok'); }
      catch (er) { toast(er.message, 'err'); }
    }
  }
});
$('#pw-dialog').addEventListener('close', async () => {
  if ($('#pw-dialog').returnValue !== 'ok') return;
  try {
    const { token } = await api('/api/auth/password', { method: 'POST', body: { old: $('#pw-old').value, new: $('#pw-new').value } });
    setSession(token, me);
    toast('비밀번호를 바꿨습니다. 다른 기기는 로그아웃됩니다', 'ok');
  } catch (er) { toast(er.message, 'err'); }
});

// 편집기 파일 미리 받기 (유휴 시간에) — 처음 여는 속도 개선
const HWP_FONTS = [
  '/rhwp/ext-fonts/gh/projectnoonnu/noonfonts_2104@1.0/HANBatang.woff.ttf',
  '/rhwp/ext-fonts/gh/projectnoonnu/noonfonts_four@1.0/HCRDotum.woff.ttf',
  '/rhwp/fonts/RHWPOldHangul-Regular.woff2.ttf',
  '/rhwp/fonts/NotoSansKR-Bold.woff2.ttf', '/rhwp/fonts/NotoSerifKR-Bold.woff2.ttf',
  '/rhwp/fonts/NotoSerifKR-Regular.woff2.ttf', '/rhwp/fonts/NotoSansKR-ExtraLight.woff2.ttf',
];
function prefetch(href, as) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link'); l.rel = 'prefetch'; l.href = href; if (as) l.as = as;
  document.head.appendChild(l);
}
// 워드·엑셀·파워포인트(한셀·한쇼) 편집기 본체 — 경로에 버전이 들어 있어 api.js 에서 알아낸다
const OO_COMMON = ['sdkjs/common/AllFonts.js', 'sdkjs/common/libfont/engine/fonts.js', 'sdkjs/common/libfont/engine/fonts.wasm',
  'sdkjs/common/Charts/ChartStyles.js', 'sdkjs/common/Images/fonts_thumbnail_ea.png.bin', 'sdkjs/common/spell/spell/spell.js',
  'web-apps/apps/common/main/resources/alphabetletters/qwertyletters.json', 'plugins.json',
  'sdkjs/cell/css/main.css', 'sdkjs/slide/themes//themes.js',
  // 새 문서 기본 글꼴 (맑은 고딕 계열) + 파워포인트 기본 테마 글꼴
  ...['063', '064', '098', '096', '097', '104', '103', '004', '101', '016', '014'].map((n) => `fonts/${n}`)];
const OO_APPS = [['word', 'documenteditor'], ['cell', 'spreadsheeteditor'], ['slide', 'presentationeditor']];
async function warmOffice() {
  const js = await (await fetch('/office/web-apps/apps/api/documents/api.js')).text();
  const ver = js.match(/\d+\.\d+\.\d+-[0-9a-f]{16,}/)?.[0];
  if (!ver) return;
  const base = `/office/${ver}/`;
  for (const p of OO_COMMON) prefetch(base + p);
  for (const [sdk, app] of OO_APPS) {
    for (const p of [`sdkjs/${sdk}/sdk-all-min.js`, `sdkjs/${sdk}/sdk-all.js`, `web-apps/apps/${app}/main/app.js`,
      `web-apps/apps/${app}/main/resources/css/app.css`, `web-apps/apps/${app}/main/code.js`]) prefetch(base + p);
  }
}
async function warmEditors() {
  if (navigator.connection?.saveData) return;
  warmOffice().catch(() => {});
  try {
    const html = await (await fetch('/rhwp/index.html')).text();
    for (const m of html.matchAll(/(?:src|href)="(\/rhwp\/assets\/[^"]+)"/g)) prefetch(m[1]);
    prefetch('/rhwp/assets/rhwp_bg-CjDYAjgF.wasm');
    // 한글 문서가 거의 항상 쓰는 글꼴 (함초롬, Noto) — 한 번 받으면 1년 캐시
    for (const f of HWP_FONTS) prefetch(f);
  } catch {}
}

(async () => {
  me = await requireLogin();
  showMe();
  load();
  window.addEventListener('pageshow', (e) => { if (e.persisted) load(); });
  (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(warmEditors);
})();
