const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const fsSync = require('node:fs');

const { createConfigStore, normalizeSettings } = require('../electron/config-store');
const { createRuntimeConfig } = require('../electron/runtime-config');
const { validateSettingsUpdate } = require('../electron/settings-validation');

test('新安装默认关闭同步，旧设置缺字段时保留历史开启行为', async () => {
  const freshPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-fresh-settings-'));
  const legacyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-legacy-settings-'));
  try {
    const fresh = createConfigStore({ userDataPath: freshPath });
    assert.equal(fresh.load().syncEnabled, false);

    const legacy = createConfigStore({ userDataPath: legacyPath });
    await fs.mkdir(legacy.directory, { recursive: true });
    await fs.writeFile(legacy.filePath, JSON.stringify({ schemaVersion: 1, vaultDir: 'C:\\vault' }), 'utf8');
    assert.equal(legacy.load().syncEnabled, true);

    await fs.writeFile(legacy.filePath, JSON.stringify({ schemaVersion: 1, syncEnabled: false }), 'utf8');
    assert.equal(legacy.load().syncEnabled, false);
  } finally {
    await Promise.all([freshPath, legacyPath].map(target => fs.rm(target, { recursive: true, force: true })));
  }
});

test('桌面设置原子保存并保留上一版快照', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-settings-'));
  try {
    const store = createConfigStore({ userDataPath });
    store.write({ ...normalizeSettings(), vaultDir: 'C:\\vault-one' });
    store.write({ ...store.load(), vaultDir: 'C:\\vault-two' });

    assert.equal(store.load().vaultDir, 'C:\\vault-two');
    const previous = JSON.parse(await fs.readFile(store.backupPath, 'utf8'));
    assert.equal(previous.vaultDir, 'C:\\vault-one');
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('比应用更新的设置版本不会被旧版静默覆写', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-newer-settings-'));
  try {
    const store = createConfigStore({ userDataPath });
    await fs.mkdir(store.directory, { recursive: true });
    await fs.writeFile(store.filePath, JSON.stringify({ schemaVersion: 99, vaultDir: 'C:\\future' }), 'utf8');
    await fs.writeFile(store.backupPath, JSON.stringify({ schemaVersion: 1, vaultDir: 'C:\\old' }), 'utf8');

    assert.throws(() => store.load(), /更新版本/);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('旧版 AI 密文设置会被忽略并在下一次保存时移除，不读取安全存储', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-legacy-ai-'));
  try {
    const store = createConfigStore({
      userDataPath,
      safeStorage: { decryptString() { throw new Error('不应读取旧密文'); } }
    });
    await fs.mkdir(store.directory, { recursive: true });
    await fs.writeFile(store.filePath, JSON.stringify({
      schemaVersion: 4,
      vaultDir: 'C:\\vault',
      secrets: { anthropicApiKey: 'legacy-encrypted-value' }
    }), 'utf8');

    const settings = store.load();
    assert.equal(Object.hasOwn(settings, 'secrets'), false);
    store.write(settings);
    const saved = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
    assert.equal(Object.hasOwn(saved, 'secrets'), false);
    assert.equal(Object.hasOwn(saved, 'anthropicApiKey'), false);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('旧检查器和 AI 设置字段在归一化时被丢弃，且不再接受更新', () => {
  const normalized = normalizeSettings({
    vaultDir: ' /vault ',
    checkDraftPath: ' /tools/check_draft.py ',
    pythonPath: ' python3 ',
    anthropicApiKey: 'legacy-value',
    secrets: { anthropicApiKey: 'legacy-encrypted-value' }
  });
  assert.deepEqual(normalized, {
    schemaVersion: 5,
    vaultDir: '/vault',
    device: '',
    readOnly: false,
    syncEnabled: false,
    syncIntervalMinutes: 15,
    launchAtLogin: false,
    theme: 'system'
  });
  assert.throws(() => validateSettingsUpdate({
    settings: { vaultDir: '/vault', checkDraftPath: '/tools/check_draft.py' }
  }), /未知设置字段：checkDraftPath/);
  assert.throws(() => validateSettingsUpdate({
    settings: { vaultDir: '/vault', pythonPath: 'python3' }
  }), /未知设置字段：pythonPath/);
  assert.throws(() => validateSettingsUpdate({
    settings: { vaultDir: '/vault' }, secrets: {}
  }), /未知设置数据字段：secrets/);
});

test('设置归一化把同步间隔限制为有效整数范围', () => {
  assert.equal(normalizeSettings({ syncIntervalMinutes: 0 }).syncIntervalMinutes, 1);
  assert.equal(normalizeSettings({ syncIntervalMinutes: 12.9 }).syncIntervalMinutes, 12);
  assert.equal(normalizeSettings({ syncIntervalMinutes: 9_999 }).syncIntervalMinutes, 1_440);
  assert.equal(normalizeSettings({ syncIntervalMinutes: 'invalid' }).syncIntervalMinutes, 15);
});

test('运行配置总是生成新的内部令牌并固定回环随机端口', () => {
  const settings = normalizeSettings({ vaultDir: path.resolve('vault') });
  const one = createRuntimeConfig(settings);
  const two = createRuntimeConfig(settings);
  assert.equal(one.host, '127.0.0.1');
  assert.equal(one.port, 0);
  assert.equal(one.internalToken.length, 64);
  assert.notEqual(one.internalToken, two.internalToken);
});

// settings.json 的落盘过去是裸 fs.renameSync。这个应用发 Windows，那边的 rename
// 会被杀毒软件和索引服务的瞬时句柄打断（EPERM/EACCES/EBUSY）—— vault 里的笔记
// 早就为此走 atomic.js 的重试了，唯独设置文件没有。而它偏偏是被夹在
// 「改设置 → 重启运行时 → 失败就整体回滚」中间的那一次写入：在这里 EBUSY 一下，
// 一份本来完全合法的新配置就被连坐回滚掉，用户看到的是「保存设置失败」。
test('设置落盘遇到 Windows 瞬时占用时重试，而不是让保存失败', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-settings-busy-'));
  const rename = fsSync.renameSync;
  let attempts = 0;
  fsSync.renameSync = (...args) => {
    attempts += 1;
    if (attempts <= 3) {
      const error = new Error('文件正被占用');
      error.code = 'EBUSY';
      throw error;
    }
    return rename(...args);
  };

  try {
    const store = createConfigStore({ userDataPath: userData });
    const written = store.write({ ...normalizeSettings(), device: 'busy-box' });
    assert.equal(written.device, 'busy-box');
    assert.equal(attempts, 4, '前三次应被当成瞬时占用重试');
    assert.equal(store.load().device, 'busy-box');

    // 重试路径不能留下临时文件：设置目录里除了 settings.json 不该多出东西。
    assert.deepEqual((await fs.readdir(store.directory)).sort(), ['settings.json']);
  } finally {
    fsSync.renameSync = rename;
    await fs.rm(userData, { recursive: true, force: true });
  }
});

// 真失败（不在瞬时占用码表里）必须照常抛出去，别把重试写成吞错误。
test('设置落盘遇到非瞬时错误立刻失败且不留临时文件', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-settings-fail-'));
  const rename = fsSync.renameSync;
  let attempts = 0;
  fsSync.renameSync = () => {
    attempts += 1;
    const error = new Error('磁盘只读');
    error.code = 'EROFS';
    throw error;
  };

  try {
    const store = createConfigStore({ userDataPath: userData });
    assert.throws(() => store.write({ ...normalizeSettings(), device: 'doomed' }), /磁盘只读/);
    assert.equal(attempts, 1, '非瞬时错误不该重试');
    assert.deepEqual(await fs.readdir(store.directory), []);
  } finally {
    fsSync.renameSync = rename;
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('外观设置只接受跟随系统、浅色、深色，旧配置默认跟随系统', () => {
  assert.equal(normalizeSettings({ vaultDir: '/vault' }).theme, 'system');
  assert.equal(normalizeSettings({ vaultDir: '/vault', theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeSettings({ vaultDir: '/vault', theme: 'sepia' }).theme, 'system');
  assert.doesNotThrow(() => validateSettingsUpdate({ settings: { vaultDir: '/vault', theme: 'light' } }));
  assert.throws(() => validateSettingsUpdate({ settings: { vaultDir: '/vault', theme: 'sepia' } }), /外观/);
});
