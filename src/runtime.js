const fs = require('node:fs/promises');
const http = require('node:http');

const { createApp } = require('./app');
const { openDatabase } = require('./db');
const { createIndexer } = require('./vault/indexer');
const { createWatcher } = require('./vault/watcher');
const { createSearch } = require('./search');
const { createSync } = require('./sync');

// 退出前那次提交推送的 git 期限。比常规同步的 60 秒短得多：
// 退出时用户在等，宁可放弃这一轮推送，也不能让应用看起来卡死。
const EXIT_GIT_TIMEOUT_MS = 15_000;

// 退出时给进行中的大文件对账留的收尾时间。上传和下载都是先写临时文件再整体
// rename，半路中止不会在任何一边留下半截文件 —— 所以不必等一份几百 MB 的音频
// 在慢上行链路上传完，让「点了退出」变成十几分钟的等待。
const BLOB_STOP_GRACE_MS = 5_000;

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

async function startRuntime(config, {
  logger = console,
  watcherOptions = {},
  initialBlobReconcile = true,
  // 对账要删除本地文件时（别的设备删掉了它）怎么删。桌面端传系统回收站，
  // 误删还能找回来；不传就直接删除。
  trashItem = null,
  blobStopGraceMs = BLOB_STOP_GRACE_MS
} = {}) {
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
  let blobQueue = Promise.resolve();
  const blobController = new AbortController();
  // Git 拉取删掉的托管大文件路径，交给对账只补齐、不当作删除传播（见 sync.js）。
  const gitRemovedMedia = new Set();
  let stopPromise;
  let stopping = false;

  try {
    await Promise.all([
      config.vaultDir,
      config.notesDir,
      config.reviewsDir,
      config.attachmentsDir
    ].map(directory => fs.mkdir(directory, { recursive: true })));

    // 配了大文件存储才把 audio/、attachments/ 排除出 Git。没配的话这些素材
    // 只存在本地，再把它们从版本库里摘掉就等于没有任何备份。
    const blobs = null;

    sync = createSync({
      vaultDir: config.vaultDir,
      logger,
      enabled: gitWritesEnabled,
      reviewSyncEnabled: config.syncEnabled,
      ignoreMedia: false,
      onMediaRemoved: paths => {
        for (const item of paths) gitRemovedMedia.add(item);
      }
    });
    await sync.probe();
    if (gitWritesEnabled) {
      const ignored = await sync.ensureGitignore();
      if (ignored.ok === false && ignored.blocked !== 'recovery-required') {
        logger.warn?.(`[sync] ${ignored.error}`);
      }
      // 摘掉媒体忽略规则是一次影响备份口径的改动，别让它悄悄发生：
      // 这些目录从此重新进 Git，仓库会变大，用户有权知道为什么。
      if (ignored.removed?.length) {
        logger.log?.(
          `[sync] 已不再配置大文件存储服务，${ignored.removed.join('、')} 重新纳入 Git，`
          + '以免这些素材在任何地方都没有备份。'
        );
      }
    }

    if (gitWritesEnabled && !sync.getStatus().recovery) {
      const pulled = await sync.pull();
      if (pulled.skipped) logger.log?.(`[sync] 跳过拉取（${pulled.skipped}）`);
    }

    db = openDatabase(config.dbPath, { logger });

    indexer = createIndexer({
      db,
      vaultDir: config.notesDir
    });

    const search = createSearch(db);
    const app = createApp(config, {
      db,
      indexer,
      search,
      sync,
      syncReviewNow,
      similarity,
      blobs,
      getIndexStatus: () => ({ ...indexer.getStatus(), notes: db.countNotes() })
    });
    server = http.createServer(app);
    await listen(server, config.port, config.host);

    // 首次扫描放到监听之后，而且**不等它**。
    //
    // 原来这一步挡在 listen() 前面：3000 篇的 vault 冷启动要 13.5 秒，这期间
    // 窗口只能干等。而且这不是一次性的 —— schema 版本一升就整库重建，
    // 等于每次发带解析改动的新版本，所有用户都要再等一次。
    const indexReady = indexer.scan({ kind: 'initial' }).then(stats => {
      logger.log?.(
        `[index] ${db.countNotes()} 篇笔记`
        + `（新增 ${stats.added} / 更新 ${stats.updated} / 移除 ${stats.removed} / 未变 ${stats.unchanged}）`
      );
      return stats;
    }).catch(error => {
      logger.warn?.(`[index] 首次扫描失败：${error.message}`);
      throw error;
    });
    // 没人 await 的话，扫描失败会变成未处理的 Promise 拒绝。
    indexReady.catch(() => {});

    // 外部编辑（Obsidian、任何编辑器、脚本）也要进索引。没有这一步的话，
    // 在别处改完笔记回到应用里是搜不到的 —— 而「Markdown 是唯一真相、
    // 随便什么编辑器都能打开」正是这个应用的立身之本。
    watcher = createWatcher({
      ...watcherOptions,
      dir: config.notesDir,
      logger,
      onChange: ({ paths, full }) => {
        if (stopping) return undefined;
        return (full ? indexer.scan() : indexer.scan({ paths })).then(stats => {
          if (stats.added || stats.updated || stats.removed) {
            logger.log?.(
              `[watch] 外部改动已入索引`
              + `（新增 ${stats.added} / 更新 ${stats.updated} / 移除 ${stats.removed}）`
            );
          }
        });
      }
    });
    watcher.start();

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法确定内部服务地址。');
    const origin = `http://${config.host}:${address.port}`;

    /**
     * 二进制资源对账。
     *
     * 和 Git 同步分开排队：它可能要传一份几百 MB 的音频，跟 git 挤在一条队列上
     * 会让「立即同步」等到天荒地老。两者操作的目录也不重叠 —— Git 管文本，
     * 它管 audio/ 和 attachments/。
     */
    function reconcileNow() {
      if (stopping) return Promise.resolve({ ok: true, skipped: '应用正在退出' });
      if (config.readOnly) return Promise.resolve({ ok: true, skipped: '只读模式不上传' });

      const result = blobQueue.then(() => reconcileBlobs({
        vaultDir: config.vaultDir,
        blobs,
        logger,
        signal: blobController.signal,
        restoreOnly: gitRemovedMedia,
        state: {
          load: prefix => db.listBlobSyncState(blobs.origin, prefix),
          save: (prefix, entries) => db.replaceBlobSyncState(blobs.origin, prefix, entries)
        },
        ...(trashItem ? { removeLocal: trashItem } : {})
      })).catch(error => {
        // 退出时主动中止的对账不是失败，别在日志里留一条假警报。
        if (blobController.signal.aborted) return { ok: true, skipped: '应用正在退出' };
        throw error;
      });
      blobQueue = result.catch(() => {});
      return result;
    }

    async function syncReviewNow(message = `复习记录 ${new Date().toISOString()}`) {
      if (!config.syncEnabled) return { ok: true, committed: false, pushed: false, changed: false, skipped: '同步未启用' };
      if (stopping) return { ok: true, committed: false, pushed: false, changed: false, skipped: '应用正在退出' };
      const recovery = sync.getStatus().recovery;
      if (recovery) {
        return { ok: false, committed: false, pushed: false, changed: false, blocked: 'recovery-required', recovery };
      }
      const outcome = await sync.syncReviewLogs(config.device, message);
      if (outcome.changed) await indexer.scan();
      return outcome;
    }

    function syncNow(message = `科研工作台同步 ${new Date().toISOString()}`) {
      if (!gitWritesEnabled) return Promise.resolve({ ok: true, skipped: '同步已关闭' });
      if (stopping) return Promise.resolve({ ok: true, skipped: '应用正在退出' });
      const recovery = sync.getStatus().recovery;
      if (recovery) return Promise.resolve({ ok: false, blocked: 'recovery-required', recovery });

      // 顺手把二进制也对一遍。用户点「立即同步」的心理预期是「让两边一致」，
      // 不会分「文本走 Git、二进制走存储服务」—— 那是实现细节。
      //
      // 放在 Git 这一轮之后：拉取可能从工作区删掉托管文件（别的设备 detach 过），
      // 对账要先知道这些删除来自 Git，才不会把它们当成用户删除传到服务器上去。
      // 对账不等 Git 以外的任何东西，也不挡住这里的返回值。
      const result = syncNowQueue.then(async () => {
        try {
          const outcome = await sync.cycle(message);
          if (outcome.changed) await indexer.scan();
          return outcome;
        } finally {
        }
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

    /**
     * 停止运行时。
     *
     * finalSync 只在真正退出应用时才该开着。改设置引起的重启不需要它：
     * 新运行时启动时会先拉取，本轮未提交的改动也会在下一次定时同步里带走 ——
     * 而把 git 放在重启路径上，会让「改个设备名」也要等一轮推送，
     * 推送失败还会把一份本来合法的新配置连带回滚掉。
     *
     * 结果会被记住：先调用的那次决定用不用 finalSync。
     */
    async function stop({ finalSync = true } = {}) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopping = true;
        if (syncTimer) clearInterval(syncTimer);
        // 先摘掉监听：再有文件事件也不该排新的扫描进来。
        watcher?.close();
        let failure;

        async function settle(operation) {
          try {
            return await operation();
          } catch (error) {
            failure ||= error;
            return undefined;
          }
        }

        await settle(() => closeServer(server));
        await settle(() => syncNowQueue);
        // 等对账收尾，但只等一小会儿：之后中止进行中的传输。半路中止是安全的
        // （两边都是临时文件 + rename），而无限期等下去会让退出卡在一次大上传上。
        await settle(() => Promise.race([
          blobQueue,
          new Promise(resolve => {
            const timer = setTimeout(resolve, blobStopGraceMs);
            timer.unref?.();
          })
        ]));
        blobController.abort();
        await settle(() => blobQueue);
        await settle(() => Promise.all([sync.idle(), indexer.idle()]));

        if (gitWritesEnabled && finalSync && !sync.getStatus().recovery) {
          // 退出路径上用更短的 git 期限：默认 60 秒乘上一串 git 调用，
          // 远端不通时会让应用「点了退出但半天不消失」，用户只会去强杀。
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
      app,
      server,
      db,
      config,
      sync,
      indexer,
      origin,
      syncNow,
      syncReviewNow,
      reconcileNow,
      blobs,
      stop,
      // 首次扫描的句柄。启动不再等它，但需要「索引已就绪」这个确定状态的
      // 调用方（测试、冒烟检查）可以自己 await。
      indexReady,
      getIndexStatus: () => ({ ...indexer.getStatus(), notes: db.countNotes() }),
      rescan: () => indexer.scan(),
      isWatchDegraded: () => Boolean(watcher?.isDegraded()),
      getSyncStatus: sync.getStatus,
      onSyncStatus: sync.onStatus,
      abortGitOperation
    };
  } catch (error) {
    blobController.abort();
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
