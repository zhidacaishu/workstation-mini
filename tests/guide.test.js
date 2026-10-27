const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGuideStore, validateGuideState } = require('../electron/guide-store');
const { isTrustedMainOriginSender } = require('../electron/trusted-sender');
test('指引进度独立持久化，完成、跳过和异常状态可恢复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-guide-'));
  try {
    const store = createGuideStore(root);
    assert.equal(store.read().status, 'active');
    store.write({ step: 3, status: 'active' });
    assert.equal(createGuideStore(root).read().step, 3);
    store.write({ step: 3, status: 'skipped' });
    assert.equal(store.read().status, 'skipped');
    assert.throws(() => validateGuideState({ step: 8, status: 'active' }));
    assert.throws(() => store.write({ step: -1, status: 'completed' }));
    assert.equal(store.read().status, 'skipped');
    fs.writeFileSync(path.join(root, 'workstation-data', 'guide.json'), '{bad');
    assert.equal(store.read().step, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('指引 IPC 仅接受当前主窗口与运行时源', () => {
  const frame = { url: 'http://127.0.0.1:1234/note/a.md' };
  const webContents = { mainFrame: frame };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  assert.ok(isTrustedMainOriginSender(event, window, 'http://127.0.0.1:1234'));
  assert.equal(isTrustedMainOriginSender({ ...event, senderFrame: { ...frame } }, window, 'http://127.0.0.1:1234'), false);
  assert.equal(isTrustedMainOriginSender(event, window, 'http://127.0.0.1:9999'), false);
  assert.equal(isTrustedMainOriginSender(event, null, ''), false);
});
