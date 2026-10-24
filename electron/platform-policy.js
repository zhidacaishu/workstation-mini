const path = require('node:path');

const EDIT_MENU = {
  label: '编辑',
  submenu: [
    { role: 'undo', label: '撤销' },
    { role: 'redo', label: '重做' },
    { type: 'separator' },
    { role: 'cut', label: '剪切' },
    { role: 'copy', label: '复制' },
    { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' }
  ]
};

function createPlatformPolicy({
  platform = process.platform,
  appId = 'com.research.workstation',
  productName = '科研工作台'
} = {}) {
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  const capabilities = Object.freeze({ launchAtLogin: isWindows });

  function initializeApp(app) {
    if (isWindows) app.setAppUserModelId(appId);
  }

  function applyLoginItem(app, enabled, {
    isPackaged = app.isPackaged,
    executablePath = process.execPath,
    appPath = app.getAppPath(),
    isTestRun = false
  } = {}) {
    if (!capabilities.launchAtLogin || isTestRun) return false;
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: executablePath,
      args: isPackaged ? ['--hidden'] : [appPath, '--hidden']
    });
    return true;
  }

  function isHiddenStartup(argv = process.argv) {
    return isWindows && argv.includes('--hidden');
  }

  function trayResource({ isPackaged, resourcesPath, projectDir }) {
    const name = isMac ? 'trayTemplate.png' : 'tray.png';
    return Object.freeze({
      path: isPackaged ? path.join(resourcesPath, name) : path.join(projectDir, 'build', name),
      template: isMac,
      revealOnClick: isWindows
    });
  }

  function applicationMenuTemplate({ actionItems, showSettings, quitApplication }) {
    if (!isMac) {
      return [
        { label: productName, submenu: actionItems },
        EDIT_MENU
      ];
    }

    const appMenuItemIds = new Set([
      'show-settings', 'quit-application', 'launch-at-login'
    ]);
    const workspaceItems = actionItems.filter(item => !appMenuItemIds.has(item.id));
    while (workspaceItems.at(-1)?.type === 'separator') workspaceItems.pop();

    return [
      {
        label: productName,
        submenu: [
          { role: 'about', label: `关于${productName}` },
          { type: 'separator' },
          { id: 'show-settings', label: '设置…', accelerator: 'Command+,', click: showSettings },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: `隐藏${productName}` },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          {
            id: 'quit-application',
            label: `退出${productName}`,
            accelerator: 'Command+Q',
            click: quitApplication
          }
        ]
      },
      { label: '工作台', submenu: workspaceItems },
      EDIT_MENU,
      {
        id: 'window-menu',
        role: 'windowMenu',
        label: '窗口',
        // 给了 submenu，Electron 就用这一份，**不会**再补上默认 windowMenu 的内容。
        // 所以 close 必须自己写出来：少了它，macOS 上 ⌘W 完全没有响应，而关窗
        // （= 隐藏到菜单栏）正是这个应用最高频的动作之一。主窗口的 close 事件
        // 已经是 preventDefault + hide，设置窗口则正常关闭。
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { id: 'close-window', role: 'close', label: '关闭窗口' },
          { type: 'separator' },
          { role: 'front', label: '前置全部窗口' }
        ]
      }
    ];
  }

  return Object.freeze({
    platform,
    restoreOnActivate: isMac,
    capabilities,
    initializeApp,
    applyLoginItem,
    isHiddenStartup,
    trayResource,
    applicationMenuTemplate
  });
}

module.exports = { createPlatformPolicy };
