const { fileURLToPath, pathToFileURL } = require('node:url');

/**
 * 页面地址去掉查询和锚点后的规范写法。本地文件统一按「路径 → URL」重新编码一次：
 * Node 的 pathToFileURL 会把 `[` `]` 编成 %5B %5D，Chromium 报告的 frame 地址却保留
 * 原字符，按字符串比较时装在带方括号目录里的应用，设置和恢复窗口的每一次调用都被拒。
 */
function normalizedDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    if (url.protocol === 'file:') return pathToFileURL(fileURLToPath(url)).href;
    return url.href;
  } catch {
    return '';
  }
}

function isTrustedMainFrameSender(event, window, documentUrl) {
  return event?.sender === window?.webContents
    && event?.senderFrame === window?.webContents?.mainFrame
    && normalizedDocumentUrl(event.senderFrame?.url) === normalizedDocumentUrl(documentUrl);
}

function isTrustedMainOriginSender(event, window, origin) {
  if (!origin || !window || window.isDestroyed()) return false;
  try {
    return event?.sender === window.webContents
      && event?.senderFrame === window.webContents.mainFrame
      && new URL(event.senderFrame.url).origin === origin;
  } catch { return false; }
}

module.exports = { normalizedDocumentUrl, isTrustedMainFrameSender, isTrustedMainOriginSender };
