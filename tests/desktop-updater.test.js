const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdater, resolveFeed, describeState, FEED_PREFIX } = require('../electron/updater');

const CONFIGURED = {
  isPackaged: true,
  updatesEnabled: true,
  blobServerUrl: 'https://blobs.example.test:4100',
  blobServerToken: 'token-abc'
};

const OTHER_SOURCE = {
  ...CONFIGURED,
  blobServerUrl: 'https://other.example.test:4100'
};

test('打包版配好存储服务时，更新源指向存储服务的 releases 前缀', () => {
  const resolved = resolveFeed(CONFIGURED);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.feed.provider, 'generic');
  assert.equal(resolved.feed.url, `https://blobs.example.test:4100/blobs/${FEED_PREFIX}`);
  assert.deepEqual(resolved.requestHeaders, { 'x-workstation-blob-token': 'token-abc' });
});

test('存储服务地址末尾的斜杠不会拼出双斜杠', () => {
  const resolved = resolveFeed({ ...CONFIGURED, blobServerUrl: 'https://blobs.example.test:4100///' });
  assert.equal(resolved.feed.url, `https://blobs.example.test:4100/blobs/${FEED_PREFIX}`);
});

test('更新源拒绝非回环 HTTP、伪 localhost、凭据、查询和片段', () => {
  for (const blobServerUrl of [
    'http://example.com', 'http://localhost.evil', 'https://u:p@example.com',
    'https://example.com?token=x', 'https://example.com/#fragment'
  ]) {
    const resolved = resolveFeed({ ...CONFIGURED, blobServerUrl });
    assert.equal(resolved.enabled, false, blobServerUrl);
    assert.equal(resolved.requestHeaders, undefined);
  }
  for (const blobServerUrl of ['http://localhost:4100', 'http://127.1:4100', 'http://[::1]:4100']) {
    assert.equal(resolveFeed({ ...CONFIGURED, blobServerUrl }).enabled, true, blobServerUrl);
  }
});

test('开发态一律不检查更新', () => {
  const resolved = resolveFeed({ ...CONFIGURED, isPackaged: false });
  assert.equal(resolved.enabled, false);
  assert.match(resolved.reason, /开发模式/);
  assert.equal(resolved.feed, undefined);
});

test('设置里关掉自动更新就不检查', () => {
  const resolved = resolveFeed({ ...CONFIGURED, updatesEnabled: false });
  assert.equal(resolved.enabled, false);
  assert.match(resolved.reason, /设置/);
});

test('没配存储服务地址或令牌时降级为不检查，并说明是哪一样缺了', () => {
  const noUrl = resolveFeed({ ...CONFIGURED, blobServerUrl: '   ' });
  assert.equal(noUrl.enabled, false);
  assert.match(noUrl.reason, /地址/);

  const noToken = resolveFeed({ ...CONFIGURED, blobServerToken: '' });
  assert.equal(noToken.enabled, false);
  assert.match(noToken.reason, /令牌/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function stubAutoUpdater() {
  const emitter = new EventEmitter();
  emitter.feeds = [];
  emitter.checks = [];
  emitter.downloads = [];
  emitter.setFeedURL = feed => {
    emitter.feed = feed;
    emitter.feeds.push(feed);
  };
  emitter.checkForUpdates = () => {
    const call = deferred();
    emitter.checks.push(call);
    return call.promise;
  };
  emitter.downloadUpdate = cancellationToken => {
    const call = { ...deferred(), cancellationToken };
    emitter.downloads.push(call);
    return call.promise;
  };
  return emitter;
}

function createCancellationToken(cancel) {
  return {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      cancel?.();
    }
  };
}

function available(version, cancellationToken = createCancellationToken()) {
  return {
    isUpdateAvailable: true,
    updateInfo: { version },
    cancellationToken
  };
}

function createHarness({ isPackaged = true } = {}) {
  const autoUpdater = stubAutoUpdater();
  const timers = [];
  const cancelledTimers = [];
  const states = [];
  const updater = createUpdater({
    autoUpdater,
    isPackaged,
    logger: { warn() {} },
    onStateChange: state => states.push(state),
    scheduleTimer: handler => {
      const timer = { handler, kind: 'timeout', unref() {} };
      timers.push(timer);
      return timer;
    },
    cancelTimer: timer => { cancelledTimers.push(timer); },
    scheduleInterval: handler => {
      const timer = { handler, kind: 'interval', unref() {} };
      timers.push(timer);
      return timer;
    },
    cancelInterval: timer => { cancelledTimers.push(timer); }
  });
  return { autoUpdater, updater, timers, cancelledTimers, states };
}

async function completeAvailable(harness, version) {
  const promise = harness.updater.checkNow();
  const check = harness.autoUpdater.checks.at(-1);
  check.resolve(available(version));
  await flush();
  const download = harness.autoUpdater.downloads.at(-1);
  harness.autoUpdater.emit('update-downloaded', { version });
  download.resolve(['/tmp/update']);
  await promise;
}

test('启用后配置源和令牌，但下载完成前不允许退出安装', () => {
  const { autoUpdater, updater } = createHarness();
  updater.configure(CONFIGURED);

  assert.equal(autoUpdater.feed.url, `https://blobs.example.test:4100/blobs/${FEED_PREFIX}`);
  assert.deepEqual(autoUpdater.requestHeaders, { 'x-workstation-blob-token': 'token-abc' });
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(updater.getState().phase, 'idle');
});

test('不检查更新时不配置 feed，也不排任何定时器', () => {
  const { autoUpdater, updater, timers } = createHarness({ isPackaged: false });
  updater.configure(CONFIGURED);

  assert.equal(autoUpdater.feed, undefined);
  assert.deepEqual(autoUpdater.requestHeaders, {});
  assert.equal(timers.length, 0);
  assert.equal(updater.getState().phase, 'disabled');
});

test('显式检查和下载完成后才进入就绪状态并打开退出安装', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);

  const promise = harness.updater.checkNow();
  assert.equal(harness.updater.getState().phase, 'checking');
  harness.autoUpdater.checks[0].resolve(available('0.2.0'));
  await flush();

  assert.equal(harness.updater.getState().phase, 'downloading');
  assert.equal(harness.autoUpdater.downloads.length, 1);
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);

  harness.autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(harness.updater.getState().phase, 'downloading');
  harness.autoUpdater.downloads[0].resolve(['/tmp/update']);
  await promise;

  assert.equal(harness.updater.getState().phase, 'downloaded');
  assert.equal(harness.updater.getState().version, '0.2.0');
  assert.match(harness.updater.describe(), /0\.2\.0/);
});

