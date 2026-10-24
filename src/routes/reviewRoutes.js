const express = require('express');

const { createReviewService } = require('../reviewService');
const { RATING_LABELS } = require('../review');
const { renderMarkdown } = require('../markdown');
const { buildResolver } = require('../vault/wikilink');
const { isSafeRelativePath } = require('../vault/paths');
const { CARD_TYPES, DEFAULT_TYPE, appendCard } = require('../cards');
const { httpError, blockWhenReadOnly } = require('./http');

function createReviewRoutes({ config, db, sync, syncReviewNow, indexer, now }) {
  const router = express.Router();
  const service = createReviewService({ vaultDir: config.vaultDir, device: config.device, now });
  const resolver = () => buildResolver(db.listPaths());

  // 只读模式拦的是「改笔记」，不是「记复习」。
  // 复习事件按设备追加到独立 JSONL，不会改动 Markdown 正文，
  // 所以下面只有 /cards/add 挂这个守卫，答题和同步不挂。
  const blockMarkdownWrite = blockWhenReadOnly(config, '不能修改笔记与卡片。');

  router.get('/decks', async (req, res, next) => {
    try {
      res.render('decks', { title: '卡片', ...(await service.stats()) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/review', async (req, res, next) => {
    try {
      const deck = String(req.query.deck || '');
      const { due, fresh, cards } = await service.queue({ deck });

      // 队列直接嵌进页面，评分过程在窗口内完成，每答一张异步提交。
      const payload = cards.map(card => ({
        id: card.id,
        deck: card.deck,
        type: card.type,
        front: renderMarkdown(card.front, resolver()),
        back: renderMarkdown(card.type === 'cloze' ? card.answer : card.back, resolver()),
        question: card.type === 'cloze' ? renderMarkdown(card.question, resolver()) : '',
        state: card.state.state,
        due: card.state.due
      }));

      res.render('review', {
        title: deck ? `复习 · ${deck}` : '复习',
        deck,
        dueCount: due.length,
        freshCount: fresh.length,
        queue: payload,
        ratings: RATING_LABELS
      });
    } catch (error) {
      next(error);
    }
  });

  // 记一次复习。只读模式同样允许。
  router.post('/review/answer', async (req, res, next) => {
    try {
      const eventId = String(req.body.eventId || '').trim();
      const cardId = String(req.body.cardId || '').trim();
      const rating = Number(req.body.rating);
      if (!cardId) throw httpError(400, '缺少 cardId。');

      const recorded = await service.answer(cardId, rating, req.body.elapsedMs, eventId);
      res.json({ ok: true, ...recorded });
    } catch (error) {
      if (/Unknown rating/.test(error.message)) {
        next(httpError(400, '评分不合法。'));
        return;
      }
      next(error);
    }
  });

  /**
   * 一次复习结束后把事件日志提交推送。
   *
   * 只读模式也允许推送 reviews/ 下按设备分隔的追加式文件。
   * 必须先拉再推，避免其它设备的新提交导致 non-fast-forward。
   */
  router.post('/review/sync', async (req, res, next) => {
    try {
      if (!config.syncEnabled) {
        res.json({ ok: true, skipped: '同步未启用' });
        return;
      }
      const message = `复习记录 ${new Date().toISOString()}`;
      const result = syncReviewNow
        ? await syncReviewNow(message)
        : await sync.syncReviewLogs(config.device, message);
      // 直接构造 app 的测试没有运行时包装；这种情况下路由负责拉取后的全量重扫。
      if (!syncReviewNow && result.changed && indexer) await indexer.scan();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /** 划词建卡：从笔记里选一段文字，直接追加成一张卡。 */
  router.post('/cards/add', blockMarkdownWrite, async (req, res, next) => {
    try {
      const front = String(req.body.front || '').trim();
      const back = String(req.body.back || '').trim();
      const deckFile = String(req.body.deckFile || 'inbox').trim().replace(/\.md$/i, '');
      const source = String(req.body.source || '').trim();
      const type = CARD_TYPES.includes(req.body.type) ? req.body.type : DEFAULT_TYPE;

      if (!front) throw httpError(400, '卡片正面不能为空。');

      if (!isSafeRelativePath(`cards/${deckFile}.md`)) throw httpError(400, '卡片文件名不合法。');

      const result = await appendCard(config.vaultDir, { deckFile, front, back, source, type });
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createReviewRoutes };
