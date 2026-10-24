const fs = require('node:fs');

const { toPosix } = require('./paths');

const DEBOUNCE_MS = 300;
// fs.watch 在 Windows 上也可能不报个别事件，因此始终低频全量对账；文件没变时
// 只需 stat，30 秒足以兜底又不会抢占正常操作。
const FALLBACK_POLL_MS = 30_000;

/**
 * 编辑器写文件时的中间产物。
 *
 * 这些必须挡在最前面：它们既不是笔记，也不代表目录变动。放过去的话，
 * 每保存一次就会被判成「不认识的路径」而触发一次全量重扫。
 *
 * 其中 `.tmp-` 是本应用自己原子写入时留下的（writeNote 先写 `x.md.tmp-<pid>-<uuid>`
 * 再 rename），vim 用 `4913` 和 `~`，各种编辑器还会用 `.swp` / `.swx`。
 */
function isEditorNoise(name) {
  const base = name.split('/').pop() || '';
  return base.startsWith('.')
    || base.endsWith('~')
    || base === '4913'
    || /\.tmp-/.test(base)
    || /\.(swp|swx|swo)$/i.test(base);
}

/**
 * 监听资料库目录，把变更批量交给调用方。
 *
 * 为什么用 `fs.watch` 而不是 chokidar：这个应用发 Windows 和 macOS，递归监听在
 * 这两个平台上都是操作系统原生支持的，Node 直接透传。多一个依赖既要打进安装包，
 * 又要跟着 Electron 的 ABI 走，不值当。
 *
 * 回调拿到的是 `{ paths, full }`：
 *   - `paths` 是能明确对应到某篇笔记的相对路径，走增量重扫；
 *   - `full` 为真表示出现了无法归因的事件（目录被改名、事件没带文件名），
 *     这时只能整体重扫一次 —— 一个目录改名会影响它下面所有笔记的路径。
 */
function createWatcher({
  dir,
  onChange,
  debounceMs = DEBOUNCE_MS,
  fallbackPollMs = FALLBACK_POLL_MS,
  logger = console,
  watch = fs.watch
} = {}) {
  let watcher = null;
  let timer = null;
  let fallbackTimer = null;
  let closed = false;
  let pending = new Set();
  let pendingFull = false;
  let degraded = false;

  function flush() {
    timer = null;
    if (closed) return;

    const paths = [...pending];
    const full = pendingFull;
    pending = new Set();
    pendingFull = false;

    if (!full && paths.length === 0) return;
    try {
      const result = onChange({ paths, full });
      // onChange 通常是异步的。它自己失败不该把监听器一起带走，否则一次
      // 扫描出错就等于从此不再感知外部编辑。
      if (result && typeof result.catch === 'function') {
        result.catch(error => logger.warn?.(`[watch] 重扫失败：${error.message}`));
      }
    } catch (error) {
      logger.warn?.(`[watch] 重扫失败：${error.message}`);
    }
  }

  function schedule() {
    if (closed || timer) return;
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  }

  function record(eventType, filename) {
    // 事件没带文件名：拿不到就只能整体重扫。
    if (!filename) {
      pendingFull = true;
      schedule();
      return;
    }

    const relative = toPosix(filename);
    if (isEditorNoise(relative)) return;

    if (relative.toLowerCase().endsWith('.md')) {
      pending.add(relative);
    } else {
      // 既不是笔记也不是编辑器中间产物 —— 多半是目录改名或整个目录被移走。
      // 猜不出影响范围，老实重扫。
      pendingFull = true;
    }
    schedule();
  }

  function startPolling() {
    if (fallbackTimer || closed) return;
    fallbackTimer = setInterval(() => {
      pendingFull = true;
      schedule();
    }, fallbackPollMs);
    fallbackTimer.unref?.();
  }

  function degrade(reason) {
    if (degraded || closed) return;
    degraded = true;
    logger.warn?.(`[watch] ${reason}，保留每 ${Math.round(fallbackPollMs / 1000)} 秒轮询。`);
  }

  function start() {
    startPolling();
    try {
      watcher = watch(dir, { recursive: true }, record);
    } catch (error) {
      // 网络盘、某些容器文件系统上递归监听可能直接不可用。这不该让应用起不来 ——
      // 轮询仍能发现改动，只是没有事件驱动的低延迟更新。
      degrade(`无法监听资料库（${error.code || error.message}）`);
      return { ok: false, degraded: true, reason: error.message };
    }

    watcher.on('error', error => {
      try { watcher.close(); } catch {}
      watcher = null;
      degrade(`监听中断（${error.code || error.message}）`);
    });

    return { ok: true, degraded: false };
  }

  function close() {
    closed = true;
    if (timer) clearTimeout(timer);
    if (fallbackTimer) clearInterval(fallbackTimer);
    timer = null;
    fallbackTimer = null;
    if (watcher) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
  }

  return { start, close, isDegraded: () => degraded };
}

module.exports = { createWatcher, isEditorNoise, DEBOUNCE_MS, FALLBACK_POLL_MS };
