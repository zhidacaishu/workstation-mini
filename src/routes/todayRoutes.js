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
        total: db.countNotes(),
        recent: search.recent(8)
      });
    } catch (error) { next(error); }
  });

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
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createTodayRoutes };
