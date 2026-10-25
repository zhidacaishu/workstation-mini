const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  nativeImage
} = require('electron');

const { createConfigStore } = require('./config-store');
const { createRuntimeConfig } = require('./runtime-config');
const { validateSettingsUpdate } = require('./settings-validation');
const { resolveVaultDir } = require('./vault-resolution');
const { createQuitCoordinator, windowVetoesUnload } = require('./quit-coordinator');
const { createPlatformPolicy } = require('./platform-policy');
const {
  validateRecoveryMode,
  validateRecoveryStart
} = require('./recovery-validation');
const { activateRecoveredVault } = require('./recovery-activation');
const { normalizedDocumentUrl, isTrustedMainFrameSender } = require('./trusted-sender');
const { startRuntime } = require('../src/runtime');
const { defaultVaultDir } = require('../src/config');
const { createRecoveryJournal } = require('../src/recovery/journal');
const { createRecoveryService, validateVaultRoot } = require('../src/recovery/service');

const SETTINGS_FILE = path.join(__dirname, 'settings', 'index.html');
const SETTINGS_URL = pathToFileURL(SETTINGS_FILE).href;
const PRELOAD_FILE = path.join(__dirname, 'settings-preload.js');
const RECOVERY_FILE = path.join(__dirname, 'recovery', 'index.html');
const RECOVERY_URL = pathToFileURL(RECOVERY_FILE).href;
const RECOVERY_PRELOAD_FILE = path.join(__dirname, 'recovery-preload.js');
const DIRECTORY_FIELDS = new Set(['vaultDir']);
const RECOVERY_SWITCHABLE_PHASES = new Set(['idle', 'cancelled', 'completed', 'failed']);
const platformPolicy = createPlatformPolicy();
const { capabilities } = platformPolicy;

// 窗口底色是渲染进程画出第一帧之前、以及缩放窗口时新暴露区域露出的颜色。
// 界面本身支持 prefers-color-scheme，写死浅色的话深色模式下拖拽缩放会闪白边。
// 取值和 styles.css / settings.css 里的 --canvas 保持一致。
const WINDOW_BACKGROUND = { light: '#f4f5f7', dark: '#0c0e11' };

function windowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

// 外观设置交给 nativeTheme：它会改写所有窗口里的 prefers-color-scheme，
// 主窗口、设置和恢复的样式表无需各自再做一套切换逻辑。
const THEME_SOURCES = new Set(['system', 'light', 'dark']);

function applyThemeSetting() {
  nativeTheme.themeSource = THEME_SOURCES.has(settings?.theme) ? settings.theme : 'system';
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setBackgroundColor(windowBackgroundColor());
  }
}

function onlyThemeChanged(previous, next) {
  if (previous?.theme === next?.theme) return false;
  const { theme: _previousTheme, ...restPrevious } = previous || {};
  const { theme: _nextTheme, ...restNext } = next || {};
  return JSON.stringify(restPrevious) === JSON.stringify(restNext);
}

let configStore;
let settings;
let runtime;
let mainWindow;
let mainWindowPromise;
let settingsWindow;
let recoveryWindow;
let recoveryService;
let recoveryServiceFingerprint = '';
let recoveryResidueLoaded = false;
let unsubscribeRecoveryState = () => {};
let recoveryMode = 'restore';
let mainSession;
let tray;
let quitting = false;
let quitReady = false;
let quitCoordinator;
let revealOnReady = false;
let restartQueue = Promise.resolve();
let settingsRevision = 0;
let runtimeGeneration = 0;
let unsubscribeSyncStatus = () => {};

const testUserDataDir = process.argv.find(argument => argument.startsWith('--workstation-user-data='))
  ?.slice('--workstation-user-data='.length);
const isSmokeTest = process.argv.includes('--workstation-smoke-test');
const isTestRun = Boolean(
  isSmokeTest
  || (testUserDataDir && !app.isPackaged)
);
if (testUserDataDir && (!app.isPackaged || isSmokeTest)) {
  app.setPath('userData', path.resolve(testUserDataDir));
}

const gotLock = app.requestSingleInstanceLock();

function isSettingsDocumentUrl(value) {
  return normalizedDocumentUrl(value) === SETTINGS_URL;
}

function trustedSettingsSender(event) {
  return isTrustedMainFrameSender(event, settingsWindow, SETTINGS_URL);
}

function assertSettingsSender(event) {
  if (!trustedSettingsSender(event)) throw new Error('拒绝来自未知页面的设置请求。');
}

function isRecoveryDocumentUrl(value) {
  return normalizedDocumentUrl(value) === RECOVERY_URL;
}

function trustedRecoverySender(event) {
  return isTrustedMainFrameSender(event, recoveryWindow, RECOVERY_URL);
}

