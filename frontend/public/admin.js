import { api, requireLogin, toast, esc, fmtSize, fmtTime } from './common.js';

const $ = (s) => document.querySelector(s);
let me;

async function load() {
  const { users, signup } = await api('/api/admin/users');
  $('#signup').checked = signup;
  const total = users.reduce((a, u) => a + u.used, 0);
  $('#summary').textContent = `사용자 ${users.length}명 · 전체 사용량 ${fmtSize(total)}`;
  $('#users').innerHTML = users.map((u) => `
    <tr data-id="${u.id}">
      <td>@${esc(u.username)}</td>
      <td>${esc(u.name)}</td>
      <td>${u.isAdmin ? '<span class="tag admin">관리자</span> ' : ''}${u.disabled ? '<span class="tag off">중지됨</span>' : '<span class="tag">사용 중</span>'}</td>
      <td class="num">${u.files}</td>
      <td class="num">${fmtSize(u.used)}</td>
      <td>${fmtTime(u.created)}</td>
      <td>${u.lastLogin ? fmtTime(u.lastLogin) : '-'}</td>
      <td>${u.id === me.id ? '<small>나</small>' : `
        <button class="btn" data-a="${u.disabled ? 'enable' : 'disable'}">${u.disabled ? '사용 재개' : '사용 중지'}</button>
        <button class="btn" data-a="${u.isAdmin ? 'unadmin' : 'admin'}">${u.isAdmin ? '관리자 해제' : '관리자 지정'}</button>
        <button class="btn" data-a="password">비밀번호 재설정</button>
        <button class="btn" data-a="delete" style="color:var(--danger)">삭제</button>`}</td>
    </tr>`).join('');
}

$('#users').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const tr = b.closest('tr');
  const id = tr.dataset.id;
  const who = tr.children[0].textContent;
  const patch = (body) => api(`/api/admin/users/${id}`, { method: 'PATCH', body });
  try {
    switch (b.dataset.a) {
      case 'disable': await patch({ disabled: true }); break;
      case 'enable': await patch({ disabled: false }); break;
      case 'admin': if (!confirm(`${who}을(를) 관리자로 지정할까요?`)) return; await patch({ isAdmin: true }); break;
      case 'unadmin': await patch({ isAdmin: false }); break;
      case 'password': {
        const pw = prompt(`${who}의 새 비밀번호 (8자 이상)`);
        if (!pw) return;
        await patch({ password: pw }); toast('비밀번호를 바꿨습니다 (기존 로그인은 해제됨)', 'ok'); break;
      }
      case 'delete':
        if (!confirm(`${who} 계정과 모든 파일을 삭제할까요? 되돌릴 수 없습니다.`)) return;
        await api(`/api/admin/users/${id}`, { method: 'DELETE' }); toast('삭제했습니다'); break;
    }
    load();
  } catch (er) { toast(er.message, 'err'); }
});

$('#signup').addEventListener('change', async (e) => {
  try { await api('/api/admin/settings', { method: 'PUT', body: { signup: e.target.checked } }); toast(e.target.checked ? '회원가입을 엽니다' : '회원가입을 닫습니다', 'ok'); }
  catch (er) { toast(er.message, 'err'); e.target.checked = !e.target.checked; }
});

const feedbackKinds = { bug: '버그', suggestion: '제안', other: '기타' };
const feedbackStatuses = { new: '새 의견', read: '읽음', done: '처리 완료' };
const feedbackLimit = 25;
let feedbackOffset = 0;
let feedbackRequest = 0;

function feedbackRow(item) {
  const row = document.createElement('tr');
  for (const value of [
    feedbackKinds[item.kind], item.message, item.email,
    [item.page, item.file_type].filter(Boolean).join(' / '), fmtTime(item.created_at), item.session_id,
  ]) {
    row.insertCell().textContent = value || '—';
  }
  const message = row.cells[1];
  message.className = 'feedback-message';
  const errors = JSON.parse(item.errors_json);
  if (errors.length || item.ua || item.screen || item.build) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '환경 및 오류 기록';
    details.append(summary);
    for (const line of [
      item.ua && `브라우저 ${item.ua}`, item.screen && `화면 ${item.screen}`,
      item.build && `빌드 ${item.build}`, ...errors.map((error) => `[${error.kind}] ${error.message}`),
    ].filter(Boolean)) {
      const entry = document.createElement('div');
      entry.textContent = line;
      details.append(entry);
    }
    message.append(details);
  }
  const select = document.createElement('select');
  select.setAttribute('aria-label', '의견 상태');
  for (const [value, label] of Object.entries(feedbackStatuses)) select.add(new Option(label, value));
  select.value = item.status;
  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await api(`/api/admin/feedback/${item.id}`, { method: 'PATCH', body: { status: select.value } });
      item.status = select.value;
      await loadFeedback();
    } catch (e) {
      select.value = item.status;
      toast(e.message, 'err');
    } finally { select.disabled = false; }
  });
  row.insertCell().append(select);
  return row;
}

async function loadFeedback() {
  const request = ++feedbackRequest;
  const query = new URLSearchParams({ limit: feedbackLimit, offset: feedbackOffset });
  for (const key of ['status', 'kind']) {
    const value = $(`#feedback-${key}`).value;
    if (value) query.set(key, value);
  }
  const { items, total, unread } = await api(`/api/admin/feedback?${query}`);
  if (request !== feedbackRequest) return;
  if (feedbackOffset && feedbackOffset >= total) {
    feedbackOffset = Math.max(0, Math.floor((total - 1) / feedbackLimit) * feedbackLimit);
    return loadFeedback();
  }
  $('#feedback-rows').replaceChildren(...items.map(feedbackRow));
  $('#feedback-unread').textContent = `새 의견 ${unread}건`;
  $('#feedback-unread').hidden = false;
  $('#feedback-range').textContent = total ? `${feedbackOffset + 1}–${feedbackOffset + items.length} / ${total}건` : '의견이 없습니다';
  $('#feedback-prev').disabled = feedbackOffset === 0;
  $('#feedback-next').disabled = feedbackOffset + items.length >= total;
}

function showFeedback(offset) {
  feedbackOffset = offset;
  $('#feedback-prev').disabled = $('#feedback-next').disabled = true;
  loadFeedback().catch((e) => {
    $('#feedback-prev').disabled = feedbackOffset === 0;
    toast(e.message, 'err');
  });
}

(async () => {
  me = await requireLogin();
  if (!me.isAdmin) { location.replace('/'); return; }
  load().catch((er) => toast(er.message, 'err'));
  for (const key of ['status', 'kind']) {
    $(`#feedback-${key}`).addEventListener('change', () => showFeedback(0));
  }
  $('#feedback-prev').addEventListener('click', () => showFeedback(feedbackOffset - feedbackLimit));
  $('#feedback-next').addEventListener('click', () => showFeedback(feedbackOffset + feedbackLimit));
  showFeedback(0);
})();
