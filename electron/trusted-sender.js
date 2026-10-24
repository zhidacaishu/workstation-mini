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

module.exports = { normalizedDocumentUrl, isTrustedMainFrameSender };
