const express = require('express');

const { createAggregator } = require('../aggregate');
const { renderRetrospective, renderBriefing } = require('../briefing');
const { writeNote } = require('../vault/note');
const { enqueueNote } = require('../vault/note-queue');
const { isSafeRelativePath, encodePath } = require('../vault/paths');
const { httpError, blockWhenReadOnly } = require('./http');

function createTodayRoutes({ config, db, indexer, search, now }) {
  const router = express.Router();
  const aggregate = createAggregator({ config, db, now });
  const guard = blockWhenReadOnly(config, '不能保存回顾。');

  /** 首页 = 聚合层的实时版。 */
  router.get('/', async (req, res, next) => {
    try {
      const snapshot = await aggregate.today();
      res.render('today', {
        title: '今日',
        snapshot,
        total: db.countNotes(),
        recent: search.recent(8)
      });
    } catch (error) {
      next(error);
    }
  });

  /** deadline 时间轴 = 聚合层的筛选版。 */
  router.get('/deadlines', async (req, res, next) => {
    try {
      const snapshot = await aggregate.today();
      const horizon = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);

      res.render('deadlines', {
        title: '截止日期',
        today: snapshot.date,
        horizon,
        entries: aggregate.deadlines(snapshot.date, horizon)
      });
    } catch (error) {
      next(error);
    }
  });

  /** 回顾 = 聚合层的汇总版。数字自动填好，人只写反思。 */
  router.get('/retro', async (req, res, next) => {
    try {
      // 模板局部量叫 period 而不是 scope：Express 把 render 的数据对象原样
      // 交给 EJS 当选项用，而 `scope` 正是 EJS 自己的一个（已废弃的）选项名，
      // 撞上之后每次渲染都会打印一行废弃警告，值还会被拿去当模板的 this。
      const period = req.query.scope === 'month' ? 'month' : 'week';
      const range = period === 'month' ? aggregate.thisMonth() : aggregate.thisWeek();
      const data = await aggregate.retrospective(range);
      const title = period === 'month' ? '月回顾' : '周回顾';

      res.render('retro', {
        title,
        period,
        data,
        draft: renderRetrospective(data, { title }),
        suggestedPath: `diary/retro-${period === 'month' ? range.from.slice(0, 7) : range.from}.md`
      });
    } catch (error) {
      next(error);
    }
  });

  /** 把回顾草稿存成一篇笔记，反思就写在里面。 */
  router.post('/retro/save', guard, async (req, res, next) => {
    try {
      const notePath = String(req.body.path || '').trim();
      const body = String(req.body.body ?? '');
      if (!isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      if (!notePath.toLowerCase().endsWith('.md')) throw httpError(400, '文件名必须以 .md 结尾。');
      await enqueueNote(config.notesDir, notePath, async () => {
        try {
          await writeNote(config.notesDir, notePath, { body }, { exclusive: true });
        } catch (error) {
          if (error.code === 'EEXIST') {
            throw httpError(409, '这篇回顾已经存在，直接编辑它就好。');
          }
          throw error;
        }
      });
      await indexer.scan({ paths: [notePath] });
      res.redirect(`/note/${encodePath(notePath)}`);
    } catch (error) {
      next(error);
    }
  });

  /** 简报 = 聚合层的推送版。 */
  router.get('/briefing', async (req, res, next) => {
    try {
      const snapshot = await aggregate.today();
      res.render('briefing', { title: '每日简报', snapshot, text: renderBriefing(snapshot) });
    } catch (error) {
      next(error);
    }
  });

  /** 简报的纯文本预览。 */
  router.get('/briefing.md', async (req, res, next) => {
    try {
      res.type('text/markdown; charset=utf-8').send(renderBriefing(await aggregate.today()));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createTodayRoutes };
