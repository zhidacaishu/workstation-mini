const fsp = require('node:fs/promises');
const path = require('node:path');

const { toAbsolute, toPosix, ensureSafeFilePath } = require('../vault/paths');
const { fingerprint } = require('./integrity');

// 这两个目录不进 Git，由存储服务托管。对账就是让本地和服务器互相补齐。
const MANAGED_PREFIXES = ['audio', 'attachments'];

// 最近这么久内还在变的本地文件先不上传：用户往 audio/ 里拷一个几百 MB 的
// 素材时，对账可能正好撞上拷到一半的那一刻，传上去的就是个截断版本。
const SETTLE_MS = 60_000;

// 一轮里要传播的删除超过这个数、且占上次同步记录的比例超过阈值时，这个方向
// 整轮不删。成批消失更像是目录没挂上、被别的程序清空，而不是用户逐个删的。
const MASS_DELETE_MIN = 5;
const MASS_DELETE_RATIO = 0.25;

/**
 * 列出本地某个前缀下的全部文件。
 *
 * 跳过的东西和存储服务那边保持一致：点号条目、符号链接、上传残留的临时文件。
 * 两边规则不一致的话，对账会把同一批文件反复判成「缺失」然后来回传。
 *
 * 值是 `{ size, mtimeMs }`。
 */
