// Surface early import failures to packaged smoke tests instead of a blocking dialog.
if (process.argv.includes('--workstation-smoke-test')) {
  process.on('uncaughtException', error => {
    console.error(error);
    process.exit(1);
  });
}

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
const { createGuideStore } = require('./guide-store');
const { createRuntimeConfig, pruneStaleIndexes, removeLegacyVaultIndex } = require('./runtime-config');
const { validateSettingsUpdate, validateConflictChoices } = require('./settings-validation');
const { resolveVaultDir } = require('./vault-resolution');
const { checkVaultChange } = require('./vault-change');
const { createQuitCoordinator, windowVetoesUnload } = require('./quit-coordinator');
const { createLeaveGuard } = require('./leave-guard');
const { showAppMessage, focusMessage } = require('./message-window');
const { createPlatformPolicy, INSET_CHROME_ARGUMENT } = require('./platform-policy');
const {
  validateRecoveryMode,
  validateRecoveryStart
} = require('./recovery-validation');
const { activateRecoveredVault } = require('./recovery-activation');
const { normalizedDocumentUrl, isTrustedMainFrameSender, isTrustedMainOriginSender } = require('./trusted-sender');
const { resourceTarget } = require('./resource-links');
const { ensureSafeFilePath } = require('../src/vault/paths');
const { startRuntime } = require('../src/runtime');
const { defaultVaultDir, createDeviceName, legacyDeviceName } = require('../src/config');
const { createRecoveryJournal } = require('../src/recovery/journal');
const { createRecoveryService, validateVaultRoot } = require('../src/recovery/service');

const SETTINGS_FILE = path.join(__dirname, 'settings', 'index.html');
const SETTINGS_URL = pathToFileURL(SETTINGS_FILE).href;
const PRELOAD_FILE = path.join(__dirname, 'settings-preload.js');
const RECOVERY_FILE = path.join(__dirname, 'recovery', 'index.html');
const RECOVERY_URL = pathToFileURL(RECOVERY_FILE).href;
const RECOVERY_PRELOAD_FILE = path.join(__dirname, 'recovery-preload.js');
const DIRECTORY_FIELDS = new Set(['vaultDir']);
const SYSTEM_CLUTTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const RECOVERY_SWITCHABLE_PHASES = new Set(['idle', 'cancelled', 'completed', 'failed']);
const platformPolicy = createPlatformPolicy();
const { capabilities } = platformPolicy;
const WINDOW_ICON = platformPolicy.windowIcon({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  projectDir: path.join(__dirname, '..')
});

// 窗口底色是渲染进程画出第一帧之前、以及缩放窗口时新暴露区域露出的颜色。
// 界面本身支持 prefers-color-scheme，写死浅色的话深色模式下拖拽缩放会闪白边。
// 取值和 src/public/tokens.css 里的 --bg 保持一致。
const WINDOW_BACKGROUND = { light: '#f8f9fa', dark: '#0c0e11' };

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

// 设置和恢复窗口是本地文件页面，没有服务端可以替它们输出 html.chrome-inset，
// 由 preload 读这个启动参数自己加上。
function panelChromeArguments() {
  return platformPolicy.insetTitleBar ? [INSET_CHROME_ARGUMENT] : [];
}

function onlyThemeChanged(previous, next) {
  if (previous?.theme === next?.theme) return false;
  const { theme: _previousTheme, ...restPrevious } = previous || {};
  const { theme: _nextTheme, ...restNext } = next || {};
  return JSON.stringify(restPrevious) === JSON.stringify(restNext);
}

let configStore;
// 指引进度（导览看到哪一步、上手清单是否隐藏）只存本机，不进资料库。
let guideStore;
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
// 设置文件损坏后用户选了「重新选择资料库」：启动时不自动认约定位置。
let chooseVaultExplicitly = false;
// 设置窗口里用「选择」按钮挑过的资料库目录：可以是对话框里刚新建的空目录。
const pickedVaultDirs = new Set();
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
// 「有未保存的更改，仍要离开吗」。自动化测试里不弹框（见 leave-guard.js）。
const confirmLeave = createLeaveGuard({ showMessage: showAppMessage, isTestRun });
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
  const response = await showAppMessage(null, {
    title: '找不到资料库',
    message: `找不到资料库目录：\n${missingPath}`,
    detail: '移动硬盘、网络位置或云盘可能还没准备好。'
      + '已保存的路径不会被自动更改，除非你在这里另选一个目录。',
    buttons: ['重试', '选择其它目录', '从备份恢复', '退出'],
    defaultId: 0,
    cancelId: 3
  });
  return ['retry', 'choose', 'restore', 'quit'][response] || 'retry';
}

