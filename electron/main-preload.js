const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, value) => ipcRenderer.invoke(channel, value).catch(error => {
  throw new Error(String(error.message).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''));
});
contextBridge.exposeInMainWorld('workstationDesktop', {
  confirmLeave: () => ipcRenderer.sendSync('workstation:confirm-leave'),
  getGuide: () => invoke('guide:get'),
  saveGuide: state => invoke('guide:save', state),
  openSettings: () => invoke('guide:settings')
});
