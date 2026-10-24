const fs = require('node:fs/promises');
const http = require('node:http');

const { createApp } = require('./app');
const { openDatabase } = require('./db');
const { createIndexer } = require('./vault/indexer');
const { createWatcher } = require('./vault/watcher');
const { createSearch } = require('./search');
const { createSync } = require('./sync');

const EXIT_GIT_TIMEOUT_MS = 15_000;

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
 */
async function startRuntime(config, { logger = console, watcherOptions = {} } = {}) {
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
      ignoreMedia: false
    });
    await sync.probe();
    if (gitWritesEnabled) {
      const ignored = await sync.ensureGitignore();
      if (ignored.ok === false && ignored.blocked !== 'recovery-required') {
        logger.warn?.(`[sync] ${ignored.error}`);
      }
    }
    if (gitWritesEnabled && !sync.getStatus().recovery) {
      const pulled = await sync.pull();
      if (pulled.skipped) logger.log?.(`[sync] 跳过拉取（${pulled.skipped}）`);
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
      db, indexer, search, sync, syncReviewNow,
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
        return (full ? indexer.scan() : indexer.scan({ paths })).then(stats => {
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
        await settle(() => syncNowQueue);
        await settle(() => Promise.all([sync.idle(), indexer.idle()]));
        if (gitWritesEnabled && finalSync && !sync.getStatus().recovery) {
          await settle(() => sync.commitAndPush(
            `科研工作台退出前提交 ${new Date().toISOString()}`,
            { timeout: EXIT_GIT_TIMEOUT_MS }
          ));
          await settle(() => sync.idle());
        }
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
      rescan: () => indexer.scan(),
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

module.exports = { startRuntime, closeServer };
