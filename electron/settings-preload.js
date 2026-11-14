const { contextBridge, ipcRenderer } = require('electron');

// macOS 上窗口隐藏了系统标题栏，主进程会带上这个参数（见 platform-policy.js）。
// 给 <html> 打上 chrome-inset，样式表据此让出红绿灯的位置、标出可拖动区域。
// 窗口在页面加载完成后才显示，DOMContentLoaded 时加上不会闪一下。
// 参数名与 platform-policy.js 的 INSET_CHROME_ARGUMENT 保持一致：沙箱里的
// preload 只能 require('electron')，不能引用那个模块。
if (process.argv.includes('--workstation-inset-chrome')) {
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('chrome-inset');
  });
}

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
  syncNow: () => invoke('settings:sync-now'),
  abortGitOperation: () => invoke('settings:abort-git-operation'),
  listGitConflicts: () => invoke('settings:list-git-conflicts'),
  resolveGitConflicts: choices => invoke('settings:resolve-git-conflicts', choices),
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
