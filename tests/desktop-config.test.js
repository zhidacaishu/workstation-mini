const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const fsSync = require('node:fs');

const { createConfigStore, normalizeSettings } = require('../electron/config-store');
const { createRuntimeConfig } = require('../electron/runtime-config');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, '')
  };
}

test('新安装默认关闭同步，旧设置缺字段时保留历史开启行为', async () => {
  const freshPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-fresh-settings-'));
  const legacyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-legacy-settings-'));
  try {
    const fresh = createConfigStore({ userDataPath: freshPath, safeStorage: fakeSafeStorage() });
    assert.equal(fresh.load().syncEnabled, false);

    const legacy = createConfigStore({ userDataPath: legacyPath, safeStorage: fakeSafeStorage() });
    await fs.mkdir(legacy.directory, { recursive: true });
    await fs.writeFile(legacy.filePath, JSON.stringify({ schemaVersion: 1, vaultDir: 'C:\\vault' }), 'utf8');
    assert.equal(legacy.load().syncEnabled, true);

    await fs.writeFile(legacy.filePath, JSON.stringify({ schemaVersion: 1, syncEnabled: false }), 'utf8');
    assert.equal(legacy.load().syncEnabled, false);
  } finally {
    await Promise.all([freshPath, legacyPath].map(target => fs.rm(target, { recursive: true, force: true })));
  }
});

test('自动更新默认开启，升级后不会因为老设置里没这个字段而悄悄关掉', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-updates-settings-'));
  try {
    const store = createConfigStore({ userDataPath, safeStorage: fakeSafeStorage() });
    assert.equal(store.load().updatesEnabled, true);

    // 这是升级路径：设置文件是老版本写的，里面根本没有 updatesEnabled。
    // Boolean(undefined) 会判成关闭，那样每次升级都要手工再打开一次。
    await fs.mkdir(store.directory, { recursive: true });
    await fs.writeFile(store.filePath, JSON.stringify({ schemaVersion: 2, vaultDir: 'C:\\vault' }), 'utf8');
    assert.equal(store.load().updatesEnabled, true);

    // 显式关掉就要留住，不能被默认值盖回去。
    await fs.writeFile(
      store.filePath,
      JSON.stringify({ schemaVersion: 2, vaultDir: 'C:\\vault', updatesEnabled: false }),
      'utf8'
    );
    assert.equal(store.load().updatesEnabled, false);
    assert.equal(store.write(store.load()).updatesEnabled, false);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('桌面设置原子保存并保留上一版快照', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-settings-'));
  try {
    const store = createConfigStore({ userDataPath, safeStorage: fakeSafeStorage() });
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
    const store = createConfigStore({ userDataPath, safeStorage: fakeSafeStorage() });
    await fs.mkdir(store.directory, { recursive: true });
    await fs.writeFile(store.filePath, JSON.stringify({ schemaVersion: 99, vaultDir: 'C:\\future' }), 'utf8');
    await fs.writeFile(store.backupPath, JSON.stringify({ schemaVersion: 1, vaultDir: 'C:\\old' }), 'utf8');

    assert.throws(() => store.load(), /更新版本/);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('秘密只以密文保存，公开设置只返回配置状态', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-secrets-'));
  try {
    const store = createConfigStore({ userDataPath, safeStorage: fakeSafeStorage() });
    const current = store.load();
    const next = store.applyUpdate(current, {
      settings: { vaultDir: 'C:\\vault' },
      secrets: {
        anthropicApiKey: { action: 'set', value: 'sk-ant-secret' },
        journalTrackerPassword: { action: 'set', value: 'password' },
        blobServerToken: { action: 'set', value: 'blob-token-secret' },
        mineruApiToken: { action: 'set', value: 'mineru-token-secret' }
      }
    });
    store.write(next);

    const raw = await fs.readFile(store.filePath, 'utf8');
    assert.doesNotMatch(raw, /sk-ant-secret|blob-token-secret|mineru-token-secret|"password"\s*:/);
    assert.deepEqual(store.runtimeSecrets(next), {
      anthropicApiKey: 'sk-ant-secret',
      journalTrackerPassword: 'password',
      blobServerToken: 'blob-token-secret',
      mineruApiToken: 'mineru-token-secret'
    });
    assert.deepEqual(store.publicSettings(next).secrets, {
      anthropicApiKey: true,
      journalTrackerPassword: true,
      blobServerToken: true,
      mineruApiToken: true
    });
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test('空秘密更新保留旧值，清除必须显式操作', () => {
  const store = createConfigStore({ userDataPath: 'C:\\tmp', safeStorage: fakeSafeStorage() });
  const configured = store.applyUpdate(normalizeSettings(), {
    settings: { vaultDir: 'C:\\vault' },
    secrets: { anthropicApiKey: { action: 'set', value: 'secret' } }
  });
  const kept = store.applyUpdate(configured, {
    settings: { vaultDir: 'C:\\vault' },
    secrets: { anthropicApiKey: { action: 'keep' } }
  });
  assert.equal(kept.secrets.anthropicApiKey, configured.secrets.anthropicApiKey);

  const cleared = store.applyUpdate(kept, {
    settings: { vaultDir: 'C:\\vault' },
    secrets: { anthropicApiKey: { action: 'clear' } }
  });
  assert.equal(cleared.secrets.anthropicApiKey, undefined);
});

test('设置归一化把同步间隔限制为有效整数范围', () => {
  assert.equal(normalizeSettings({ syncIntervalMinutes: 0 }).syncIntervalMinutes, 1);
  assert.equal(normalizeSettings({ syncIntervalMinutes: 12.9 }).syncIntervalMinutes, 12);
  assert.equal(normalizeSettings({ syncIntervalMinutes: 9_999 }).syncIntervalMinutes, 1_440);
  assert.equal(normalizeSettings({ syncIntervalMinutes: 'invalid' }).syncIntervalMinutes, 15);
});

test('运行配置总是生成新的内部令牌并固定回环随机端口', () => {
  const settings = normalizeSettings({ vaultDir: path.resolve('vault') });
  const one = createRuntimeConfig(settings, {});
  const two = createRuntimeConfig(settings, {});
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
    const store = createConfigStore({ userDataPath: userData, safeStorage: fakeSafeStorage() });
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
    const store = createConfigStore({ userDataPath: userData, safeStorage: fakeSafeStorage() });
    assert.throws(() => store.write({ ...normalizeSettings(), device: 'doomed' }), /磁盘只读/);
    assert.equal(attempts, 1, '非瞬时错误不该重试');
    assert.deepEqual(await fs.readdir(store.directory), []);
  } finally {
    fsSync.renameSync = rename;
    await fs.rm(userData, { recursive: true, force: true });
  }
});
