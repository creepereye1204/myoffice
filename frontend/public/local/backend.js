// 앱 모드: 웹 화면이 부르는 /api/... 를 서버 대신 기기 안에서 처리한다 (common.js 의 api() 가 이리로 보냄).
// 돌려주는 모양은 서버(api/app/main.py)와 같다 — 화면 코드는 서버인지 기기인지 모른다.
//
// 파일 = 알오피스 폴더의 파일 + 기기 다른 곳에서 연 파일(그 자리에 저장). 화면이 쓰는 id 는 파일 이름이
// 바뀌어도 그대로여야 해서, id ↔ 파일 위치(handle) 표를 localStorage 에 둔다.
import { platform } from './platform.js';
import { convertLocal } from './office.js';

const WORD = ['docx', 'doc', 'odt', 'rtf', 'txt'], CELL = ['xlsx', 'xls', 'ods', 'csv'], SLIDE = ['pptx', 'ppt', 'odp'];
const HWP = ['hwp', 'hwpx'], PDF = ['pdf'];
const ALLOWED = new Set([...WORD, ...CELL, ...SLIDE, ...HWP, ...PDF]);
const OO_EDITABLE = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv']);
const APP_NEW = { hcell: 'xlsx', hshow: 'pptx' };
const APP_EXT = { hcell: new Set(['xlsx', 'xls', 'ods', 'csv']), hshow: new Set(['pptx', 'ppt', 'odp']) };
const HANCOM_NATIVE = new Set(['cell', 'show', 'nxl', 'hcdt', 'hsdt']);
const DEFAULT_NAMES = { docx: '새 워드', xlsx: '새 엑셀', pptx: '새 파워포인트', hwp: '새 한글', hwpx: '새 한글', hcell: '새 한셀', hshow: '새 한쇼' };

export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
export const docType = (ext) => (WORD.includes(ext) ? 'word' : CELL.includes(ext) ? 'cell' : SLIDE.includes(ext) ? 'slide' : HWP.includes(ext) ? 'hwp' : 'pdf');
const cleanName = (name, ext) => {
  let n = String(name || '').trim().replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').slice(0, 120).replace(/^[. ]+|[. ]+$/g, '') || '제목 없음';
  if (!n.toLowerCase().endsWith(`.${ext}`)) n = `${n}.${ext}`;
  return n;
};
const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };

// ---------------------------------------------------------------- id ↔ 위치 표
const INDEX_KEY = 'myoffice.index';
let index = null;
function loadIndex() {
  if (!index) { try { index = JSON.parse(localStorage.getItem(INDEX_KEY)) || {}; } catch { index = {}; } }
  return index;
}
function saveIndex() { try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* 저장 공간 없음 */ } }
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
function idFor(handle, extra = {}) {
  const idx = loadIndex();
  for (const [id, e] of Object.entries(idx)) if (e.handle === handle) { if (Object.keys(extra).length) { Object.assign(e, extra); saveIndex(); } return id; }
  const id = newId();
  idx[id] = { handle, version: 1, created: Math.floor(Date.now() / 1000), ...extra };
  saveIndex();
  return id;
}
function entry(id) {
  const e = loadIndex()[id];
  if (!e) fail(404, '파일이 없습니다');
  return e;
}
function toPublic(id, e, st) {
  const ext = extOf(st.name);
  return {
    id, name: st.name, ext, type: docType(ext), size: st.size,
    version: e.version || 1, created: e.created || Math.floor(st.mtime / 1000), modified: Math.floor(st.mtime / 1000),
    editable: OO_EDITABLE.has(ext) || HWP.includes(ext),
    app: e.app && APP_EXT[e.app]?.has(ext) ? e.app : null,
    shared: false, external: !platform.inLibrary(e.handle),
    handle: e.handle,
  };
}
async function meta(id) {
  const e = entry(id);
  const st = await platform.stat(e.handle);
  if (!st) { delete index[id]; saveIndex(); fail(404, '파일이 없습니다 (옮겨졌거나 지워졌습니다)'); }
  return toPublic(id, e, st);
}

/** 기기 다른 곳의 파일(데스크톱 경로, 안드로이드 content://)을 목록에 넣고 id 를 돌려준다. 그 자리에 저장된다. */
export function registerFile(handle) { return idFor(handle); }

async function listFiles() {
  const lib = await platform.list();
  const seen = new Set();
  const out = [];
  for (const f of lib) {
    if (!ALLOWED.has(extOf(f.name))) continue;
    const id = idFor(f.handle);
    seen.add(id);
    out.push(toPublic(id, index[id], f));
  }
  // 알오피스 폴더 밖에서 연 파일
  for (const [id, e] of Object.entries(loadIndex())) {
    if (seen.has(id)) continue;
    if (platform.inLibrary(e.handle)) { delete index[id]; continue; }   // 폴더에서 지워짐
    const st = await platform.stat(e.handle).catch(() => null);
    if (st) out.push(toPublic(id, e, st)); else delete index[id];
  }
  saveIndex();
  return out.sort((a, b) => b.modified - a.modified);
}

async function createFile(name, ext, bytes, app) {
  const r = await platform.create(cleanName(name, ext), bytes);
  const id = idFor(r.handle, app ? { app } : {});
  return meta(id);
}

