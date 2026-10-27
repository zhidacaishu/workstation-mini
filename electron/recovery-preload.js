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

const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch(error => {
    const message = String(error?.message ?? error).replace(REMOTE_ERROR_PREFIX, '');
    throw new Error(message || '操作失败。');
  });
}

contextBridge.exposeInMainWorld('workstationRecovery', {
  getState: () => invoke('recovery:get-state'),
  chooseLocalSource: () => invoke('recovery:choose-local-source'),
  chooseDestinationParent: () => invoke('recovery:choose-destination-parent'),
  inspectRemote: remote => invoke('recovery:inspect-remote', remote),
  beginRestore: () => invoke('recovery:begin-restore'),
  start: options => invoke('recovery:start', options),
  cancel: () => invoke('recovery:cancel'),
  retryStage: () => invoke('recovery:retry-stage'),
  activate: () => invoke('recovery:activate'),
  discardOwnedStaging: () => invoke('recovery:discard-owned-staging'),
  openCurrentVault: () => invoke('recovery:open-current-vault'),
  createVault: () => invoke('recovery:create-vault'),
  openExistingVault: () => invoke('recovery:open-existing-vault'),
  onStateChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('recovery:state-changed', listener);
    return () => ipcRenderer.removeListener('recovery:state-changed', listener);
  }
});
