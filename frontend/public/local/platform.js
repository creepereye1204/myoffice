// 앱(서버 없이) 모드의 기기 저장소 — 플랫폼마다 다른 부분을 하나로 감싼다.
//   데스크톱(Electron): preload 가 넣는 window.nativeBridge (실제 폴더: 문서/알오피스)
//   안드로이드: window.AndroidBridge (문자열만 오가므로 base64 + 콜백 id, 앱 폴더)
//   그 밖(브라우저로 확인할 때): IndexedDB
//
// 공통 모양 (handle = 파일을 가리키는 문자열: 경로 / content:// / idb:...)
//   list()                    → [{ handle, name, size, mtime(ms) }]   알오피스 폴더의 파일
//   stat(handle)              → { name, size, mtime } | null
//   read(handle)              → Uint8Array
//   write(handle, bytes)
//   create(name, bytes)       → { handle, name }   알오피스 폴더에 새 파일 (이름이 겹치면 (2) 붙임)
//   rename(handle, name)      → { handle, name }
//   remove(handle)            (데스크톱은 휴지통으로)
//   pickOpen()                → { handle, name } | null   기기 아무 곳의 파일 고르기
//   pickSave(name, bytes)     → { handle, name } | null   위치 골라 저장
//   onOpenRequest(cb)         운영체제에서 "이 앱으로 열기" → cb({ handle, name })
//   setDirty(bool), setTitle(text), reveal(handle?), folder (표시용 폴더 이름)
//   inLibrary(handle)         알오피스 폴더 안인지

const b64 = {
  enc(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
};
const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

function desktop(n) {
  return {
    name: n.platform || 'desktop',
    folder: n.libraryDir(),
    list: () => n.list(),
    stat: (h) => n.stat(h),
    read: async (h) => u8(await n.read(h)),
    write: (h, bytes) => n.write(h, u8(bytes)),
    create: (name, bytes) => n.create(name, u8(bytes)),
    rename: (h, name) => n.rename(h, name),
    remove: (h) => n.remove(h),
    pickOpen: () => n.pickOpen(),
    pickSave: (name, bytes) => n.pickSave(name, u8(bytes)),
    onOpenRequest: (cb) => n.onOpenRequest(cb),
    setDirty: (d) => n.setDirty(!!d),
    setTitle: (t) => n.setTitle(t),
    reveal: (h) => n.reveal(h),
    pathForFile: (f) => n.pathForFile?.(f) || null,
    inLibrary: (h) => !!h && h.startsWith(n.libraryDir()),
  };
}

function android(a) {
  // Java 는 끝나면 window.__bridgeDone(id, json) 을 부른다. json = 결과 | {error}
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
  let openCb = null;
  const queued = [];
  window.__openRequest = (json) => {
    const f = typeof json === 'string' ? JSON.parse(json) : json;
    if (openCb) openCb(f); else queued.push(f);
  };
  const folder = a.libraryDir();
  return {
    name: 'android',
    folder,
    list: async () => (await call('list')).files,
    stat: async (h) => (await call('stat', h)).stat || null,
    // 읽은 내용은 Java 가 /__file/<토큰> 주소로 한 번 내준다 (큰 문서를 문자열로 바꾸지 않으려고)
    read: async (h) => { const r = await call('read', h); return new Uint8Array(await (await fetch(r.url)).arrayBuffer()); },
    write: (h, bytes) => call('write', h, b64.enc(u8(bytes))),
    create: (name, bytes) => call('create', name, b64.enc(u8(bytes))),
    rename: (h, name) => call('rename', h, name),
    remove: (h) => call('remove', h),
    pickOpen: async () => { const r = await call('pickOpen'); return r && r.handle ? r : null; },
    pickSave: async (name, bytes) => { const r = await call('pickSave', name, b64.enc(u8(bytes))); return r && r.handle ? r : null; },
    onOpenRequest: (cb) => { openCb = cb; queued.splice(0).forEach(cb); a.ready(); },
    setDirty: (d) => a.setDirty(!!d),
    setTitle: () => {},
    reveal: () => {},
    pathForFile: () => null,
    inLibrary: (h) => !!h && h.startsWith('file://'),
  };
}

// 브라우저: IndexedDB 한 곳에 { handle, name, bytes, mtime }
function browser() {
  const db = new Promise((resolve, reject) => {
    const r = indexedDB.open('myoffice-local', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'handle' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = async (mode, fn) => {
    const d = await db;
    return new Promise((resolve, reject) => {
      const t = d.transaction('files', mode);
      const out = fn(t.objectStore('files'));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  };
  const get = (h) => tx('readonly', (s) => s.get(h));
  const all = () => tx('readonly', (s) => s.getAll());
  const put = (rec) => tx('readwrite', (s) => s.put(rec));
  const uniqueName = async (name) => {
    const names = new Set((await all()).map((r) => r.name));
    if (!names.has(name)) return name;
    const m = name.match(/^(.*?)(\.[^.]*)?$/);
    for (let i = 2; ; i++) { const n = `${m[1]} (${i})${m[2] || ''}`; if (!names.has(n)) return n; }
  };
  return {
    name: 'browser',
    folder: '이 브라우저',
    list: async () => (await all()).map(({ handle, name, bytes, mtime }) => ({ handle, name, size: bytes.byteLength, mtime })),
    stat: async (h) => { const r = await get(h); return r ? { name: r.name, size: r.bytes.byteLength, mtime: r.mtime } : null; },
    read: async (h) => { const r = await get(h); if (!r) throw new Error('파일이 없습니다'); return u8(r.bytes); },
    write: async (h, bytes) => { const r = await get(h); if (!r) throw new Error('파일이 없습니다'); await put({ ...r, bytes: u8(bytes).slice(), mtime: Date.now() }); },
    create: async (name, bytes) => {
      const rec = { handle: `idb:${crypto.randomUUID()}`, name: await uniqueName(name), bytes: u8(bytes).slice(), mtime: Date.now() };
      await put(rec);
      return { handle: rec.handle, name: rec.name };
    },
    rename: async (h, name) => { const r = await get(h); await put({ ...r, name: await uniqueName(name) }); return { handle: h, name: (await get(h)).name }; },
    remove: (h) => tx('readwrite', (s) => s.delete(h)),
    pickOpen: () => new Promise((resolve) => {
      // 브라우저는 파일 자리에 다시 쓸 수 없으므로 알오피스 저장소로 가져온다
      const inp = Object.assign(document.createElement('input'), { type: 'file' });
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return resolve(null);
        resolve(await browser().create(f.name, new Uint8Array(await f.arrayBuffer())));
      };
      inp.click();
    }),
    pickSave: async (name, bytes) => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([u8(bytes)])), download: name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { handle: null, name };
    },
    onOpenRequest() {},
    setDirty() {},
    setTitle(t) { document.title = t; },
    reveal() {},
    pathForFile: () => null,
    inLibrary: (h) => !!h && h.startsWith('idb:'),
  };
}

export const platform = window.nativeBridge ? desktop(window.nativeBridge)
  : window.AndroidBridge ? android(window.AndroidBridge)
    : browser();
