const { contextBridge, ipcRenderer } = require('electron');

// Electron 会把主进程抛出的错误包成
// `Error invoking remote method 'settings:save': Error: 资料库必须是绝对路径。`
// 设置页面是直接把 message 显示给人看的，这层壳得剥掉，
// 否则每一条精心写过的校验提示都要带着一串英文前缀出现。
const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch(error => {
    const message = String(error?.message ?? error).replace(REMOTE_ERROR_PREFIX, '');
    throw new Error(message || '操作失败。');
  });
}

contextBridge.exposeInMainWorld('workstationSettings', {
  get: () => invoke('settings:get'),
  save: update => invoke('settings:save', update),
  chooseDirectory: field => invoke('settings:choose-directory', field),
  chooseFile: field => invoke('settings:choose-file', field),
  syncNow: () => invoke('settings:sync-now'),
  abortGitOperation: () => invoke('settings:abort-git-operation'),
  openVault: () => invoke('settings:open-vault'),
  openConfigDirectory: () => invoke('settings:open-config-directory'),
  openRecovery: mode => invoke('settings:open-recovery', mode),
  onChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
  onSyncStatusChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('sync-status:changed', listener);
    return () => ipcRenderer.removeListener('sync-status:changed', listener);
  }
});
