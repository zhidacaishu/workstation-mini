const express = require('express');

const { createReviewService } = require('../reviewService');
const { RATING_LABELS, State } = require('../review');
const { renderMarkdown } = require('../markdown');
const { buildIndexResolver } = require('../vault/wikilink');
const { isSafeRelativePath } = require('../vault/paths');
const { CARD_TYPES, DEFAULT_TYPE, appendCard, updateCard, deleteCard, listDeckFiles, renderClozeAnswer } = require('../cards');
const { readNote } = require('../vault/note');
const { toLocalDate } = require('../templates');
const { httpError, blockWhenReadOnly } = require('./http');

const isTrue = value => value === true || value === 'true' || value === '1' || value === 'on';

function createReviewRoutes({ config, db, sync, syncReviewNow, indexer, now, review }) {
  const router = express.Router();
  const service = review || createReviewService({ vaultDir: config.vaultDir, device: config.device, now });
  const resolver = () => buildIndexResolver(db);

  // 只读模式拦的是「改笔记」，不是「记复习」。
  // 复习事件按设备追加到独立 JSONL，不会改动 Markdown 正文，
  // 所以下面只有 /cards/add 挂这个守卫，答题和同步不挂。
  const blockMarkdownWrite = blockWhenReadOnly(config, '不能修改笔记与卡片。');

  async function defaultDeckFile(deck, cards) {
    if (!deck || config.readOnly) return '';
    if (cards.length) return cards[0].deckFile;
    const files = await listDeckFiles(config.vaultDir);
    return files.find(item => item.deck === deck)?.file || deck;
  }

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
      const { cards } = await service.queue({ deck });

      // 队列直接嵌进页面，评分过程在窗口内完成，每答一张异步提交。
      // 每个请求只建一次双链解析器：它要把整张笔记表读一遍，按卡建的话
      // 几百张到期卡、几千篇笔记时页面要等好几秒。
      const resolve = resolver();
      const options = { readOnly: config.readOnly };
      const payload = cards.map(card => ({
        id: card.id,
        deck: card.deck,
        deckFile: card.deckFile,
        type: card.type,
        front: renderMarkdown(card.front, resolve, options),
        // 挖空卡的答案面带高亮标记：翻面时在原位把空填上，不在卡片底部再重复一遍整句。
        back: card.type === 'cloze'
          ? renderClozeAnswer(card.back, text => renderMarkdown(text, resolve, options))
          : renderMarkdown(card.back, resolve, options),
        question: card.type === 'cloze' ? renderMarkdown(card.question, resolve, options) : '',
        state: card.state.state,
        due: card.state.due
      }));

      res.render('review', {
        title: deck ? `复习 · ${deck}` : '复习',
        deck,
        defaultFile: await defaultDeckFile(deck, cards),
        returnTo: deck ? `/review?deck=${encodeURIComponent(deck)}` : '/review',
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

  /** 撤销刚才那一次评分（只限本机日志的最后一条）。 */
  router.post('/review/undo', async (req, res, next) => {
    try {
      res.json(await service.undo(String(req.body.eventId || '')));
    } catch (error) {
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

  router.get('/api/card-decks', async (req, res, next) => {
    try { res.json(await listDeckFiles(config.vaultDir)); }
    catch (error) { next(error); }
  });

  /** 手写与划词建卡都追加到卡组文件，划词建卡额外保留来源。 */
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

  // ---------- 卡片管理 ----------

  // 编辑完回到哪里：只认应用内这几个页面，挡住外部地址。
  const safeReturn = (value, fallback) => {
    const target = String(value || '');
    return /^\/(review|cards|decks)(?:[/?#]|$)/.test(target) ? target : fallback;
  };
  const wantsJson = req => (req.get('accept') || '').includes('application/json');

  function stateLabel(card, nowIso, today) {
    if (card.suspended) return { label: '已暂停', tone: 'is-suspended' };
    if (card.state.state === State.New) return { label: '新卡', tone: 'is-new' };
    if (card.state.due <= nowIso) return { label: '到期', tone: 'is-due' };
    const date = toLocalDate(new Date(card.state.due));
    return { label: `下次 ${date === today ? '今天' : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`}`, tone: '' };
  }

  router.get('/cards', async (req, res, next) => {
    try {
      const deck = String(req.query.deck || '');
      const all = await service.withStates();
      const current = (now || (() => new Date()))();
      const nowIso = current.toISOString();
      const today = toLocalDate(current);
      const cards = all
        .filter(card => !deck || card.deck === deck)
        .map(card => ({ ...card, status: stateLabel(card, nowIso, today) }));
      res.render('cards', {
        title: deck ? `卡片 · ${deck}` : '全部卡片',
        deck,
        cards,
        defaultFile: await defaultDeckFile(deck, cards),
        decks: [...new Set(all.map(card => card.deck))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
        returnTo: deck ? `/cards?deck=${encodeURIComponent(deck)}` : '/cards'
      });
    } catch (error) { next(error); }
  });

  router.get('/cards/edit', blockMarkdownWrite, async (req, res, next) => {
    try {
      const id = String(req.query.id || '');
      const card = (await service.allCards()).find(item => item.id === id);
      if (!card) throw httpError(404, '卡片不存在或已被删除。');
      const file = await readNote(config.vaultDir, card.path);
      res.render('card-edit', {
        title: '编辑卡片',
        card,
        expectedHash: file.hash,
        deckFiles: await listDeckFiles(config.vaultDir),
        returnTo: safeReturn(req.query.returnTo, `/cards?deck=${encodeURIComponent(card.deck)}`)
      });
    } catch (error) { next(error); }
  });

  router.post('/cards/update', blockMarkdownWrite, async (req, res, next) => {
    try {
      const json = req.is('application/json');
      const result = await updateCard(config.vaultDir, {
        id: req.body.id,
        expectedHash: String(req.body.expectedHash || ''),
        front: req.body.front,
        back: req.body.back,
        deckFile: req.body.deckFile,
        // JSON 里不传就保持原样；传了按真假解析（字符串 "false" 不能算真）。
        // 表单里复选框没勾就不出现在请求里，所以表单总是明确设定。
        suspended: json ? (req.body.suspended === undefined ? undefined : isTrue(req.body.suspended)) : isTrue(req.body.suspended)
      });
      const redirect = safeReturn(req.body.returnTo, '/decks');
      if (wantsJson(req)) { res.json({ ok: true, ...result, redirect }); return; }
      res.redirect(redirect);
    } catch (error) { next(error); }
  });

  // 只切换暂停状态：复习中途和卡片列表里一键操作，不需要卡组版本号。
  router.post('/cards/suspend', blockMarkdownWrite, async (req, res, next) => {
    try {
      const suspended = isTrue(req.body.suspended);
      const result = await updateCard(config.vaultDir, { id: req.body.id, suspended });
      if (wantsJson(req)) { res.json({ ok: true, suspended, ...result }); return; }
      res.redirect(safeReturn(req.body.returnTo, '/decks'));
    } catch (error) { next(error); }
  });

  router.post('/cards/delete', blockMarkdownWrite, async (req, res, next) => {
    try {
      const result = await deleteCard(config.vaultDir, { id: req.body.id, expectedHash: String(req.body.expectedHash || '') });
      if (wantsJson(req)) { res.json({ ok: true, ...result }); return; }
      const returnTo = safeReturn(req.body.returnTo, '/decks');
      // 从复习页进来删掉的卡，回到复习页会重新排队，不会再出现。
      res.redirect(returnTo);
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createReviewRoutes };
