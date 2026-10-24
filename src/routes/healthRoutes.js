const express = require('express');
const { createHealthReport } = require('../health');
function createHealthRoutes(deps) {
  const router = express.Router();
  const report = () => createHealthReport(deps);
  router.get('/api/health', async (req, res, next) => { try { res.json(await report()); } catch (error) { next(error); } });
  router.get('/health', async (req, res, next) => { try { res.render('health', { title: '资料库健康', report: await report() }); } catch (error) { next(error); } });
  return router;
}
module.exports = { createHealthRoutes };
