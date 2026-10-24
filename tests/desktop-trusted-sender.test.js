const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizedDocumentUrl, isTrustedMainFrameSender } = require('../electron/trusted-sender');

const DOCUMENT = 'file:///D:/app/electron/recovery/index.html';

function fixture(url = DOCUMENT) {
  const mainFrame = { url };
  const webContents = { mainFrame };
  const window = { webContents };
  const event = { sender: webContents, senderFrame: mainFrame };
  return { event, window, webContents, mainFrame };
}

test('只有目标窗口精确本地文档的主 frame 能调用 IPC', () => {
  const trusted = fixture();
  assert.equal(isTrustedMainFrameSender(trusted.event, trusted.window, DOCUMENT), true);

  assert.equal(isTrustedMainFrameSender(
    { ...trusted.event, sender: {} }, trusted.window, DOCUMENT
  ), false);
  assert.equal(isTrustedMainFrameSender(
    { ...trusted.event, senderFrame: { url: DOCUMENT } }, trusted.window, DOCUMENT
  ), false);
  assert.equal(isTrustedMainFrameSender(
    { ...trusted.event, senderFrame: { ...trusted.mainFrame, url: 'file:///D:/app/electron/recovery/other.html' } },
    trusted.window,
    DOCUMENT
  ), false);
});

test('查询和 fragment 不改变文档身份，但路径与协议不能伪装', () => {
  assert.equal(normalizedDocumentUrl(`${DOCUMENT}?mode=restore#step`), DOCUMENT);
  assert.equal(normalizedDocumentUrl('https://example.com/recovery/index.html'), 'https://example.com/recovery/index.html');
  assert.equal(normalizedDocumentUrl('not a url'), '');

  const trusted = fixture(`${DOCUMENT}?mode=restore#step`);
  assert.equal(isTrustedMainFrameSender(trusted.event, trusted.window, DOCUMENT), true);
  trusted.mainFrame.url = 'https://example.com/recovery/index.html';
  assert.equal(isTrustedMainFrameSender(trusted.event, trusted.window, DOCUMENT), false);
});
