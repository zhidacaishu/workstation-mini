const fsp = require('node:fs/promises');

const { toAbsolute, toPosix, isSafeRelativePath } = require('../vault/paths');

/**
 * 二进制资源的本地缓存。
 *
 * vault 里的 `attachments/`、`audio/` 不再进 Git，本地那份就退化成了缓存：
 * 有就直接用，没有就从存储服务拉一份下来再用。拉过一次就留在本地，
 * 所以离线时看过的附件照样能看 —— 这是「本地端」这三个字的底线。
 */
function createBlobCache({ vaultDir, blobs, logger = console }) {
  // 同一个文件的并发请求合并成一次下载。一篇笔记里同一张图出现两次、
  // 或者浏览器重试，都不该变成两次网络传输和两次写盘。
  const inflight = new Map();

  async function existsLocally(relative) {
    try {
      await fsp.access(toAbsolute(vaultDir, relative));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保某个 vault 相对路径在本地存在。
   *
   * 返回值只说明「现在本地有没有」，不抛错：调用方是静态文件服务，
   * 拉不到就让它照常走 404，比抛异常变成 500 更贴近事实 —— 文件确实没有。
   */
  async function ensureLocal(relative) {
    const target = toPosix(relative);
    if (!target || !isSafeRelativePath(target)) return false;
    if (await existsLocally(target)) return true;
    if (!blobs?.configured) return false;

    if (!inflight.has(target)) {
      const task = blobs.download(target, vaultDir)
        .then(result => {
          if (result.ok) {
            logger.log?.(`[blobs] 已从存储服务取回 ${target}（${result.size} 字节）`);
            return true;
          }
          // 服务器上也没有是正常情况（本来就没上传过），不值得当错误刷屏。
          if (!result.missing) {
            logger.warn?.(`[blobs] 取回 ${target} 失败：${result.reason}`);
          }
          return false;
        })
        .catch(error => {
          logger.warn?.(`[blobs] 取回 ${target} 失败：${error.message}`);
          return false;
        })
        .finally(() => inflight.delete(target));
      inflight.set(target, task);
    }
    return inflight.get(target);
  }

  /**
   * 挂在 express.static 前面的中间件。
   *
   * 命中本地就立刻放行；没命中才去回源，回源完再交给 static 去做真正的
   * 文件服务 —— Range、ETag、条件请求都还是 static 那一套，不自己重写。
   */
  function middleware(prefix) {
    return (req, res, next) => {
      let relative;
      try {
        relative = decodeURIComponent(req.path).replace(/^\/+/, '');
      } catch {
        next();
        return;
      }
      if (!relative) {
        next();
        return;
      }
      ensureLocal(`${prefix}/${relative}`).then(() => next(), () => next());
    };
  }

  return { ensureLocal, middleware };
}

module.exports = { createBlobCache };
