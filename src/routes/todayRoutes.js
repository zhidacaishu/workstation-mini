const express = require('express');

const { createAggregator } = require('../aggregate');

function createTodayRoutes({ config, db, search, now }) {
  const router = express.Router();
  const aggregate = createAggregator({ config, db, now });

  router.get('/', async (req, res, next) => {
    try {
      const snapshot = await aggregate.today();
      res.render('today', {
        title: '今日',
        snapshot,
        projectDeadlines: aggregate.deadlines(snapshot.date).filter(entry => entry.source === '研究项目').slice(0, 4),
        total: db.countNotes(),
        recent: search.recent(8)
      });
    } catch (error) { next(error); }
  });


  return router;
}

module.exports = { createTodayRoutes };
