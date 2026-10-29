const express = require('express');

const { createReviewService } = require('../reviewService');
const { onboardingProgress, gitSetupStatus, gitSetupCommands, readGuideState } = require('../onboarding');

/**
 * 上手指南：上手清单 + 语法速查 + Git 版本记录的准备情况。
 *
 * 首次启动的界面导览只负责「东西在哪」；怎么写、怎么配都放在这一页，
 * 随时能回来翻，也能直接跳到某一节（/guide#git）。
 */
function createGuideRoutes({ config, db, search, guide, now, review: shared }) {
  const router = express.Router();
  const review = shared || createReviewService({ vaultDir: config.vaultDir, device: config.device, now });

  router.get('/guide', async (req, res, next) => {
    try {
      const [progress, git] = await Promise.all([
        onboardingProgress({ db, review, recent: search.recent(8) }),
        gitSetupStatus(config)
      ]);
      res.render('guide', {
        title: '上手指南',
        progress,
        git,
        gitCommands: gitSetupCommands(config.vaultDir, git),
        vaultDir: config.vaultDir,
        checklistHidden: readGuideState(guide).checklist === 'hidden'
      });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = { createGuideRoutes };
