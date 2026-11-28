import { api, requireLogin, toast, esc, fmtSize, fmtTime } from './common.js';

const $ = (s) => document.querySelector(s);
let me;
let users = [];

async function loadUsers() {
  const { users: list, signup } = await api('/api/admin/users');
  $('#signup').checked = signup;
  users = list;
  renderUsers();
}

function renderUsers() {
  const query = $('#user-search').value.trim().toLocaleLowerCase();
  const sort = $('#user-sort').value;
  const visible = users.filter((user) =>
    [user.username, user.name].some((value) => value.toLocaleLowerCase().includes(query)));
  if (sort === 'username') visible.sort((a, b) => a.username.localeCompare(b.username));
  else if (sort !== 'default') visible.sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));
  const total = users.reduce((a, u) => a + u.used, 0);
  $('#summary').textContent = `사용자 ${users.length}명 · 검색 결과 ${visible.length}명 · 전체 사용량 ${fmtSize(total)}`;
  $('#user-rows').innerHTML = visible.map((u) => `
    <tr data-id="${esc(u.id)}">
      <td data-label="아이디">@${esc(u.username)}</td>
      <td data-label="이름">${esc(u.name)}</td>
      <td data-label="상태">${u.isAdmin ? '<span class="tag admin">관리자</span> ' : ''}${u.disabled ? '<span class="tag off">중지됨</span>' : '<span class="tag">사용 중</span>'}</td>
      <td class="num" data-label="문서 수">${esc(u.files)}</td>
      <td class="num" data-label="저장 용량">${esc(fmtSize(u.used))}</td>
      <td data-label="가입">${esc(fmtTime(u.created))}</td>
      <td data-label="최근 로그인">${u.lastLogin ? esc(fmtTime(u.lastLogin)) : '-'}</td>
      <td class="admin-actions">${u.id === me.id ? '<small>나</small>' : `
        <button class="btn" data-a="${u.disabled ? 'enable' : 'disable'}">${u.disabled ? '사용 재개' : '사용 중지'}</button>
        <button class="btn" data-a="${u.isAdmin ? 'unadmin' : 'admin'}">${u.isAdmin ? '관리자 해제' : '관리자 지정'}</button>
        <button class="btn" data-a="password">비밀번호 재설정</button>
        <button class="btn" data-a="delete" style="color:var(--danger)">삭제</button>`}</td>
    </tr>`).join('');
}

$('#user-rows').addEventListener('click', async (e) => {
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
    await loadUsers();
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

const feedbackImageUrls = new Set();
const lightbox = $('#feedback-lightbox');
const fullImage = lightbox.querySelector('img');
let feedbackImageObserver;
let feedbackImagePage;

lightbox.addEventListener('click', (event) => {
  if (event.target === lightbox || event.target === fullImage) lightbox.close();
});
lightbox.addEventListener('close', () => {
  if (!lightbox.open) fullImage.removeAttribute('src');
});

function clearFeedbackImages() {
  feedbackImageObserver?.disconnect();
  feedbackImagePage?.abort();
  if (lightbox.open) lightbox.close();
  fullImage.removeAttribute('src');
  for (const url of feedbackImageUrls) URL.revokeObjectURL(url);
  feedbackImageUrls.clear();
}

async function loadFeedbackImage(button, signal) {
  const { fid, n } = button.dataset;
  try {
    const response = await api(`/api/admin/feedback/${fid}/images/${n}`, {
      signal, includeShare: false, referrerPolicy: 'no-referrer',
    });
    const blob = await response.blob();
    if (signal.aborted) return;
    const url = URL.createObjectURL(blob);
    feedbackImageUrls.add(url);
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    button.replaceChildren(image);
    button.disabled = false;
    button.addEventListener('click', () => {
      fullImage.src = url;
      lightbox.showModal();
    });
  } catch {
    if (!signal.aborted) button.textContent = '이미지 불러오기 실패';
  }
}

function observeFeedbackImages() {
  const signal = (feedbackImagePage = new AbortController()).signal;
  feedbackImageObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      loadFeedbackImage(entry.target, signal);
    }
  });
  document.querySelectorAll('#feedback-rows .feedback-image-button').forEach((button) => {
    feedbackImageObserver.observe(button);
  });
}

