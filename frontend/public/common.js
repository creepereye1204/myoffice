// 공통: API 호출 + 익명 작업공간 관리
// www.<도메인> 에서는 api.<도메인> 을 쓰고, 그 외(로컬 등)는 같은 출처 /api 프록시
export const API_BASE = location.hostname.startsWith('www.') ? `https://api.${location.hostname.slice(4)}` : '';
const WS_KEY = 'rhwp.workspace';

export function getWorkspace() {
  try { return localStorage.getItem(WS_KEY); } catch { return null; }
}
export function setWorkspace(ws) {
  try { localStorage.setItem(WS_KEY, ws); } catch {}
}

async function ensureWorkspace(force = false) {
  let ws = getWorkspace();
  if (ws && !force) return ws;
  const r = await fetch(`${API_BASE}/api/workspaces`, { method: 'POST' });
  if (!r.ok) throw new Error('작업공간을 만들 수 없습니다');
  ws = (await r.json()).workspace;
  setWorkspace(ws);
  return ws;
}

export async function api(path, opts = {}, retried = false) {
  const ws = await ensureWorkspace();
  const headers = { 'X-Workspace': ws, ...(opts.headers || {}) };
  let body = opts.body;
  if (body && !(body instanceof FormData) && !(body instanceof Uint8Array) && !(body instanceof Blob) && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const r = await fetch(`${API_BASE}${path}`, { ...opts, headers, body });
  if (r.status === 401 && !retried) {
    await ensureWorkspace(true);
    return api(path, opts, true);
  }
  if (!r.ok) {
    let msg = `요청 실패 (${r.status})`;
    try { const j = await r.json(); if (j.detail) msg = typeof j.detail === 'string' ? j.detail : msg; } catch {}
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r;
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

export function toast(msg, kind = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
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
