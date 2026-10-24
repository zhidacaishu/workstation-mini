const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { isSafeRelativePath, toAbsolute, toPosix } = require('../vault/paths');
const { MANAGED_PREFIXES } = require('./reconcile');

async function sha256File(filePath) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

async function localFile(relative, vaultDir, expectedSha256) {
  const absolute = toAbsolute(vaultDir, relative);
  try {
    const stats = await fsp.lstat(absolute);
    if (stats.isSymbolicLink() || !stats.isFile()) return { conflict: true };
    return {
      size: stats.size,
      sha256: expectedSha256 ? await sha256File(absolute) : ''
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function publicFailure(path, code, retryable = true) {
  const messages = {
    'list-failed': '无法列出远端大文件。',
    'download-failed': '大文件下载失败。',
    'missing-remote': '远端已没有这个大文件。',
    'local-conflict': '本地已有不同内容，未覆盖。',
    'local-read-failed': '无法核对本地已有文件。',
    'integrity-failed': '下载内容未通过完整性校验。',
    'invalid-metadata': '远端返回了不合法的大文件元数据。'
  };
  return { path: toPosix(path), code, reason: messages[code], retryable };
}

function aborted(signal, error) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

// 只有服务明确拒绝了这个参数（4xx，典型是不认识的算法）才算「不支持摘要」。
// 超时、断网、5xx 都只是这次没列成：降级成不带摘要的列表会让恢复悄悄少一层
// 校验，还会被报成「旧服务」—— 应当按列出失败处理，让用户重试。
function integrityUnsupported(result) {
  if (result?.transient) return false;
  const status = Number(result?.status);
  if (Number.isFinite(status)) return status >= 400 && status < 500 && status !== 408 && status !== 429;
  return true;
}

async function listRemote(blobs, prefix, signal) {
  try {
    const verified = await blobs.list({ prefix, integrity: 'sha256', signal });
    if (verified?.ok) return { response: verified, integrityUnavailable: false };
    if (!integrityUnsupported(verified)) return { response: null, integrityUnavailable: false };
    const compatible = await blobs.list({ prefix, signal });
    if (compatible?.ok) return { response: compatible, integrityUnavailable: true };
    return { response: null, integrityUnavailable: false };
  } catch (error) {
    if (aborted(signal, error)) throw signal?.reason || error;
    return { response: null, integrityUnavailable: false };
  }
}

function validBlob(blob, prefix) {
  const relative = toPosix(blob?.path);
  const size = Number(blob?.size);
  const sha256 = String(blob?.sha256 || '').toLowerCase();
  return isSafeRelativePath(relative)
    && (relative === prefix || relative.startsWith(`${prefix}/`))
    && Number.isSafeInteger(size)
    && size >= 0
    && (!sha256 || /^[0-9a-f]{64}$/.test(sha256));
}

async function downloadMissingBlobs({
  vaultDir,
  blobs,
  prefixes = MANAGED_PREFIXES,
  retryPaths = null,
  signal,
  onProgress
} = {}) {
  if (!vaultDir) throw new Error('恢复大文件缺少目标资料库。');
  if (typeof blobs?.list !== 'function' || typeof blobs?.download !== 'function') {
    throw new Error('恢复大文件需要只读的 list/download 客户端。');
  }

  const selected = retryPaths ? new Set([...retryPaths].map(toPosix)) : null;
  const summary = {
    ok: true,
    partial: false,
    downloaded: 0,
    existing: 0,
    integrityUnavailable: false,
    checkedPaths: [],
    failed: []
  };

  for (const prefix of prefixes) {
    signal?.throwIfAborted();
    const listed = await listRemote(blobs, prefix, signal);
    if (!listed.response) {
      summary.failed.push(publicFailure(prefix, 'list-failed'));
      continue;
    }
    if (listed.integrityUnavailable) summary.integrityUnavailable = true;

    if (selected?.has(prefix)) summary.checkedPaths.push(prefix);
    for (const blob of listed.response.blobs || []) {
      signal?.throwIfAborted();
      if (!validBlob(blob, prefix)) {
        summary.failed.push(publicFailure(prefix, 'invalid-metadata', false));
        continue;
      }
      const relative = toPosix(blob.path);
      if (selected && !selected.has(prefix) && !selected.has(relative)) continue;
      summary.checkedPaths.push(relative);
      if (!blob.sha256) summary.integrityUnavailable = true;

      let local;
      try {
        local = await localFile(relative, vaultDir, blob.sha256);
      } catch (error) {
        if (aborted(signal, error)) throw signal?.reason || error;
        summary.failed.push(publicFailure(relative, 'local-read-failed'));
        continue;
      }
      if (local) {
        if (!local.conflict
          && local.size === Number(blob.size)
          && (!blob.sha256 || local.sha256 === String(blob.sha256).toLowerCase())) {
          summary.existing += 1;
        } else {
          summary.failed.push(publicFailure(relative, 'local-conflict', false));
        }
        continue;
      }

      let result;
      try {
        result = await blobs.download(relative, vaultDir, {
          signal,
          expectedSize: Number(blob.size),
          expectedSha256: blob.sha256 || '',
          exclusive: true,
          onProgress: progress => onProgress?.({ ...progress, prefix })
        });
      } catch (error) {
        if (aborted(signal, error)) throw signal?.reason || error;
        summary.failed.push(publicFailure(relative, 'download-failed'));
        continue;
      }
      if (result?.aborted || signal?.aborted) throw signal?.reason || new DOMException('Aborted', 'AbortError');
      if (result?.ok) {
        summary.downloaded += 1;
      } else {
        const code = result?.missing
          ? 'missing-remote'
          : result?.integrity ? 'integrity-failed' : 'download-failed';
        summary.failed.push(publicFailure(relative, code));
      }
    }
  }

  summary.partial = summary.failed.length > 0 || summary.integrityUnavailable;
  summary.ok = !summary.partial;
  return summary;
}

function createBlobRestore(options) {
  let retryPaths = new Set();
  let unresolved = new Map();
  let integrityUnavailable = false;

  async function execute(runOptions = {}) {
    const result = await downloadMissingBlobs({ ...options, ...runOptions });
    for (const checkedPath of result.checkedPaths) unresolved.delete(checkedPath);
    for (const failure of result.failed) unresolved.set(failure.path, failure);
    integrityUnavailable ||= result.integrityUnavailable;
    const failed = [...unresolved.values()];
    retryPaths = new Set(failed.filter(item => item.retryable).map(item => item.path));
    return {
      ...result,
      ok: failed.length === 0 && !integrityUnavailable,
      partial: failed.length > 0 || integrityUnavailable,
      integrityUnavailable,
      failed
    };
  }

  function run(runOptions = {}) {
    retryPaths = new Set();
    unresolved = new Map();
    integrityUnavailable = false;
    return execute(runOptions);
  }

  function retry(runOptions = {}) {
    return execute({ ...runOptions, retryPaths: new Set(retryPaths) });
  }

  function pending() {
    return [...retryPaths].sort();
  }

  return { run, retry, pending };
}

module.exports = { downloadMissingBlobs, createBlobRestore, sha256File };
