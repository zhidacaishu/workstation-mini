// 更新包放在大文件存储服务上，走 electron-updater 的 generic provider。
//
// 为什么不是 GitHub provider：源码仓库是私有的，私有仓库的 Release 资源匿名拉不到，
// 要么把仓库开成公开（asar 不是加密，公开安装包等于公开源码），要么把一个只读
// token 打进安装包（拿到安装包的人就能提取它）。两条都和这个项目其它地方的取舍冲突。
//
// 而存储服务本来就是「各端都能到、带令牌、倾向挂在 Tailscale 上」的东西，令牌也
// 已经用系统安全存储保存。更新包放这儿，不新增任何一处对外暴露。
//
// 代价写在这里，免得以后忘：没配存储服务就没有自动更新。这是显式的降级，
// 不是静默失败 —— 状态里会说清楚原因。
const { normalizeBlobBaseUrl } = require('../src/blobs/url');

const FEED_PREFIX = 'releases';

// 启动后先让位给索引和首次同步。更新检查是这台机器上最不着急的一件事，
// 抢在冷启动那几秒里跑只会让界面更慢出来。
const INITIAL_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 算出更新源，顺便回答「这台机器现在能不能自动更新」。
 *
 * 拆成纯函数是为了能测：判断条件（开发态、没配存储服务、设置里关了）比
 * 下载安装那部分更容易出错，而那部分没法在测试里真的跑一遍。
 */
function resolveFeed({ isPackaged, updatesEnabled, blobServerUrl, blobServerToken } = {}) {
  if (!isPackaged) {
    // 开发态绝不检查更新。装上去会覆盖源码树，而且每次 npm start 都发一次
    // 网络请求，纯属打扰。
    return { enabled: false, reason: '开发模式下不检查更新。' };
  }
  if (!updatesEnabled) {
    return { enabled: false, reason: '已在设置中关闭自动更新。' };
  }

  const rawBase = String(blobServerUrl || '').trim();
  if (!rawBase) {
    return { enabled: false, reason: '未配置大文件存储服务地址，无法检查更新。' };
  }
  let base;
  try {
    base = normalizeBlobBaseUrl(rawBase);
  } catch (error) {
    return { enabled: false, reason: `${error.message} 无法检查更新。` };
  }
  if (!String(blobServerToken || '').trim()) {
    return { enabled: false, reason: '大文件存储服务缺少访问令牌，无法检查更新。' };
  }

  return {
    enabled: true,
    feed: { provider: 'generic', url: `${base}/blobs/${FEED_PREFIX}`, useMultipleRangeRequest: false },
    requestHeaders: { 'x-workstation-blob-token': blobServerToken }
  };
}

const STATE_LABELS = {
  disabled: '未启用自动更新',
  idle: '尚未检查更新',
  checking: '正在检查更新…',
  current: '已是最新版本',
  downloading: '正在下载更新…',
  downloaded: '更新已就绪，退出时安装',
  error: '检查更新失败'
};

function describeState(state) {
  const label = STATE_LABELS[state.phase] || STATE_LABELS.idle;
  if (state.phase === 'downloaded' && state.version) return `更新 ${state.version} 已就绪，退出时安装`;
  if (state.phase === 'downloading' && state.version) return `正在下载更新 ${state.version}…`;
  if (state.reason) return `${label}：${state.reason}`;
  return label;
}

/**
 * 自动更新。
 *
 * **安装时机是这里唯一重要的设计。** 应用退出前要跑完最后一次提交和推送
 * （runtime.stop 那一段），中途被安装器打断就等于丢掉这一轮没提交的笔记。
 *
 * 所以这里只用 `autoInstallOnAppQuit`，绝不在会话中途调 quitAndInstall：
 * electron-updater 挂的是 Electron 的 `quit` 事件，而 main.js 里的 before-quit
 * 会一直 preventDefault 到 quitReady 为止 —— 也就是说安装器只可能在
 * runtime.stop() 跑完之后才启动。想「立即重启安装」也必须先走完整套退出流程，
 * 这就是 installOnQuit() 要调用方传 quitApplication 进来的原因。
 */
