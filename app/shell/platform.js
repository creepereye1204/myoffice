// 기기 파일 읽기/쓰기 — 플랫폼마다 다른 부분을 하나로 감싼다.
//   데스크톱(Electron): preload 가 window.nativeBridge 를 넣어 준다 (Uint8Array 그대로 주고받음).
//   안드로이드: WebView 의 window.AndroidBridge (문자열만 오가므로 base64 + 콜백 id).
//   그 밖(브라우저에서 열어 볼 때): File System Access API 또는 파일 선택/내려받기.
//
// 공통 모양:
//   pickOpen()                 → { handle, name, bytes } | null
//   read(handle)               → { name, bytes }
//   write(handle, bytes)       → void
//   pickSave(name, bytes)      → { handle, name } | null   (고른 곳에 바로 씀)
//   onOpenRequest(cb)          → 운영체제에서 "이 앱으로 열기" 했을 때 cb({handle,name,bytes})
//   setDirty(bool)             → 닫을 때 확인용
//   setTitle(text)
//   canRecent                  → 최근 문서를 다시 열 수 있는지(handle 이 오래 유지되는지)

const b64 = {
  enc(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function desktop(n) {
  return {
    name: n.platform || 'desktop',
    canRecent: true,
    pickOpen: () => n.pickOpen(),
    read: (h) => n.read(h),
    write: (h, bytes) => n.write(h, bytes),
    pickSave: (name, bytes) => n.pickSave(name, bytes),
    onOpenRequest: (cb) => n.onOpenRequest(cb),
    setDirty: (d) => n.setDirty(!!d),
    setTitle: (t) => n.setTitle(t),
    showInFolder: (h) => n.showInFolder?.(h),
  };
}

function android(a) {
  // Java 는 끝나면 window.__bridgeDone(id, json) 을 부른다. json = {ok, ...} | {error}
  let seq = 0;
  const waits = new Map();
  window.__bridgeDone = (id, json) => {
    const w = waits.get(id);
    if (!w) return;
    waits.delete(id);
    const r = typeof json === 'string' ? JSON.parse(json) : json;
    if (r && r.error) w.reject(new Error(r.error)); else w.resolve(r);
  };
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waits.set(id, { resolve, reject });
    a[method](id, ...args);
  });
  // 읽은 내용은 Java 가 /__file/<토큰> 주소로 한 번 내준다 (큰 문서를 문자열로 바꾸지 않으려고)
  const file = async (r) => {
    if (!r || !r.handle) return null;
    let bytes;
    if (r.url) bytes = new Uint8Array(await (await fetch(r.url)).arrayBuffer());
    else if (r.data != null) bytes = b64.dec(r.data);
    return { handle: r.handle, name: r.name, bytes };
  };
  let openCb = null, queued = [];
  window.__openRequest = async (json) => {
    const f = await file(typeof json === 'string' ? JSON.parse(json) : json);
    if (!f) return;
    if (openCb) openCb(f); else queued.push(f);
  };
  return {
    name: 'android',
    canRecent: true,
    pickOpen: async () => file(await call('pickOpen')),
    read: async (h) => file(await call('read', h)),
    write: async (h, bytes) => { await call('write', h, b64.enc(bytes)); },
    pickSave: async (name, bytes) => { const r = await call('pickSave', name, b64.enc(bytes)); return r && r.handle ? { handle: r.handle, name: r.name } : null; },
    onOpenRequest: (cb) => { openCb = cb; queued.splice(0).forEach(cb); a.ready(); },
    setDirty: (d) => a.setDirty(!!d),
    setTitle: () => {},
  };
}

function browser() {
  // 브라우저에서 미리 볼 때. 저장 위치를 기억할 수 있으면(File System Access) 그 파일에 쓰고, 아니면 내려받기.
  const fsa = 'showOpenFilePicker' in window;
  const handles = new Map();
  let n = 0;
  const keep = (h) => { const id = `mem:${++n}`; handles.set(id, h); return id; };
  return {
    name: 'browser',
    canRecent: false,
    async pickOpen() {
      if (fsa) {
        try {
          const [h] = await window.showOpenFilePicker();
          const f = await h.getFile();
          return { handle: keep(h), name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
        } catch (e) { if (e.name === 'AbortError') return null; throw e; }
      }
      return new Promise((resolve) => {
        const inp = Object.assign(document.createElement('input'), { type: 'file' });
        inp.onchange = async () => {
          const f = inp.files[0];
          resolve(f ? { handle: keep(null), name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
        };
        inp.click();
      });
    },
    async read() { throw new Error('브라우저에서는 최근 문서를 다시 열 수 없습니다'); },
    async write(handle, bytes) {
      const h = handles.get(handle);
      if (!h) throw new Error('저장할 위치를 모릅니다 — 다른 이름으로 저장을 써 주세요');
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
    },
    async pickSave(name, bytes) {
      if ('showSaveFilePicker' in window) {
        try {
          const h = await window.showSaveFilePicker({ suggestedName: name });
          const w = await h.createWritable();
          await w.write(bytes);
          await w.close();
          return { handle: keep(h), name: h.name };
        } catch (e) { if (e.name === 'AbortError') return null; throw e; }
      }
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes])), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return null;
    },
    onOpenRequest() {},
    setDirty() {},
    setTitle(t) { document.title = t; },
  };
}

export const platform = window.nativeBridge ? desktop(window.nativeBridge)
  : window.AndroidBridge ? android(window.AndroidBridge)
    : browser();
