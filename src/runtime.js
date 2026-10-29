const fs = require('node:fs/promises');
const http = require('node:http');

const { createApp } = require('./app');
const { openDatabase } = require('./db');
const { createIndexer } = require('./vault/indexer');
const { createWatcher } = require('./vault/watcher');
const { createSearch } = require('./search');
const { createSync } = require('./sync');
const { withWritesPaused } = require('./vault/note-queue');

const EXIT_GIT_TIMEOUT_MS = 15_000;
// 退出同步共享一个截止时间；到期取消 Git 子进程，等待队列释放再关闭数据库。
// 中断的变基下次启动会被检测出来，可以在设置里中止。
const EXIT_WAIT_MS = 20_000;

async function finishSync(sync, operation, milliseconds, logger) {
  let expired = false;
  const timer = setTimeout(() => { expired = true; sync.cancel(); }, milliseconds);
  try { await operation(); }
  catch (error) { if (!expired) throw error; }
  finally { clearTimeout(timer); }
  if (expired) logger.warn?.('[sync] 退出同步已超时并取消，未完成的操作将在下次启动显示。');
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server, timeoutMs = 5_000) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close(finish);
    server.closeIdleConnections?.();
  });
}

/**
 * 启动 Mini 的本地运行时。Markdown 是唯一真相，SQLite 是可重建索引，
 * Git 只负责文本和复习事件同步。
 *
 * guide 是桌面壳的本机指引存储（只用到 read()），决定今日页是否显示上手清单；
 * 不传时按默认状态处理。
 */
