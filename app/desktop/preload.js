// 앱 화면(app/shell/platform.js)이 쓰는 window.nativeBridge. 메인 창 최상위 문서에만 들어간다.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nativeBridge', {
  platform: process.platform === 'win32' ? 'windows' : 'linux',
  pickOpen: () => ipcRenderer.invoke('pickOpen'),
  read: (handle) => ipcRenderer.invoke('read', handle),
  write: (handle, bytes) => ipcRenderer.invoke('write', handle, bytes),
  pickSave: (name, bytes) => ipcRenderer.invoke('pickSave', name, bytes),
  onOpenRequest: (cb) => {
    ipcRenderer.on('open-request', (_e, f) => cb(f));
    ipcRenderer.send('ready');
  },
  setDirty: (d) => ipcRenderer.send('setDirty', !!d),
  setTitle: (t) => ipcRenderer.send('setTitle', String(t)),
  showInFolder: (h) => ipcRenderer.send('showInFolder', h),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
});
