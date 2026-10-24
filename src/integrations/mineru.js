const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const API_BASE = 'https://mineru.net/api/v4';
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const TERMINAL_FAILURE_STATES = new Set(['failed', 'error', 'cancelled', 'canceled']);

// 轮询的三个上限。没有它们的话，MinerU 侧卡在 running 就是一个永不 settle 的
// Promise —— 而解析队列是严格串行的，一个卡住的任务会让后面排队的 PDF 永远
// 停在「等待解析」，界面上还看不出原因。超时失败反而是安全的：batch ID 留在
// manifest 里，用户再点一次会接着轮询同一个批次，不会重复上传也不会重复计费。
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_DEADLINE_MS = 2 * 60 * 60 * 1000;
// 单个 JSON 请求的时限。等待上限只在 result() **返回之后**才检查，所以一个
// 永不响应的连接照样能把串行队列钉死 —— 请求本身也得有时限才关得住这个洞。
// 上传和下载不设固定时限（几百 MB 传多久取决于网络），靠 undici 的无活动超时。
const REQUEST_TIMEOUT_MS = 60_000;

function abortError() {
  const error = new Error('操作已中止。');
  error.name = 'AbortError';
  return error;
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = operation => {
      signal?.removeEventListener('abort', onAbort);
      operation();
    };
    const timer = setTimeout(() => finish(resolve), milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(abortError()));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout(signal, milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return signal;
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError';
}

function safeMessage(value, fallback = 'MinerU 请求失败。') {
  const message = String(value || '')
    .replace(/https?:\/\/\S+/gi, '[地址]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|private|tmp|var\/folders|Volumes)\/)[^\s"'<>]+/g, '[路径]')
    .trim();
  return message ? message.slice(0, 500) : fallback;
}

async function jsonResponse(response, label) {
  if (!response.ok) {
    // 不读掉响应体的话，undici 要等 GC 才肯释放这条连接。
    await response.text().catch(() => {});
    throw new Error(`${label}失败（HTTP ${response.status}）。`);
  }
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new Error(`${label}返回了无效 JSON。`);
  }
  if (Number(payload?.code) !== 0) {
    throw new Error(safeMessage(payload?.msg, `${label}失败（代码 ${payload?.code ?? '未知'}）。`));
  }
  return payload.data || {};
}

