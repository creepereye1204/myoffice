// 공통: API 호출 + 로그인 세션
// www.<도메인> 에서는 api.<도메인> 을 쓰고, 그 외(로컬 등)는 같은 출처 /api 프록시
export const API_BASE = location.hostname.startsWith('www.') ? `https://api.${location.hostname.slice(4)}` : '';
const TOKEN_KEY = 'rhwp.token';
const ME_KEY = 'rhwp.me';

export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setSession(token, user) {
  try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(ME_KEY, JSON.stringify(user)); } catch {}
}
export function clearSession() { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY); } catch {} }
export function cachedMe() { try { return JSON.parse(localStorage.getItem(ME_KEY) || 'null'); } catch { return null; } }

export function goLogin() {
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

/** 로그인 필수 페이지: 세션 확인, 없으면 로그인 화면으로 */
export async function requireLogin() {
  if (!getToken()) { goLogin(); return new Promise(() => {}); }
  try {
    const me = await api('/api/auth/me');
    setSession(getToken(), me);
    return me;
  } catch (e) {
    if (e.status === 401) { clearSession(); goLogin(); return new Promise(() => {}); }
    throw e;
  }
}

// 공유 링크로 들어온 경우: X-Share 토큰도 같이 보낸다 (로그인 없이도 열림)
let SHARE = null;
export function setShare(token) { SHARE = token; }
export function getShare() { return SHARE; }

// 공동 편집 표시용 사용자. 로그인하면 계정 기준(u<id>), 아니면 브라우저별 임시 id
export function getUser() {
  const me = getToken() && cachedMe();
  if (me) return { uid: `u${me.id}`, name: me.name, account: true };
  let u = null;
  try { u = JSON.parse(localStorage.getItem('rhwp.user') || 'null'); } catch {}
  if (!u || !u.uid) {
    const rnd = crypto.getRandomValues(new Uint8Array(9));
    u = { uid: btoa(String.fromCharCode(...rnd)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c])), name: '' };
    try { localStorage.setItem('rhwp.user', JSON.stringify(u)); } catch {}
  }
  return u;
}
export function setUserName(name) {
  const u = getUser(); u.name = name.trim().slice(0, 30);
  try { localStorage.setItem('rhwp.user', JSON.stringify(u)); } catch {}
  return u;
}

function reportApiError(path, method, status, message, requestId) {
  if (!window.reportClientError) return;
  // 알려진 경로만 기록하고 파일·계정·공유 링크 값은 템플릿으로 바꾼다.
  const [pathname, query] = path.split(/[?#]/, 2);
  const privateValues = [SHARE, ...new URLSearchParams(query).values()];
  const route = pathname
    .replace(/^(\/api\/files\/)(?!new$|upload$)([^/]+)/, (_, prefix, id) => {
      privateValues.push(id);
      return prefix + '{id}';
    })
    .replace(/^(\/api\/(?:shared|admin\/users|files\/\{id\}\/grants)\/)([^/]+)$/, (_, prefix, id) => {
      privateValues.push(id);
      return prefix + '{id}';
    });
  const known = /^\/api\/(?:auth\/(?:config|login|logout|me|password|signup)|admin\/(?:settings|users(?:\/\{id\})?)|files(?:\/(?:new|upload|\{id\}(?:\/(?:content|convert|download-link|export|grants(?:\/\{id\})?|onlyoffice|save|share))?))?|shared\/\{id\}|shared-with-me|workspaces\/me|health)$/;
  window.reportClientError('api', message, '', {
    method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) ? method : 'OTHER',
    route: known.test(route) ? route : 'other', status,
    request_id: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(requestId || '') ? requestId : undefined,
  }, privateValues);
}

export async function api(path, { includeShare = true, ...opts } = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (includeShare && SHARE) headers['X-Share'] = SHARE;
  let body = opts.body;
  if (body && !(body instanceof FormData) && !(body instanceof Uint8Array) && !(body instanceof Blob) && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  // timeout(ms) 지정 시 응답이 없으면 끊는다 (저장이 영원히 '저장 중'에 걸리지 않게)
  const ctrl = opts.timeout ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), opts.timeout);
  const method = String(opts.method || 'GET').toUpperCase();
  let r;
  try {
    r = await fetch(`${API_BASE}${path}`, { ...opts, headers, body, signal: ctrl?.signal || opts.signal });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const err = new Error(e.name === 'AbortError' ? '서버 응답이 없습니다. 잠시 후 다시 저장합니다' : '네트워크 연결을 확인하세요');
    err.status = 0;
    reportApiError(path, method, 0, err.message);
    throw err;
  } finally { if (timer) clearTimeout(timer); }
  if (!r.ok) {
    let msg = `요청 실패 (${r.status})`;
    try { const j = await r.json(); if (j.detail) msg = typeof j.detail === 'string' ? j.detail : msg; } catch {}
    if (r.status >= 500) reportApiError(path, method, r.status, msg, r.headers.get('X-Request-ID'));
    const err = new Error(msg); err.status = r.status;
    throw err;
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r;
}

export async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  clearSession();
  location.href = '/login';
}

