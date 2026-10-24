const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { toAbsolute, toPosix } = require('../vault/paths');
const { replaceFile } = require('../vault/atomic');
const { enqueueFile } = require('../vault/note-queue');

// 2 GiB。不是能力上限，是「一份研究资料不该比这更大」的止损线：
// 超过它多半是误拖了整个数据集或虚拟机镜像，宁可拒收也不要把磁盘塞满。
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

async function hashFile(filePath, algorithm) {
  const digest = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

class BlobError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 二进制资源的文件系统层。
 *
 * 只认 vault 相对路径（正斜杠），所有越界判断都在这里做完，
 * 上面的 HTTP 层不需要再想路径安全的事。
 */
function createBlobStore({ root, maxBytes = DEFAULT_MAX_BYTES }) {
  if (!root) throw new Error('大文件存储缺少根目录。');

  // 带摘要的列表每次都要把文件整个读一遍。摘要按「路径 + 大小 + mtime + inode」
  // 缓存在进程里：写入走临时文件 + rename，内容一变这几项必然跟着变。
  const HASH_CACHE_LIMIT = 100_000;
  const hashCache = new Map();

  async function cachedSha256(full, stats) {
    const signature = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
    const cached = hashCache.get(full);
    if (cached?.signature === signature) return cached.sha256;
    const sha256 = await hashFile(full, 'sha256');
    if (hashCache.size >= HASH_CACHE_LIMIT) hashCache.clear();
    hashCache.set(full, { signature, sha256 });
    return sha256;
  }

  let rootRealPromise;
  function rootReal() {
    // 缓存 realpath：根目录本身可能就是个符号链接（/var 在 macOS 上就是），
    // 每次请求都解一遍纯属浪费，而它在进程生命周期内不会变。
    rootRealPromise ||= fsp.mkdir(root, { recursive: true }).then(() => fsp.realpath(root));
    return rootRealPromise;
  }

  function within(base, target) {
    return target === base || target.startsWith(base + path.sep);
  }

  /**
   * 点号开头的路径段一律拒绝。
   *
   * `isSafeRelativePath` 只拦 `.` 和 `..` 本身，`.hidden` 是放行的。但列表会跳过
   * 点号条目、下载也 `dotfiles: 'deny'` —— 允许写入就会造出一个存得进去、
   * 列不出来、也读不回来的文件。与其留这种自相矛盾的状态，不如直接不收。
   */
  function assertVisible(relative) {
    const segments = toPosix(relative).split('/');
    if (segments.some(segment => segment.startsWith('.'))) {
      throw new BlobError(400, `路径不能包含点号开头的部分：${relative}`);
    }
  }

  /**
   * 解析相对路径并确认它真的落在根目录里面。
   *
   * `toAbsolute` 挡的是路径字符串层面的穿越（`../`、盘符、UNC），它的注释里
   * 明确说了不管符号链接 —— 在本地索引场景下这没问题，因为扫描时不跟随链接。
   * 但这个存储是要挂到网络上的：根目录里放一个指向 `/etc` 的软链，
   * 光靠字符串校验就能被读走任意文件。所以这里必须再解一次 realpath。
   */
  async function resolveExisting(relative) {
    const base = await rootReal();
    assertVisible(relative);
    let absolute;
    try {
      absolute = toAbsolute(base, relative);
    } catch (error) {
      throw new BlobError(400, `路径不合法：${relative}`);
    }

    let real;
    try {
      real = await fsp.realpath(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw new BlobError(404, `没有这个文件：${relative}`);
      throw error;
    }
    if (!within(base, real)) throw new BlobError(400, `路径越界：${relative}`);

    const stats = await fsp.stat(real);
    if (!stats.isFile()) throw new BlobError(400, `不是普通文件：${relative}`);
    return { absolute: real, size: stats.size, mtimeMs: stats.mtimeMs };
  }

  /** 写入前的解析：文件可以不存在，但它的父目录必须真的在根目录里面。 */
  async function resolveForWrite(relative) {
    const base = await rootReal();
    assertVisible(relative);
    let absolute;
    try {
      absolute = toAbsolute(base, relative);
    } catch (error) {
      throw new BlobError(400, `路径不合法：${relative}`);
    }

    const parent = path.dirname(absolute);
    await fsp.mkdir(parent, { recursive: true });
    const parentReal = await fsp.realpath(parent);
    if (!within(base, parentReal)) throw new BlobError(400, `路径越界：${relative}`);

    return path.join(parentReal, path.basename(absolute));
  }

  async function stat(relative) {
    return resolveExisting(relative);
  }

  async function openRead(relative) {
    return resolveExisting(relative);
  }

  /**
   * 从可读流写入一个二进制资源。
   *
   * 先写临时文件再整体 rename：中途断线（手机切网、笔记本合盖）只会留下
   * 一个临时文件，不会让一个半截的 m4a 冒充完整素材躺在那里 —— 那种损坏
   * 要等到播放时才发现，比直接失败糟糕得多。
   */
  async function checkVersion(relative, expectedSha256) {
    if (expectedSha256 === undefined) return;
    let actual = '';
    try { actual = await hashFile((await resolveExisting(relative)).absolute, 'sha256'); }
    catch (error) { if (error.status !== 404) throw error; }
    if (actual !== expectedSha256) throw new BlobError(409, '远端文件已变化，未覆盖或删除。');
  }

  async function write(relative, source, { declaredSize, expectedSha256 } = {}) {
    const absolute = await resolveForWrite(relative);

    // 有 Content-Length 就先看一眼再决定收不收。等把 2GB 收完再说「太大了」
    // 既浪费带宽又浪费磁盘，而绝大多数客户端都会带上这个头。
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new BlobError(413, `文件超过 ${maxBytes} 字节的上限。`);
    }

    const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const out = fs.createWriteStream(temporary);
    let size = 0;

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        function finish(error) {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        }

        source.on('data', chunk => {
          size += chunk.length;
          if (size <= maxBytes || settled) return;
          // 停止落盘，但**不掐断连接**：destroy 掉请求流的话客户端只会看到
          // 一个连接重置，根本不知道是超限了。改成把剩下的请求体读完丢掉，
          // 让 413 这个响应能正常发回去。
          source.unpipe(out);
          out.destroy();
          source.resume();
          finish(new BlobError(413, `文件超过 ${maxBytes} 字节的上限。`));
        });

        // 上游断了也要把写入流收掉。不收的话文件描述符一直开着，
        // 底下 catch 里的 rm 在 Windows 上会 EBUSY，把真正的错误盖成一个假象。
        source.on('error', error => {
          source.unpipe(out);
          out.destroy();
          finish(error);
        });
        out.on('error', finish);
        // 等 close 而不是 finish：Windows 上文件描述符还开着就 rename 会 EBUSY。
        out.on('close', () => finish());
        source.pipe(out);
      });

      const sha256 = await hashFile(temporary, 'sha256');
      await enqueueFile(root, relative, async () => {
        await checkVersion(relative, expectedSha256);
        await replaceFile(temporary, absolute);
      });
      return { path: toPosix(relative), size, sha256 };
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    }
  }

  async function remove(relative, { expectedSha256 } = {}) {
    return enqueueFile(root, relative, async () => {
      await checkVersion(relative, expectedSha256);
      const { absolute } = await resolveExisting(relative);
      await fsp.rm(absolute, { force: true });
      return { path: toPosix(relative) };
    });
  }

  /**
   * 列出资源，供客户端对账用。
   *
   * 不跟随符号链接，理由和 listNotes 一样：一个指向根目录外面的链接
   * 会把整块磁盘列进来。点号开头的目录一并跳过。
   */
  async function list({ prefix = '', integrity = '' } = {}) {
    if (integrity && integrity !== 'sha256') {
      throw new BlobError(400, `不支持的完整性算法：${integrity}`);
    }
    const base = await rootReal();
    let start = base;
    if (prefix) {
      start = path.join(base, ...toPosix(prefix).split('/').filter(Boolean));
      if (!within(base, start)) throw new BlobError(400, `前缀越界：${prefix}`);
      // 字符串校验挡不住符号链接：根目录里放一个指向 /etc 的 audio 链接，
      // readdir 会跟着走，把外面的文件名全列进对账清单。下面的 walk 会跳过
      // 子目录里的链接，但**起点自己**没人查过 —— 和 resolveExisting 一样解一次。
      //
      // 只拿 realpath 做判断，仍从原路径往下走：这样列出来的相对路径还是
      // 用户请求的那个前缀，不会因为中间有个库内软链就换一套名字。
      let real;
      try {
        real = await fsp.realpath(start);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      if (!within(base, real)) throw new BlobError(400, `前缀越界：${prefix}`);
    }

    const blobs = [];
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          // 断电或中途失败留下的临时文件不该出现在对账清单里，
          // 否则客户端会把它当成一份真素材拉下来。
          if (/\.tmp-/.test(entry.name)) continue;
          const stats = await fsp.stat(full);
          const blob = {
            path: toPosix(path.relative(base, full)),
            size: stats.size,
            mtimeMs: Math.floor(stats.mtimeMs)
          };
          if (integrity === 'sha256') blob.sha256 = await cachedSha256(full, stats);
          blobs.push(blob);
        }
      }
    }

    await walk(start);
    blobs.sort((left, right) => left.path.localeCompare(right.path));
    return blobs;
  }

  return { stat, openRead, write, remove, list, maxBytes };
}

module.exports = { createBlobStore, BlobError, DEFAULT_MAX_BYTES };
