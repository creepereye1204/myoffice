import { api, download, fileIcon, toast, esc, fmtSize, fmtTime, getWorkspace, setWorkspace, TYPE_INFO, kindOf } from './common.js';

const $ = (s) => document.querySelector(s);
let files = [];
let filter = 'all';

const CONVERT = {
  word: [['pdf', 'PDF'], ['docx', 'Word (.docx)']],
  cell: [['pdf', 'PDF'], ['xlsx', 'Excel (.xlsx)']],
  slide: [['pdf', 'PDF'], ['pptx', 'PowerPoint (.pptx)']],
  hwp: [['docx', 'Word (.docx)'], ['pdf', 'PDF']],
  pdf: [['docx', 'Word (.docx)']],
};

function openFile(id) { location.href = `/edit?id=${id}`; }

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const shown = files.filter((f) => (filter === 'all' || kindOf(f) === filter) && (!q || f.name.toLowerCase().includes(q)));
  $('#list').innerHTML = shown.map((f) => `
    <li class="row" data-id="${f.id}">
      <button class="open" data-act="open" title="열기">
        ${fileIcon(kindOf(f), f.ext)}
        <span class="meta">
          <span class="name">${esc(f.name)}</span>
          <span class="sub">${TYPE_INFO[kindOf(f)]?.label || ''} · ${fmtSize(f.size)} · ${fmtTime(f.modified)}${f.editable ? '' : ' · 보기 전용'}</span>
        </span>
      </button>
      <div class="row-actions">
        <button class="icon-btn" data-act="download" title="다운로드" aria-label="다운로드"><svg viewBox="0 0 24 24"><path d="M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V4ZM5 18h14v2H5v-2Z"/></svg></button>
        <button class="icon-btn" data-act="menu" title="더보기" aria-label="더보기"><svg viewBox="0 0 24 24"><path d="M12 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/></svg></button>
      </div>
    </li>`).join('');
  $('#empty').hidden = shown.length > 0;
  $('#empty').textContent = files.length ? '조건에 맞는 파일이 없습니다.' : '아직 파일이 없습니다. 새로 만들거나 파일을 올려 보세요.';
}

async function load() {
  try {
    [files] = await Promise.all([api('/api/files')]);
    render();
    const u = await api('/api/workspaces/me');
    $('#usage').textContent = `사용량 ${fmtSize(u.used)} / ${fmtSize(u.quota)} · 파일 ${u.files}개`;
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
  load();
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
function closeMenu() { document.querySelector('.menu')?.remove(); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu, [data-act="menu"]')) closeMenu(); });

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.row').dataset.id;
  const f = files.find((x) => x.id === id);
  const act = btn.dataset.act;
  if (act === 'open') return openFile(id);
  if (act === 'download') return download(id).catch((er) => toast(er.message, 'err'));
  if (act === 'menu') {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `
      <button data-m="open">열기</button>
      <button data-m="rename">이름 바꾸기</button>
      ${(CONVERT[f.type] || []).filter(([t]) => t !== f.ext).map(([t, l]) => `<button data-m="conv" data-to="${t}">${l}로 변환</button>`).join('')}
      <hr /><button data-m="delete" class="danger">삭제</button>`;
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect();
    m.style.top = `${r.bottom + window.scrollY + 4}px`;
    m.style.left = `${Math.max(8, r.right + window.scrollX - m.offsetWidth)}px`;
    m.addEventListener('click', async (ev) => {
      const it = ev.target.closest('[data-m]');
      if (!it) return;
      closeMenu();
      try {
        if (it.dataset.m === 'open') openFile(id);
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

// ---- 필터/검색
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  filter = b.dataset.f; render();
}));
$('#q').addEventListener('input', render);

// ---- 작업공간 열쇠
$('#ws-btn').addEventListener('click', () => { $('#ws-key').value = getWorkspace() || ''; $('#ws-new').value = ''; $('#ws-dialog').showModal(); });
$('#ws-copy').addEventListener('click', async () => { await navigator.clipboard.writeText($('#ws-key').value); toast('복사했습니다', 'ok'); });
$('#ws-apply').addEventListener('click', () => {
  const v = $('#ws-new').value.trim();
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(v)) return toast('올바른 열쇠가 아닙니다', 'err');
  setWorkspace(v); $('#ws-dialog').close(); load();
});

window.addEventListener('pageshow', load);
