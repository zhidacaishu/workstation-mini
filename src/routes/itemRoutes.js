const express = require('express');

const { createItems } = require('../items');
const { WORKFLOWS, workflowOf } = require('../workflows');
const { sortTasks, summarize } = require('../tasks');
const { updateTask } = require('../taskActions');
const { isSafeRelativePath } = require('../vault/paths');
const { toLocalDate } = require('../templates');
const { httpError, blockWhenReadOnly } = require('./http');

function createItemRoutes({ config, db, indexer, now = () => new Date() }) {
  const router = express.Router();
  const items = createItems({ db, notesDir: config.notesDir });
  const guard = blockWhenReadOnly(config, '不能修改条目状态。');

  router.post('/tasks/update', guard, async (req, res, next) => {
    try {
      const notePath = String(req.body.path || '');
      if (!isSafeRelativePath(notePath) || !notePath.toLowerCase().endsWith('.md')) throw httpError(400, '路径不合法。');
      const json = req.is('application/json');
      const result = await updateTask(config.notesDir, {
        path: notePath, line: Number(req.body.line), expectedHash: String(req.body.expectedHash || ''),
        done: json ? req.body.done : req.body.done === 'on', due: req.body.due
      });
      await indexer.scan({ paths: [notePath] });
      if ((req.get('accept') || '').includes('application/json')) res.json({ ok: true, ...result });
      else res.redirect('/tasks');
    } catch (error) { next(error); }
  });

  /** 三类条目共用这一个看板页面，只是喂进去的工作流不同。 */
  router.get('/board/:workflow', (req, res, next) => {
    try {
      const key = String(req.params.workflow);
      const flow = workflowOf(key);
      if (!flow) throw httpError(404, `没有这个看板：${key}`);

      const board = items.board(key);
      res.render('board', {
        title: flow.label,
        workflow: flow,
        columns: board.columns,
        total: board.total,
        workflows: Object.values(WORKFLOWS),
        today: toLocalDate(now())
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/board/status', guard, async (req, res, next) => {
    try {
      const workflow = String(req.body.workflow || '');
      const notePath = String(req.body.path || '');
      const status = String(req.body.status || '');
      const expectedHash = String(req.body.expectedHash || '');

      if (!workflowOf(workflow)) throw httpError(400, '未知的工作流。');
      if (!isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      if (!db.getNote(notePath)) throw httpError(404, '没有这个条目。');

      const result = await items.setStatus(workflow, notePath, status, expectedHash);
      // 状态写进了 frontmatter，要重扫才能反映到看板上。
      await indexer.scan({ paths: [notePath] });

      if ((req.get('accept') || '').includes('application/json')) {
        res.json({ ok: true, ...result });
        return;
      }
      res.redirect(`/board/${workflow}`);
    } catch (error) {
      next(/不是.*合法状态/.test(error.message) ? httpError(400, error.message) : error);
    }
  });

  /**
   * 待办汇总。
   *
   * 任务从各篇笔记正文的 `- [ ]` 抽出来，这里只是换个角度看同一批数据 ——
   * 勾掉一条的正确做法仍然是去改那篇 Markdown。
   */
  router.get('/tasks', (req, res, next) => {
    try {
      const today = toLocalDate(now());
      const showDone = req.query.done === '1';
      const all = db.listTasks({ includeDone: showDone });

      res.render('tasks', {
        title: '待办',
        today,
        showDone,
        tasks: sortTasks(all, today),
        summary: summarize(db.listTasks({ includeDone: true }), today)
      });
    } catch (error) {
      next(error);
    }
  });


  return router;
}

module.exports = { createItemRoutes };
