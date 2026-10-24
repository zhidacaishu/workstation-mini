const express = require('express');

const { createCalendar } = require('../calendar');
const { renderCalendar } = require('../ics');
const { isValidDateString, isValidMonthString, addDays, monthOf } = require('../dates');
const { httpError, blockWhenReadOnly } = require('./http');

// .ics 默认导出的窗口：往回一个月（刚过去的截止还有用），往前一年。
const ICS_PAST_DAYS = 30;
const ICS_FUTURE_DAYS = 365;

function createCalendarRoutes({ config, db, indexer, now }) {
  const router = express.Router();
  const calendar = createCalendar({ config, db, indexer, now });
  const guard = blockWhenReadOnly(config, '不能修改日程。');

  /** 月视图。?month=2026-08 翻月，?day=2026-08-12 展开右侧详情。 */
  router.get('/calendar', async (req, res, next) => {
    try {
      const requested = String(req.query.month || '').trim();
      if (requested && !isValidMonthString(requested)) {
        throw httpError(400, '月份格式不对，应为 YYYY-MM。');
      }

      const grid = await calendar.month(requested);

      const requestedDay = String(req.query.day || '').trim();
      if (requestedDay && !isValidDateString(requestedDay)) {
        throw httpError(400, '日期格式不对，应为 YYYY-MM-DD。');
      }
      // 没点具体某天时：看的是本月就展开今天，翻到别的月份就展开 1 号 ——
      // 详情栏总有内容，不会在翻月后突然空掉。
      const detailDate = requestedDay
        || (grid.month === monthOf(grid.today) ? grid.today : `${grid.month}-01`);

      res.render('calendar', {
        title: '日历',
        grid,
        detail: await calendar.day(detailDate)
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 订阅/导入用的 .ics。
   *
   * 只读，没有写入口 —— 这个应用里 Markdown 是唯一真相，日历文件只是它的投影。
   */
  router.get('/calendar.ics', (req, res, next) => {
    try {
      const today = calendar.today();
      const entries = calendar.icsEntries({
        from: addDays(today, -ICS_PAST_DAYS),
        to: addDays(today, ICS_FUTURE_DAYS)
      });

      res.type('text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="workstation.ics"');
      res.send(renderCalendar(entries, { name: '科研工作台', dtstamp: now ? now() : new Date() }));
    } catch (error) {
      next(error);
    }
  });

  /** 给某天排一个时间块，落到那天日记 frontmatter 的 plan 里。 */
  router.post('/calendar/plan', guard, async (req, res, next) => {
    try {
      const date = String(req.body.date || '').trim();
      const result = await calendar.addPlanBlock(date, {
        from: req.body.from,
        to: req.body.to,
        what: req.body.what,
        expectedHash: req.body.expectedHash
      });

      if (String(req.get('accept') || '').includes('application/json')) {
        res.json({ ok: true, ...result });
        return;
      }
      res.redirect(`/calendar?month=${monthOf(result.date)}&day=${result.date}`);
    } catch (error) {
      // 领域层抛的是普通 Error，到边界上翻译成 400 —— 这些都是用户填错了，
      // 不是应用坏了，不该走 500 那条把文案吞掉的路径。
      next(error.status ? error : httpError(400, error.message));
    }
  });

  /** 当天议程的 JSON。桌面提醒调度器在主进程里轮询这个。 */
  router.get('/api/calendar/agenda', async (req, res, next) => {
    try {
      const requested = String(req.query.date || '').trim();
      if (requested && !isValidDateString(requested)) {
        throw httpError(400, '日期格式不对，应为 YYYY-MM-DD。');
      }
      const detail = await calendar.day(requested || undefined);
      res.json({
        ok: true,
        date: detail.date,
        weekday: detail.weekday,
        plan: detail.plan,
        entries: detail.entries,
        reviewDue: detail.reviewDue
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createCalendarRoutes, ICS_PAST_DAYS, ICS_FUTURE_DAYS };