function assertRecoverySender(event) {
  if (!trustedRecoverySender(event)) throw new Error('拒绝来自未知页面的恢复请求。');
}

function notifyRecoveryStateChanged(state = recoveryService?.getState()) {
  if (state && recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.webContents.send('recovery:state-changed', state);
  }
}

function writeSettings(nextSettings) {
  settings = configStore.write(nextSettings);
  settingsRevision += 1;
  applyThemeSetting();
  return settings;
}

function runtimeState() {
  return {
    revision: settingsRevision,
    settings: configStore.publicSettings(settings),
    runtimeRunning: Boolean(runtime),
    syncStatus: runtime?.getSyncStatus() || {
      phase: settings?.syncEnabled ? 'idle' : 'disabled',
      operation: '',
      recovery: null,
      lastResult: null
    },
    capabilities: { ...capabilities }
  };
}

function notifySyncStatusChanged(status) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('sync-status:changed', status);
  }
}


function setRuntime(nextRuntime) {
  unsubscribeSyncStatus();
  unsubscribeSyncStatus = () => {};
  runtime = nextRuntime;
  const generation = ++runtimeGeneration;
  if (runtime) {
    unsubscribeSyncStatus = runtime.onSyncStatus(status => {
      if (generation !== runtimeGeneration || runtime !== nextRuntime) return;
      notifySyncStatusChanged(status);
      refreshMenus();
    });
  }
  notifySyncStatusChanged(runtimeState().syncStatus);
}

function notifySettingsChanged() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:changed');
  }
}

function applyLoginItemSetting() {
  platformPolicy.applyLoginItem(app, settings.launchAtLogin, { isTestRun });
}

// 下面两个函数只负责把决策渲染成原生对话框。「这次用哪个资料库」的判断
// 在 vault-resolution.js 里 —— 那边不依赖 Electron，因此能被回归测试盖住。
const VAULT_PROMPT_TITLES = {
  initial: '选择或创建科研工作台资料库',
  replace: '更换资料库'
};

async function promptForVaultDir(purpose) {
  const result = await dialog.showOpenDialog({
    title: VAULT_PROMPT_TITLES[purpose],
    defaultPath: settings.vaultDir || defaultVaultDir(),
    buttonLabel: '使用此目录',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? '' : result.filePaths[0];
}

async function askMissingVault(missingPath) {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '找不到资料库',
    message: `找不到资料库目录：\n${missingPath}`,
    detail: '移动硬盘、网络位置或云盘可能还没准备好。'
      + '已保存的路径不会被自动更改，除非你在这里另选一个目录。',
    buttons: ['重试', '选择其它目录', '从备份恢复', '退出'],
    defaultId: 0,
    cancelId: 3,
    noLink: true
  });
  return ['retry', 'choose', 'restore', 'quit'][response] || 'retry';
}

function chooseInitialVault() {
  return resolveVaultDir({
    savedVaultDir: settings.vaultDir,
    conventionalVaultDir: defaultVaultDir(),
    pathExists: target => fs.existsSync(target),
    askMissingVault,
    promptForDirectory: promptForVaultDir
  });
}

async function startConfiguredRuntime(nextSettings = settings) {
  const config = createRuntimeConfig(nextSettings, { isProduction: app.isPackaged });
  return startRuntime(config);
}

function attachInternalSession() {
  const partition = 'persist:workstation-main';
  if (!mainSession) {
    mainSession = session.fromPartition(partition);
    mainSession.webRequest.onBeforeSendHeaders((details, callback) => {
      for (const header of Object.keys(details.requestHeaders)) {
        if (header.toLowerCase() === 'x-workstation-internal-token') {
          delete details.requestHeaders[header];
        }
      }
      try {
        const target = new URL(details.url);
        if (runtime && target.origin === runtime.origin) {
          details.requestHeaders['x-workstation-internal-token'] = runtime.config.internalToken;
        }
      } catch {}
      callback({ requestHeaders: details.requestHeaders });
    });
  }
  return partition;
}

function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function openExternalUrl(url) {
  shell.openExternal(url).catch(showFatalError);
}

function secureMainWindow(window, origin) {
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) openExternalUrl(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
    } catch {}
    event.preventDefault();
    if (isExternalUrl(url)) openExternalUrl(url);
  });

  window.webContents.on('will-redirect', (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
    } catch {}
    event.preventDefault();
    if (isExternalUrl(url)) openExternalUrl(url);
  });
}

function secureSettingsWindow(window) {
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isSettingsDocumentUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', event => event.preventDefault());
}

function secureRecoveryWindow(window) {
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isRecoveryDocumentUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', event => event.preventDefault());
}

