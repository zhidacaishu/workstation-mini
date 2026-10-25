const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const { createNoteRoutes } = require('./routes/noteRoutes');
const { createHistoryRoutes } = require('./routes/historyRoutes');
const { createHealthRoutes } = require('./routes/healthRoutes');
const { createReviewRoutes } = require('./routes/reviewRoutes');
const { createItemRoutes } = require('./routes/itemRoutes');
const { createTodayRoutes } = require('./routes/todayRoutes');
const { createCalendarRoutes } = require('./routes/calendarRoutes');
const { encodePath } = require('./vault/paths');
const { toLocalDate } = require('./templates');
const viewHelpers = require('./viewHelpers');

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function wantsJson(req) {
  return req.xhr
    || req.is('application/json')
    || (req.get('accept') || '').includes('application/json');
}

function createApp(config, deps) {
  const app = express();
  const noopSync = async () => ({ ok: true, skipped: '同步未配置' });
  const resolved = {
    sync: {
      commitAndPush: noopSync,
      pull: noopSync,
      cycle: noopSync,
      syncReviewLogs: noopSync,
      idle: noopSync
    },
    // 没显式传相似度服务就退回主线程内联计算：运行时会传一个带工作线程的进来，
    // 而直接构造 app 的调用方不该被迫去管线程生命周期。
    ...deps
  };

  // 界面跑在 Electron 里，而这个 HTTP 服务就在主进程内，所以 process.platform
  // 就是用户实际所在的平台 —— 前端不必去嗅探 userAgent。可注入是为了让回归测试
  // 能在任意平台上验两端的渲染差异，生产路径不传，走默认值。
  //
  // 主修饰键必须分平台，不能「Ctrl 或 Cmd 都认」：macOS 的 Ctrl+K 是系统级的
  // 文本编辑绑定（删到行尾），认了它就等于在编辑器里把这个键抢走。
  const isMac = (resolved.platform || process.platform) === 'darwin';

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });

  if (config.internalToken) {
    app.use((req, res, next) => {
      if (safeEqual(req.get('x-workstation-internal-token'), config.internalToken)) {
        next();
        return;
      }
      res.status(403).type('text/plain').send('Forbidden');
    });
  }

  // 附件上传的请求体就是文件本身（见 attachmentRoutes），不能先被这里按
  // Content-Type 解析掉：前端发的是文件自己的 MIME 类型，一个 .json 附件会被
  // express.json() 读空，上传路由只收到零字节。
  const skipRawUploads = parser => (req, res, next) => (
    req.method === 'POST' && req.path === '/attachments' ? next() : parser(req, res, next)
  );
  app.use(skipRawUploads(express.urlencoded({ extended: false, limit: '2mb' })));
  app.use(skipRawUploads(express.json({ limit: '2mb' })));
  app.use('/static', express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProduction ? '1h' : 0
  }));
  // 打包的界面字体。字体文件按内容切片且版本固定，可以长时间缓存。
  for (const [name, directory] of Object.entries(viewHelpers.fontDirectories())) {
    app.use(`/static/fonts/${name}`, express.static(directory, {
      maxAge: config.isProduction ? '30d' : 0,
      index: false
    }));
  }

  const navCounts = viewHelpers.createNavCounts({ config, db: resolved.db, now: resolved.now });

  app.use(async (req, res, next) => {
    res.locals.readOnly = config.readOnly;
    res.locals.currentPath = req.path;
    res.locals.encodePath = encodePath;
    res.locals.isMac = isMac;
    res.locals.draftId = crypto.randomUUID();
    res.locals.recovered = false;
    res.locals.editorWarning = '';
    res.locals.today = toLocalDate((resolved.now || (() => new Date()))());
    res.locals.ui = viewHelpers;
    res.locals.navCounts = { overdue: 0, review: 0 };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      navCounts.invalidate();
    } else if (!wantsJson(req) && !req.path.startsWith('/api/')) {
      try {
        res.locals.navCounts = await navCounts.get();
      } catch {}
    }
    next();
  });

  app.use(createTodayRoutes({ config, ...resolved }));
  app.use(createCalendarRoutes({ config, ...resolved }));
  app.use(createReviewRoutes({ config, ...resolved }));
  app.use(createItemRoutes({ config, ...resolved }));
  app.use(createNoteRoutes({ config, ...resolved }));
  app.use(createHistoryRoutes({ config, ...resolved }));
  app.use(createHealthRoutes({ config, ...resolved }));

  app.use((req, res) => {
    const message = `没有这个地址：${req.path}`;
    if (wantsJson(req)) {
      res.status(404).json({ ok: false, message });
      return;
    }
    res.status(404).render('error', { title: '找不到页面', message });
  });

  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    // 索引库页损坏常常要到某个页面查询时才暴露；记下来，下次启动时重建。
    const corrupt = status >= 500 && Boolean(resolved.db?.reportError?.(error));
    const message = corrupt
      ? '索引数据库已损坏，请重启应用，启动时会自动重建。'
      : status >= 500 ? '应用内部错误，请稍后重试。' : error.message;

    if (wantsJson(req)) {
      res.status(status).json({
        ok: false,
        message,
        ...(Array.isArray(error.completedOutputs) ? { completedOutputs: error.completedOutputs } : {})
      });
      return;
    }
    res.status(status).render('error', {
      title: status === 404 ? '找不到笔记' : '出错了',
      message
    });
  });

  return app;
}

module.exports = { createApp };
