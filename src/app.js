const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const { createResourceRoutes } = require('./routes/resourceRoutes');
const { createNoteRoutes } = require('./routes/noteRoutes');
const { createHistoryRoutes } = require('./routes/historyRoutes');
const { createHealthRoutes } = require('./routes/healthRoutes');
const { createReviewRoutes } = require('./routes/reviewRoutes');
const { createItemRoutes } = require('./routes/itemRoutes');
const { createTodayRoutes } = require('./routes/todayRoutes');
const { createCalendarRoutes } = require('./routes/calendarRoutes');
const { createGuideRoutes } = require('./routes/guideRoutes');
const { createEditorRoutes } = require('./routes/editorRoutes');
const { encodePath } = require('./vault/paths');
const { toLocalDate } = require('./templates');
const viewHelpers = require('./viewHelpers');
const { createReviewService } = require('./reviewService');

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

// 编辑器一次提交整篇原文；10MB 足够任何正常的笔记，又不至于把一次误粘贴的巨型内容整个吞进内存。
const BODY_LIMIT = '10mb';

function createApp(config, deps) {
  const app = express();
  app.locals.trackWrite = deps?.trackWrite;
  const noopSync = async () => ({ ok: true, skipped: '同步未配置' });
  const resolved = {
    sync: {
      commitAndPush: noopSync,
      pull: noopSync,
      cycle: noopSync,
      syncReviewLogs: noopSync,
      idle: noopSync
    },
    ...deps
  };
  // 整个应用共用一个复习服务：卡片和复习日志的缓存只建一份，今日、卡组、复习、
  // 侧栏角标看到的是同一份状态。
  resolved.review ||= createReviewService({ vaultDir: config.vaultDir, device: config.device, now: resolved.now });

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

  // 页面模板要用的默认值放在解析请求体之前：请求体解析出错（太大、格式坏）时
  // 直接进错误页，那时后面的中间件都还没跑，模板里缺这些变量就会崩成一页堆栈。
  app.use((req, res, next) => {
    res.locals.readOnly = config.readOnly;
    res.locals.currentPath = req.path;
    res.locals.encodePath = encodePath;
    res.locals.isMac = isMac;
    // macOS 桌面壳隐藏了系统标题栏，页面要给红绿灯让位（见 electron/platform-policy.js）。
    res.locals.insetChrome = config.windowChrome === 'inset';
    res.locals.draftId = crypto.randomUUID();
    res.locals.recovered = false;
    res.locals.editorWarning = '';
    res.locals.today = toLocalDate((resolved.now || (() => new Date()))());
    res.locals.ui = viewHelpers;
    res.locals.navCounts = { overdue: 0, review: 0 };
    next();
  });

  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));
  app.use(express.json({ limit: BODY_LIMIT }));
  // 没有请求体或 Content-Type 不认识时，Express 5 的 req.body 是 undefined；
  // 统一成空对象，交给各路由按「缺字段」返回 400，而不是读属性时崩成 500。
  app.use((req, res, next) => {
    req.body ??= {};
    // 只用到一两个界面偏好（比如计划页上次的视图），不值得为此引入 cookie-parser。
    req.cookies = Object.fromEntries(String(req.get('cookie') || '').split(';').map(part => {
      const index = part.indexOf('=');
      if (index < 0) return null;
      try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]; } catch { return null; }
    }).filter(Boolean));
    next();
  });
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

  app.use('/static/katex', express.static(path.join(path.dirname(require.resolve('katex/package.json')), 'dist'), {
    index: false, maxAge: config.isProduction ? '30d' : 0
  }));

  const navCounts = viewHelpers.createNavCounts({ config, db: resolved.db, now: resolved.now, review: resolved.review });

  // 侧栏角标只在真的渲染页面时才算：图片、媒体、JSON 接口和跳转都用不上它。
  app.use((req, res, next) => {
    const render = res.render.bind(res);
    res.render = (view, locals, callback) => {
      navCounts.get()
        .then(counts => { res.locals.navCounts = counts; }, () => {})
        .then(() => render(view, locals, callback));
    };
    next();
  });

  app.use(createResourceRoutes({ config }));
  app.use(createTodayRoutes({ config, ...resolved }));
  app.use(createCalendarRoutes({ config, ...resolved }));
  app.use(createReviewRoutes({ config, ...resolved }));
  app.use(createItemRoutes({ config, ...resolved }));
  app.use(createNoteRoutes({ config, ...resolved }));
  app.use(createHistoryRoutes({ config, ...resolved }));
  app.use(createHealthRoutes({ config, ...resolved }));
  app.use(createGuideRoutes({ config, ...resolved }));
  app.use(createEditorRoutes({ config, ...resolved }));

  app.use((req, res) => {
    const message = `没有这个地址：${req.path}`;
    if (wantsJson(req)) {
      res.status(404).json({ ok: false, message });
      return;
    }
    res.status(404).render('error', { title: '找不到页面', message });
  });

  app.use((error, req, res, next) => {
    // 响应已经开始发了，不能再渲染错误页（会抛 ERR_HTTP_HEADERS_SENT 打到主进程）；
    // 交给 Express 默认处理，它只断开这个连接。
    if (res.headersSent) {
      next(error);
      return;
    }
    // 请求体解析阶段的错误（body-parser）：给中文说明，不露英文原文。
    if (error.type === 'entity.too.large') {
      error.status = 413;
      // 贴图走单独的 15 MB 上限（editorRoutes），别拿笔记的 10MB 提示去说一张图片。
      error.message = req.path === '/api/attachments'
        ? `图片超过 ${Math.round((error.limit || 0) / 1024 / 1024)} MB，没有保存。请先压缩或缩小后再贴。`
        : '内容超过 10MB，没有保存。请把大段内容拆到几篇笔记里。';
    } else if (error.type === 'entity.parse.failed' || error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
      error.status = 400;
      error.message = '请求格式不正确，没有保存。';
    }
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    // 索引库页损坏常常要到某个页面查询时才暴露；记下来，下次启动时重建。
    const corrupt = status >= 500 && Boolean(resolved.db?.reportError?.(error));
    const message = corrupt
      ? '索引数据库已损坏，请重启应用，启动时会自动重建。'
      : error.code === 'HISTORY_WRITE_FAILED' ? '本机历史未能保存，请检查磁盘后重试。'
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
