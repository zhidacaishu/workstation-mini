const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fs = require('node:fs');

const { createPlatformPolicy, INSET_CHROME_ARGUMENT } = require('../electron/platform-policy');

function fakeApp() {
  const calls = [];
  return {
    calls,
    isPackaged: false,
    getAppPath: () => '/repo',
    dock: { setIcon(value) { calls.push(['dock-icon', value]); } },
    setAppUserModelId(value) { calls.push(['app-id', value]); },
    setLoginItemSettings(value) { calls.push(['login', value]); }
  };
}

function findItem(items, id) {
  for (const item of items) {
    if (item.id === id) return item;
    const submenu = Array.isArray(item.submenu) ? item.submenu : [];
    const found = findItem(submenu, id);
    if (found) return found;
  }
  return null;
}

test('Windows 平台保留 AppUserModelID、登录启动与隐藏启动语义', () => {
  const policy = createPlatformPolicy({ platform: 'win32' });
  const app = fakeApp();

  assert.equal(app.calls.length, 0);
  assert.equal(require('../package.json').build.appId, 'com.research.workstation-mini');
  assert.equal(policy.restoreOnActivate, false);
  assert.deepEqual(policy.capabilities, { launchAtLogin: true });
  policy.initializeApp(app);
  assert.equal(policy.applyLoginItem(app, true, {
    isPackaged: false,
    executablePath: 'C:\\Electron.exe',
    appPath: 'C:\\repo'
  }), true);
  assert.deepEqual(app.calls, [
    ['app-id', 'com.research.workstation-mini'],
    ['login', {
      openAtLogin: true,
      path: 'C:\\Electron.exe',
      args: ['C:\\repo', '--hidden']
    }]
  ]);
  assert.equal(policy.isHiddenStartup(['electron', '--hidden']), true);
  assert.deepEqual(policy.trayResource({
    isPackaged: true,
    resourcesPath: 'C:\\resources',
    projectDir: 'C:\\repo'
  }), {
    path: path.join('C:\\resources', 'tray.png'),
    template: false,
    revealOnClick: true
  });
});

test('macOS 平台不调用 Windows API，并使用 template status item', () => {
  const policy = createPlatformPolicy({ platform: 'darwin' });
  const app = fakeApp();

  assert.equal(policy.restoreOnActivate, true);
  assert.deepEqual(policy.capabilities, { launchAtLogin: false });
  policy.initializeApp(app);
  assert.equal(policy.applyLoginItem(app, true), false);
  assert.deepEqual(app.calls, [['dock-icon', path.join('/repo', 'build', 'icon.png')]]);
  app.calls.length = 0;
  app.isPackaged = true;
  policy.initializeApp(app);
  assert.deepEqual(app.calls, []);
  assert.equal(policy.isHiddenStartup(['app', '--hidden']), false);
  assert.deepEqual(policy.trayResource({
    isPackaged: false,
    resourcesPath: '/Applications/App.app/Contents/Resources',
    projectDir: '/repo'
  }), {
    path: path.join('/repo', 'build', 'trayTemplate.png'),
    template: true,
    revealOnClick: false
  });
});

test('所有平台的开发和安装版窗口都使用现有应用图标', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const policy = createPlatformPolicy({ platform });
    const name = platform === 'win32' ? 'icon.ico' : 'icon.png';
    assert.equal(policy.windowIcon({ isPackaged: false, projectDir: '/repo', resourcesPath: '/resources' }), path.join('/repo', 'build', name));
    assert.equal(policy.windowIcon({ isPackaged: true, projectDir: '/repo', resourcesPath: '/resources' }), path.join('/resources', name));
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const windows = main.match(/new BrowserWindow\(\{[\s\S]*?\n\s*\}\);/g) || [];
  assert.equal(windows.length, 3);
  assert.ok(windows.every(source => source.includes('icon: WINDOW_ICON')), '主窗口、设置、恢复均指定图标');
});

test('Windows 菜单保持共享动作', () => {
  const policy = createPlatformPolicy({ platform: 'win32' });
  const actions = [{ id: 'show-settings', label: '设置' }, { id: 'quit-application', label: '退出' }];
  const template = policy.applicationMenuTemplate({ actionItems: actions });

  assert.equal(template[0].label, '科研工作台');
  assert.equal(template[0].submenu, actions);
  assert.equal(template[1].label, '编辑');
});

test('macOS 菜单使用标准角色，并让 Settings 与 Quit 委托共享回调', () => {
  const policy = createPlatformPolicy({ platform: 'darwin' });
  let settingsCalls = 0;
  let quitCalls = 0;
  const template = policy.applicationMenuTemplate({
    actionItems: [
      { id: 'show-main', label: '显示科研工作台' },
      { id: 'show-settings', label: '设置' },
      { type: 'separator' },
      { id: 'launch-at-login', label: '不应出现' },
      { id: 'quit-application', label: '退出' }
    ],
    showSettings: () => { settingsCalls += 1; },
    quitApplication: () => { quitCalls += 1; }
  });

  assert.equal(template[0].submenu.some(item => item.role === 'about'), true);
  const windowMenu = template.find(item => item.role === 'windowMenu');
  assert.ok(windowMenu);
  // 给了 submenu，Electron 就不会再补默认 windowMenu 的内容。close 必须自己列出来，
  // 否则 macOS 上 ⌘W 完全没反应 —— 而关窗（隐藏到菜单栏）是这个应用的高频动作。
  assert.equal(windowMenu.submenu.some(item => item.role === 'close'), true);
  assert.equal(windowMenu.submenu.some(item => item.role === 'minimize'), true);
  assert.equal(findItem(template, 'launch-at-login'), null);
  const settings = findItem(template, 'show-settings');
  const quit = findItem(template, 'quit-application');
  assert.equal(settings.accelerator, 'Command+,');
  assert.equal(quit.accelerator, 'Command+Q');
  settings.click();
  quit.click();
  assert.equal(settingsCalls, 1);
  assert.equal(quitCalls, 1);
});

test('只有 macOS 隐藏系统标题栏，红绿灯按各窗口侧栏定位；Windows 和 Linux 只收起菜单栏', () => {
  const mac = createPlatformPolicy({ platform: 'darwin' });
  assert.equal(mac.insetTitleBar, true);
  assert.deepEqual(mac.windowChrome('main'), { titleBarStyle: 'hidden', trafficLightPosition: { x: 8, y: 18 } });
  assert.deepEqual(mac.windowChrome('panel'), { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 18 } });
  // 每次给新对象：BrowserWindow 的选项不能共享同一个可变的坐标。
  assert.notEqual(mac.windowChrome('main').trafficLightPosition, mac.windowChrome('main').trafficLightPosition);

  for (const platform of ['win32', 'linux']) {
    const policy = createPlatformPolicy({ platform });
    assert.equal(policy.insetTitleBar, false);
    // 系统标题栏保留；菜单栏收起，按 Alt 出现。不用 removeMenu()：那样窗口里就打不开菜单了。
    for (const kind of ['main', 'panel']) {
      assert.deepEqual(policy.windowChrome(kind), { autoHideMenuBar: true });
    }
  }
});

test('设置和恢复窗口的 preload 认主进程传入的标题栏参数', () => {
  // 沙箱里的 preload 不能 require 这个模块，参数名只能写成字面量，这里防止两边改岔。
  for (const file of ['settings-preload.js', 'recovery-preload.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8');
    assert.ok(source.includes(`process.argv.includes('${INSET_CHROME_ARGUMENT}')`), `${file} 没有认 ${INSET_CHROME_ARGUMENT}`);
  }
});
