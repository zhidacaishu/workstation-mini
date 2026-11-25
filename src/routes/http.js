/**
 * 路由层公用件。
 *
 * 这两样东西每个路由文件都要用：构造带状态码的错误、在只读模式下拦住写请求。
 * 放在这里而不是各自复制一份，是为了让「只读模式返回什么状态码」这类规则
 * 只有一个改动点。
 */

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * 只读模式下拒绝写请求。
 *
 * 文案由调用方给，因为它是用户直接看到的：笔记页该说「不能修改笔记」，
 * 而不是笼统的「不能写入」。前缀统一在这里拼，保证各处口径一致。
 *
 * 注意这拦的是「改动 vault 里的 Markdown」。复习事件按设备追加到独立 JSONL，
 * 不算 Markdown 改动，只读模式下仍然放行 —— 见 reviewRoutes。
 */
function blockWhenReadOnly(config, action) {
  return (req, res, next) => {
    if (config.readOnly) {
      next(httpError(403, `应用处于只读模式，${action}`));
      return;
    }
    next();
  };
}

// 跟踪业务处理函数的 Promise。客户端断线后，它仍可能在保存或提交索引。
function writeHandler(handler) {
  return (req, res, next) => {
    const run = () => handler(req, res, next);
    return req.app.locals.trackWrite ? req.app.locals.trackWrite(run) : run();
  };
}

// 写入成功后再由服务端记下一次性提示，避免原生表单提交未落盘就提前报「已完成」。
function setFlash(res, payload) {
  if (!payload?.message) return;
  res.cookie('ws_flash', JSON.stringify(payload), {
    maxAge: 30_000,
    httpOnly: true,
    sameSite: 'strict',
    path: '/'
  });
}

module.exports = { httpError, blockWhenReadOnly, writeHandler, setFlash };
