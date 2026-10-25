const express = require('express');

const { renderMarkdown } = require('../markdown');
const { buildIndexResolver } = require('../vault/wikilink');
const { isSafeRelativePath, toPosix, sectionOf, encodePath } = require('../vault/paths');
const { readNote, writeNote, deleteNote } = require('../vault/note');
const { enqueueNote } = require('../vault/note-queue');
const { httpError, blockWhenReadOnly } = require('./http');

function createNoteRoutes({ config, db, indexer, search, getIndexStatus }) {
  const router = express.Router();
  // 只读模式拒绝一切会改动 Markdown 的请求。
  const guard = blockWhenReadOnly(config, '不能修改笔记。');

  const resolver = () => buildIndexResolver(db);

  router.get('/search', (req, res) => {
    const query = String(req.query.q || '');
    const section = String(req.query.section || '');
    const tag = String(req.query.tag || '');
    const isBrowsing = !query.trim();
    const outcome = isBrowsing
      ? { results: search.browse({ section, tag }), usedFallback: false }
      : search.search(query, { section, tag });

    res.render('search', {
      title: isBrowsing ? '笔记资料库' : `搜索：${query}`,
      query,
      section,
      tag,
      results: outcome.results,
      isBrowsing,
      total: db.countNotes(),
      usedFallback: outcome.usedFallback,
      sections: db.raw.prepare(`
        SELECT section, count(*) AS count
        FROM notes
        WHERE section != ''
        GROUP BY section
        ORDER BY section
      `).all(),
      tags: db.listTags()
    });
  });

  router.get('/section/:section', (req, res) => {
    const section = String(req.params.section);
    res.render('section', {
      title: section,
      section,
      notes: search.bySection(section, 500)
    });
  });

  router.get('/new', (req, res, next) => {
    if (config.readOnly) {
      next(httpError(403, '应用处于只读模式，不能新建笔记。'));
      return;
    }
    const suggested = toPosix(String(req.query.path || ''));
    // 研究项目也是普通笔记，只是 frontmatter 里带状态字段。从看板新建时预先填好
    // 字段骨架，免得每次去翻格式；用户可以删掉不需要的行。
    const isProject = suggested.startsWith('experiments/');
    res.render('edit', {
      title: isProject ? '新建研究项目' : '新建笔记',
      notePath: suggested.endsWith('.md') ? suggested : `${suggested}.md`,
      body: isProject
        ? '---\ntitle: \nstatus: planned\ndeadline: \ndataset: \nparams: \nseed: \ncommit: \nnext: \n---\n\n'
        : '',
      expectedHash: '',
      isNew: true
    });
  });

  router.get('/note/*notePath', async (req, res, next) => {
    try {
      const requestedPath = req.params.notePath.join('/');
      if (!isSafeRelativePath(requestedPath)) throw httpError(400, '路径不合法。');
      const notePath = toPosix(requestedPath);

      const indexed = db.getNote(notePath);
      if (!indexed) throw httpError(404, `没有这篇笔记：${notePath}`);

      const note = await readNote(config.notesDir, notePath);
      res.render('note', {
        title: note.title,
        note,
        html: renderMarkdown(note.body, resolver(), { notePath }),
        backlinks: db.backlinks(notePath),
        outbound: db.outboundLinks(notePath).filter(link => link.path),
        pending: db.outboundLinks(notePath).filter(link => !link.path)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/edit/*notePath', async (req, res, next) => {
    try {
      if (config.readOnly) throw httpError(403, '应用处于只读模式，不能编辑笔记。');
      const requestedPath = req.params.notePath.join('/');
      if (!isSafeRelativePath(requestedPath)) throw httpError(400, '路径不合法。');
      const notePath = toPosix(requestedPath);

      const note = await readNote(config.notesDir, notePath, { tolerateInvalid: true });
      res.render('edit', {
        title: `编辑 ${note.title}`,
        notePath,
        body: note.raw,
        editorWarning: note.parseError ? '笔记格式有误，请修正后保存：' + note.parseError : '',
        expectedHash: note.hash,
        isNew: false
      });
    } catch (error) {
      next(error.code === 'ENOENT' ? httpError(404, '笔记不存在。') : error);
    }
  });

  // 编辑器提交的是完整原文（含 frontmatter），直接落盘。
  // 正文是唯一真相，这里不做任何「智能」改写。
  router.post('/save', guard, async (req, res, next) => {
    try {
      const requestedPath = String(req.body.path || '').trim();
      if (!isSafeRelativePath(requestedPath)) throw httpError(400, '路径不合法。');
      const notePath = toPosix(requestedPath);
      if (!notePath.toLowerCase().endsWith('.md')) throw httpError(400, '笔记文件名必须以 .md 结尾。');

      const expectedHash = String(req.body.expectedHash || '').trim();
      const isNew = String(req.body.isNew || '') === '1'
        || (req.body.isNew === undefined && !expectedHash);
      const written = await enqueueNote(config.notesDir, notePath, async () => {
        if (isNew) {
          try {
            return await writeNote(
              config.notesDir,
              notePath,
              { raw: String(req.body.body ?? '') },
              { exclusive: true }
            );
          } catch (error) {
            if (error.code === 'EEXIST') {
              throw httpError(409, '该路径已经存在笔记，请换一个路径或刷新后编辑现有内容。');
            }
            throw error;
          }
        }

        let existing = null;
        try {
          existing = await readNote(config.notesDir, notePath, { tolerateInvalid: true });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        // 目标不存在和目标被改过是两回事。以前两种都报「已被其它操作修改」，
        // 于是往一个不存在的路径提交时，错误信息会指向一次根本没发生的并发编辑。
        if (!existing) {
          throw httpError(404, '要保存的笔记不存在，请确认路径，或从「新建笔记」创建。');
        }
        if (existing.hash !== expectedHash) {
          throw httpError(409, '笔记已被其它操作修改，请刷新后合并更改。');
        }
        return writeNote(config.notesDir, notePath, { raw: String(req.body.body ?? '') });
      });
      await indexer.scan({ paths: [notePath] });
      const redirect = `/note/${encodePath(notePath)}`;
      if ((req.get('accept') || '').includes('application/json')) {
        res.json({ ok: true, hash: written.hash, redirect });
        return;
      }
      res.redirect(redirect);
    } catch (error) {
      next(error);
    }
  });

  router.post('/delete', guard, async (req, res, next) => {
    try {
      const requestedPath = String(req.body.path || '').trim();
      if (!isSafeRelativePath(requestedPath)) throw httpError(400, '路径不合法。');
      const notePath = toPosix(requestedPath);

      const expectedHash = String(req.body.expectedHash || '').trim();
      await enqueueNote(config.notesDir, notePath, async () => {
        let note;
        try {
          note = await readNote(config.notesDir, notePath);
        } catch (error) {
          if (error.code === 'ENOENT') throw httpError(404, '笔记不存在。');
          throw error;
        }
        if (!expectedHash || note.hash !== expectedHash) {
          throw httpError(409, '笔记已被其它操作修改，请刷新后再删除。');
        }
        await deleteNote(config.notesDir, notePath);
      });
      await indexer.scan({ paths: [notePath] });
      res.redirect(sectionOf(notePath) ? `/section/${encodeURIComponent(sectionOf(notePath))}` : '/');
    } catch (error) {
      next(error);
    }
  });

  // 命令面板空查询显示最近笔记，非空查询执行全文检索。
  router.get('/api/search', (req, res) => {
    const query = String(req.query.q || '');
    if (!query.trim()) {
      res.json({ results: search.recent(10).map(n => ({ path: n.path, title: n.title, section: n.section })) });
      return;
    }
    res.json(search.search(query, { limit: 20 }));
  });

  /**
   * 索引状态。冷启动时界面已经能打开了，但索引可能还没建完 —— 这个接口让页面
   * 能显示「正在建立索引 N/M」，而不是让用户看着空列表以为笔记没了。
   */
  router.get('/api/index-status', (req, res) => {
    res.json(getIndexStatus ? getIndexStatus() : {
      phase: 'ready', scanKind: 'full', generation: 0, done: 0, total: 0, notes: 0,
      failureTotal: 0, failures: [], failuresTruncated: false, fatal: null, updatedAt: ''
    });
  });

  router.post('/api/reindex', async (req, res, next) => {
    try {
      res.json(await indexer.scan({ force: true, kind: 'full' }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/index-retry', async (req, res, next) => {
    try {
      res.json(await indexer.retry());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createNoteRoutes };
