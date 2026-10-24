const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, normalizeDeviceName, defaultVaultDir } = require('../src/config');

test('显式设置派生出桌面内部运行配置', () => {
  const vaultDir = path.resolve('tmp-vault');
  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly: true,
    device: 'Henry 的 Laptop',
    syncEnabled: false,
    syncIntervalMinutes: 7,
    anthropicApiKey: ' key ',
    mineruApiToken: ' mineru-token '
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 0);
  assert.equal(config.vaultDir, vaultDir);
  assert.equal(config.notesDir, path.join(vaultDir, 'notes'));
  assert.equal(config.reviewsDir, path.join(vaultDir, 'reviews'));
  assert.equal(config.attachmentsDir, path.join(vaultDir, 'attachments'));
  assert.equal(config.mineruCacheDir, path.join(vaultDir, '.workstation', 'mineru'));
  assert.equal(config.dbPath, ':memory:');
  assert.equal(config.readOnly, true);
  assert.match(config.device, /^henry-laptop-[a-f0-9]{10}$/);
  assert.equal(config.syncEnabled, false);
  assert.equal(config.syncIntervalMinutes, 7);
  assert.equal(config.anthropicApiKey, 'key');
  assert.equal(config.mineruApiToken, ' mineru-token ');
});

test('默认 vault 位于用户主目录且索引跟随 vault', () => {
  assert.equal(defaultVaultDir(), path.join(os.homedir(), 'workstation-vault'));
  const config = loadConfig({ vaultDir: defaultVaultDir() });
  assert.equal(config.dbPath, path.join(config.vaultDir, 'workstation.db'));
});

test('设备名始终可安全放进复习事件文件名且信息损失时带稳定摘要', () => {
  assert.match(normalizeDeviceName('Desk Top #1'), /^desk-top-1-[a-f0-9]{10}$/);
  assert.equal(normalizeDeviceName('___'), '___');
  assert.equal(normalizeDeviceName('desk-top-1'), 'desk-top-1');
  assert.match(normalizeDeviceName('中文'), /^unknown-[a-f0-9]{10}$/);
  assert.notEqual(normalizeDeviceName('中文'), normalizeDeviceName('研究室'));
  assert.equal(normalizeDeviceName('é'), normalizeDeviceName('é'), 'Unicode 等价名称应先归一为 NFC');
  assert.equal(normalizeDeviceName('中文'), normalizeDeviceName('中文'), '摘要必须稳定');
  assert.match(normalizeDeviceName('a'.repeat(200)), /^a{64}-[a-f0-9]{10}$/);
});
