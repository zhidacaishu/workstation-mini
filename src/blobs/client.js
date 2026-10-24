const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { toAbsolute, toPosix, encodePath, ensureSafeTargetParent } = require('../vault/paths');
const { replaceFile } = require('../vault/atomic');
const { normalizeBlobBaseUrl } = require('./url');
const { fingerprint } = require('./integrity');
const { enqueueFile } = require('../vault/note-queue');

// 列目录和删除是小请求，30 秒够了。传文件不设这个超时 —— 一份 200MB 的音频
// 在慢上行链路上跑几分钟是正常的，用固定超时掐掉只会让它永远传不完。
const METADATA_TIMEOUT_MS = 30_000;
// 带 sha256 的列表要服务端把前缀下每个文件读一遍，几十 GB 的音频库在机械盘
// 上要好几分钟。沿用 30 秒的话大库每次都超时，恢复就退回不带摘要的校验。
const INTEGRITY_LIST_TIMEOUT_MS = 30 * 60_000;

/**
 * 大文件存储服务的客户端。
 *
 * 没配服务器时返回 `{ available: false, reason }` 而不是抛错 —— 和 llm.js、
 * checkDraft.js 一个路数：外部依赖缺席时功能降级，不能让整个应用不可用。
 * 本地已经有的附件在没配服务器时照样能看。
 */