function chooseInitialVault() {
  return resolveVaultDir({
    savedVaultDir: settings.vaultDir,
    conventionalVaultDir: defaultVaultDir(),
    pathExists: target => fs.existsSync(target),
    askMissingVault,
    promptForDirectory: promptForVaultDir,
    chooseExplicitly: chooseVaultExplicitly
  });
}

async function startConfiguredRuntime(nextSettings = settings) {
  const indexDir = path.join(app.getPath('userData'), 'workstation-data', 'index');
  const config = createRuntimeConfig(nextSettings, {
    isProduction: app.isPackaged,
    windowChrome: platformPolicy.insetTitleBar ? 'inset' : 'native',
    indexDir
  });
  pruneStaleIndexes(indexDir, config.dbPath);
  const legacy = removeLegacyVaultIndex(config.vaultDir);
  if (legacy.length) console.log(`[index] 已清理资料库里旧版本留下的索引文件：${legacy.join('、')}`);
  // 服务端只读指引状态，用来决定今日页要不要渲染上手清单；写入仍走 guide:save。
  return startRuntime(config, { guide: guideStore });
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

// 附件交给系统默认应用打开（见 resource-links.js）。测试里不真的拉起别的程序。
async function openResource(window, target) {
  const vaultDir = runtime?.config?.vaultDir;
  try {
    if (target.invalid || !vaultDir) throw Object.assign(new Error('附件路径不合法。'), { code: 'EINVAL' });
    const absolute = await ensureSafeFilePath(vaultDir, target.relative);
    if (isTestRun) { console.log(`[resource] 用系统默认应用打开：${target.relative}`); return; }
    const failure = await shell.openPath(absolute);
    if (failure) throw new Error(failure);
  } catch (error) {
    const detail = error.code === 'ENOENT' ? `资料库里没有 ${target.relative}。` : String(error.message || error);
    if (isTestRun) { console.log(`[resource] 打不开：${detail}`); return; }
    const parent = window && !window.isDestroyed() ? window : undefined;
    await showAppMessage(parent, { buttons: ['好'], message: '打不开这个附件', detail }).catch(showFatalError);
  }
}

function secureMainWindow(window, origin) {
  // 其余权限一律拒绝；只放行本应用页面「写入纯文本到剪贴板」，上手指南的「复制命令」要用。
  // 读剪贴板仍然拒绝。按当前运行时的源判断，内部服务重启换端口后照样生效。
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== 'clipboard-sanitized-write') return callback(false);
    try { callback(new URL(details?.requestingUrl).origin === runtime?.origin); } catch { callback(false); }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Ctrl/⌘ 或中键点应用内链接：在主窗口里打开。交给系统浏览器的话，
    // 浏览器没有内部令牌，打开的只是一个 403。
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === runtime?.origin; } catch {}
    const resource = sameOrigin ? resourceTarget(url, runtime?.origin) : null;
    if (resource) openResource(window, resource);
    else if (sameOrigin) window.loadURL(url).catch(() => {});
    else if (isExternalUrl(url)) openExternalUrl(url);
    return { action: 'deny' };
  });

  // 页面已在 beforeunload 中询问；选择留下时让 Chromium 取消这次导航。
  window.webContents.on('will-prevent-unload', event => {
    if (quitCoordinator?.isAccepted()) event.preventDefault();
  });

  window.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === origin; } catch {}
    const resource = sameOrigin ? resourceTarget(url, origin) : null;
    if (sameOrigin && !resource) return;
    event.preventDefault();
    if (resource) openResource(window, resource);
    else if (isExternalUrl(url)) openExternalUrl(url);
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
  window.webContents.on('will-prevent-unload', event => {
    if (quitCoordinator?.isAccepted()) event.preventDefault();
  });
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

