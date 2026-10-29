const path = require('node:path');
const express = require('express');
const { ensureSafeFilePath, isSafeRelativePath } = require('../vault/paths');
const { httpError } = require('./http');

// Markdown 已生成这些本地地址；只读取媒体文件，不挂载整个资料库。
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);
const MEDIA_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.mov']);

function createResourceRoutes({ config }) {
  const router = express.Router();
  function serve(directory) {
    return async (req, res, next) => {
      const relative = req.params.resourcePath.join('/');
      const extension = path.extname(relative).toLowerCase();
      // 以点开头的文件和目录不对外提供，和笔记索引跳过点目录的规则一致。
      if (!isSafeRelativePath(relative) || relative.split('/').some(segment => segment.startsWith('.'))
        || (!IMAGE_EXTENSIONS.has(extension) && !MEDIA_EXTENSIONS.has(extension))) {
        next(httpError(404, '附件不存在或不是支持的媒体文件。'));
        return;
      }
      let absolute;
      try {
        absolute = await ensureSafeFilePath(config.vaultDir, directory + '/' + relative);
      } catch {
        next(httpError(404, '附件不存在或无法读取。'));
        return;
      }
      // SVG 等文件直接打开时同样只允许被动展示，不运行附件中的脚本。
      res.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'");
      // dotfiles: 'allow'：send 默认检查绝对路径的每一段，资料库放在 ~/.notes 这类
      // 点目录下时所有附件都会 404。附件自身的相对路径上面已经排除了点开头的段。
      res.sendFile(absolute, { dotfiles: 'allow' }, error => { if (error) next(error); });
    };
  }
  router.get('/attachments/*resourcePath', serve('attachments'));
  router.get('/media/*resourcePath', serve('audio'));
  return router;
}

module.exports = { createResourceRoutes };
