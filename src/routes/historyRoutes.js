const express = require('express');
const crypto = require('node:crypto');
const { listRecords, getRecord, saveDraft, removeDraft } = require('../vault/history');
const { readNote } = require('../vault/note');
const { isSafeRelativePath } = require('../vault/paths');
const { blockWhenReadOnly, httpError } = require('./http');

function createHistoryRoutes({ config }) {
  const router = express.Router();
  const guard = blockWhenReadOnly(config, '不能恢复笔记或保存草稿。');
  router.get('/api/drafts', async (req, res, next) => {
    try {
      const records = await listRecords(config.notesDir, String(req.query.path || ''));
      res.json({ count: records.filter(record => record.kind === 'draft').length });
    } catch (error) { next(error); }
  });
  router.get('/history', async (req, res, next) => {
    try {
      const notePath = String(req.query.path || '');
      if (notePath && !isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      const records = await listRecords(config.notesDir, notePath);
      const selected = req.query.id ? await getRecord(config.notesDir, String(req.query.id)) : null;
      res.render('history', { title: '版本历史与草稿', records, selected, notePath });
    } catch (error) { next(error.code === 'ENOENT' ? httpError(404, '恢复记录不存在。') : error); }
  });
  router.get('/recover/:id', guard, async (req, res, next) => {
    try {
      const record = await getRecord(config.notesDir, req.params.id);
      let current;
      try { current = await readNote(config.notesDir, record.path, { tolerateInvalid: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      res.render('edit', {
        title: '恢复笔记', notePath: record.path, body: record.raw,
        expectedHash: current?.hash || '', isNew: !current,
        draftId: crypto.randomUUID(), recovered: true,
        editorWarning: current
          ? '已载入恢复内容，尚未覆盖当前文件。请核对后保存；当前版本会保留在历史中。'
          : '已载入恢复内容，尚未写入笔记。保存后将重新创建文件。'
      });
    } catch (error) { next(error.code === 'ENOENT' ? httpError(404, '恢复记录不存在。') : error); }
  });
  router.post('/api/drafts/:id', guard, async (req, res, next) => {
    try { res.json({ ok: true, ...await saveDraft(config.notesDir, req.params.id, req.body) }); }
    catch (error) { next(error); }
  });
  router.delete('/api/drafts/:id', guard, async (req, res, next) => {
    try {
      await removeDraft(config.notesDir, req.params.id, Number(req.body.sequence));
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { createHistoryRoutes };
