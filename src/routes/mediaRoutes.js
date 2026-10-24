const express = require('express');
const path = require('node:path');

const shadowing = require('../shadowing');
const { toMdx, validate, publish, slugify } = require('../publish');
const { readNote } = require('../vault/note');
const { isSafeRelativePath } = require('../vault/paths');
const { toLocalDate } = require('../templates');
const { createBlobCache } = require('../blobs/cache');
const { httpError, blockWhenReadOnly } = require('./http');

function createMediaRoutes({ config, db, blobs, logger = console, now = () => new Date() }) {
  const router = express.Router();
  const guard = blockWhenReadOnly(config, '不能写入。');
  const cache = createBlobCache({ vaultDir: config.vaultDir, blobs, logger });

  // 音频文件直接从 vault 提供，走 express.static 并限定在 audio/ 目录内。
  // 前面那道缓存中间件负责「本地没有就先从存储服务取回来」——
  // audio/ 不再进 Git 之后，换台机器时本地是空的。
  router.use(
    '/media',
    cache.middleware(shadowing.AUDIO_DIR),
    express.static(path.join(config.vaultDir, shadowing.AUDIO_DIR), {
      dotfiles: 'deny',
      index: false
    })
  );

  router.get('/shadowing', async (req, res, next) => {
    try {
      res.render('shadowing', {
        title: '影子跟读',
        clips: await shadowing.listClips(config.vaultDir),
        whisperReady: shadowing.isAvailable(config.whisperPath) && shadowing.isAvailable(config.whisperModel),
        whisperPath: config.whisperPath
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/shadowing/:clip', async (req, res, next) => {
    try {
      const clipId = String(req.params.clip);
      if (!/^[\w.-]+$/.test(clipId)) throw httpError(400, '素材名不合法。');

      const clip = await shadowing.loadClip(config.vaultDir, clipId);
      if (!clip) throw httpError(404, '找不到这份素材。');

      res.render('shadow-player', {
        title: `跟读 · ${clip.id}`,
        clip,
        payload: encodeURIComponent(JSON.stringify(clip.cues)),
        whisperReady: shadowing.isAvailable(config.whisperPath) && shadowing.isAvailable(config.whisperModel)
      });
    } catch (error) {
      next(error);
    }
  });

  /** 对没有字幕的素材跑 whisper.cpp。 */
  router.post('/shadowing/:clip/transcribe', guard, async (req, res, next) => {
    try {
      const clipId = String(req.params.clip);
      if (!/^[\w.-]+$/.test(clipId)) throw httpError(400, '素材名不合法。');

      const clip = await shadowing.loadClip(config.vaultDir, clipId);
      if (!clip) throw httpError(404, '找不到这份素材。');

      const audioPath = path.join(config.vaultDir, ...clip.audio.split('/'));
      const result = await shadowing.transcribe(config.whisperPath, config.whisperModel, audioPath, {
        language: String(req.body.language || 'en')
      });

      if (!result.available) throw httpError(400, `${result.reason}。请在应用设置中选择 whisper.cpp 和模型文件。`);
      if (!result.ok) throw httpError(500, result.reason);

      res.json({ ok: true, cues: result.cues.length });
    } catch (error) {
      next(error);
    }
  });

  // ── 发表到 myblog ──────────────────────────────────

  router.get('/publish', (req, res, next) => {
    try {
      const notePath = String(req.query.path || '');
      res.render('publish', {
        title: '发表到博客',
        notePath,
        blogRepo: config.blogRepo,
        blogReady: Boolean(config.blogRepo),
        today: toLocalDate(now()),
        candidates: db.raw.prepare(`
          SELECT path, title_raw AS title FROM notes
          WHERE section IN ('reading', 'research', 'clips') ORDER BY mtime_ms DESC LIMIT 50
        `).all()
      });
    } catch (error) {
      next(error);
    }
  });

  /** 先预览：转出来的 MDX 和校验结果都摆出来再决定写不写。 */
  router.post('/publish/preview', async (req, res, next) => {
    try {
      const notePath = String(req.body.path || '');
      if (!isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      if (!db.getNote(notePath)) throw httpError(404, '没有这篇笔记。');

      const note = await readNote(config.notesDir, notePath);
      const mdx = toMdx(note, {
        pubDate: String(req.body.pubDate || toLocalDate(now())),
        category: String(req.body.category || 'notes'),
        kind: String(req.body.kind || 'reading'),
        description: String(req.body.description || ''),
        draft: req.body.draft !== false && req.body.draft !== 'false'
      });

      res.json({ ok: true, mdx, slug: slugify(note.title, 'post'), validation: validate(mdx) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/publish/write', guard, async (req, res, next) => {
    try {
      if (!config.blogRepo) throw httpError(400, '尚未在应用设置中选择博客仓库。');

      const mdx = String(req.body.mdx || '');
      const slug = slugify(String(req.body.slug || ''), 'post');
      if (!mdx.trim()) throw httpError(400, '没有内容可写。');

      const result = await publish(config.blogRepo, { slug, mdx, commit: false, now });
      if (!result.ok) throw httpError(400, result.problems.join('；'));

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createMediaRoutes };
