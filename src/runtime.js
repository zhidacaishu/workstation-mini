const fs = require('node:fs/promises');
const http = require('node:http');

const { createApp } = require('./app');
const { openDatabase } = require('./db');
const { createIndexer } = require('./vault/indexer');
const { createWatcher } = require('./vault/watcher');
const { createSearch } = require('./search');
const { createSync } = require('./sync');
const { withWritesPaused } = require('./vault/note-queue');
const { saveVersion, pruneDrafts } = require('./vault/history');
const { isSafeRelativePath } = require('./vault/paths');

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

/**
 * 中止 Git 操作前工作区里没提交的笔记和卡组、解决冲突时没采用的那一边，存进本机历史
 * （历史与草稿页能找回）。
 * 笔记的历史挂在 notes/ 下，卡组的挂在资料库根下，和平时保存时一致。
 */
function createDiscardPreserver(config) {
  return async ({ path: file, content, reason = 'abort' }) => {
    if (!file.toLowerCase().endsWith('.md')) return false;
    if (file.startsWith('notes/')) {
      const relative = file.slice('notes/'.length);
      if (!isSafeRelativePath(relative)) return false;
      await saveVersion(config.notesDir, relative, content, reason);
      return true;
    }
    if (file.startsWith('cards/') && isSafeRelativePath(file)) {
      await saveVersion(config.vaultDir, file, content, reason);
      return true;
    }
    return false;
  };
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

function closeServer(server, timeoutMs = 5_000, writesDone = Promise.resolve()) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    writesDone.then(() => {
      if (settled) return;
      timer = setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, timeoutMs);
      timer.unref?.();
    });
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
  let draftCleanup;
  const writes = new Set();
  async function trackWrite(operation) {
    if (stopping) throw Object.assign(new Error('应用正在停止，请稍后重试。'), { status: 503 });
    const result = Promise.resolve().then(operation);
    writes.add(result);
    try { return await result; } finally { writes.delete(result); }
  }

  try {
    await Promise.all([config.vaultDir, config.notesDir, config.reviewsDir, config.attachmentsDir]
      .map(directory => fs.mkdir(directory, { recursive: true })));

    sync = createSync({
      vaultDir: config.vaultDir,
      logger,
      enabled: gitWritesEnabled,
      reviewSyncEnabled: config.syncEnabled,
      pauseWrites: withWritesPaused,
      preserveDiscarded: createDiscardPreserver(config)
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
      db, indexer, search, sync, syncReviewNow, guide, trackWrite,
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

    // 顺手清掉 30 天没动过的草稿；只读模式不产生草稿，也不该动磁盘。
    if (!config.readOnly) {
      draftCleanup = pruneDrafts(config.notesDir).then(removed => {
        if (removed) logger.log?.(`[history] 清理了 ${removed} 份超过 30 天的草稿`);
      }).catch(error => logger.warn?.(`[history] 清理旧草稿失败：${error.message}`));
    }

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
        // 排在前一轮后面、等到开始时应用已经在退出：不再起新的一轮，免得拖长退出等待。
        if (stopping) return { ok: true, skipped: '应用正在退出' };
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
        const writesDone = Promise.allSettled([...writes, draftCleanup]);
        const closed = closeServer(server, 5_000, writesDone);
        await settle(() => finishSync(sync, async () => {
          await syncNowQueue;
          await sync.idle();
        }, EXIT_WAIT_MS, logger));
        await settle(() => closed);
        await writesDone;
        if (gitWritesEnabled && finalSync && !sync.getStatus().recovery) {
          await settle(() => finishSync(sync, () => sync.commitAndPush(
            '科研工作台退出前提交 ' + new Date().toISOString(), { timeout: EXIT_GIT_TIMEOUT_MS }
          ), EXIT_WAIT_MS, logger));
        }
        await settle(() => indexer.idle());
        await settle(() => db.close());
        if (failure) throw failure;
      })();
      return stopPromise;
    }

    async function abortGitOperation() {
      if (config.readOnly) return { ok: false, error: '只读模式下不能中止 Git 操作。', recovery: sync.getStatus().recovery };
      const result = await sync.abortOperation();
      if (result.ok && result.aborted) await indexer.scan();
      return result;
    }

    // 冲突文件逐个选了保留哪一边之后：文件内容变了要重扫索引；Git 回到正常状态的话
    // 紧接着在后台同步一轮，把结果推上去，不用再去点一次「立即同步」。
    async function resolveGitConflicts(choices) {
      if (config.readOnly) return { ok: false, error: '只读模式下不能处理冲突；请先在设置里关掉只读。', recovery: sync.getStatus().recovery };
      const result = await sync.resolveConflicts(choices);
      if (result.resolved) await indexer.scan();
      if (result.ok && result.resolved && !result.recovery) {
        syncNow().catch(error => logger.warn?.(`[sync] ${error.message}`));
      }
      return result;
    }

    return {
      app, server, db, config, sync, indexer, origin, syncNow, syncReviewNow, stop, indexReady,
      getIndexStatus: () => ({ ...indexer.getStatus(), notes: db.countNotes() }),
      rescan: () => indexer.scan({ kind: 'background' }),
      isWatchDegraded: () => Boolean(watcher?.isDegraded()),
      getSyncStatus: sync.getStatus, onSyncStatus: sync.onStatus, abortGitOperation,
      listGitConflicts: () => sync.listConflicts(), resolveGitConflicts
    };
  } catch (error) {
    if (syncTimer) clearInterval(syncTimer);
    try { watcher?.close(); } catch {}
    stopping = true;
    const writesDone = Promise.allSettled([...writes, draftCleanup]);
    try { await closeServer(server, 5_000, writesDone); } catch {}
    await writesDone;
    try { await sync?.idle(); } catch {}
    try { await indexer?.idle(); } catch {}
    try { db?.close(); } catch {}
    throw error;
  }
}

module.exports = { startRuntime, closeServer, finishSync, createDiscardPreserver };