async function startRuntime(config, { logger = console, watcherOptions = {}, guide } = {}) {
  if (config.host !== '127.0.0.1' || config.port !== 0) {
    throw new Error('桌面内部服务必须监听随机的 127.0.0.1 端口。');
  }
  if (!config.internalToken) throw new Error('桌面内部服务缺少会话令牌。');

  const gitWritesEnabled = config.syncEnabled && !config.readOnly;
  let db;
  let indexer;
  let sync;
  let server;
  let watcher;
  let syncTimer;
  let syncNowQueue = Promise.resolve();
  let stopPromise;
  let stopping = false;

  try {
    await Promise.all([config.vaultDir, config.notesDir, config.reviewsDir, config.attachmentsDir]
      .map(directory => fs.mkdir(directory, { recursive: true })));

    sync = createSync({
      vaultDir: config.vaultDir,
      logger,
      enabled: gitWritesEnabled,
      reviewSyncEnabled: config.syncEnabled,
      pauseWrites: withWritesPaused
    });
    await sync.probe();
    if (gitWritesEnabled) {
      const ignored = await sync.ensureGitignore();
      if (ignored.ok === false && ignored.blocked !== 'recovery-required') {
        logger.warn?.(`[sync] ${ignored.error}`);
      }
      await sync.ensureGitattributes?.();
    }
    db = openDatabase(config.dbPath, { logger });
    indexer = createIndexer({ db, vaultDir: config.notesDir });
    const search = createSearch(db);

    async function syncReviewNow(message = `复习记录 ${new Date().toISOString()}`) {
      if (!config.syncEnabled) {
        return { ok: true, committed: false, pushed: false, changed: false, skipped: '同步未启用' };
      }
      if (stopping) {
        return { ok: true, committed: false, pushed: false, changed: false, skipped: '应用正在退出' };
      }
      const recovery = sync.getStatus().recovery;
      if (recovery) {
        return { ok: false, committed: false, pushed: false, changed: false, blocked: 'recovery-required', recovery };
      }
      const outcome = await sync.syncReviewLogs(config.device, message);
      if (outcome.changed) await indexer.scan();
      return outcome;
    }

    const app = createApp(config, {
      db, indexer, search, sync, syncReviewNow, guide,
      getIndexStatus: () => ({ ...indexer.getStatus(), notes: db.countNotes() })
    });
    server = http.createServer(app);
    await listen(server, config.port, config.host);

    const indexReady = indexer.scan({ kind: 'initial' }).then(stats => {
      logger.log?.(`[index] ${db.countNotes()} 篇笔记（新增 ${stats.added} / 更新 ${stats.updated} / 移除 ${stats.removed} / 未变 ${stats.unchanged}）`);
      return stats;
    }).catch(error => {
      logger.warn?.(`[index] 首次扫描失败：${error.message}`);
      throw error;
    });
    indexReady.catch(() => {});

    watcher = createWatcher({
      ...watcherOptions,
      dir: config.notesDir,
      logger,
      onChange: ({ paths, full }) => {
        if (stopping) return undefined;
        // 后台对账（kind: background）不打扰界面：只有真的扫出失败才会在横幅里出现。
        return (full ? indexer.scan({ kind: 'background' }) : indexer.scan({ paths })).then(stats => {
          if (stats.added || stats.updated || stats.removed) {
            logger.log?.(`[watch] 外部改动已入索引（新增 ${stats.added} / 更新 ${stats.updated} / 移除 ${stats.removed}）`);
          }
        });
      }
    });
    watcher.start();

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法确定内部服务地址。');
    const origin = `http://${config.host}:${address.port}`;

    function syncNow(message = `科研工作台同步 ${new Date().toISOString()}`) {
      if (!gitWritesEnabled) return Promise.resolve({ ok: true, skipped: '同步已关闭' });
      if (stopping) return Promise.resolve({ ok: true, skipped: '应用正在退出' });
      const recovery = sync.getStatus().recovery;
      if (recovery) return Promise.resolve({ ok: false, blocked: 'recovery-required', recovery });
      const result = syncNowQueue.then(async () => {
        const outcome = await sync.cycle(message);
        if (outcome.changed) await indexer.scan();
        return outcome;
      });
      syncNowQueue = result.catch(() => {});
      return result;
    }

    // 启动时的拉取放到后台：以前要等 git pull 结束才开始监听、建窗口，远端连不上
    // 或者凭据管理器弹了登录框没人管时，整整一分钟只看得到托盘图标。
    // 拉到了新内容再补扫一遍索引。
    if (gitWritesEnabled && !sync.getStatus().recovery) {
      const startupPull = syncNowQueue.then(async () => {
        if (stopping) return;
        const pulled = await sync.pull();
        if (pulled.skipped) logger.log?.(`[sync] 跳过拉取（${pulled.skipped}）`);
        if (pulled.ok && !pulled.skipped && !stopping) await indexer.scan({ kind: 'background' });
      }).catch(error => logger.warn?.(`[sync] 启动拉取失败：${error.message}`));
      syncNowQueue = startupPull;
    }

    if (gitWritesEnabled) {
      syncTimer = setInterval(() => {
        syncNow().catch(error => logger.warn?.(`[sync] ${error.message}`));
      }, config.syncIntervalMinutes * 60_000);
      syncTimer.unref?.();
    }

    async function stop({ finalSync = true } = {}) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopping = true;
        if (syncTimer) clearInterval(syncTimer);
        watcher?.close();
        let failure;
        async function settle(operation) {
          try { return await operation(); } catch (error) { failure ||= error; return undefined; }
        }
        await settle(() => closeServer(server));
        await settle(() => finishSync(sync, async () => {
          await syncNowQueue;
          await sync.idle();
          if (gitWritesEnabled && finalSync && !sync.getStatus().recovery) {
            await sync.commitAndPush('科研工作台退出前提交 ' + new Date().toISOString(), { timeout: EXIT_GIT_TIMEOUT_MS });
          }
        }, EXIT_WAIT_MS, logger));
        await settle(() => indexer.idle());
        await settle(() => db.close());
        if (failure) throw failure;
      })();
      return stopPromise;
    }

    async function abortGitOperation() {
      const result = await sync.abortOperation();
      if (result.ok && result.aborted) await indexer.scan();
      return result;
    }

    return {
      app, server, db, config, sync, indexer, origin, syncNow, syncReviewNow, stop, indexReady,
      getIndexStatus: () => ({ ...indexer.getStatus(), notes: db.countNotes() }),
      rescan: () => indexer.scan({ kind: 'background' }),
      isWatchDegraded: () => Boolean(watcher?.isDegraded()),
      getSyncStatus: sync.getStatus, onSyncStatus: sync.onStatus, abortGitOperation
    };
  } catch (error) {
    if (syncTimer) clearInterval(syncTimer);
    try { watcher?.close(); } catch {}
    try { await closeServer(server); } catch {}
    try { await sync?.idle(); } catch {}
    try { await indexer?.idle(); } catch {}
    try { db?.close(); } catch {}
    throw error;
  }
}

module.exports = { startRuntime, closeServer, finishSync };
