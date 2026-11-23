// 앱 모드의 워드·엑셀·파워포인트 편집기: ONLYOFFICE 편집기 + x2t 변환기(WebAssembly)를 iframe 으로 (서버 없음).
// /document/ 아래 파일은 ranuts/document 의 오프라인 빌드 (app/prepare.mjs 가 넣는다). iframe 과는 postMessage 로 이야기한다.

const SRC = `/document/editor.html?embed=1&locale=ko-KR&embedOrigin=${encodeURIComponent(location.origin)}`;

// 옛 한글 인코딩(CP949/EUC-KR)으로 된 txt·csv 는 편집기가 UTF-8 로 읽어 글자가 깨진다 → UTF-8 로 바꿔서 연다.
// (저장하면 UTF-8 로 저장된다)
export function toUtf8Text(bytes, name) {
  if (!/\.(txt|csv)$/i.test(name)) return bytes;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return bytes; } catch { /* UTF-8 아님 */ }
  try {
    const text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
    return new TextEncoder().encode(text);
  } catch { return bytes; }
}

// zip 안 파일 하나 꺼내기 (브라우저 내장 압축 풀기)
async function unzipEntry(buf, want) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip 이 아닙니다');
  let p = v.getUint32(eocd + 16, true);
  for (let i = 0; i < v.getUint16(eocd + 10, true); i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
    if (name === want) {
      const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      const out = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(out).arrayBuffer());
    }
    p += 46 + nl + xl + cl;
  }
  throw new Error(`${want} 없음`);
}
// docx 의 본문 글자 → 텍스트 (문단은 줄바꿈, 탭·줄 나눔 유지)
async function docxToText(docx) {
  const xml = new TextDecoder().decode(await unzipEntry(docx, 'word/document.xml'));
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const lines = [];
  for (const para of doc.getElementsByTagNameNS(W, 'p')) {
    let line = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.namespaceURI === W && c.localName === 't') line += c.textContent;
        else if (c.namespaceURI === W && c.localName === 'tab') line += '\t';
        else if (c.namespaceURI === W && (c.localName === 'br' || c.localName === 'cr')) line += '\n';
        else if (c.nodeType === 1 && !(c.namespaceURI === W && c.localName === 'p')) walk(c);
      }
    };
    walk(para);
    lines.push(line);
  }
  return lines.join('\r\n');
}

export class LocalOffice {
  constructor(container, { hidden = false } = {}) {
    this.frame = document.createElement('iframe');
    this.frame.title = '문서 편집기';
    this.frame.className = 'local-office';
    if (hidden) Object.assign(this.frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '1200px', height: '800px', border: '0' });
    else Object.assign(this.frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
    this.pending = new Map();
    this.seq = 0;
    this.onDirty = () => {};
    this.ready = new Promise((resolve, reject) => {
      let ping = 0;
      const t = setTimeout(() => { clearInterval(ping); reject(new Error('편집기를 불러오지 못했습니다')); }, 90000);
      window.addEventListener('message', (e) => {
        if (e.source !== this.frame.contentWindow) return;
        const { id, type, payload } = e.data || {};
        if (typeof type !== 'string' || !type.startsWith('document:')) return;
        // 'document:ready' 는 load 시점에 따라 안 올 때가 있어 get-state 응답으로 준비를 확인한다
        if (type === 'document:ready' || id === 'ping') { clearTimeout(t); clearInterval(ping); resolve(this.frame.contentWindow); return; }
        if (type === 'document:dirty-changed') { this.onDirty(!!payload?.dirty); return; }
        const w = this.pending.get(id);
        if (!w) return;
        this.pending.delete(id);
        if (type === 'document:error') w.reject(new Error(payload?.message || '편집기 오류')); else w.resolve(payload || {});
      });
      this.frame.addEventListener('load', () => {
        ping = setInterval(() => this.frame.contentWindow.postMessage({ id: 'ping', type: 'document:get-state', payload: {} }, location.origin), 250);
      }, { once: true });
    });
    this.frame.src = SRC;
    container.appendChild(this.frame);
  }

  async cmd(type, payload = {}, ms = 120000) {
    const win = await this.ready;
    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('시간이 너무 오래 걸립니다')); }, ms);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      win.postMessage({ id, type, payload }, location.origin);
    });
  }

  async open(bytes, name, readonly = false) {
    await this.cmd('document:open-buffer', { fileName: name, buffer: toUtf8Text(bytes, name), readonly });
    await this.loaded();
  }

  // 'opened' 응답은 편집기가 문서를 다 그리기 전에 온다 → 편집기 API 가 '다 읽었음'을 알릴 때까지 기다린다
  // (그 전에 입력·저장하면 내용이 빠질 수 있음). PDF 보기 등 API 가 없으면 로딩 표시가 사라질 때까지.
  async loaded(ms = 90000) {
    const end = Date.now() + ms;
    const state = (win) => {
      try {
        const api = win.Asc?.editor || win.editor;
        if (api && typeof api.isDocumentLoadComplete === 'boolean') return api.isDocumentLoadComplete ? 'done' : 'loading';
        for (let i = 0; i < win.frames.length; i++) { const s = state(win.frames[i]); if (s) return s; }
      } catch { /* 다른 출처 */ }
      return null;
    };
    let none = 0;
    while (Date.now() < end) {
      const s = state(this.frame.contentWindow);
      if (s === 'done') return;
      if (!s && ++none > 15) return;   // API 를 못 찾음 (3초) — 그대로 진행
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // 엑셀에서 셀에 입력하던 중(Enter 전)에 저장하면 그 셀도 넣는다
  commitCellEdit(win = this.frame.contentWindow) {
    let done = false;
    try {
      const api = win.Asc?.editor || win.editor;
      if (api && typeof api.asc_closeCellEditor === 'function') { api.asc_closeCellEditor(false); done = true; }
      for (let i = 0; i < win.frames.length; i++) done = this.commitCellEdit(win.frames[i]) || done;
    } catch { /* 다른 출처 */ }
    return done;
  }

  /** 현재 문서를 ext 형식(docx, xlsx, pptx, pdf, odt, csv …)으로 → Uint8Array. 결과의 dirty: 저장 중 생긴 수정 */
  async save(ext) {
    if (this.commitCellEdit()) await new Promise((r) => setTimeout(r, 300));
    // txt: 변환기(x2t wasm)가 한글을 1바이트로 잘라 써서 글자가 사라진다 → docx 로 받아 글자만 꺼내 UTF-8 로
    const asTxt = ext.toLowerCase() === 'txt';
    const r = await this.cmd('document:save', { targetExt: asTxt ? 'DOCX' : ext.toUpperCase() });
    let bytes = new Uint8Array(await r.file.arrayBuffer());
    if (asTxt) bytes = new TextEncoder().encode(`\ufeff${await docxToText(bytes)}`);
    return { bytes, dirty: !!r.dirty };
  }
}

// 변환 전용 (화면 밖 편집기 하나를 돌려 씀): bytes(name) → toExt
let converter = null;
let queue = Promise.resolve();
export function convertLocal(bytes, name, toExt) {
  const job = queue.then(async () => {
    converter ||= new LocalOffice(document.body, { hidden: true });
    await converter.open(bytes, name, true);
    return (await converter.save(toExt)).bytes;
  });
  queue = job.catch(() => {});
  return job;
}