test('没有可用更新时进入 current 且不下载', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const promise = harness.updater.checkNow();
  harness.autoUpdater.checks[0].resolve({ isUpdateAvailable: false });
  await promise;

  assert.equal(harness.updater.getState().phase, 'current');
  assert.equal(harness.autoUpdater.downloads.length, 0);
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);
});

test('检查更新失败只记状态，不抛错', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const promise = harness.updater.checkNow();
  harness.autoUpdater.checks[0].reject(new Error('connect ETIMEDOUT'));
  await promise;

  assert.equal(harness.updater.getState().phase, 'error');
  assert.match(harness.updater.describe(), /connect ETIMEDOUT/);
});

test('下载 promise 没有配套完成事件时拒绝把包标成可安装', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const promise = harness.updater.checkNow();
  harness.autoUpdater.checks[0].resolve(available('0.2.0'));
  await flush();
  harness.autoUpdater.downloads[0].resolve(['/tmp/update']);
  await promise;

  assert.equal(harness.updater.getState().phase, 'error');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);
});

test('同源重配保留在途流水线和已下载状态', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const first = harness.updater.checkNow();
  harness.updater.configure({ ...CONFIGURED, blobServerUrl: 'https://blobs.example.test:4100/' });
  assert.equal(harness.autoUpdater.checks.length, 1);
  harness.autoUpdater.checks[0].resolve({ isUpdateAvailable: false });
  await first;

  await completeAvailable(harness, '0.2.0');
  harness.updater.configure(CONFIGURED);
  assert.equal(harness.updater.getState().phase, 'downloaded');
  assert.equal(harness.updater.getState().version, '0.2.0');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, true);
});

test('元数据请求途中换源，旧结果取消且新 feed 等旧流水线收束后才应用', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const oldFeed = harness.autoUpdater.feed;
  const oldPipeline = harness.updater.checkNow();

  harness.updater.configure(OTHER_SOURCE);
  assert.equal(harness.autoUpdater.feed, oldFeed);
  assert.equal(harness.updater.getState().phase, 'idle');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);

  const token = createCancellationToken();
  harness.autoUpdater.checks[0].resolve(available('9.9.9', token));
  await oldPipeline;
  await flush();

  assert.equal(token.cancelled, true);
  assert.equal(harness.autoUpdater.feed.url, 'https://other.example.test:4100/blobs/releases');
  harness.autoUpdater.emit('update-downloaded', { version: '9.9.9' });
  assert.equal(harness.updater.getState().phase, 'idle');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);

  const current = harness.updater.checkNow();
  harness.autoUpdater.checks[1].resolve({ isUpdateAvailable: false });
  await current;
  assert.equal(harness.updater.getState().phase, 'current');
});

test('下载途中换源会取消旧下载，旧完成事件不能重新打开退出安装', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const token = createCancellationToken();
  const oldPipeline = harness.updater.checkNow();
  harness.autoUpdater.checks[0].resolve(available('0.2.0', token));
  await flush();

  harness.updater.configure(OTHER_SOURCE);
  assert.equal(token.cancelled, true);
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);
  harness.autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);

  harness.autoUpdater.downloads[0].resolve(['/tmp/old-update']);
  await oldPipeline;
  await flush();
  assert.equal(harness.autoUpdater.feed.url, 'https://other.example.test:4100/blobs/releases');
  assert.equal(harness.updater.getState().phase, 'idle');
});

