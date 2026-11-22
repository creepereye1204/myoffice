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

// ---------------------------------------------------------------- ONLYOFFICE (실시간 공동 편집은 ONLYOFFICE 자체 WebSocket)
async function openOnlyOffice() {
  const mobile = matchMedia('(max-width: 700px)').matches;
  const q = new URLSearchParams({ mobile, uid: me.uid, name: me.name });
  const { config, apiUrl } = await api(`/api/files/${id}/onlyoffice?${q}`);
  setLoading('문서를 여는 중…');
  await loadScript(apiUrl);
  config.events = {
    // 편집기 자체 진행률(%)이 튀는 대신, 문서가 실제로 준비될 때까지 우리 로딩 화면 유지
    onDocumentReady: doneLoading,
    onAppReady: () => {
      // 편집기 안에서 누른 Ctrl+S 도 같은 저장으로 (브라우저 저장 창 X, 보기 전용이면 안내)
      try { document.querySelector('iframe[name="frameEditor"]').contentWindow.addEventListener('keydown', onSaveKey, true); } catch {}
    },
    onDocumentStateChange: (e) => { if (config.editorConfig.mode === 'edit') setStatus(e.data ? '수정 중…' : '자동 저장됨', e.data ? '' : 'ok'); },
    onError: (e) => { doneLoading(); toast(`편집기 오류: ${e.data?.errorDescription || e.data?.errorCode}`, 'err'); },
  };
  setTimeout(doneLoading, 60000);
  // eslint-disable-next-line no-undef
  new DocsAPI.DocEditor('oo', config);
  if (!file.editable) setStatus('보기 전용 — docx/xlsx/pptx로 변환하면 편집할 수 있습니다');
  else if (file.role === 'view') setStatus('보기 전용 공유');
}

// ---------------------------------------------------------------- Ctrl+S
// 어디에 초점이 있든(제목칸, 로딩 중, 편집기 안) 브라우저의 '페이지를 HTML로 저장'이 뜨지 않게 하고 서버에 저장.
// 한글 입력 상태에서는 e.key 가 'ㄴ' 이라 e.code 로도 확인.
const isSaveKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's');
let ooSaving = false;
async function saveNow() {
  if (!file) return;
  if (file.role === 'view' || (file.type !== 'hwp' && !file.editable)) return toast('보기 전용 문서입니다');
  if (file.type === 'hwp') {
    if (!editor) return toast('문서를 여는 중입니다');
    return canWrite ? saveHwp(true) : nudge();
  }
  if (ooSaving) return;
  ooSaving = true; setStatus('저장 중…');
  try {
    await api(`/api/files/${id}/save`, { method: 'POST', timeout: 20000 });
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

  // 실시간 방 (접속자, HWP 잠금, 저장 알림)
  room = connectRoom(id, async (m) => {
    if (m.type === 'presence') {
      const before = presence.users.length;
      presence = m; renderPeople();
      if (before && m.users.length > before) toast(`${m.users[m.users.length - 1].name}님이 들어왔습니다`);
      if (file.type === 'hwp' && m.lock === me.uid && m.requests?.length) {
        const who = m.users.find((u) => u.uid === m.requests[0]);
        banner(`${who?.name || '다른 사람'}님이 편집을 요청했습니다.`, '저장하고 넘기기', async () => {
          if (dirty) await saveHwp(); room.send({ type: 'release' });
        });
      }
      if (file.type === 'hwp' && !(m.lock === me.uid && m.requests?.length)) applyLock();
    } else if (m.type === 'saved' && file.type === 'hwp' && editor && !canWrite) {
      reloadHwp(m.by).catch(() => {});
    } else if (m.type === 'renamed') {
      file.name = m.name; if (document.activeElement !== t) t.value = base(); document.title = `${file.name} — 알오피스`;
    }
  }, (on) => {
    clearTimeout(connTimer);
    if (on) connected = true; else connTimer = setTimeout(() => { connected = false; applyLock(); }, 8000);
    $('#conn').classList.toggle('on', on); $('#conn').title = on ? '실시간 연결됨' : '연결 끊김 — 다시 연결 중'; });

  try {
    if (file.type === 'hwp') await openHwp();
    else await openOnlyOffice();
  } catch (e) { fail(e.message || '편집기를 불러오지 못했습니다'); }
}

main();
