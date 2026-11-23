// 웹 화면(frontend/public/local/platform.js)이 쓰는 window.nativeBridge. 메인 창 최상위 문서에만 들어간다.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nativeBridge', {
  platform: process.platform === 'win32' ? 'windows' : 'linux',
  libraryDir: () => ipcRenderer.sendSync('libraryDir'),
  list: () => ipcRenderer.invoke('list'),
  stat: (h) => ipcRenderer.invoke('stat', h),
  read: (h) => ipcRenderer.invoke('read', h),
  write: (h, bytes) => ipcRenderer.invoke('write', h, bytes),
  create: (name, bytes) => ipcRenderer.invoke('create', name, bytes),
  rename: (h, name) => ipcRenderer.invoke('rename', h, name),
  remove: (h) => ipcRenderer.invoke('remove', h),
  pickOpen: () => ipcRenderer.invoke('pickOpen'),
  pickSave: (name, bytes) => ipcRenderer.invoke('pickSave', name, bytes),
  onOpenRequest: (cb) => {
    ipcRenderer.removeAllListeners('open-request');
    ipcRenderer.on('open-request', (_e, f) => cb(f));
    ipcRenderer.send('ready');
  },
  setDirty: (d) => ipcRenderer.send('setDirty', !!d),
  setTitle: (t) => ipcRenderer.send('setTitle', String(t)),
  reveal: (h) => ipcRenderer.send('reveal', h || null),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
});