async function createMainWindow({ hidden = false } = {}) {
  if (!runtime || quitting) return null;
  if (mainWindowPromise) return mainWindowPromise;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  const runtimeAtCreation = runtime;
  mainWindowPromise = (async () => {
    const partition = attachInternalSession();
    const window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 620,
      // 最小尺寸按内容区算：Windows 的外框和标题栏要另算，否则内容区比 900 窄。
      useContentSize: true,
      show: false,
      title: '科研工作台',
      icon: WINDOW_ICON,
      backgroundColor: windowBackgroundColor(),
      ...platformPolicy.windowChrome('main'),
      webPreferences: {
        partition,
        preload: path.join(__dirname, 'main-preload.js'),
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
    // Windows 关机、重启、注销时不发 before-quit：没有这两个处理，退出前的写入等待、
    // 最后一次提交和关闭索引库都不会执行，同步可能停在半路。只在 Windows 上触发。
    window.on('query-session-end', event => {
      if (quitReady) return;
      // 推迟结束会话，等保存和退出前同步做完；应用退出后系统继续关机。
      event.preventDefault();
      endSession();
    });
    window.on('session-end', () => endSession());
    // 切回窗口时补一次对账，接住外部编辑器的改动（文件监听在部分平台会漏事件）。
    // 来回切窗口很频繁，15 秒内只扫一次；后台对账不会在界面上弹索引横幅。
    let lastFocusRescan = 0;
    window.on('focus', () => {
      if (quitting || Date.now() - lastFocusRescan < 15_000) return;
      lastFocusRescan = Date.now();
      runtime?.rescan().catch(error => console.warn(`[index] 聚焦重扫失败：${error.message}`));
    });
    // 渲染进程崩溃（内存不足、GPU 驱动问题）后窗口是一片空白：自动重新载入。
    window.webContents.on('render-process-gone', (_event, details) => {
      if (quitting || details?.reason === 'clean-exit' || window.isDestroyed()) return;
      console.error(`[window] 渲染进程退出（${details?.reason}），重新载入页面`);
      window.webContents.reload();
    });
    // 页面卡死：问一下要等还是重新载入。
    window.on('unresponsive', async () => {
      if (quitting || isTestRun || window.isDestroyed() || focusMessage(window)) return;
      const choice = await showAppMessage(window, {
        buttons: ['继续等待', '重新载入'],
        defaultId: 0,
        cancelId: 0,
        message: '页面没有响应',
        detail: '可以再等一会儿，或者重新载入页面（还没保存的内容会丢失，笔记编辑器里写的内容已存成本机草稿）。'
      }).catch(error => { showFatalError(error); return 0; });
      if (choice === 1 && !window.isDestroyed()) {
        window.webContents.forcefullyCrashRenderer();
        window.webContents.reload();
      }
    });

    try {
      await window.loadURL(runtimeAtCreation.origin);
      if (!hidden && !quitting) window.show();
      return window;
    } catch (error) {
      // 首页已经可交互时，用户可能在资源加载完前打开另一页。新导航会取消
      // 原 loadURL（ERR_ABORTED），不能因此销毁正在加载新页面的窗口。
      let internalNavigation = false;
      if (!window.isDestroyed() && (error.code === 'ERR_ABORTED' || error.errno === -3)) {
        try { internalNavigation = new URL(window.webContents.getURL()).origin === runtimeAtCreation.origin; } catch {}
      }
      if (internalNavigation && runtime === runtimeAtCreation && !quitting) {
        if (!hidden) window.show();
        return window;
      }
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

// 这个函数直接挂在托盘的 click/double-click 和「显示科研工作台」菜单项上，
// Electron 会给它传 KeyboardEvent、MenuItem 之类的参数，这里一概不用。
function showMainWindow() {
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

  return createMainWindow().then(window => {
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
  if (runtime.config.readOnly) throw new Error('只读模式下不能中止 Git 操作。');
  const status = runtime.getSyncStatus();
  const recovery = status.recovery;
  if (!recovery) return { ok: true, skipped: '没有需要恢复的 Git 操作' };
  if (!recovery.abortable) throw new Error('当前只有未合并文件，无法安全自动中止；请用 Git 工具手工处理。');
  const options = {
    title: `中止 Git ${syncRecoveryLabel(recovery)}`,
    message: `确认中止当前 ${syncRecoveryLabel(recovery)} 操作？`,
    detail: 'Git 会回到该操作开始前的状态，这之后保存过、还没提交的修改会从笔记里撤掉。\n\n撤掉的笔记和卡组内容会先存进「历史与草稿」，复习记录会自动补回。\n\n中止后不会自动重新同步；同一处冲突没解决的话，下次同步还会停在这里。',
    buttons: ['取消', '确认中止'],
    defaultId: 0,
    cancelId: 0,
    primaryId: 1
  };
  const parent = dialogParent();
  const response = await showAppMessage(parent, options);
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
    ...(recovery?.abortable ? [{ id: 'abort-git-operation', label: '中止当前 Git 操作…', enabled: !runtime.config.readOnly && !syncBusy, click: () => confirmAndAbortGitOperation().catch(showFatalError) }] : []),
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
    useContentSize: true,
    show: false,
    title: '恢复科研工作台资料库',
    icon: WINDOW_ICON,
    backgroundColor: windowBackgroundColor(),
    ...platformPolicy.windowChrome('panel'),
    webPreferences: {
      preload: RECOVERY_PRELOAD_FILE,
      additionalArguments: panelChromeArguments(),
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
  // loadURL 而不是 loadFile：安装路径里有 `%` 时 loadFile 会把它当成转义，找不到文件。
  window.loadURL(RECOVERY_URL)
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
    useContentSize: true,
    show: false,
    title: '科研工作台设置',
    icon: WINDOW_ICON,
    backgroundColor: windowBackgroundColor(),
    ...platformPolicy.windowChrome('panel'),
    webPreferences: {
      preload: PRELOAD_FILE,
      additionalArguments: panelChromeArguments(),
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
  window.loadURL(SETTINGS_URL)
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
  if (mainWindow && focusMessage(mainWindow)) return false;
  if (mainWindowPromise) await mainWindowPromise.catch(() => {});
  if (!await windowVetoesUnload(mainWindow)) return true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // 以前直接返回「取消」，设置保存按钮像没反应；现在问一声，用户可以放弃那些更改。
  return confirmLeave(mainWindow, 'restart');
}

async function replaceRuntime(nextSettings, previousSettings, { unloadChecked = false } = {}) {
  if (!unloadChecked && !await canReplaceRuntime()) {
    return { cancelled: true, reason: '主窗口有未保存的编辑或附件任务。' };
  }
  const previousRuntime = runtime;
  // 失败回滚后设置回到原样，revision 也要回到设置窗口手里那一版：否则用户改好
  // 再存一次，必然被当成「设置已在其它位置更新」。整个替换在重启队列里串行，
  // 这期间不会有别的设置写入。
  const revisionBefore = settingsRevision;
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
    settingsRevision = revisionBefore;
    try {
      applyLoginItemSetting();
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

function endSession() {
  if (quitReady || !quitCoordinator) return;
  quitCoordinator.forceAccept().catch(showFatalError);
}

function quitApplication() {
  if (focusMessage()) return Promise.resolve({ cancelled: true });
  return quitCoordinator.request();
}

async function showFatalError(error) {
  console.error(error);
  if (isTestRun) return;
  const detail = error.message || String(error);
  try {
    await showAppMessage(dialogParent(), { message: '工作台遇到错误', detail, buttons: ['关闭'] });
  } catch {
    // 消息窗口本身无法创建时仍需让用户看见启动错误。
    dialog.showErrorBox('科研工作台', detail);
  }
}

function registerIpc() {
  // beforeunload 必须同步给 Chromium 答案。只有发起导航的渲染进程等待，
  // 主进程继续处理独立消息窗口的点击、Esc 和关闭。
  ipcMain.on('workstation:confirm-leave', async event => {
    try {
      if (trustedSettingsSender(event)) event.returnValue = await confirmLeave(settingsWindow, 'settings');
      else if (isTrustedMainOriginSender(event, mainWindow, runtime?.origin)) event.returnValue = await confirmLeave(mainWindow, 'main');
      else event.returnValue = false;
    } catch (error) {
      console.error(error);
      event.returnValue = false;
    }
  });
  const assertGuideSender = event => {
    if (!isTrustedMainOriginSender(event, mainWindow, runtime?.origin)) throw new Error('拒绝来自未知页面的指引请求。');
  };
  ipcMain.handle('guide:get', event => {
    assertGuideSender(event);
    return guideStore.read();
  });
  ipcMain.handle('guide:save', (event, state) => {
    assertGuideSender(event);
    return guideStore.write(state);
  });
  ipcMain.handle('guide:settings', async event => {
    assertGuideSender(event);
    await showSettingsWindow();
  });
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
      // 手打的路径写错时不能悄悄建出一个空资料库切过去。
      await checkVaultChange({
        previousVaultDir: previous.vaultDir,
        nextVaultDir: next.vaultDir,
        pickedDirs: pickedVaultDirs
      });
      // 只换外观时不必重启内部服务，也不打断主窗口里正在进行的编辑。
      if (onlyThemeChanged(previous, next)) {
        writeSettings(next);
        notifySettingsChanged();
        return runtimeState();
      }
      if (!previous.syncEnabled && next.syncEnabled) {
        const response = await showAppMessage(settingsWindow, {
          title: '启用 Git 自动同步',
          message: '启用后，科研工作台会修改并同步整个资料库。',
          detail: '每轮同步会拉取并 rebase，然后执行 git add -A、提交和推送。git add -A 会包含资料库内所有未被 .gitignore 排除的文件，而不只是应用创建的 Markdown。请先确认远端和忽略规则正确。',
          buttons: ['取消', '确认启用'],
          defaultId: 0,
          cancelId: 0,
          primaryId: 1
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
    if (result.canceled) return '';
    if (field === 'vaultDir') pickedVaultDirs.add(result.filePaths[0]);
    return result.filePaths[0];
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
  ipcMain.handle('settings:list-git-conflicts', async event => {
    assertSettingsSender(event);
    if (!runtime) throw new Error('工作台尚未启动。');
    return runtime.listGitConflicts();
  });
  ipcMain.handle('settings:resolve-git-conflicts', async (event, choices) => {
    assertSettingsSender(event);
    if (!runtime) throw new Error('工作台尚未启动。');
    return runtime.resolveGitConflicts(validateConflictChoices(choices));
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
    // 启动时发现残留就只开了恢复窗口，运行时根本没起来：这里先把它启动，
    // 否则 showMainWindow 找不到运行时，又会把恢复窗口显示回来，按钮像没反应一样。
    if (!runtime) await enqueueRestart(() => replaceRuntime(settings, settings, { unloadChecked: true }));
    recoveryWindow?.hide();
    await showMainWindow();
    return publicRecoveryState();
  });
  ipcMain.handle('recovery:dismiss-residue', async event => {
    assertRecoverySender(event);
    return recoveryService.dismissResidue();
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
    // 文件管理器自己放进去的东西不算内容：访达打开过的空文件夹里就有 .DS_Store。
    const entries = fs.readdirSync(vaultDir).filter(name => !SYSTEM_CLUTTER.has(name));
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
    onCancelled: () => refreshMenus(),
    confirmDiscard: window => confirmLeave(window, window === settingsWindow ? 'settings' : 'quit')
  });
  // 外观跟随系统时，系统切换明暗之后窗口底色也要跟着换，否则缩放窗口会闪旧颜色的边。
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setBackgroundColor(windowBackgroundColor());
    }
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
    const loadIssue = configStore.lastLoadIssue?.();
    if (loadIssue && !isTestRun) {
      // 设置文件损坏：说清楚用了什么、坏文件留在哪里，而不是悄悄换成上一版甚至直接退出。
      if (loadIssue.kind === 'backup' && settings.vaultDir) {
        const choice = await showAppMessage(null, {
          buttons: ['使用这个资料库', '重新选择资料库'],
          defaultId: 0,
          cancelId: 0,
          message: '设置文件损坏，已从上一版备份恢复',
          detail: `备份里的资料库是：\n${settings.vaultDir}\n\n损坏的文件已改名保存在：\n${loadIssue.corruptPath}`
        });
        if (choice === 1) {
          settings = { ...settings, vaultDir: '' };
          chooseVaultExplicitly = true;
        }
      } else if (loadIssue.kind === 'reset') {
        await showAppMessage(null, {
          buttons: ['好'],
          message: '设置文件损坏，已按首次启动处理',
          detail: `接下来请重新选择资料库。损坏的文件已改名保存在：\n${loadIssue.corruptPath}`
        });
      }
    }
    // 设备名决定复习日志写进哪个文件，第一次保存后不再随主机名变化。老用户（已经有
    // 资料库、只是没存过设备名）沿用一直在用的主机名算法，复习日志不会换文件。
    if (!settings.device) {
      writeSettings({ ...settings, device: settings.vaultDir || loadIssue ? legacyDeviceName() : createDeviceName() });
    } else if (loadIssue) {
      writeSettings(settings);
    }
    guideStore = createGuideStore(app.getPath('userData'));
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
      // 排进重启队列：启动途中（建索引、大资料库）用户点了退出，finishQuit 会等运行时
      // 起来再把它停掉，不会留一个没人停的运行时和半截的 Git 子进程。
      await enqueueRestart(async () => {
        setRuntime(await startConfiguredRuntime(settings));
        await createMainWindow({ hidden: platformPolicy.isHiddenStartup(process.argv) && !revealOnReady });
      });
      refreshMenus();
    } catch (error) {
      // 启动途中退出：运行时由 finishQuit 停，这里不再弹错误、不再开设置窗口。
      if (quitting) return;
      try {
        await runtime?.stop();
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      setRuntime(null);
      destroyMainWindow();
      refreshMenus();
      await showFatalError(error);
      showSettingsWindow();
    }
  }).catch(async error => {
    // 启动到这一步还失败（设置文件损坏、托盘图标加载不了……），已经没有
    // 任何界面可用了。**必须退出进程**：没有窗口也没有托盘时，
    // window-all-closed 是空实现，进程会一直挂着并占住单实例锁 ——
    // 用户之后再双击图标，新进程会因为拿不到锁直接退出，
    // 而僵尸进程收到 second-instance 也弹不出任何东西。表现就是「应用打不开了」。
    await showFatalError(error);
    app.exit(1);
  });
}