// fetch 응답처럼 쓰이는 결과 (edit.js 가 arrayBuffer()·headers.get 을 씀)
class LocalResponse {
  constructor(bytes, headers = {}) { this.bytes = bytes; this.h = headers; this.ok = true; this.status = 200; }
  get headers() { return { get: (k) => this.h[k.toLowerCase()] ?? null }; }
  async arrayBuffer() { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength); }
  async blob() { return new Blob([this.bytes]); }
}

async function convert(id, to) {
  const f = await meta(id);
  if (f.type === 'hwp') fail(400, '앱에서는 한글 문서를 다른 형식으로 바꿀 수 없습니다 (웹 사이트에서는 됩니다)');
  const bytes = await platform.read(entry(id).handle);
  return { f, out: await convertLocal(bytes, f.name, to) };
}

// ---------------------------------------------------------------- 라우터
export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const url = new URL(path, 'http://local');
  const p = url.pathname;
  const body = opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData) && !(opts.body instanceof Uint8Array) && !(opts.body instanceof Blob) ? opts.body : null;
  let m;

  if (p === '/api/auth/me') return { id: 0, username: 'local', name: '내 기기', isAdmin: false, local: true };
  if (p === '/api/files' && method === 'GET') return listFiles();
  if (p === '/api/shared-with-me') return [];
  if (p === '/api/workspaces/me') {
    const files = await listFiles();
    return { used: files.reduce((s, f) => s + f.size, 0), quota: 0, files: files.length, folder: platform.folder, local: true };
  }
  if (p === '/api/files/new' && method === 'POST') {
    const kind = String(body?.type || '').toLowerCase();
    const app = APP_NEW[kind] ? kind : null;
    const ext = APP_NEW[kind] || kind;
    if (!DEFAULT_NAMES[kind]) fail(400, '지원하지 않는 형식');
    const tpl = await fetch(`/templates/blank.${ext}`);
    if (!tpl.ok) fail(500, '빈 문서 템플릿이 없습니다');
    return createFile(body?.name || DEFAULT_NAMES[kind], ext, new Uint8Array(await tpl.arrayBuffer()), app);
  }
  if (p === '/api/files/upload' && method === 'POST') {
    const file = opts.body.get('file');
    const ext = extOf(file.name);
    if (HANCOM_NATIVE.has(ext)) fail(400, `한셀/한쇼 고유 형식(.${ext})은 열 수 없습니다. 한셀·한쇼에서 xlsx/pptx로 저장한 뒤 가져와 주세요`);
    if (!ALLOWED.has(ext)) fail(400, `지원하지 않는 형식입니다: .${ext}`);
    // 데스크톱에서 끌어다 놓은 파일은 경로가 있으면 그 자리에서 연다 (복사하지 않음)
    const path = platform.pathForFile(file);
    if (path) return meta(idFor(path));
    return createFile(file.name, ext, new Uint8Array(await file.arrayBuffer()));
  }
  if ((m = p.match(/^\/api\/files\/([a-f0-9]{32})$/))) {
    const id = m[1];
    if (method === 'GET') return meta(id);
    if (method === 'PATCH') {
      const f = await meta(id);
      if (body?.name) {
        const e = entry(id);
        const r = await platform.rename(e.handle, cleanName(body.name, f.ext));
        e.handle = r.handle; saveIndex();
      }
      return meta(id);
    }
    if (method === 'DELETE') {
      const e = entry(id);
      if (platform.inLibrary(e.handle)) await platform.remove(e.handle);   // 밖에서 연 파일은 목록에서만 뺀다
      delete index[id]; saveIndex();
      return { ok: true };
    }
  }
  if ((m = p.match(/^\/api\/files\/([a-f0-9]{32})\/content$/))) {
    const id = m[1], e = entry(id);
    if (method === 'GET') {
      const bytes = await platform.read(e.handle);
      return new LocalResponse(bytes, { 'x-file-version': String(e.version || 1) });
    }
    if (method === 'PUT') {
      await platform.write(e.handle, opts.body instanceof Blob ? new Uint8Array(await opts.body.arrayBuffer()) : opts.body);
      e.version = (e.version || 1) + 1; saveIndex();
      return meta(id);
    }
  }
  if ((m = p.match(/^\/api\/files\/([a-f0-9]{32})\/convert$/)) && method === 'POST') {
    const to = body.to;
    const { f, out } = await convert(m[1], to);
    return createFile(f.name.replace(/\.[^.]+$/, ''), to, out);
  }
  if ((m = p.match(/^\/api\/files\/([a-f0-9]{32})\/export$/)) && method === 'POST') {
    const to = body.to;
    const { f, out } = await convert(m[1], to);
    const name = `${f.name.replace(/\.[^.]+$/, '')}.${to}`;
    return new LocalResponse(out, { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
  }
  fail(404, `앱에서는 쓸 수 없는 기능입니다 (${method} ${p})`);
}

/** 파일 내용 (내려받기·내보내기용) */
export async function readFile(id) { return platform.read(entry(id).handle); }
export async function fileHandle(id) { return entry(id).handle; }
