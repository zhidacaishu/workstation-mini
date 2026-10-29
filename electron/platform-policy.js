const path = require('node:path');

// 设置和恢复窗口的 preload 认这个参数（经 webPreferences.additionalArguments 传入）。
const INSET_CHROME_ARGUMENT = '--workstation-inset-chrome';

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

// 必须和安装器写进开始菜单、桌面快捷方式的 AppUserModelID 一致（electron-builder
// 取的是 package.json 的 build.appId）。不一致时，固定到任务栏的图标和运行中的窗口
// 会分成两个按钮；完整版装在同一台机器上时，两个应用的窗口反而会被合到一组。
// electron-builder removes build metadata from the packaged package.json.
const BUILD_APP_ID = 'com.research.workstation-mini';

function createPlatformPolicy({
  platform = process.platform,
  appId = BUILD_APP_ID,
  productName = '科研工作台'
} = {}) {
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  const capabilities = Object.freeze({ launchAtLogin: isWindows });

  function initializeApp(app) {
    if (isWindows) app.setAppUserModelId(appId);
    // 开发模式运行的是 Electron.app，打包配置不会替换它的 Dock 图标。
    if (isMac && !app.isPackaged) {
      app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
    }
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

  // macOS 的系统标题栏是一条和界面无关的灰条，压在侧栏和正文上面很突兀。
  // 这里把它藏起来，红绿灯直接落在侧栏顶部，界面一直画到窗口最上沿；
  // 拖动窗口、双击缩放交给页面里标了 -webkit-app-region: drag 的区域。
  // 页面靠 html.chrome-inset 知道要给红绿灯让位：主窗口由服务端按运行时配置
  // 输出（runtime-config 的 windowChrome），设置和恢复窗口由 preload 按
  // INSET_CHROME_ARGUMENT 加上。
  // 横坐标按各自侧栏算：主窗口侧栏 76px，三颗按钮占 52px，x=12 正好居中；
  // 设置和恢复窗口与侧栏里标记的左边缘对齐。
  const insetTitleBar = isMac;
  const TRAFFIC_LIGHTS = { main: { x: 12, y: 18 }, panel: { x: 18, y: 18 } };

  function windowChrome(kind = 'panel') {
    if (!insetTitleBar) return {};
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { ...(TRAFFIC_LIGHTS[kind] || TRAFFIC_LIGHTS.panel) }
    };
  }

  return Object.freeze({
    platform,
    restoreOnActivate: isMac,
    insetTitleBar,
    windowChrome,
    capabilities,
    initializeApp,
    applyLoginItem,
    isHiddenStartup,
    trayResource,
    applicationMenuTemplate
  });
}

module.exports = { createPlatformPolicy, INSET_CHROME_ARGUMENT };