/** 저장하지 않고 다른 형식(PDF 등)으로 바로 내려받기 */
export async function exportAs(id, to) {
  const r = await api(`/api/files/${id}/export`, { method: 'POST', body: { to } });
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || `document.${to}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export async function download(id) {
  const { url, name } = await api(`/api/files/${id}/download-link`);
  const a = document.createElement('a');
  a.href = `${API_BASE}${url}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// kind = 파일의 app(hcell/hshow) 또는 type(word/cell/slide/hwp/pdf)
export const TYPE_INFO = {
  word:  { label: '워드',       short: 'W', color: 'var(--word)' },
  cell:  { label: '엑셀',       short: 'X', color: 'var(--cell)' },
  slide: { label: '파워포인트', short: 'P', color: 'var(--slide)' },
  hwp:   { label: '한글',       short: '한', color: 'var(--hwp)' },
  hcell: { label: '한셀',       short: '셀', color: 'var(--hcell)' },
  hshow: { label: '한쇼',       short: '쇼', color: 'var(--hshow)' },
  pdf:   { label: 'PDF',        short: 'P', color: 'var(--pdf)' },
};

export const kindOf = (f) => f.app || f.type;

export function fileIcon(type, ext) {
  const t = TYPE_INFO[type] || TYPE_INFO.word;
  return `<span class="ficon" style="--c:${t.color}" aria-hidden="true"><b>${t.short}</b><i>${ext.toUpperCase()}</i></span>`;
}

export function toast(msg, kind = '', privateValues = [], container = document.body) {
  if (kind === 'err') window.reportClientError?.('toast', msg, '', {}, [SHARE, ...privateValues]);
  let box = container.querySelector(':scope > .toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('aria-live', 'polite');
    if (container === document.body) box.id = 'toasts';
    container.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtTime(sec) {
  const d = new Date(sec * 1000), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400 && d.getDate() === now.getDate()) return `${Math.floor(diff / 3600)}시간 전`;
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

// 실시간 소켓 (자동 재접속 + 20초 핑 — 프록시 유휴 타임아웃 방지)
export function connectRoom(fileId, onMsg, onState = () => {}) {
  const base = API_BASE || location.origin;
  const u = getUser();
  const q = new URLSearchParams({ uid: u.uid, name: u.name || '손님' });
  if (SHARE) q.set('s', SHARE);
  if (getToken()) q.set('t', getToken());
  const url = `${base.replace(/^http/, 'ws')}/ws/files/${fileId}?${q}`;
  let sock, timer, retry = 0, closed = false;
  const open = () => {
    sock = new WebSocket(url);
    sock.onopen = () => { retry = 0; onState(true); timer = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 20000); };
    sock.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch {} };
    sock.onclose = (e) => {
      clearInterval(timer); onState(false);
      if (closed || e.code === 4401 || e.code === 4403) return;
      setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
    };
  };
  open();
  return {
    send: (m) => sock?.readyState === 1 && sock.send(JSON.stringify(m)),
    close: () => { closed = true; sock?.close(); },
    bye: () => { closed = true; if (sock?.readyState === 1) sock.send('{"type":"bye"}'); },
  };
}
