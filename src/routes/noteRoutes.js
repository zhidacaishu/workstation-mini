const express = require('express');

const { renderMarkdown } = require('../markdown');
const { buildIndexResolver } = require('../vault/wikilink');
const { isSafeRelativePath, isNotePath, toPosix, sectionOf, encodePath, withNoteExtension, basename } = require('../vault/paths');
const { readNote, writeNote, deleteNote } = require('../vault/note');
const { enqueueNote } = require('../vault/note-queue');
const { discardDraft } = require('../vault/history');
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
    // 浏览按页翻，一页 PAGE_SIZE 篇；「共 N 篇」按同样的筛选条件计数。
    const pageSize = search.PAGE_SIZE || 50;
    const total = isBrowsing ? search.count({ section, tag }) : 0;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = isBrowsing ? Math.min(pages, Math.max(1, Math.floor(Number(req.query.page)) || 1)) : 1;
    const outcome = isBrowsing
      ? { results: search.browse({ section, tag, limit: pageSize, offset: (page - 1) * pageSize }), usedFallback: false }
      : search.search(query, { section, tag, limit: pageSize });

    res.render('search', {
      title: isBrowsing ? '笔记资料库' : `搜索：${query}`,
      query,
      section,
      tag,
      results: outcome.results,
      isBrowsing,
      total,
      page,
      pages,
      pageSize,
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

  /**
   * 新建笔记：先写标题，路径按标题自动生成，默认放进 inbox/。
   *
   *   /new                      收件箱里的新笔记
   *   /new?title=注意力机制       标题预填好
   *   /new?folder=experiments   研究项目（预填状态字段骨架）
   *   /new?path=research/x      指定路径（点「待建」双链时用），标题取文件名
   */
  router.get('/new', (req, res, next) => {
    if (config.readOnly) {
      next(httpError(403, '应用处于只读模式，不能新建笔记。'));
      return;
    }
    const explicit = withNoteExtension(req.query.path);
    const notePath = explicit && isNotePath(explicit) ? explicit : '';
    const folderInput = toPosix(String(req.query.folder || '')).replace(/^\/+|\/+$/g, '');
    const folder = folderInput && isNotePath(`${folderInput}/x.md`) ? folderInput : 'inbox';
    const title = String(req.query.title || '').replace(/\s+/g, ' ').trim() || (notePath ? basename(notePath) : '');
    // 研究项目也是普通笔记，只是 frontmatter 里带状态字段。预先填好字段骨架，
    // 免得每次去翻格式；用户可以删掉不需要的行。
    const isProject = (notePath || `${folder}/`).startsWith('experiments/');
    const yamlTitle = title && /[:#\[\]{}&*!|>'"%@`,]|^[\s-?]|\s$/.test(title) ? JSON.stringify(title) : title;
    res.render('edit', {
      title: isProject ? '新建研究项目' : '新建笔记',
      notePath,
      body: isProject
        ? `---\ntitle: ${yamlTitle}\nstatus: planned\ndeadline: \ndataset: \nparams: \nseed: \ncommit: \nnext: \n---\n\n`
        : title ? `# ${title}\n\n` : '',
      expectedHash: '',
      isNew: true,
      autoPath: !notePath,
      folder: isProject ? 'experiments' : folder
    });
  });

  router.get('/note/*notePath', async (req, res, next) => {
    try {
      const requestedPath = req.params.notePath.join('/');
      if (!isNotePath(requestedPath)) throw httpError(400, '路径不合法。');
      const notePath = toPosix(requestedPath);

      // 索引里没有不等于文件不存在：属性区写坏的笔记进不了索引，刚在外部建的笔记
      // 也可能还没扫到。照样读文件，读不到才是 404。
      const indexed = db.getNote(notePath);

      let note;
      try {
        note = await readNote(config.notesDir, notePath, { tolerateInvalid: true });
      } catch (error) {
        if (!indexed) throw httpError(404, `没有这篇笔记：${notePath}`);
        if (error.code !== 'ENOENT') throw error;
        // 索引里还有、文件已经没了（外部删除或改名，监听漏了事件）：补扫这一篇再报 404。
        indexer?.scan({ paths: [notePath] }).catch(() => {});
        throw httpError(404, `这篇笔记已被删除或移动：${notePath}`);
      }
      if (!indexed && !note.parseError) indexer?.scan({ paths: [notePath] }).catch(() => {});
      if (note.parseError) {
        // frontmatter 写坏了：照样打开，显示原文和修复入口，而不是一个 500。
        res.render('note', {
          title: note.title,
          note: { ...note, section: sectionOf(notePath), tags: [], data: {} },
          html: '',
          parseError: note.parseError,
          backlinks: db.backlinks(notePath),
          pending: []
        });
        return;
      }
      res.render('note', {
        title: note.title,
        note,
        parseError: '',
        // 非只读时阅读页的待办可以直接勾选，提交到 /tasks/update，和计划页同一条路径。
        html: renderMarkdown(note.body, resolver(), { notePath, today: res.locals.today, taskToggle: !config.readOnly, title: note.title, readOnly: config.readOnly }),
        backlinks: db.backlinks(notePath),
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
      if (!isNotePath(requestedPath)) throw httpError(400, '路径不合法。');
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
      // 路径可以不写 .md：这里统一补上，前端和草稿用同一条规则。
      const requestedPath = withNoteExtension(req.body.path);
      if (!isNotePath(requestedPath)) throw httpError(400, '路径不合法。');
      const notePath = toPosix(requestedPath);

      const expectedHash = String(req.body.expectedHash || '').trim();
      // 原生表单提交时浏览器把 textarea 的换行编码成 CRLF；脚本提交是 LF。统一成 LF，
      // 不让同一篇笔记因为提交方式不同混进 \r。
      const body = String(req.body.body ?? '').replace(/\r\n?/g, '\n');
      const isNew = String(req.body.isNew || '') === '1'
        || (req.body.isNew === undefined && !expectedHash);
      // 路径是按标题自动生成的：重名时依次试「标题 2」「标题 3」，而不是让用户自己去想一个。
      const autoPath = isNew && String(req.body.autoPath || '') === '1';
      let savedPath = notePath;
      const written = await enqueueNote(config.notesDir, notePath, async () => {
        if (isNew) {
          for (let attempt = 1; ; attempt += 1) {
            const candidate = attempt === 1 ? notePath : notePath.replace(/\.md$/i, ` ${attempt}.md`);
            try {
              const note = await writeNote(config.notesDir, candidate, { raw: body }, { exclusive: true });
              savedPath = candidate;
              return note;
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
              if (!autoPath || attempt >= 50) {
                throw httpError(409, '该路径已经存在笔记，请换一个路径或刷新后编辑现有内容。');
              }
            }
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
          throw httpError(409, '笔记已在别处修改，不能直接覆盖。');
        }
        return writeNote(config.notesDir, notePath, { raw: body });
      });
      // 从草稿恢复的内容保存好了，那份草稿就用掉了；不删的话编辑页会一直提示「有草稿」。
      if (req.body.recoveredFrom) await discardDraft(config.notesDir, String(req.body.recoveredFrom)).catch(() => {});
      await indexer.scan({ paths: [savedPath] });
      const redirect = `/note/${encodePath(savedPath)}`;
      if ((req.get('accept') || '').includes('application/json')) {
        res.json({ ok: true, hash: written.hash, path: savedPath, redirect });
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
      if (!isNotePath(requestedPath)) throw httpError(400, '路径不合法。');
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
      res.redirect(sectionOf(notePath) ? `/search?section=${encodeURIComponent(sectionOf(notePath))}` : '/search');
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