function createMineruClient({
  token,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxPollIntervalMs = POLL_MAX_INTERVAL_MS,
  pollDeadlineMs = POLL_DEADLINE_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  sleep = wait
} = {}) {
  const apiToken = String(token || '');

  function configured() {
    return Boolean(apiToken);
  }

  function authHeaders(extra = {}) {
    if (!configured()) throw new Error('请先在应用设置中配置 MinerU API Token。');
    return { authorization: `Bearer ${apiToken}`, ...extra };
  }

  async function requestJson(url, options, label) {
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      if (isTimeout(error)) throw new Error(`${label}超时未响应。`);
      throw error;
    }
    return jsonResponse(response, label);
  }

  async function createTask({ fileName, dataId, signal }) {
    const data = await requestJson(`${API_BASE}/file-urls/batch`, {
      method: 'POST',
      signal: withTimeout(signal, requestTimeoutMs),
      headers: authHeaders({
        accept: 'application/json',
        'content-type': 'application/json'
      }),
      body: JSON.stringify({
        files: [{ name: fileName, data_id: dataId }],
        model_version: 'vlm'
      })
    }, '创建 MinerU 解析任务');
    const batchId = String(data.batch_id || '');
    const uploadUrl = Array.isArray(data.file_urls) ? String(data.file_urls[0] || '') : '';
    if (!batchId || !uploadUrl) throw new Error('MinerU 没有返回完整的上传任务。');
    let parsed;
    try { parsed = new URL(uploadUrl); } catch { throw new Error('MinerU 返回了无效上传地址。'); }
    if (parsed.protocol !== 'https:') throw new Error('MinerU 上传地址不是 HTTPS。');
    return { batchId, uploadUrl };
  }

  async function uploadFile({ uploadUrl, filePath, size, signal }) {
    if (!Number.isFinite(size) || size < 1) throw new Error('PDF 是空文件，无法上传解析。');
    if (size > MAX_PDF_BYTES) throw new Error('PDF 必须小于等于 200 MB。');
    const body = fs.createReadStream(filePath);
    try {
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        signal,
        body,
        duplex: 'half',
        headers: { 'content-length': String(size) }
      });
      if (!response.ok) throw new Error(`上传 PDF 至 MinerU 失败（HTTP ${response.status}）。`);
    } finally {
      body.destroy();
    }
  }

  async function result(batchId, { signal } = {}) {
    const safeBatchId = String(batchId || '');
    if (!/^[A-Za-z0-9_-]+$/.test(safeBatchId)) throw new Error('MinerU batch ID 无效。');
    const data = await requestJson(`${API_BASE}/extract-results/batch/${encodeURIComponent(safeBatchId)}`, {
      signal: withTimeout(signal, requestTimeoutMs),
      headers: authHeaders({ accept: 'application/json' })
    }, '查询 MinerU 解析状态');
    const entry = Array.isArray(data.extract_result) ? data.extract_result[0] : null;
    if (!entry) throw new Error('MinerU 没有返回文件解析状态。');
    const state = String(entry.state || 'pending').toLowerCase();
    if (TERMINAL_FAILURE_STATES.has(state)) {
      throw new Error(safeMessage(entry.err_msg, 'MinerU 解析失败。'));
    }
    const progress = entry.extract_progress && typeof entry.extract_progress === 'object'
      ? {
          extractedPages: Number(entry.extract_progress.extracted_pages) || 0,
          totalPages: Number(entry.extract_progress.total_pages) || 0
        }
      : null;
    if (state === 'done') {
      const zipUrl = String(entry.full_zip_url || '');
      let parsed;
      try { parsed = new URL(zipUrl); } catch { throw new Error('MinerU 没有返回有效的解析结果地址。'); }
      if (parsed.protocol !== 'https:') throw new Error('MinerU 解析结果地址不是 HTTPS。');
      return { state, progress, zipUrl };
    }
    return { state, progress, zipUrl: '' };
  }

  async function waitForResult(batchId, { signal, onProgress, deadlineMs = pollDeadlineMs } = {}) {
    const deadline = Date.now() + deadlineMs;
    let interval = pollIntervalMs;
    for (;;) {
      const status = await result(batchId, { signal });
      await onProgress?.(status);
      if (status.state === 'done') return status;
      if (Date.now() >= deadline) {
        throw new Error('MinerU 解析超过等待上限仍未完成，可稍后在文献页重试同一个任务。');
      }
      await sleep(interval, signal);
      // 退避：固定 2 秒轮询一天就是四万多次请求，容易撞上 MinerU 的限流。
      interval = Math.min(Math.round(interval * 1.5), maxPollIntervalMs);
    }
  }

  async function downloadResult({ zipUrl, targetPath, signal }) {
    let parsed;
    try { parsed = new URL(String(zipUrl || '')); } catch { throw new Error('MinerU 解析结果地址无效。'); }
    if (parsed.protocol !== 'https:') throw new Error('MinerU 解析结果地址不是 HTTPS。');
    const response = await fetchImpl(parsed, { signal, headers: { accept: 'application/zip' } });
    if (!response.ok || !response.body) {
      throw new Error(`下载 MinerU 解析结果失败（HTTP ${response.status}）。`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) throw new Error('MinerU 解析结果压缩包过大。');

    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > MAX_ZIP_BYTES) callback(new Error('MinerU 解析结果压缩包过大。'));
        else callback(null, chunk);
      }
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        limiter,
        fs.createWriteStream(targetPath, { flags: 'wx' }),
        { signal }
      );
      return { size: received };
    } catch (error) {
      await fsp.rm(targetPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    configured,
    createTask,
    uploadFile,
    result,
    waitForResult,
    downloadResult
  };
}

module.exports = {
  API_BASE,
  MAX_PDF_BYTES,
  MAX_ZIP_BYTES,
  POLL_INTERVAL_MS,
  POLL_MAX_INTERVAL_MS,
  POLL_DEADLINE_MS,
  REQUEST_TIMEOUT_MS,
  createMineruClient,
  safeMessage,
  wait
};