async function createMainWindow({ hidden = false, targetUrl = '' } = {}) {
  if (!runtime || quitting) return null;
  if (mainWindowPromise) {
    const window = await mainWindowPromise;
    if (window && !window.isDestroyed() && targetUrl && window.webContents.getURL() !== targetUrl) {
      await window.loadURL(targetUrl);
    }
    return window;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (targetUrl && mainWindow.webContents.getURL() !== targetUrl) await mainWindow.loadURL(targetUrl);
    return mainWindow;
  }

  const runtimeAtCreation = runtime;
  mainWindowPromise = (async () => {
    const partition = attachInternalSession();
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 620,
      show: false,
      title: '科研工作台',
      backgroundColor: windowBackgroundColor(),
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    mainWindow = window;
    secureMainWindow(window, runtimeAtCreation.origin);
    window.on('close', event => {
      if (quitCoordinator?.isAccepted()) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null;
    });
    window.on('focus', () => {
      if (quitting) return;
      runtime?.rescan().catch(error => console.warn(`[index] 聚焦重扫失败：${error.message}`));
    });

    try {
      await window.loadURL(targetUrl || runtimeAtCreation.origin);
      if (!hidden && !quitting) window.show();
      return window;
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  })();

  try {
    return await mainWindowPromise;
  } finally {
    mainWindowPromise = null;
  }
}

function showMainWindow(targetUrl = '') {
  // 这个函数直接挂在托盘的 click/double-click 和「显示科研工作台」菜单项上，
  // 而 Electron 给这两种回调的第一个参数是 KeyboardEvent 和 MenuItem，不是字符串。
  // 原样传下去，createMainWindow 会拿它去 loadURL，Electron 抛
  // 「conversion failure from」TypeError，再被 showFatalError 变成一个模态错误框 ——
  // 主进程从此卡在那个框上。表现就是「点托盘图标窗口不出来，还弹个看不懂的错」，
  // 而托盘恰恰是关掉窗口（关闭 = 隐藏）之后唯一能把它唤回来的入口。
  // 只认字符串，其余一律当成「没有指定目标地址」。
  const url = typeof targetUrl === 'string' ? targetUrl : '';
  if (quitting) return Promise.resolve(null);
  if ((!mainWindow || mainWindow.isDestroyed()) && !runtime) {
    const fallback = recoveryWindow && !recoveryWindow.isDestroyed()
      ? recoveryWindow
      : settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
    if (fallback) {
      fallback.show();
      fallback.focus();
    } else {
      revealOnReady = true;
    }
    return Promise.resolve(fallback);
  }

  return createMainWindow({ targetUrl: url }).then(window => {
    if (!window || window.isDestroyed() || quitting) return null;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }).catch(error => {
    showFatalError(error);
    return null;
  });
}

function createTray() {
  const trayPolicy = platformPolicy.trayResource({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectDir: path.join(__dirname, '..')
  });
  const icon = nativeImage.createFromPath(trayPolicy.path);
  if (icon.isEmpty()) throw new Error(`无法加载托盘图标：${trayPolicy.path}`);
  if (trayPolicy.template) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('科研工作台');
  if (trayPolicy.revealOnClick) {
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  }
  refreshMenus();
}

function openVault() {
  if (!settings.vaultDir) return;
  shell.openPath(settings.vaultDir).then(error => {
    if (error) showFatalError(new Error(error));
  }).catch(showFatalError);
}

function dialogParent() {
  const focused = BrowserWindow.getFocusedWindow?.();
  if (focused && !focused.isDestroyed() && focused.isVisible()) return focused;
  return [settingsWindow, recoveryWindow, mainWindow]
    .find(window => window && !window.isDestroyed() && window.isVisible()) || null;
}

function syncRecoveryLabel(recovery) {
  const labels = { rebase: 'rebase', merge: 'merge', 'cherry-pick': 'cherry-pick', revert: 'revert', unmerged: '未合并文件' };
  return labels[recovery?.kind] || 'Git';
}

async function confirmAndAbortGitOperation() {
  if (!runtime) throw new Error('工作台尚未启动。');
  const status = runtime.getSyncStatus();
  const recovery = status.recovery;
  if (!recovery) return { ok: true, skipped: '没有需要恢复的 Git 操作' };
  if (!recovery.abortable) throw new Error('当前只有未合并文件，无法安全自动中止；请用 Git 工具手工处理。');
  const options = {
    type: 'warning',
    title: `中止 Git ${syncRecoveryLabel(recovery)}`,
    message: `确认中止当前 ${syncRecoveryLabel(recovery)} 操作？`,
    detail: 'Git 将尝试恢复到该操作开始前的状态。本地工作台不会自动重新同步；请检查资料库后手动同步。',
    buttons: ['取消', '确认中止'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const parent = dialogParent();
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (response !== 1) return { cancelled: true };
  return runtime.abortGitOperation();
}

function actionMenuItems({ includeShow = true } = {}) {
  const syncStatus = runtime?.getSyncStatus();
  const recovery = syncStatus?.recovery;
  const syncBusy = syncStatus?.phase === 'running';
  return [
    ...(includeShow ? [{ id: 'show-main', label: '显示科研工作台', click: showMainWindow }] : []),
    { id: 'show-settings', label: '设置', click: showSettingsWindow },
    { type: 'separator' },
    ...(recovery ? [{ id: 'sync-status', label: `Git 需要恢复：${syncRecoveryLabel(recovery)}`, enabled: false }] : []),
    { id: 'sync-now', label: syncBusy ? '正在同步…' : '立即同步', enabled: Boolean(runtime && settings.syncEnabled && !syncBusy && !recovery), click: () => runtime?.syncNow().catch(showFatalError) },
    ...(recovery?.abortable ? [{ id: 'abort-git-operation', label: '中止当前 Git 操作…', click: () => confirmAndAbortGitOperation().catch(showFatalError) }] : []),
    { id: 'open-vault', label: '打开资料库', enabled: Boolean(settings.vaultDir), click: openVault },
    { id: 'change-vault', label: '更换资料库', click: () => chooseAndSaveVault().catch(showFatalError) },
    { type: 'separator' },
    ...(capabilities.launchAtLogin ? [
      {
        id: 'launch-at-login',
        label: '登录 Windows 后启动',
        type: 'checkbox',
        checked: Boolean(settings.launchAtLogin),
        click: item => updateLaunchAtLogin(item.checked)
      },
      { type: 'separator' }
    ] : []),
    { id: 'quit-application', label: '退出', click: quitApplication }
  ];
}

/**
 * 菜单的可见状态签名。
 *
 * refreshMenus 被同步状态的每一次变化触发，而一轮同步会连着推好几个状态。
 * 每次都无条件 setApplicationMenu 的话，macOS 上用户正拉开的菜单栏菜单会被
 * 强行关掉。绝大多数这类事件并不改变菜单的样子，所以先算一个签名，真变了才重建。
 * click 回调不进签名 —— 它们是稳定的模块级函数。动作项目前都是平铺的，
 * 没有嵌套 submenu，所以一层就够；以后真加了嵌套，这里要跟着往下走一层。
 */
function menuSignature(items) {
  return JSON.stringify(items.map(item => [
    item.id || '', item.type || '', item.label || '',
    item.enabled !== false, Boolean(item.checked)
  ]));
}

let lastMenuSignature = '';

function refreshMenus() {
  // 退出已经开始时托盘菜单是进度提示。此刻还可能有一次设置重启没跑完
  // （quitApplication 会等它），别让它把提示覆盖回可点的菜单。
  if (quitting) return;
  const items = actionMenuItems();

  // 托盘菜单每次都重挂：托盘可能是刚建出来的，此刻还没有任何 context menu，
  // 而签名很可能和建托盘之前的某次刷新一致（更新器在那之前就会推状态）。
  // 放进去重分支里，就会出现「托盘菜单永远是空的」这种只在特定时序下发生的故障。
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(items));

  // 应用菜单才是需要去重的那个：它是全局的，重设一次就会把用户正拉开的
  // macOS 菜单栏菜单关掉，而 setApplicationMenu 本身幂等，跳过完全安全。
  const signature = menuSignature(items);
  if (signature === lastMenuSignature) return;
  lastMenuSignature = signature;

  const template = platformPolicy.applicationMenuTemplate({
    actionItems: actionMenuItems(),
    showSettings: showSettingsWindow,
    quitApplication
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function publicRecoveryState(state = recoveryService?.getState()) {
  if (!state) return { phase: 'idle', mode: recoveryMode };
  return {
    ...state,
    mode: RECOVERY_SWITCHABLE_PHASES.has(state.phase) ? recoveryMode : state.mode,
    canOpenCurrentVault: state.phase === 'residue'
      && state.residue?.owned !== true
      && Boolean(settings?.vaultDir && fs.existsSync(settings.vaultDir))
  };
}

function recoveryFingerprint(mode) {
  return JSON.stringify({ mode, vaultDir: settings.vaultDir });
}

function resetRecoveryService(mode) {
  const validatedMode = validateRecoveryMode(mode);
  unsubscribeRecoveryState();
  const journal = createRecoveryJournal({
    journalPath: path.join(configStore.directory, 'recovery-session.json')
  });
  recoveryServiceFingerprint = recoveryFingerprint(validatedMode);
  recoveryService = createRecoveryService({ journal, mode: 'restore' });
  recoveryResidueLoaded = false;
  unsubscribeRecoveryState = recoveryService.onState(notifyRecoveryStateChanged);
  return recoveryService;
}
function ensureRecoveryService(mode) {
  const state = recoveryService?.getState();
  const fingerprintChanged = recoveryServiceFingerprint !== recoveryFingerprint(mode);
  const reusable = recoveryService
    && !fingerprintChanged
    && mode === recoveryMode
    && !['completed', 'failed'].includes(state.phase);
  if (!reusable) {
    if (state && !RECOVERY_SWITCHABLE_PHASES.has(state.phase)) {
      throw new Error('请先完成或取消当前恢复操作。');
    }
    resetRecoveryService(mode);
  }
  return recoveryService;
}

async function showRecoveryWindow(mode = 'restore') {
  if (quitting) return;
  validateRecoveryMode(mode);
  const service = ensureRecoveryService(mode);
  if (mode !== recoveryMode && !RECOVERY_SWITCHABLE_PHASES.has(service.getState().phase)) {
    throw new Error('请先完成或取消当前恢复操作。');
  }
  recoveryMode = mode;
  if (!recoveryResidueLoaded) {
    await service.loadResidue();
    recoveryResidueLoaded = true;
  }
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    notifyRecoveryStateChanged(publicRecoveryState());
    if (recoveryWindow.isMinimized()) recoveryWindow.restore();
    recoveryWindow.show();
    recoveryWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: '恢复科研工作台资料库',
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      preload: RECOVERY_PRELOAD_FILE,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  recoveryWindow = window;
  secureRecoveryWindow(window);
  window.on('close', event => {
    if (quitCoordinator?.isAccepted()) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    if (recoveryWindow === window) recoveryWindow = null;
  });
  window.loadFile(RECOVERY_FILE)
    .then(() => {
      notifyRecoveryStateChanged(publicRecoveryState());
      window.show();
    })
    .catch(error => {
      if (!window.isDestroyed()) window.destroy();
      showFatalError(error);
    });
}

function showSettingsWindow() {
  if (quitting) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: '科研工作台设置',
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      preload: PRELOAD_FILE,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  settingsWindow = window;
  secureSettingsWindow(window);
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  window.loadFile(SETTINGS_FILE)
    .then(() => window.show())
    .catch(error => {
      if (!window.isDestroyed()) window.destroy();
      showFatalError(error);
    });
}

function destroyMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
}

async function canReplaceRuntime() {
  if (mainWindowPromise) await mainWindowPromise.catch(() => {});
  if (!await windowVetoesUnload(mainWindow)) return true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  return false;
}

async function replaceRuntime(nextSettings, previousSettings, { unloadChecked = false } = {}) {
  if (!unloadChecked && !await canReplaceRuntime()) {
    return { cancelled: true, reason: '主窗口有未保存的编辑或附件任务。' };
  }
  const previousRuntime = runtime;
  const showMainAfterRestart = !previousRuntime
    || Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  let candidateRuntime;
  setRuntime(null);

  try {
    if (previousRuntime) {
      // 旧运行时没收干净，不该把一份合法的新配置连坐掉：服务已经不再接受请求，
      // 新运行时用的又是另一个随机端口，剩下的只是清理失败，记一条日志就够。
      try {
        await previousRuntime.stop({ finalSync: false });
      } catch (error) {
        console.error(error);
      }
    }
    destroyMainWindow();
    candidateRuntime = await startConfiguredRuntime(nextSettings);
    writeSettings(nextSettings);
    applyLoginItemSetting();
    setRuntime(candidateRuntime);
    candidateRuntime = null;
    await createMainWindow({ hidden: !showMainAfterRestart });
    refreshMenus();
    notifySettingsChanged();
    return runtimeState();
  } catch (error) {
    try { await candidateRuntime?.stop({ finalSync: false }); } catch {}
    try { await runtime?.stop({ finalSync: false }); } catch {}
    setRuntime(null);
    destroyMainWindow();

    const rollbackErrors = [];
    try {
      writeSettings(previousSettings);
    } catch (rollbackError) {
      settings = previousSettings;
      rollbackErrors.push(rollbackError);
    }
    try {
      applyLoginItemSetting();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      const restoredRuntime = previousRuntime ? await startConfiguredRuntime(previousSettings) : null;
      setRuntime(restoredRuntime);
      if (runtime) await createMainWindow({ hidden: !showMainAfterRestart });
    } catch (rollbackError) {
      try { await runtime?.stop(); } catch {}
      setRuntime(null);
      rollbackErrors.push(rollbackError);
    }

    if (rollbackErrors.length > 0) {
      error.message += `；恢复旧设置也失败：${rollbackErrors.map(item => item.message).join('；')}`;
    }
    refreshMenus();
    throw error;
  }
}

function enqueueRestart(operation) {
  if (quitting) return Promise.reject(new Error('应用正在退出。'));
  const result = restartQueue.then(operation);
  restartQueue = result.catch(() => {});
  return result;
}

async function chooseAndSaveVault() {
  const vaultDir = await promptForVaultDir('replace');
  if (!vaultDir) return;
  await enqueueRestart(() => {
    const previous = settings;
    const next = { ...settings, vaultDir };
    return replaceRuntime(next, previous);
  });
  showMainWindow();
}

function updateLaunchAtLogin(enabled) {
  return enqueueRestart(async () => {
    const previous = settings;
    try {
      platformPolicy.applyLoginItem(app, enabled, { isTestRun });
      writeSettings({ ...settings, launchAtLogin: enabled });
      refreshMenus();
      notifySettingsChanged();
    } catch (error) {
      settings = previous;
      try { applyLoginItemSetting(); } catch {}
      refreshMenus();
      throw error;
    }
  }).catch(showFatalError);
}

/**
 * 退出要走完最后一次提交推送，可能要好几秒。窗口这时已经收起来了，
 * 托盘图标是唯一还看得见的东西 —— 让它说清楚应用在忙，
 * 否则用户只会认为程序卡死然后去强杀，把收尾工作打断在半路。
 */
function showQuitProgress() {
  const template = [{ label: '正在退出，请稍候…', enabled: false }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  lastMenuSignature = '';
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip('科研工作台（正在退出，保存并同步中…）');
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function finishQuit() {
  quitting = true;
  mainWindow?.hide();
  settingsWindow?.hide();
  recoveryWindow?.hide();
  showQuitProgress();

  // 定时检查停掉，但不动 autoInstallOnAppQuit：更新的安装要留到最后，
  // 由 Electron 的 quit 事件触发 —— 那时 runtime.stop() 已经跑完，
  // 最后一次提交推送不会被安装器打断。
  const recoveryState = recoveryService?.getState();
  if (recoveryState?.canCancel) await recoveryService.cancel().catch(error => console.error(error));
  await recoveryService?.idle();
  await restartQueue;
  try {
    await runtime?.stop();
  } catch (error) {
    console.error(error);
  }
  destroyMainWindow();
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  settingsWindow = null;
  if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.destroy();
  recoveryWindow = null;
  unsubscribeRecoveryState();
  unsubscribeRecoveryState = () => {};
  tray?.destroy();
  tray = null;
  quitReady = true;
  app.quit();
  return { ok: true };
}

function quitApplication() {
  return quitCoordinator.request();
}

function showFatalError(error) {
  console.error(error);
  dialog.showErrorBox('科研工作台', error.message || String(error));
}

function registerIpc() {
  ipcMain.handle('settings:get', event => {
    assertSettingsSender(event);
    return runtimeState();
  });

  ipcMain.handle('settings:save', (event, update) => {
    assertSettingsSender(event);
    return enqueueRestart(async () => {
      if (update?.expectedRevision !== settingsRevision) {
        return { conflict: true, latest: runtimeState() };
      }
      const previous = settings;
      const supportedUpdate = {
        settings: {
          ...update?.settings,
          ...(!capabilities.launchAtLogin ? { launchAtLogin: previous.launchAtLogin } : {}),
        }
      };
      validateSettingsUpdate(supportedUpdate, previous);
      const next = configStore.applyUpdate(previous, supportedUpdate);
      // 只换外观时不必重启内部服务，也不打断主窗口里正在进行的编辑。
      if (onlyThemeChanged(previous, next)) {
        writeSettings(next);
        notifySettingsChanged();
        return runtimeState();
      }
      if (!previous.syncEnabled && next.syncEnabled) {
        const { response } = await dialog.showMessageBox(settingsWindow, {
          type: 'warning',
          title: '启用 Git 自动同步',
          message: '启用后，科研工作台会修改并同步整个资料库。',
          detail: '每轮同步会拉取并 rebase，然后执行 git add -A、提交和推送。git add -A 会包含资料库内所有未被 .gitignore 排除的文件，而不只是应用创建的 Markdown。请先确认远端和忽略规则正确。',
          buttons: ['取消', '确认启用'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        if (response !== 1) return { cancelled: true };
      }
      return replaceRuntime(next, previous);
    });
  });

  ipcMain.handle('settings:choose-directory', async (event, field) => {
    assertSettingsSender(event);
    if (!DIRECTORY_FIELDS.has(field)) throw new Error('不允许选择这个目录字段。');
    const result = await dialog.showOpenDialog(settingsWindow, {
      defaultPath: settings[field] || settings.vaultDir || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('settings:sync-now', async event => {
    assertSettingsSender(event);
    if (!runtime) throw new Error('工作台尚未启动。');
    return runtime.syncNow();
  });
  ipcMain.handle('settings:abort-git-operation', async event => {
    assertSettingsSender(event);
    return confirmAndAbortGitOperation();
  });
  ipcMain.handle('settings:open-vault', async event => {
    assertSettingsSender(event);
    if (!settings.vaultDir) return '';
    const error = await shell.openPath(settings.vaultDir);
    if (error) throw new Error(error);
    return '';
  });
  ipcMain.handle('settings:open-config-directory', async event => {
    assertSettingsSender(event);
    fs.mkdirSync(configStore.directory, { recursive: true });
    const error = await shell.openPath(configStore.directory);
    if (error) throw new Error(error);
    return '';
  });
  ipcMain.handle('settings:open-recovery', async (event, mode) => {
    assertSettingsSender(event);
    await showRecoveryWindow(mode);
    return { ok: true };
  });

  ipcMain.handle('recovery:get-state', event => {
    assertRecoverySender(event);
    return publicRecoveryState();
  });
  ipcMain.handle('recovery:begin-restore', event => {
    assertRecoverySender(event);
    if (recoveryMode !== 'first-run') throw new Error('当前不在首次启动流程。');
    recoveryMode = 'restore';
    return publicRecoveryState();
  });
  ipcMain.handle('recovery:choose-local-source', async event => {
    assertRecoverySender(event);
    const result = await dialog.showOpenDialog(recoveryWindow, {
      title: '选择资料库备份',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory']
    });
    if (result.canceled) return { selected: false, state: publicRecoveryState() };
    await validateVaultRoot(result.filePaths[0]);
    recoveryService.selectLocalSource(result.filePaths[0]);
    return { selected: true, display: result.filePaths[0], state: publicRecoveryState() };
  });
  ipcMain.handle('recovery:choose-destination-parent', async event => {
    assertRecoverySender(event);
    const result = await dialog.showOpenDialog(recoveryWindow, {
      title: '选择新资料库所在位置',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return { selected: false, state: publicRecoveryState() };
    recoveryService.selectDestinationParent(result.filePaths[0]);
    return { selected: true, display: result.filePaths[0], state: publicRecoveryState() };
  });
  ipcMain.handle('recovery:inspect-remote', async (event, remote) => {
    assertRecoverySender(event);
    if (typeof remote !== 'string' || remote.length > 2_048) throw new Error('Git 远端地址不合法。');
    await recoveryService.inspectRemote(remote);
    return { message: '远端可以读取，默认分支存在。', state: publicRecoveryState() };
  });
  ipcMain.handle('recovery:start', async (event, input) => {
    assertRecoverySender(event);
    const options = validateRecoveryStart(input, { mode: recoveryMode });
    return recoveryService.start({ ...options, device: settings.device });
  });
  ipcMain.handle('recovery:cancel', async event => {
    assertRecoverySender(event);
    return recoveryService.cancel();
  });
  ipcMain.handle('recovery:retry-stage', async event => {
    assertRecoverySender(event);
    return recoveryService.retryStage();
  });
  ipcMain.handle('recovery:activate', async event => {
    assertRecoverySender(event);
    const result = await enqueueRestart(async () => {
      if (!await canReplaceRuntime()) {
        return { cancelled: true, reason: '主窗口有未保存的编辑或附件任务。' };
      }
      const currentSettings = settings;
      const restoreMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
      if (restoreMainWindow) mainWindow.hide();
      try {
        await activateRecoveredVault({
          recovery: recoveryService,
          currentSettings,
          replaceRuntime: (next, previous) => replaceRuntime(next, previous, { unloadChecked: true })
        });
        return { cancelled: false };
      } catch (error) {
        if (restoreMainWindow) await showMainWindow();
        throw error;
      }
    });
    if (!result.cancelled) await showMainWindow();
    return { ...publicRecoveryState(), ...result };
  });
  ipcMain.handle('recovery:open-current-vault', async event => {
    assertRecoverySender(event);
    const state = publicRecoveryState();
    if (!state.canOpenCurrentVault) throw new Error('当前资料库不可用。');
    recoveryWindow?.hide();
    showMainWindow();
    return state;
  });
  ipcMain.handle('recovery:discard-owned-staging', async event => {
    assertRecoverySender(event);
    const result = await recoveryService.discardOwnedStaging();
    const choice = await chooseInitialVault();
    if (choice.quit) {
      await quitApplication();
      return { ...publicRecoveryState(), discard: result };
    }
    if (choice.vaultDir) {
      const previous = settings;
      const next = choice.vaultDir === settings.vaultDir
        ? settings
        : { ...settings, vaultDir: choice.vaultDir };
      const replacement = await enqueueRestart(() => replaceRuntime(next, previous));
      if (replacement.cancelled) {
        return { ...publicRecoveryState(), ...replacement, discard: result };
      }
      recoveryWindow?.hide();
      await showMainWindow();
      return { ...publicRecoveryState(), discard: result, resumed: true };
    }

    const nextMode = choice.firstRun ? 'first-run' : 'restore';
    resetRecoveryService(nextMode);
    recoveryMode = nextMode;
    recoveryWindow?.setTitle(nextMode === 'first-run'
      ? '开始使用科研工作台'
      : '恢复科研工作台资料库');
    notifyRecoveryStateChanged(publicRecoveryState());
    return { ...publicRecoveryState(), discard: result };
  });
  ipcMain.handle('recovery:create-vault', async event => {
    assertRecoverySender(event);
    if (recoveryMode !== 'first-run') throw new Error('只有首次启动可以从这里创建资料库。');
    const vaultDir = await promptForVaultDir('initial');
    if (!vaultDir) return publicRecoveryState();
    const entries = fs.readdirSync(vaultDir);
    if (entries.length > 0) throw new Error('创建新资料库需要选择一个空目录。');
    const previous = settings;
    const replacement = await enqueueRestart(() => replaceRuntime({ ...settings, vaultDir, syncEnabled: false }, previous));
    if (replacement.cancelled) return { ...publicRecoveryState(), ...replacement };
    recoveryWindow?.hide();
    await showMainWindow();
    return { ...publicRecoveryState(), phase: 'completed', outcome: 'complete' };
  });
  ipcMain.handle('recovery:open-existing-vault', async event => {
    assertRecoverySender(event);
    if (recoveryMode !== 'first-run') throw new Error('只有首次启动可以从这里打开现有资料库。');
    const vaultDir = await promptForVaultDir('initial');
    if (!vaultDir) return publicRecoveryState();
    await validateVaultRoot(vaultDir);
    const previous = settings;
    const replacement = await enqueueRestart(() => replaceRuntime({ ...settings, vaultDir }, previous));
    if (replacement.cancelled) return { ...publicRecoveryState(), ...replacement };
    recoveryWindow?.hide();
    await showMainWindow();
    return { ...publicRecoveryState(), phase: 'completed', outcome: 'complete' };
  });
}

if (!gotLock) {
  app.quit();
} else {
  quitCoordinator = createQuitCoordinator({
    getWindows: () => [settingsWindow, recoveryWindow, mainWindow],
    onAccepted: finishQuit,
    onCancelled: () => refreshMenus()
  });
  app.on('second-instance', () => showMainWindow());
  if (platformPolicy.restoreOnActivate) app.on('activate', () => showMainWindow());
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    quitApplication().catch(showFatalError);
  });
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    platformPolicy.initializeApp(app);

    configStore = createConfigStore({ userDataPath: app.getPath('userData') });
    settings = configStore.load();
    applyThemeSetting();
    // 合盖再打开之后，setInterval 的节奏已经乱了，中间那段时间的提醒也没跑。
    // 醒来立刻补一轮 —— tick 本身是按墙上时钟算的，补跑不会重复发。
    registerIpc();

    const startupRecovery = resetRecoveryService('restore');
    const residue = await startupRecovery.loadResidue();
    recoveryResidueLoaded = true;
    if (residue) {
      applyLoginItemSetting();
      createTray();
      await showRecoveryWindow('restore');
      return;
    }

    const choice = await chooseInitialVault();
    if (choice.quit) {
      await quitApplication();
      return;
    }
    if (choice.vaultDir && choice.vaultDir !== settings.vaultDir) {
      writeSettings({ ...settings, vaultDir: choice.vaultDir });
    }
    applyLoginItemSetting();
    createTray();

    if (choice.firstRun || choice.restore || !settings.vaultDir) {
      await showRecoveryWindow(choice.firstRun ? 'first-run' : 'restore');
      return;
    }

    try {
      setRuntime(await startConfiguredRuntime(settings));
      await createMainWindow({ hidden: platformPolicy.isHiddenStartup(process.argv) && !revealOnReady });
      refreshMenus();
    } catch (error) {
      try {
        await runtime?.stop();
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      setRuntime(null);
      destroyMainWindow();
      refreshMenus();
      showFatalError(error);
      showSettingsWindow();
    }
  }).catch(error => {
    // 启动到这一步还失败（设置文件损坏、托盘图标加载不了……），已经没有
    // 任何界面可用了。**必须退出进程**：没有窗口也没有托盘时，
    // window-all-closed 是空实现，进程会一直挂着并占住单实例锁 ——
    // 用户之后再双击图标，新进程会因为拿不到锁直接退出，
    // 而僵尸进程收到 second-instance 也弹不出任何东西。表现就是「应用打不开了」。
    showFatalError(error);
    app.exit(1);
  });
}