function createUpdater({
  autoUpdater,
  isPackaged,
  logger = console,
  onStateChange = () => {},
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
  scheduleInterval = setInterval,
  cancelInterval = clearInterval
} = {}) {
  let state = Object.freeze({ phase: 'disabled', version: '', reason: '', enabled: false });
  let initialTimer = null;
  let intervalTimer = null;
  let listenersAttached = false;
  let configurationGeneration = 0;
  let desired = null;
  let activeContext = null;
  let transitionPromise = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  function setState(patch) {
    state = Object.freeze({ ...state, ...patch });
    try {
      onStateChange(state);
    } catch (error) {
      logger.warn?.(`[update] 状态回调失败：${error.message}`);
    }
    return state;
  }

  function getState() {
    return state;
  }

  function isCurrent(context) {
    return Boolean(
      context &&
      !context.stale &&
      activeContext === context &&
      desired?.generation === context.generation &&
      desired.identity === context.identity &&
      desired.resolved.enabled
    );
  }

  function cancelContext(context) {
    try {
      context?.cancellationToken?.cancel?.();
    } catch (error) {
      logger.warn?.(`[update] 取消旧下载失败：${error.message}`);
    }
  }

  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;

    autoUpdater.on('update-downloaded', info => {
      const context = activeContext;
      if (
        !isCurrent(context) ||
        !context.downloading ||
        !context.expectedVersion ||
        info?.version !== context.expectedVersion
      ) return;

      context.downloadedEvent = true;
      // BaseUpdater 在 emit 返回后才读取这个标志并注册 quit handler，所以必须同步打开。
      autoUpdater.autoInstallOnAppQuit = true;
    });
    // EventEmitter 的 error 没有 listener 会抛出；状态归属由 pipeline 的 reject 决定。
    autoUpdater.on('error', error => {
      logger.warn?.(`[update] ${error?.message || String(error)}`);
    });
  }

  function stop() {
    if (initialTimer) cancelTimer(initialTimer);
    if (intervalTimer) cancelInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  function scheduleChecks() {
    initialTimer = scheduleTimer(() => { checkNow(); }, INITIAL_CHECK_DELAY_MS);
    initialTimer?.unref?.();
    intervalTimer = scheduleInterval(() => { checkNow(); }, CHECK_INTERVAL_MS);
    intervalTimer?.unref?.();
  }

  function sourceIdentity(resolved) {
    if (!resolved.enabled) return 'disabled';
    return JSON.stringify({
      feed: resolved.feed,
      requestHeaders: resolved.requestHeaders
    });
  }

  function applyDesired() {
    if (!desired.resolved.enabled) {
      activeContext = null;
      autoUpdater.requestHeaders = {};
      return;
    }

    const target = desired;
    autoUpdater.logger = null;
    autoUpdater.requestHeaders = target.resolved.requestHeaders;
    autoUpdater.setFeedURL(target.resolved.feed);
    activeContext = {
      generation: target.generation,
      identity: target.identity,
      stale: false,
      pipeline: null,
      cancellationToken: null,
      downloading: false,
      downloadedEvent: false,
      expectedVersion: ''
    };
  }

  function reconcileConfiguration() {
    if (transitionPromise) return transitionPromise;
    if (!activeContext?.pipeline) {
      applyDesired();
      return null;
    }

    transitionPromise = (async () => {
      await activeContext.pipeline.catch(() => {});
      applyDesired();
    })().finally(() => {
      transitionPromise = null;
      if (
        desired.resolved.enabled &&
        (!activeContext || activeContext.identity !== desired.identity)
      ) reconcileConfiguration();
    });
    return transitionPromise;
  }

  async function runPipeline(context) {
    autoUpdater.autoInstallOnAppQuit = false;
    setState({ phase: 'checking', version: '', reason: '' });

    try {
      const result = await autoUpdater.checkForUpdates();
      context.cancellationToken = result?.cancellationToken || null;
      if (!isCurrent(context)) {
        cancelContext(context);
        return;
      }

      if (!result?.isUpdateAvailable) {
        setState({ phase: 'current', version: '', reason: '' });
        return;
      }

      const version = result.updateInfo?.version || result.versionInfo?.version || '';
      context.expectedVersion = version;
      context.downloading = true;
      context.downloadedEvent = false;
      setState({ phase: 'downloading', version, reason: '' });

      if (!isCurrent(context)) {
        cancelContext(context);
        return;
      }

      await autoUpdater.downloadUpdate(context.cancellationToken || undefined);
      context.downloading = false;
      if (!isCurrent(context)) return;
      if (!context.downloadedEvent) {
        throw new Error('更新下载结束，但未收到下载完成事件。');
      }
      setState({ phase: 'downloaded', version, reason: '' });
    } catch (error) {
      context.downloading = false;
      if (!isCurrent(context)) return;
      autoUpdater.autoInstallOnAppQuit = false;
      const reason = error?.message || String(error);
      logger.warn?.(`[update] 检查或下载更新失败：${reason}`);
      setState({ phase: 'error', reason });
    } finally {
      context.cancellationToken = null;
    }
  }

  async function checkNow() {
    if (!state.enabled) return state;
    if (transitionPromise) await transitionPromise;
    if (!state.enabled || !activeContext || activeContext.identity !== desired.identity) return state;
    if (state.phase === 'downloaded') return state;

    const context = activeContext;
    if (!context.pipeline) {
      context.pipeline = runPipeline(context).finally(() => {
        context.pipeline = null;
        if (context.stale) reconcileConfiguration();
      });
    }
    await context.pipeline;
    return state;
  }

  /**
   * 按当前设置重新配置。设置里改了存储服务地址或开关就再调一次。
   */
  function configure({ updatesEnabled, blobServerUrl, blobServerToken } = {}) {
    const resolved = resolveFeed({ isPackaged, updatesEnabled, blobServerUrl, blobServerToken });
    const identity = sourceIdentity(resolved);

    if (desired?.identity === identity) {
      // 源没变就别动定时器。设置页每次保存都会调一次 configure，
      // 之前无条件 stop + 重排，等于每保存一次就把「启动一分钟后首检」再推迟一分钟；
      // 频繁改设置的话那次首检可以永远不发生。
      desired.resolved = resolved;
      if (!resolved.enabled) {
        stop();
        setState({ phase: 'disabled', version: '', reason: resolved.reason, enabled: false });
      } else if (!intervalTimer) {
        scheduleChecks();
      }
      return state;
    }

    stop();
    configurationGeneration += 1;
    desired = { generation: configurationGeneration, identity, resolved };
    if (activeContext) {
      activeContext.stale = true;
      cancelContext(activeContext);
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.requestHeaders = {};

    if (!resolved.enabled) {
      setState({ phase: 'disabled', version: '', reason: resolved.reason, enabled: false });
    } else {
      attachListeners();
      setState({ phase: 'idle', version: '', reason: '', enabled: true });
      scheduleChecks();
    }

    reconcileConfiguration();
    return state;
  }

  /**
   * 「重启并安装」。
   *
   * 不直接调 autoUpdater.quitAndInstall —— 那会让安装器和最后一次提交推送
   * 抢时间。走应用自己的退出流程，安装由 autoInstallOnAppQuit 在退出末尾完成。
   */
  async function installOnQuit(quitApplication) {
    if (state.phase !== 'downloaded' || !autoUpdater.autoInstallOnAppQuit) {
      throw new Error('还没有已下载好的更新。');
    }
    return quitApplication();
  }

  return { configure, checkNow, getState, describe: () => describeState(state), installOnQuit, stop };
}

module.exports = {
  createUpdater,
  resolveFeed,
  describeState,
  FEED_PREFIX,
  INITIAL_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS
};