function feedbackRow(item) {
  const row = document.createElement('tr');
  const values = [
    feedbackKinds[item.kind], item.message, item.email,
    [item.page, item.file_type].filter(Boolean).join(' / '), fmtTime(item.created_at), item.session_id,
  ];
  values.forEach((value, index) => {
    const cell = row.insertCell();
    cell.dataset.label = $('#feedback .admin-table').tHead.rows[0].cells[index].textContent;
    cell.textContent = value || '—';
  });
  const message = row.cells[1];
  message.className = 'feedback-message';
  if (item.image_count) {
    const count = document.createElement('div');
    count.textContent = `첨부 이미지 ${item.image_count}장`;
    message.append(count);
    const attachments = document.createElement('div');
    attachments.className = 'feedback-thumbnails';
    for (const { n } of item.images) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'feedback-image-button';
      button.dataset.fid = item.id;
      button.dataset.n = n;
      button.textContent = '불러오는 중…';
      button.setAttribute('aria-label', `첨부 이미지 ${n} 크게 보기`);
      button.disabled = true;
      attachments.append(button);
    }
    message.append(attachments);
  }
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
  const status = row.insertCell();
  status.dataset.label = '상태';
  status.append(select);
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
  clearFeedbackImages();
  $('#feedback-rows').replaceChildren(...items.map(feedbackRow));
  if (activeTab === 'feedback') observeFeedbackImages();
  updateUnread(unread);
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

function updateUnread(count) {
  const badge = $('#feedback-unread');
  badge.textContent = number(count);
  badge.setAttribute('aria-label', `안 읽은 의견 ${count}건`);
  badge.hidden = count === 0;
}

const number = (value) => value.toLocaleString('ko-KR');
const time = (value) => new Date(value).toLocaleString('ko-KR');

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function renderStats(target, entries) {
  $(target).replaceChildren(...entries.map(([label, value, detail]) => {
    const card = element('div', undefined, 'admin-card');
    card.append(element('div', label, 'admin-label'), element('strong', value));
    if (detail) card.append(element('div', detail, 'admin-label'));
    return card;
  }));
}

function typesText(types) {
  return Object.entries(types).map(([type, count]) => `${type} ${number(count)}건`).join(' · ') || '문서 없음';
}

