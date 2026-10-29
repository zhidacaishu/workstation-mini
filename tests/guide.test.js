const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGuideStore, validateGuideState, GUIDE_STEPS } = require('../electron/guide-store');
const { isTrustedMainOriginSender } = require('../electron/trusted-sender');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-guide-'));
  try { return run(createGuideStore(root), path.join(root, 'workstation-data', 'guide.json')); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('指引进度独立持久化，完成、跳过和异常状态可恢复', () => withStore((store, file) => {
  assert.deepEqual(store.read(), { version: 2, step: 0, status: 'active', checklist: 'shown' });
  store.write({ step: 3, status: 'active' });
  assert.equal(createGuideStore(path.dirname(path.dirname(file))).read().step, 3);
  store.write({ step: 3, status: 'skipped' });
  assert.equal(store.read().status, 'skipped');
  assert.throws(() => validateGuideState({ step: GUIDE_STEPS, status: 'active' }));
  assert.throws(() => store.write({ step: -1, status: 'completed' }));
  assert.throws(() => store.write({ checklist: 'gone' }));
  assert.equal(store.read().status, 'skipped');
  fs.writeFileSync(file, '{bad');
  assert.equal(store.read().step, 0);
}));

test('导览翻页与上手清单开关互不覆盖', () => withStore(store => {
  store.write({ checklist: 'hidden' });
  store.write({ step: 2, status: 'active' });
  assert.deepEqual(store.read(), { version: 2, step: 2, status: 'active', checklist: 'hidden' });
  store.write({ status: 'completed' });
  assert.deepEqual(store.read(), { version: 2, step: 2, status: 'completed', checklist: 'hidden' });
  store.write({ checklist: 'shown' });
  assert.equal(store.read().status, 'completed');
}));

test('旧版八步指引的进度迁移：看完或跳过的不再打扰，看到一半的从头开始', () => withStore((store, file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const status of ['completed', 'skipped']) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, step: 7, status }));
    assert.deepEqual(store.read(), { version: 2, step: 0, status, checklist: 'shown' });
  }
  // 其它桌面测试用不带版本号的 { step: 7, status: 'completed' } 关掉导览，同样要认。
  fs.writeFileSync(file, JSON.stringify({ step: 7, status: 'completed' }));
  assert.equal(store.read().status, 'completed');
  fs.writeFileSync(file, JSON.stringify({ version: 1, step: 5, status: 'active' }));
  assert.deepEqual(store.read(), { version: 2, step: 0, status: 'active', checklist: 'shown' });
}));

test('导览模板步数与存储上限一致', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'partials', 'tour.ejs'), 'utf8');
  assert.equal(template.match(/<template data-guide-step/g).length, GUIDE_STEPS);
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
