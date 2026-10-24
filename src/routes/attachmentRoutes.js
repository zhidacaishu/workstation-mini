const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

const { createBlobCache } = require('../blobs/cache');
const { toAbsolute, toPosix, encodePath } = require('../vault/paths');
const { replaceFile } = require('../vault/atomic');
const { httpError, blockWhenReadOnly } = require('./http');

const ATTACHMENTS_DIR = 'attachments';

// 上传单个附件的上限。比存储服务那边的 2GiB 小得多：走编辑器拖拽这条路的
// 是插图和 PDF，几百 MB 的东西该用别的方式放进 audio/，不该从编辑器里塞。
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

const EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,12}$/;

/**
 * 从原始文件名里取一个安全的词干，用来让附件路径还能看出是什么东西。
 *
 * 全部替换成哈希当然更简单，但 `attachments/2026-08/a3f9c2b1.png` 这种名字
 * 在文件管理器里翻起来毫无意义 —— 而 vault 是要能用别的工具直接打开的。
 */
function slugOf(name) {
  const stem = String(name || '').replace(EXTENSION_PATTERN, '');
  const slug = stem
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return slug || 'file';
}

function extensionOf(name) {
  const match = String(name || '').match(EXTENSION_PATTERN);
  return match ? match[0].toLowerCase() : '';
}

function createAttachmentRoutes({ config, blobs, logger = console, now = () => new Date() }) {
  const router = express.Router();
  const guard = blockWhenReadOnly(config, '不能上传附件。');
  const cache = createBlobCache({ vaultDir: config.vaultDir, blobs, logger });

  /**
   * 接收上传。
   *
   * 请求体就是文件本身，不走 multipart —— 前端 `fetch(url, { body: file })`
   * 直接发原始字节，一个文件一个请求，表单编码那套没有东西可以承载。
   * 顺带避开了引入 multer 这个依赖。
   */
  router.post('/attachments', guard, async (req, res, next) => {
    const stamp = now();
    const month = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}`;
    const original = String(req.query.name || '').trim();
    const extension = extensionOf(original);

    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      next(httpError(413, `附件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。`));
      return;
    }

    const scratchDir = path.join(config.vaultDir, ATTACHMENTS_DIR, month);
    await fsp.mkdir(scratchDir, { recursive: true });
    const temporary = path.join(scratchDir, `.tmp-${process.pid}-${crypto.randomUUID()}`);

    try {
      // 边写盘边算哈希：内容寻址让同一张图重复粘贴不会存两份，
      // 而流式处理保证 200MB 的东西不会先整个进内存。
      const hash = crypto.createHash('sha256');
      let size = 0;

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(temporary);
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };

        req.on('data', chunk => {
          size += chunk.length;
          hash.update(chunk);
          if (size > MAX_UPLOAD_BYTES && !settled) {
            req.unpipe(out);
            out.destroy();
            req.resume();
            finish(httpError(413, `附件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。`));
          }
        });
        req.on('error', finish);
        out.on('error', finish);
        out.on('close', () => finish());
        req.pipe(out);
      });

      if (size === 0) throw httpError(400, '上传的内容是空的。');

      const digest = hash.digest('hex').slice(0, 8);
      const relative = `${ATTACHMENTS_DIR}/${month}/${slugOf(original)}-${digest}${extension}`;
      await replaceFile(temporary, toAbsolute(config.vaultDir, relative));

      // 推到存储服务。推失败不算上传失败：文件已经在本地了，笔记也能引用，
      // 下一轮对账会把它补上去。这里只如实报告推没推成功。
      const pushed = blobs?.configured
        ? await blobs.upload(relative, config.vaultDir)
        : { available: false, reason: '未配置大文件存储服务，附件只存在本机。' };

      res.json({
        ok: true,
        path: relative,
        url: `/${encodePath(relative)}`,
        size,
        uploaded: Boolean(pushed.ok),
        ...(pushed.ok ? {} : { warning: pushed.reason })
      });
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      next(error);
    }
  });

  // 先过缓存中间件：本地没有就去存储服务取一份回来，取完再交给 static。
  // Range、ETag、条件请求全部由 static 负责，不自己重写一遍。
  router.use(
    `/${ATTACHMENTS_DIR}`,
    cache.middleware(ATTACHMENTS_DIR),
    express.static(path.join(config.vaultDir, ATTACHMENTS_DIR), {
      dotfiles: 'deny',
      index: false
    })
  );

  return router;
}

module.exports = { createAttachmentRoutes, ATTACHMENTS_DIR, MAX_UPLOAD_BYTES, slugOf };
