function normalizedDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function isTrustedMainFrameSender(event, window, documentUrl) {
  return event?.sender === window?.webContents
    && event?.senderFrame === window?.webContents?.mainFrame
    && normalizedDocumentUrl(event.senderFrame?.url) === documentUrl;
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
