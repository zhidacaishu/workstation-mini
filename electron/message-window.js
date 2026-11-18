const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, nativeTheme, screen } = require('electron');

const openMessages = new Map();

function focusMessage(parent) {
  const window = parent ? openMessages.get(parent) : openMessages.values().next().value;
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (window.isVisible()) window.focus();
  return true;
}

// 启动时可能没有主窗口；beforeunload 和页面卡死时也必须由独立的渲染进程接收选择。
async function showAppMessage(parent, options) {
  const { title = '科研工作台', cancelId = 0 } = options;
  if (parent?.isDestroyed() || openMessages.has(parent)) return cancelId;
  const bounds = parent?.getBounds();
  const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const width = Math.min(460, display.workArea.width);
  const maxHeight = Math.min(540, display.workArea.height);
  const window = new BrowserWindow({
    parent: parent || undefined, modal: Boolean(parent), show: false, frame: false,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    width, height: maxHeight, useContentSize: true, title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191d22' : '#ffffff',
    webPreferences: { partition: 'workstation-messages', sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  openMessages.set(parent, window);
  window.setMenu(null);
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  const closed = new Promise(resolve => {
    window.once('closed', () => resolve(cancelId));
    contents.once('render-process-gone', () => resolve(cancelId));
  });
  const closeWithParent = () => { if (!window.isDestroyed()) window.destroy(); };
  parent?.once('closed', closeWithParent);
  async function present() {
    await window.loadURL(pathToFileURL(path.join(__dirname, 'message.html')).href);
    // 在显示前铺好内容并按实际文字高度调整窗口，长路径和长错误可在窗内滚动。
    await contents.executeJavaScript(`window.messageAnswer = window.workstationDialog.ask(${JSON.stringify(options)}); void 0`);
    const height = await contents.executeJavaScript('document.fonts.ready.then(() => Math.ceil(document.querySelector("dialog").getBoundingClientRect().height))');
    window.setContentSize(width, Math.min(maxHeight, height));
    window.center();
    if (bounds) {
      const area = display.workArea;
      const x = Math.round(bounds.x + (bounds.width - width) / 2);
      const y = Math.round(bounds.y + (bounds.height - height) / 2);
      window.setPosition(Math.max(area.x, Math.min(x, area.x + area.width - width)), Math.max(area.y, Math.min(y, area.y + area.height - height)));
    }
    window.show();
    return contents.executeJavaScript('window.messageAnswer');
  }
  try {
    return await Promise.race([closed, present()]);
  } finally {
    parent?.removeListener('closed', closeWithParent);
    openMessages.delete(parent);
    if (!window.isDestroyed()) window.destroy();
  }
}

module.exports = { showAppMessage, focusMessage };
