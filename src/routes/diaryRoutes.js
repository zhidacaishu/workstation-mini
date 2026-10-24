const express = require('express');

const { createDiary, isValidDateString } = require('../diary');
const { writeNote } = require('../vault/note');
const { enqueueNote } = require('../vault/note-queue');
const { encodePath } = require('../vault/paths');
const { httpError } = require('./http');

function createDiaryRoutes({ config, db, indexer, now }) {
  const router = express.Router();
  const diary = createDiary({ db, config, now });

  router.get('/diary', (req, res) => {
    const today = diary.today();
    const series = diary.trend(30, today);

    res.render('diary', {
      title: '日记',
      today,
      todayExists: diary.exists(today),
      entries: diary.list(60),
      onThisDay: diary.onThisDay(today),
      series,
      summary: diary.summarize(series)
    });
  });

  /**
   * 打开今天的日记，没有就按模板建一篇再打开。
   *
   * 用 POST 而不是 GET：它会写文件。GET 触发写入意味着预取、爬虫、甚至浏览器
   * 的推测性加载都可能凭空建出一篇空日记。
   */
  router.post('/diary/today', async (req, res, next) => {
    try {
      if (config.readOnly) throw httpError(403, '应用处于只读模式，不能新建日记。');

      const date = String(req.body.date || diary.today());
      if (!isValidDateString(date)) throw httpError(400, '日期格式不对，应为 YYYY-MM-DD。');

      const notePath = diary.diaryPath(date);
      await enqueueNote(config.notesDir, notePath, async () => {
        try {
          await writeNote(
            config.notesDir,
            notePath,
            { body: diary.renderNewEntry(date) },
            { exclusive: true }
          );
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      });
      await indexer.scan({ paths: [notePath] });
      res.redirect(`/note/${encodePath(notePath)}`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createDiaryRoutes };