async function listLocal(vaultDir, prefix) {
  const root = path.join(vaultDir, prefix);
  const found = new Map();

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      if (/\.tmp-/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stats = await fsp.stat(full);
        found.set(toPosix(path.relative(vaultDir, full)), { size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
  }

  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('托管目录不能是符号链接。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await walk(root);
  return found;
}

function massive(count, recorded) {
  return count > MASS_DELETE_MIN && count > recorded * MASS_DELETE_RATIO;
}

/**
 * 本地与存储服务对账。
 *
 * 双向补齐，而不是只往下拉：跟读素材是用户自己往 `audio/` 里放的，
 * 这个目录又已经不进 Git 了 —— 只拉不推的话，手动放进去的音频哪里都没有备份，
 * 换台机器就永远消失了。
 *
 * `state` 是「上次对账结束时两边都有、且大小一致的文件」的本机记录（见
 * db.js 的 blob_sync_state）。有了它，「一边缺」才分得清是「另一边新增的」
 * 还是「这一边删掉的」，「两边大小不同」也才分得清是哪一边改的：
 *
 *   - 记录里有、本地没了、服务器仍是记录的大小 → 本地删了，删服务器那份；
 *   - 记录里有、服务器没了、本地仍是记录的大小 → 别的设备删了，删本地这份；
 *     （删掉的那边之后另一边又改过的话，改动优先，补齐回来）
 *   - 服务器仍是记录里的大小、本地变了 → 本地改了，上传覆盖；
 *   - 本地仍是记录里的大小、服务器变了 → 别处改了，下载覆盖；
 *   - 两边都变了                        → 冲突，只报告。
 *
 * 没有记录（新设备、删过索引库、脚本调用）时退回纯补齐：宁可让删掉的文件
 * 回来，也不凭猜测去删一份可能是唯一的副本。某一边整个前缀是空的（刚 clone、
 * 服务器换了空目录）同样按「没有记录」处理，成批的删除则整轮不做。
 */
async function reconcileBlobs({
  vaultDir,
  blobs,
  prefixes = MANAGED_PREFIXES,
  logger = console,
  state = null,
  removeLocal = target => fsp.rm(target, { force: true }),
  settleMs = SETTLE_MS,
  now = () => Date.now(),
  // Git 拉取时从工作区删掉的托管文件（典型是别的设备执行了 detach-blobs，
  // `git rm --cached` 在拉取方会真的删文件）。它们不是用户删的，只补齐不传播删除。
  restoreOnly = new Set(),
  signal
} = {}) {
  if (!blobs?.configured) {
    return { ok: true, skipped: '未配置大文件存储服务' };
  }

  const summary = {
    ok: true,
    downloaded: 0,
    uploaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    deferred: [],
    heldDeletions: [],
    mismatched: [],
    failed: []
  };

  for (const prefix of prefixes) {
    signal?.throwIfAborted();
    const remote = await blobs.list({ prefix, integrity: 'sha256', signal });
    if (!remote.ok) {
      summary.ok = false;
      summary.failed.push({ prefix, reason: remote.reason });
      logger.warn?.(`[blobs] 列出 ${prefix} 失败：${remote.reason}`);
      continue;
    }

    if (!remote.conditionalWrites || remote.blobs.some(blob => !/^[a-f0-9]{64}$/.test(blob.sha256 || ''))) {
      summary.failed.push({ prefix, reason: '存储服务缺少内容校验或条件写入能力，请升级服务后同步。' });
      continue;
    }
    const remoteFiles = new Map(remote.blobs.map(blob => [blob.path, blob]));
    const remoteSizes = new Map(remote.blobs.map(blob => [blob.path, blob.sha256]));
    const localFiles = await listLocal(vaultDir, prefix);
    for (const [relative, file] of localFiles) {
      Object.assign(file, await fingerprint(vaultDir, relative, { signal }));
    }
    const oldRecords = state ? await state.load(prefix) : new Map();
    // Old size-only records cannot justify destructive decisions.
    let recorded = new Map([...oldRecords].filter(([, value]) => value?.sha256).map(([key, value]) => [key, value.sha256]));
    // 一边整个是空的：更像是新环境，而不是用户把所有东西都删了。
    if (recorded.size > 0 && (localFiles.size === 0 || remoteSizes.size === 0)) {
      logger.warn?.(`[blobs] ${prefix} 有一边完全为空，本轮只补齐不删除。`);
      recorded = new Map();
    }

    const synced = new Map();

    // 用绝对差：mtime 在未来（相机时钟超前、拷贝时保留了原时间）的文件不可能是
    // 「正在写」的 —— 正在写的文件 mtime 一直被刷新成当前时间。
    const settled = file => Math.abs(now() - file.mtimeMs) >= settleMs;

    // 没做成的操作（推迟、失败）要把旧记录原样留下，否则下一轮会把
    // 「本地改过、服务器还是旧的」误判成双方都变了的冲突。
    function keep(relative, previous) {
      if (previous !== undefined && oldRecords.get(relative)?.sha256 === previous) synced.set(relative, oldRecords.get(relative));
    }

    async function upload(relative, file, previous) {
      if (!settled(file)) {
        summary.deferred.push(relative);
        keep(relative, previous);
        return;
      }
      const result = await blobs.upload(relative, vaultDir, { signal, expectedSha256: remoteSizes.get(relative) || '' });
      if (result.ok) {
        summary.uploaded += 1;
        // 记服务器实际收下的大小，而不是本地此刻的大小：文件在上传期间又变了的话，
        // 下一轮看到「服务器等于记录、本地不等」就会再传一次，而不是永久卡成冲突。
        if (result.sha256) synced.set(relative, { size: result.size, sha256: result.sha256 });
      } else {
        summary.failed.push({ path: relative, reason: result.reason });
        keep(relative, previous);
      }
    }

    async function download(relative, digest, previous) {
      const result = await blobs.download(relative, vaultDir, {
        signal, expectedSha256: digest, expectedLocalSha256: localFiles.get(relative)?.sha256 || '',
        exclusive: !localFiles.has(relative)
      });
      if (result.ok) {
        summary.downloaded += 1;
        synced.set(relative, { size: result.size, sha256: result.sha256 });
        restoreOnly.delete(relative);
      } else {
        summary.failed.push({ path: relative, reason: result.reason });
        keep(relative, previous);
      }
    }

    // 先只做分类，不在循环里传文件：删除要在传输之前、紧挨着列表执行，
    // 否则中间隔着几分钟的大文件传输，删的就是一份过时判断。
    const transfers = [];
    const plannedLocalDeletes = [];
    const plannedRemoteDeletes = [];
    const paths = [...new Set([...remoteSizes.keys(), ...localFiles.keys()])].sort();
    for (const relative of paths) {
      const local = localFiles.get(relative);
      const remoteSize = remoteSizes.get(relative);
      const previous = recorded.get(relative);

      if (local && remoteSize !== undefined) {
        if (local.sha256 === remoteSize) {
          synced.set(relative, { size: local.size, sha256: remoteSize });
        } else if (previous !== undefined && remoteSize === previous) {
          transfers.push(() => upload(relative, local, previous));
        } else if (previous !== undefined && local.sha256 === previous) {
          transfers.push(() => download(relative, remoteSize, previous));
        } else {
          summary.mismatched.push({ path: relative, local: local.size, remote: remoteFiles.get(relative)?.size });
        }
      } else if (local) {
        // 别处删了，但这边在那之后又改过：改动比删除新，推上去而不是删掉。
        if (previous !== undefined && local.sha256 === previous) plannedLocalDeletes.push(relative);
        else transfers.push(() => upload(relative, local));
      } else if (previous !== undefined && remoteSize === previous && !restoreOnly.has(relative)) {
        plannedRemoteDeletes.push(relative);
      } else {
        // 这边删了、别处又改过，或者是 Git 拉取时删掉的（见 restoreOnly）：取回。
        transfers.push(() => download(relative, remoteSize, previous));
      }
    }

    if (massive(plannedRemoteDeletes.length, recorded.size)) {
      summary.heldDeletions.push(...plannedRemoteDeletes.map(item => ({ path: item, side: 'remote' })));
      for (const relative of plannedRemoteDeletes) keep(relative, recorded.get(relative));
    } else if (plannedRemoteDeletes.length > 0) {
      // 删之前再列一次：列表之后另一台设备可能刚传上来一个新版本。
      const fresh = await blobs.list({ prefix, integrity: 'sha256', signal });
      const freshSizes = fresh.ok ? new Map(fresh.blobs.map(blob => [blob.path, blob.sha256])) : null;
      for (const relative of plannedRemoteDeletes) {
        signal?.throwIfAborted();
        const previous = recorded.get(relative);
        if (!freshSizes) {
          summary.failed.push({ path: relative, reason: fresh.reason });
          keep(relative, previous);
          continue;
        }
        if (!freshSizes.has(relative)) continue;
        if (freshSizes.get(relative) !== previous || restoreOnly.has(relative)) {
          transfers.push(() => download(relative, freshSizes.get(relative), previous));
          continue;
        }
        const result = await blobs.remove(relative, { expectedSha256: previous, signal });
        if (result.ok) summary.deletedRemote += 1;
        else {
          summary.failed.push({ path: relative, reason: result.reason });
          keep(relative, previous);
        }
      }
    }

    if (massive(plannedLocalDeletes.length, recorded.size)) {
      summary.heldDeletions.push(...plannedLocalDeletes.map(item => ({ path: item, side: 'local' })));
      for (const relative of plannedLocalDeletes) keep(relative, recorded.get(relative));
    } else {
      for (const relative of plannedLocalDeletes) {
        signal?.throwIfAborted();
        const listed = localFiles.get(relative);
        const absolute = toAbsolute(vaultDir, relative);
        // 同理，删之前再看一眼：列表之后本地又写过（重新录了一版）就不是同一个文件了。
        let current;
        try {
          current = await fingerprint(vaultDir, relative, { signal });
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          summary.failed.push({ path: relative, reason: error.message });
          keep(relative, recorded.get(relative));
          continue;
        }
        if (current.sha256 !== listed.sha256) {
          transfers.push(() => upload(relative, current));
          continue;
        }
        try {
          await ensureSafeFilePath(vaultDir, relative);
          await removeLocal(absolute);
          summary.deletedLocal += 1;
        } catch (error) {
          summary.failed.push({ path: relative, reason: error.message });
          keep(relative, recorded.get(relative));
        }
      }
    }

    for (const transfer of transfers) {
      signal?.throwIfAborted();
      await transfer();
    }

    if (state) await state.save(prefix, synced);
  }

  if (summary.failed.length > 0) summary.ok = false;

  if (summary.downloaded || summary.uploaded || summary.deletedLocal || summary.deletedRemote) {
    logger.log?.(
      `[blobs] 对账完成：取回 ${summary.downloaded} 个，上传 ${summary.uploaded} 个，`
      + `同步删除本地 ${summary.deletedLocal} 个、服务器 ${summary.deletedRemote} 个`
    );
  }
  for (const item of summary.mismatched) {
    logger.warn?.(
      `[blobs] ${item.path} 两边内容不一致（本地 ${item.local} / 服务器 ${item.remote}），`
      + '未自动处理，请自己确认保留哪一份。'
    );
  }
  if (summary.deferred.length > 0) {
    logger.log?.(`[blobs] ${summary.deferred.length} 个本地文件最近还在写入，推迟到下一轮再上传：${summary.deferred.join('、')}`);
  }
  if (summary.heldDeletions.length > 0) {
    logger.warn?.(
      `[blobs] 有 ${summary.heldDeletions.length} 个文件在一边成批消失，比例异常，本轮没有同步删除；`
      + '确认是有意删除后，请在另一边也手工删掉它们。'
    );
  }
  for (const item of summary.failed) {
    logger.warn?.(`[blobs] ${item.path || item.prefix} 处理失败：${item.reason}`);
  }

  return summary;
}

module.exports = { reconcileBlobs, listLocal, MANAGED_PREFIXES, SETTLE_MS };
