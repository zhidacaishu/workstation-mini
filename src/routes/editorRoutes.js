const express = require('express');
const fsp = require('node:fs/promises');

const { renderMarkdown } = require('../markdown');
const { renderClozeAnswer } = require('../cards');
const { parseNote } = require('../vault/note');
const { buildIndexResolver } = require('../vault/wikilink');
const { enqueueFile } = require('../vault/note-queue');
const { ensureSafeFilePath, isNotePath, toPosix, stripExtension, basename, withNoteExtension } = require('../vault/paths');
const { toLocalDate } = require('../templates');
const { httpError, blockWhenReadOnly } = require('./http');

const ATTACHMENTS_DIR = 'attachments';
const IMAGE_LIMIT = 15 * 1024 * 1024;
const SUGGEST_LIMIT = 8;

/**
 * 按文件开头的特征字节认图片类型，不信请求头里的 Content-Type：
 * 这个接口往资料库里写文件，只收确实是位图的内容。SVG 是可以带脚本的文本，不收。
 */
function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return '';
}

function createEditorRoutes({ config, db, now = () => new Date() }) {
  const router = express.Router();
  const resolver = () => buildIndexResolver(db);

  /**
   * 编辑时的实时预览。和阅读页同一套渲染，但待办不能勾、未建的双链不指向新建页：
   * 预览只是给人看排出来的样子。
   */
  router.post('/api/preview', (req, res, next) => {
    try {
      const raw = String(req.body.raw ?? '');
      const options = { anchors: false, readOnly: true, taskToggle: false, today: res.locals.today };
      if (req.body.kind === 'card') {
        const resolve = resolver();
        res.json({ html: renderClozeAnswer(raw, text => renderMarkdown(text, resolve, options)),
          frontHtml: renderMarkdown(String(req.body.front || ''), resolve, options) });
        return;
      }
      const requested = toPosix(String(req.body.path || '')).trim();
      const notePath = requested && isNotePath(withNoteExtension(requested)) ? withNoteExtension(requested) : 'inbox/preview.md';
      let note;
      try {
        note = parseNote(notePath, raw);
      } catch (error) {
        // 属性区写到一半时解析不了很正常：告诉预览栏原因，正文等写完再排。
        res.json({ html: '', error: `属性区还解析不了：${String(error.reason || error.message).split('\n')[0]}` });
        return;
      }
      res.json({ html: renderMarkdown(note.body, resolver(), { ...options, notePath }) });
    } catch (error) { next(error); }
  });

  /**
   * `[[` 补全。返回可以直接写进双链的目标：文件名在全库唯一时只写文件名，
   * 否则写完整路径 —— 和解析器认的两种写法一致（见 wikilink.buildResolver）。
   */
  router.get('/api/link-suggest', (req, res) => {
    const query = String(req.query.q || '').trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const rows = db.listNoteTitles();
    const basenameCount = new Map();
    for (const row of rows) {
      const name = stripExtension(basename(row.path));
      basenameCount.set(name, (basenameCount.get(name) || 0) + 1);
    }
    const scored = [];
    for (const row of rows) {
      const title = String(row.title || '');
      const path = stripExtension(row.path);
      const lowerTitle = title.toLowerCase();
      const lowerPath = path.toLowerCase();
      if (!terms.every(term => lowerTitle.includes(term) || lowerPath.includes(term))) continue;
      let score = 0;
      if (query) {
        if (lowerTitle === query) score += 100;
        else if (lowerTitle.startsWith(query)) score += 60;
        else if (lowerTitle.includes(query)) score += 40;
        else if (lowerPath.includes(query)) score += 20;
      }
      // 月历备注数量多、很少被链接，排到后面。
      if (row.path.startsWith('calendar/')) score -= 30;
      const name = stripExtension(basename(row.path));
      scored.push({ score, title: title || name, path: row.path, target: basenameCount.get(name) === 1 ? name : path });
    }
    scored.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title, 'zh-Hans-CN'));
    res.json({ results: scored.slice(0, SUGGEST_LIMIT).map(({ title, path, target }) => ({ title, path, target })) });
  });

  /**
   * 粘贴或拖入的图片：存进 attachments/，文件名用时间，返回可以直接写进正文的嵌入写法。
   * 请求体就是图片本身。只在这条路由上放宽体积上限。
   */
  router.post('/api/attachments',
    blockWhenReadOnly(config, '不能添加附件。'),
    express.raw({ type: () => true, limit: IMAGE_LIMIT }),
    async (req, res, next) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (data.length === 0) throw httpError(400, '没有收到图片内容。');
        const extension = sniffImage(data);
        if (!extension) throw httpError(415, '只能粘贴 PNG、JPEG、GIF 或 WebP 图片。');

        const at = now();
        const pad = number => String(number).padStart(2, '0');
        const stamp = `${toLocalDate(at).replaceAll('-', '')}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
        let name = '';
        for (let attempt = 1; attempt <= 50 && !name; attempt += 1) {
          const candidate = `${stamp}${attempt === 1 ? '' : `-${attempt}`}.${extension}`;
          const relative = `${ATTACHMENTS_DIR}/${candidate}`;
          // 和笔记一样过写入闸门：Git 变基期间不往工作区里放新文件。
          name = await enqueueFile(config.vaultDir, relative, async () => {
            const absolute = await ensureSafeFilePath(config.vaultDir, relative, { allowMissing: true, createParents: true });
            try {
              // wx：同名文件已经在了就换下一个名字，绝不覆盖。
              const handle = await fsp.open(absolute, 'wx');
              try { await handle.writeFile(data); } finally { await handle.close(); }
              return candidate;
            } catch (error) {
              if (error.code === 'EEXIST') return '';
              throw error;
            }
          });
        }
        if (!name) throw httpError(409, '附件文件名冲突，请稍后再试。');
        res.json({ ok: true, name, path: `${ATTACHMENTS_DIR}/${name}`, markdown: `![[${name}]]`, bytes: data.length });
      } catch (error) { next(error); }
    });

  return router;
}

module.exports = { createEditorRoutes, sniffImage };
