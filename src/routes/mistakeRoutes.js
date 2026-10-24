const express = require('express');
const path = require('node:path');

const { createMistakeStore, clusterByCategory, monthlyTrend, EXERCISE_REASONS, reasonLabel, SOURCES } = require('../mistakes');
const { checkDraft, isAvailable } = require('../checkDraft');
const { appendCard } = require('../cards');
const { isSafeRelativePath } = require('../vault/paths');
const { httpError, blockWhenReadOnly } = require('./http');

function createMistakeRoutes({ config, db, now }) {
  const router = express.Router();
  const store = createMistakeStore({ vaultDir: config.vaultDir, device: config.device, now });
  const guard = blockWhenReadOnly(config, '不能记录错题。');

  router.get('/mistakes', async (req, res, next) => {
    try {
      const all = await store.all();
      const cluster = clusterByCategory(all);

      res.render('mistakes', {
        title: '错题本',
        writing: cluster.filter(row => row.source === SOURCES.WRITING),
        exercise: cluster.filter(row => row.source === SOURCES.EXERCISE),
        trend: monthlyTrend(all),
        total: all.reduce((sum, row) => sum + (Number(row.count) || 1), 0),
        recent: [...all].sort((a, b) => (a.ts > b.ts ? -1 : 1)).slice(0, 25),
        reasons: EXERCISE_REASONS,
        reasonLabel,
        checkerAvailable: isAvailable(config.checkDraftPath),
        checkerPath: config.checkDraftPath,
        // 只列英文稿：检查器是给英文稿件用的，中文笔记跑它没有意义。
        drafts: db.raw.prepare(`
          SELECT path, title_raw AS title FROM notes
          WHERE section IN ('research', 'writing', 'drafts') ORDER BY mtime_ms DESC LIMIT 50
        `).all()
      });
    } catch (error) {
      next(error);
    }
  });

  /** 对一份稿件跑 check_draft.py，把结果落进错题本。 */
  router.post('/mistakes/check', guard, async (req, res, next) => {
    try {
      const notePath = String(req.body.path || '').trim();
      if (!isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      if (!db.getNote(notePath)) throw httpError(404, '没有这篇笔记。');

      const absolute = path.join(config.notesDir, ...notePath.split('/'));
      const result = await checkDraft(config.checkDraftPath, absolute, { python: config.pythonPath });

      if (!result.available) throw httpError(400, `${result.reason}。请在应用设置中选择 check_draft.py。`);
      if (!result.ok) throw httpError(500, result.reason);

      const recorded = store.recordCheck(notePath, result.findings);
      res.json({
        ok: true,
        hardCount: result.hardCount,
        softCount: result.softCount,
        categories: result.findings.length,
        recorded: recorded.length
      });
    } catch (error) {
      next(error);
    }
  });

  /** 手工录入一条习题错题。 */
  router.post('/mistakes/exercise', guard, (req, res, next) => {
    try {
      const record = store.recordExercise({
        subject: req.body.subject,
        category: req.body.category,
        reason: req.body.reason,
        detail: req.body.detail,
        note: req.body.note,
        ref: req.body.ref
      });
      res.redirect('/mistakes');
      return record;
    } catch (error) {
      next(error.message.includes('不能为空') ? httpError(400, error.message) : error);
    }
  });

  /**
   * 错题转卡片。
   *
   * 这是「错误沉淀成个人训练数据」闭环的最后一步：犯过的错进复习队列，
   * 用的还是 P2 那套 FSRS 引擎，没有第二套调度器。
   */
  router.post('/mistakes/card', guard, async (req, res, next) => {
    try {
      const id = String(req.body.id || '').trim();
      const all = await store.all();
      const mistake = all.find(record => record.id === id);
      if (!mistake) throw httpError(404, '找不到这条错题。');

      const isWriting = mistake.source === SOURCES.WRITING;
      // 要考的那句话必须待在正面，而正面只有一行 —— 所以用引号嵌进同一行，
      // 不能换行分段（那样它会被当成背面，答案先于问题露出来）。
      const quoted = String(mistake.detail || mistake.subject || '').replace(/\s+/g, ' ').trim();
      const front = isWriting
        ? `${mistake.category}：下面这句话问题在哪？${quoted ? `「${quoted}」` : ''}`
        : `${mistake.category}${mistake.subject ? `（${mistake.subject}）` : ''}`;
      const back = isWriting
        ? (mistake.note || `这属于「${mistake.category}」，改法见 academic-writing 的规则。`)
        : [mistake.detail && `我的错法：${mistake.detail}`,
           mistake.note && `正确思路：${mistake.note}`,
           mistake.tier && `错因：${reasonLabel(mistake.tier)}`].filter(Boolean).join('\n\n');

      const result = await appendCard(config.vaultDir, {
        deckFile: isWriting ? 'writing-mistakes' : 'exercise-mistakes',
        front,
        back,
        source: isWriting ? mistake.ref : ''
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createMistakeRoutes };
