const express = require('express');
const { writeHandler } = require('./http');
const { createHealthReport } = require('../health');
function createHealthRoutes(deps) {
  const router = express.Router();
  // 健康统计访问历史记录，旧资料库在读取时可能迁移文件。
  const report = () => createHealthReport(deps);
  router.get('/api/health', writeHandler(async (req, res, next) => { try { res.json(await report()); } catch (error) { next(error); } }));
  router.get('/health', writeHandler(async (req, res, next) => { try { res.render('health', { title: '资料库健康', report: await report() }); } catch (error) { next(error); } }));
  return router;
}
module.exports = { createHealthRoutes };
