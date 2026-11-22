const express = require('express');

const { createItems } = require('../items');
const { WORKFLOWS, workflowOf } = require('../workflows');
const { updateTask } = require('../taskActions');
const { isSafeRelativePath } = require('../vault/paths');
const { toLocalDate } = require('../templates');
const { httpError, blockWhenReadOnly, writeHandler } = require('./http');

function createItemRoutes({ config, db, indexer, now = () => new Date() }) {
  const router = express.Router();
  const items = createItems({ db, notesDir: config.notesDir });
  const guard = blockWhenReadOnly(config, '不能修改条目状态。');

  router.post('/tasks/update', guard, writeHandler(async (req, res, next) => {
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
      else {
        const returnTo = String(req.body.returnTo || '');
        res.redirect(returnTo.startsWith('/plan?') ? returnTo : '/plan');
      }
    } catch (error) { next(error); }
  }));

  /** 研究项目看板，旧工作流由 workflowOf 明确拒绝。 */
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

  router.post('/board/status', guard, writeHandler(async (req, res, next) => {
    try {
      const workflow = String(req.body.workflow || '');
      const notePath = String(req.body.path || '');
      const status = String(req.body.status || '');
      const expectedHash = String(req.body.expectedHash || '');

      const flow = workflowOf(workflow);
      if (!flow) throw httpError(400, '未知的工作流。');
      if (!isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      // 只能改这个看板分区里的条目，不能借这个接口往任意笔记里写 status。
      if (!notePath.startsWith(`${flow.section}/`)) throw httpError(400, '这篇笔记不在这个看板里。');
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
  }));

  return router;
}

module.exports = { createItemRoutes };
