const express = require('express');

const { createAggregator } = require('../aggregate');
const { onboardingProgress, readGuideState } = require('../onboarding');

function createTodayRoutes({ config, db, search, guide, now, review }) {
  const router = express.Router();
  const aggregate = createAggregator({ config, db, now, review });

  // 新用户在今日页看到上手清单。只读模式下清单里的事都做不了；全部完成或
  // 用户手动隐藏后不再出现。清单只是提示，读不到卡片或复习日志时不能挡住今日页。
  async function onboarding(recent) {
    if (config.readOnly || readGuideState(guide).checklist === 'hidden') return null;
    try {
      const progress = await onboardingProgress({ db, review: aggregate.review, recent });
      return progress.complete ? null : progress;
    } catch {
      return null;
    }
  }

  router.get('/', async (req, res, next) => {
    try {
      const snapshot = await aggregate.today();
      // 月历备注不算「最近的笔记」：在查询里就排除，而不是取了 8 篇再滤，
      // 否则最近 8 篇恰好都是备注时会误显示「还没有笔记」。
      const recent = search.recent(8, { excludeSection: 'calendar' });
      res.render('today', {
        title: '今日',
        snapshot,
        total: db.countNotes(),
        recent,
        onboarding: await onboarding(recent)
      });
    } catch (error) { next(error); }
  });


  return router;
}

module.exports = { createTodayRoutes };
