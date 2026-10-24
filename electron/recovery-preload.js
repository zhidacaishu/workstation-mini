const { contextBridge, ipcRenderer } = require('electron');

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