function svgElement(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function chart(title, rows, series) {
  const figure = element('figure', undefined, 'admin-card');
  const svg = svgElement('svg', { viewBox: '0 0 360 104', 'aria-hidden': 'true' });
  const max = Math.max(1, ...rows.flatMap((row) => series.map(([key]) => row[key])));
  for (const y of [8, 50, 92]) {
    svg.append(svgElement('line', { x1: 6, x2: 354, y1: y, y2: y, stroke: 'var(--line)' }));
  }
  const legend = element('div', undefined, 'admin-legend');
  for (const [key, label, color] of series) {
    svg.append(svgElement('polyline', {
      points: rows.map((row, i) => `${6 + 348 * i / (rows.length - 1)},${92 - 84 * row[key] / max}`).join(' '),
      stroke: color, 'stroke-width': 2, fill: 'none',
    }));
    const item = element('span', label);
    item.style.borderColor = color;
    legend.append(item);
  }
  const axis = element('div', undefined, 'admin-axis');
  axis.append(element('span', rows[0].date), element('span', rows.at(-1).date));
  const details = element('details');
  details.append(element('summary', '날짜별 수치 (UTC)'));
  const values = element('ul');
  for (const row of rows) {
    values.append(element('li', `${row.date} · ${series.map(([key, label]) => `${label} ${row[key]}건`).join(' · ')}`));
  }
  details.append(values);
  figure.append(element('figcaption', title), legend, svg, axis, details);
  return figure;
}

async function loadOverview() {
  const { users, documents, storage, live, errors24h, unreadFeedback, activityDaily, errorsDaily } =
    await api('/api/admin/overview');
  updateUnread(unreadFeedback);
  renderStats('#overview-stats', [
    ['전체 사용자', `${number(users.total)}명`], ['최근 7일 가입', `${number(users.joined7d)}명`],
    ['전체 문서 수', `${number(documents.total)}건`, typesText(documents.byType)],
    ['저장 공간 사용량', fmtSize(storage.dataBytes), `문서 본문 ${fmtSize(storage.storedBytes)} 포함`],
    ['지금 접속 중', `${number(live.users)}명`, `활성 문서 방 ${number(live.rooms)}개`],
    ['최근 24시간 에러', `${number(errors24h.client + errors24h.server)}건`,
      `브라우저 ${number(errors24h.client)}건 · 서버 ${number(errors24h.server)}건`],
    ['안 읽은 의견', `${number(unreadFeedback)}건`],
  ]);
  const charts = $('#overview-charts');
  const open = [...charts.querySelectorAll('details')].map((details) => details.open);
  charts.replaceChildren(
    chart('가입·문서 생성 · 최근 30일', activityDaily, [
      ['signups', '가입', 'var(--accent)'], ['documents', '문서 생성', 'var(--cell)'],
    ]),
    chart('에러 · 최근 14일', errorsDaily, [
      ['client', '브라우저', 'var(--accent)'], ['server', '서버', 'var(--danger)'],
    ]),
  );
  charts.querySelectorAll('details').forEach((details, i) => { details.open = Boolean(open[i]); });
}

async function loadDocuments() {
  const docs = await api('/api/admin/documents');
  renderStats('#document-stats', [
    ['전체 문서 수', `${number(docs.total)}건`, typesText(docs.byType)],
    ['최근 7일 생성', `${number(docs.created7d)}건`], ['최근 7일 수정', `${number(docs.modified7d)}건`],
    ['공유 링크', `보기 ${number(docs.shareLinks.view)}개 · 편집 ${number(docs.shareLinks.edit)}개`],
  ]);
  const body = $('#document-rows');
  const headers = body.closest('table').tHead.rows[0].cells;
  body.replaceChildren(...docs.largest.map((doc) => {
    const row = document.createElement('tr');
    [doc.id, `@${doc.owner}`, doc.type, fmtSize(doc.size), time(doc.modified * 1000)].forEach((value, i) => {
      const cell = row.insertCell();
      cell.dataset.label = headers[i].textContent;
      cell.textContent = value;
    });
    return row;
  }));
  $('#document-empty').hidden = docs.largest.length > 0;
}

let errorRequest = 0;
async function loadErrors() {
  const request = ++errorRequest;
  const query = new URLSearchParams({ days: $('#errors-days').value, tests: $('#errors-tests').checked ? '1' : '0' });
  const { groups, skipped } = await api(`/api/admin/errors?${query}`);
  if (request !== errorRequest) return;
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  $('#error-summary').textContent =
    `에러 ${number(total)}건 · ${number(groups.length)}개 그룹${skipped ? ` · 형식 오류로 제외 ${number(skipped)}줄` : ''}`;
  const list = $('#error-groups');
  list.replaceChildren();
  for (const group of groups) {
    const card = element('article', undefined, 'admin-card');
    card.append(
      element('div', `${group.kind} · ${number(group.count)}건`, 'admin-label'),
      element('h3', group.message),
      element('div', `최초 ${time(group.first)} · 최근 ${time(group.last)}`, 'admin-label'),
      element('div', `페이지 ${group.pages.join(', ') || '—'} · 파일 형식 ${group.fileTypes.join(', ') || '—'}`, 'admin-label'),
      element('div', `요청 ID ${group.request_id || '—'} · 세션 ID ${group.sessionId || '—'}`, 'admin-label'),
    );
    if (group.sampleStack) {
      const details = element('details');
      details.append(element('summary', '예시 스택'), element('pre', group.sampleStack));
      card.append(details);
    }
    list.append(card);
  }
}

async function loadStatus() {
  const { api: status, onlyoffice, disk, prometheus } = await api('/api/admin/status');
  const uptime = status.uptimeSeconds;
  renderStats('#status-stats', [
    ['API', status.ok ? '정상' : '응답 없음',
      `가동 시간 ${Math.floor(uptime / 86400)}일 ${Math.floor(uptime / 3600) % 24}시간 ${Math.floor(uptime / 60) % 60}분`],
    ['API 버전', status.version, `빌드 ${status.build || '정보 없음'}`],
    ['ONLYOFFICE', onlyoffice.ok ? '정상' : '응답 확인 실패'],
    ['데이터 볼륨 여유 공간', fmtSize(disk.freeBytes), `전체 ${fmtSize(disk.totalBytes)}`],
  ]);
  $('#prometheus-unavailable').hidden = prometheus.available;
  const metric = (value, scale, unit) => value == null ? '—' : `${(value * scale).toFixed(2)}${unit}`;
  renderStats('#status-metrics', [
    ['요청 수/분', metric(prometheus.requestsPerMinute, 1, '건')],
    ['p95 응답 시간', metric(prometheus.p95Seconds, 1000, 'ms')],
    ['5xx 비율', metric(prometheus.errorRate, 100, '%')],
  ]);
}

const tabs = {
  overview: loadOverview, users: loadUsers, documents: loadDocuments,
  feedback: loadFeedback, errors: loadErrors, status: loadStatus,
};
let activeTab;
let refreshRequest = 0;

async function refresh(tab = activeTab, background = false) {
  const request = ++refreshRequest;
  const button = $(`#${tab} [data-refresh]`);
  const notice = $('#admin-notice');
  button.disabled = true;
  if (!background) {
    notice.textContent = '불러오는 중…';
    notice.hidden = false;
  }
  try {
    await tabs[tab]();
    if (request === refreshRequest) notice.hidden = true;
  } catch (e) {
    if (request === refreshRequest) {
      notice.textContent = e.message;
      notice.hidden = false;
    }
  } finally {
    button.disabled = false;
  }
}

function selectTab() {
  const hash = location.hash.slice(1);
  const tab = Object.hasOwn(tabs, hash) ? hash : 'overview';
  if (activeTab === tab) return;
  if (activeTab === 'feedback') clearFeedbackImages();
  activeTab = tab;
  for (const key of Object.keys(tabs)) {
    $(`#${key}`).hidden = key !== tab;
    const link = $(`.admin-tabs a[href="#${key}"]`);
    if (key === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  refresh();
}

(async () => {
  me = await requireLogin();
  if (!me.isAdmin) { location.replace('/'); return; }
  $('#user-search').addEventListener('input', renderUsers);
  $('#user-sort').addEventListener('change', renderUsers);
  for (const key of ['status', 'kind']) {
    $(`#feedback-${key}`).addEventListener('change', () => showFeedback(0));
  }
  $('#feedback-prev').addEventListener('click', () => showFeedback(feedbackOffset - feedbackLimit));
  $('#feedback-next').addEventListener('click', () => showFeedback(feedbackOffset + feedbackLimit));
  for (const id of ['errors-days', 'errors-tests']) {
    $(`#${id}`).addEventListener('change', () => refresh('errors'));
  }
  for (const tab of Object.keys(tabs)) {
    $(`#${tab} [data-refresh]`).addEventListener('click', () => refresh(tab));
  }
  window.addEventListener('hashchange', selectTab);
  selectTab();
  if (!['overview', 'feedback'].includes(activeTab)) {
    api('/api/admin/feedback?limit=1').then(({ unread }) => {
      if ($('#feedback-unread').textContent === '') updateUnread(unread);
    }).catch(() => {});
  }
  setInterval(() => {
    if (!document.hidden && ['overview', 'status'].includes(activeTab)
        && !$(`#${activeTab} [data-refresh]`).disabled) refresh(activeTab, true);
  }, 60000);
})().catch((e) => toast(e.message, 'err'));