function createBlobClient({ baseUrl, token, logger = console } = {}) {
  const rawBase = String(baseUrl || '').trim();
  let base = '';
  let invalidReason = '';
  if (rawBase) {
    try {
      base = normalizeBlobBaseUrl(rawBase);
    } catch (error) {
      invalidReason = error.message;
    }
  }
  const configured = Boolean(base && String(token || '').trim());

  function unavailable() {
    return {
      available: false,
      reason: invalidReason || (rawBase
        ? '大文件存储服务缺少访问令牌，请在应用设置中补上。'
        : '未在应用设置中配置大文件存储服务地址。')
    };
  }

  function urlFor(relative) {
    return `${base}/blobs/${encodePath(relative)}`;
  }

  function headers() {
    return { 'x-workstation-blob-token': token };
  }

  async function describeFailure(response) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch {}
    return message;
  }

  /** 列出服务器上的资源，供对账用。 */
  async function list({ prefix = '', integrity = '', signal } = {}) {
    if (!configured) return unavailable();
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (integrity) params.set('integrity', integrity);
    const query = params.size ? `?${params}` : '';
    const timeout = AbortSignal.timeout(integrity ? INTEGRITY_LIST_TIMEOUT_MS : METADATA_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/blobs${query}`, {
        headers: headers(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      if (!response.ok) {
        return { available: true, ok: false, status: response.status, reason: await describeFailure(response) };
      }
      const body = await response.json();
      return { available: true, ok: true, blobs: body.blobs || [], conditionalWrites: body.conditionalWrites === true };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      // 超时和网络错误是「这次没列成」，不是「服务不支持」—— 调用方要能分清，
      // 否则一次超时就会被当成旧服务，悄悄降级成不校验摘要。
      return { available: true, ok: false, transient: true, reason: error.message };
    }
  }

  /**
   * 把服务器上的资源取下来写进本地。
   *
   * 同样先写临时文件再 rename：下到一半断网不能留下一个看起来完整的
   * 半截文件，否则本地缓存命中它之后就再也不会去重新取了。
   */
  async function download(relative, targetDir, options = {}) {
    if (!configured) return unavailable();

    const {
      signal,
      expectedSize,
      expectedSha256 = '',
      exclusive = false,
      expectedLocalSha256,
      onProgress
    } = options;
    const absolute = toAbsolute(targetDir, relative);
    const temporary = path.join(
      path.resolve(targetDir),
      `.blob-download.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    const digest = crypto.createHash('sha256');
    let received = 0;

    try {
      await ensureSafeTargetParent(targetDir, absolute, { create: true });
      const response = await fetch(urlFor(relative), { headers: headers(), signal });
      if (response.status === 404) {
        return { available: true, ok: false, missing: true, reason: `服务器上没有：${relative}` };
      }
      if (!response.ok) return { available: true, ok: false, reason: await describeFailure(response) };
      if (!response.body) return { available: true, ok: false, reason: '服务器没有返回文件内容。' };

      const total = Number(response.headers.get('content-length')) || Number(expectedSize) || 0;
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          digest.update(chunk);
          onProgress?.({ path: toPosix(relative), received, total });
          callback(null, chunk);
        }
      });
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        fs.createWriteStream(temporary, { flags: 'wx' }),
        { signal }
      );

      if (Number.isFinite(expectedSize) && received !== Number(expectedSize)) {
        return {
          available: true,
          ok: false,
          integrity: true,
          reason: `文件大小不一致：预期 ${expectedSize} 字节，实际 ${received} 字节。`
        };
      }
      const sha256 = digest.digest('hex');
      if (expectedSha256 && sha256 !== String(expectedSha256).toLowerCase()) {
        return { available: true, ok: false, integrity: true, reason: '文件内容摘要不一致。' };
      }

      await ensureSafeTargetParent(targetDir, absolute);
      if (exclusive) {
        try {
          await fsp.link(temporary, absolute);
        } catch (error) {
          if (error.code === 'EEXIST') {
            return { available: true, ok: false, conflict: true, reason: `本地已存在：${relative}` };
          }
          throw error;
        }
      } else {
        await enqueueFile(targetDir, relative, async () => {
          if (expectedLocalSha256 !== undefined) {
            let current = '';
            try { current = (await fingerprint(targetDir, relative, { signal })).sha256; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (current !== expectedLocalSha256) throw new Error('本地文件已变化，未覆盖。');
          }
          await replaceFile(temporary, absolute);
        });
      }
      return { available: true, ok: true, path: toPosix(relative), size: received, sha256 };
    } catch (error) {
      return {
        available: true,
        ok: false,
        aborted: error.name === 'AbortError',
        reason: error.name === 'AbortError' ? '下载已取消。' : error.message
      };
    } finally {
      await fsp.rm(temporary, { force: true });
    }
  }

  /** 把本地文件推到服务器。 */
  async function upload(relative, sourceDir, { signal, expectedSha256 } = {}) {
    if (!configured) return unavailable();

    const absolute = toAbsolute(sourceDir, relative);
    let stats;
    try {
      stats = await fsp.stat(absolute);
    } catch (error) {
      return { available: true, ok: false, reason: `本地没有这个文件：${relative}` };
    }

    try {
      const response = await fetch(urlFor(relative), {
        method: 'PUT',
        headers: {
          ...headers(),
          ...(expectedSha256 !== undefined ? { 'x-workstation-expected-sha256': expectedSha256 } : {}),
          'content-type': 'application/octet-stream',
          'content-length': String(stats.size)
        },
        // 只读声明过的长度：文件在上传途中还在变长时，多出来的部分不属于这次上传，
        // 否则请求体和 content-length 对不上，整个请求直接失败。
        body: stats.size > 0
          ? Readable.toWeb(fs.createReadStream(absolute, { start: 0, end: stats.size - 1 }))
          : new Uint8Array(0),
        // Node 的 fetch 在带流式 body 时要求显式声明，否则直接报错。
        duplex: 'half',
        signal
      });
      if (!response.ok) return { available: true, ok: false, reason: await describeFailure(response) };
      let stored = stats.size;
      let sha256 = '';
      try {
        const body = await response.json();
        if (Number.isSafeInteger(body?.size)) stored = body.size;
        sha256 = body?.sha256 || '';
      } catch {}
      return { available: true, ok: true, path: toPosix(relative), size: stored, sha256 };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return { available: true, ok: false, reason: error.message };
    }
  }

  async function remove(relative, { expectedSha256, signal } = {}) {
    if (!configured) return unavailable();
    try {
      const response = await fetch(urlFor(relative), {
        method: 'DELETE',
        headers: { ...headers(), ...(expectedSha256 !== undefined ? { 'x-workstation-expected-sha256': expectedSha256 } : {}) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]) : AbortSignal.timeout(METADATA_TIMEOUT_MS)
      });
      if (!response.ok && response.status !== 404) {
        return { available: true, ok: false, reason: await describeFailure(response) };
      }
      return { available: true, ok: true };
    } catch (error) {
      return { available: true, ok: false, reason: error.message };
    }
  }

  // origin 是规范化后的服务地址：本机对账记录按它分开存，换一台存储服务时
  // 旧服务的记录不会被拿来推断新服务上的「删除」。
  return { configured, origin: base, list, download, upload, remove, logger };
}

module.exports = { createBlobClient };