test('取消旧下载失败不会阻止新配置，但旧上下文仍不能提交状态', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const token = createCancellationToken(() => { throw new Error('cancel failed'); });
  const oldPipeline = harness.updater.checkNow();
  harness.autoUpdater.checks[0].resolve(available('0.2.0', token));
  await flush();

  assert.doesNotThrow(() => harness.updater.configure(OTHER_SOURCE));
  harness.autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  harness.autoUpdater.downloads[0].resolve(['/tmp/old-update']);
  await oldPipeline;
  await flush();

  assert.equal(harness.updater.getState().phase, 'idle');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);
});

test('连续 A→B→C 重配只应用最后一个更新源', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const oldPipeline = harness.updater.checkNow();
  harness.updater.configure(OTHER_SOURCE);
  harness.updater.configure({ ...CONFIGURED, blobServerUrl: 'https://third.example.test:4100' });
  harness.autoUpdater.checks[0].resolve({ isUpdateAvailable: false });
  await oldPipeline;
  await flush();

  assert.deepEqual(
    harness.autoUpdater.feeds.map(feed => feed.url),
    [
      'https://blobs.example.test:4100/blobs/releases',
      'https://third.example.test:4100/blobs/releases'
    ]
  );
});

test('令牌变化属于更新源变化，会立即撤销旧包的安装资格', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  await completeAvailable(harness, '0.2.0');

  harness.updater.configure({ ...CONFIGURED, blobServerToken: 'token-new' });
  assert.equal(harness.updater.getState().phase, 'idle');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);
  assert.deepEqual(harness.autoUpdater.requestHeaders, { 'x-workstation-blob-token': 'token-new' });
});

test('关掉自动更新会清理凭据并取消在途下载，重新启用后可重新检查', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const token = createCancellationToken();
  const oldPipeline = harness.updater.checkNow();
  harness.autoUpdater.checks[0].resolve(available('0.2.0', token));
  await flush();

  harness.updater.configure({ ...CONFIGURED, updatesEnabled: false });
  assert.equal(token.cancelled, true);
  assert.deepEqual(harness.autoUpdater.requestHeaders, {});
  assert.equal(harness.updater.getState().phase, 'disabled');
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, false);

  harness.updater.configure(CONFIGURED);
  assert.equal(harness.updater.getState().phase, 'idle');
  harness.autoUpdater.downloads[0].resolve(['/tmp/old-update']);
  await oldPipeline;
  await flush();

  const current = harness.updater.checkNow();
  harness.autoUpdater.checks[1].resolve({ isUpdateAvailable: false });
  await current;
  assert.equal(harness.updater.getState().phase, 'current');
});

test('并发 checkNow 共用一条 metadata 和 download 流水线', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  const first = harness.updater.checkNow();
  const second = harness.updater.checkNow();
  assert.equal(harness.autoUpdater.checks.length, 1);

  harness.autoUpdater.checks[0].resolve(available('0.2.0'));
  await flush();
  assert.equal(harness.autoUpdater.downloads.length, 1);
  harness.autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  harness.autoUpdater.downloads[0].resolve(['/tmp/update']);
  await Promise.all([first, second]);
  assert.equal(harness.updater.getState().phase, 'downloaded');
});

test('stop 只停止调度，不禁用更新或清理凭据和安装资格', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  await completeAvailable(harness, '0.2.0');
  harness.updater.stop();

  assert.equal(harness.updater.getState().enabled, true);
  assert.deepEqual(harness.autoUpdater.requestHeaders, { 'x-workstation-blob-token': 'token-abc' });
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(harness.cancelledTimers.length, 2);
});

test('还没下载好时拒绝安装，不去动退出流程', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);

  let quitCalls = 0;
  await assert.rejects(
    () => harness.updater.installOnQuit(async () => { quitCalls += 1; }),
    /还没有已下载好的更新/
  );
  assert.equal(quitCalls, 0);
});

test('安装走的是应用自己的退出流程，而不是 autoUpdater.quitAndInstall', async () => {
  const harness = createHarness();
  harness.updater.configure(CONFIGURED);
  await completeAvailable(harness, '0.2.0');

  let quitAndInstallCalls = 0;
  harness.autoUpdater.quitAndInstall = () => { quitAndInstallCalls += 1; };
  const order = [];
  const result = await harness.updater.installOnQuit(async () => {
    order.push('quitApplication');
    return { cancelled: true };
  });

  assert.deepEqual(result, { cancelled: true });
  assert.deepEqual(order, ['quitApplication']);
  assert.equal(quitAndInstallCalls, 0);
});

test('状态文案覆盖每个阶段，不会出现空白', () => {
  for (const phase of ['disabled', 'idle', 'checking', 'current', 'downloading', 'downloaded', 'error']) {
    assert.notEqual(describeState({ phase, version: '', reason: '' }), '');
  }
});
