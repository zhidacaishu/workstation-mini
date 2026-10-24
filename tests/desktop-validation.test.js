const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { validateSettingsUpdate } = require('../electron/settings-validation');

function validUpdate(overrides = {}) {
  return {
    settings: {
      vaultDir: path.resolve('vault'),
      device: 'laptop',
      readOnly: false,
      syncEnabled: true,
      syncIntervalMinutes: 15,
      zoteroApi: 'http://localhost:23119/api/users/0',
      zoteroDataDir: '',
      journalTrackerUrl: '',
      journalTrackerEmail: '',
      checkDraftPath: '',
      pythonPath: 'python',
      whisperPath: '',
      whisperModel: '',
      blogRepo: '',
      launchAtLogin: false,
      updatesEnabled: true,
      ...overrides
    },
    secrets: {
      anthropicApiKey: { action: 'keep' },
      journalTrackerPassword: { action: 'clear' },
      mineruApiToken: { action: 'keep' }
    }
  };
}

test('桌面设置校验接受完整合法表单', () => {
  assert.doesNotThrow(() => validateSettingsUpdate(validUpdate()));
});

test('桌面设置校验拒绝未知字段、错误类型和越界间隔', () => {
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ unexpected: true })),
    /未知设置字段/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ readOnly: 'false' })),
    /必须是布尔值/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ updatesEnabled: 'true' })),
    /必须是布尔值/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ syncIntervalMinutes: 0 })),
    /1 到 1440/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ syncIntervalMinutes: 1.5 })),
    /1 到 1440/
  );
});

test('桌面设置校验限制路径和外部地址', () => {
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ vaultDir: 'relative-vault' })),
    /资料库必须是绝对路径/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ blogRepo: 'relative-blog' })),
    /必须是绝对路径/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ zoteroApi: 'file:///secret' })),
    /HTTP 或 HTTPS/
  );
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ journalTrackerUrl: 'https://user:pass@example.com' })),
    /不能在网址中包含账号或密码/
  );
});

test('Blob 地址远程只接受 HTTPS，HTTP 仅接受精确回环地址', () => {
  for (const blobServerUrl of ['https://blobs.example.com/', 'http://localhost:4100', 'http://127.1:4100', 'http://[::1]:4100']) {
    assert.doesNotThrow(() => validateSettingsUpdate(validUpdate({ blobServerUrl })), blobServerUrl);
  }
  for (const blobServerUrl of ['http://example.com', 'http://localhost.evil', 'https://u:p@example.com', 'https://example.com?q=1', 'https://example.com/#x']) {
    assert.throws(() => validateSettingsUpdate(validUpdate({ blobServerUrl })), /大文件存储服务/, blobServerUrl);
  }
  // 报错要指明是哪个字段，否则用户面对一句「地址必须使用 HTTPS」不知道该改哪一栏。
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ blobServerUrl: 'http://example.com' })),
    /blobServerUrl/
  );
});

test('已存的旧 HTTP 地址不会把整个设置页锁死', () => {
  // 设置页每次提交都会原样带上所有字段。收紧成「远端必须 HTTPS」之后，按旧文档配了
  // Tailscale CGNAT 地址的安装会连改设备名都做不到 —— 提交里带着那个老地址，整份被拒。
  const legacy = 'http://100.64.0.1:4100';
  const current = { blobServerUrl: legacy };

  assert.doesNotThrow(
    () => validateSettingsUpdate(validUpdate({ blobServerUrl: legacy, device: '改个名字' }), current),
    '没动过的旧地址不该阻塞其它字段'
  );
  assert.doesNotThrow(
    () => validateSettingsUpdate(validUpdate({ blobServerUrl: '' }), current),
    '应当允许把有问题的地址清掉'
  );
  assert.doesNotThrow(
    () => validateSettingsUpdate(validUpdate({ blobServerUrl: 'https://blobs.example.com' }), current),
    '改成合法地址当然可以'
  );
  // 但换成另一个同样不合法的新值仍然要拦。
  assert.throws(
    () => validateSettingsUpdate(validUpdate({ blobServerUrl: 'http://100.64.0.2:4100' }), current),
    /blobServerUrl/
  );
  // 没有 current 时（比如首次配置）照旧严格。
  assert.throws(() => validateSettingsUpdate(validUpdate({ blobServerUrl: legacy })), /blobServerUrl/);
});

test('桌面设置校验要求显式且有界的秘密操作', () => {
  const malformed = validUpdate();
  malformed.secrets.anthropicApiKey = { action: 'set', value: '' };
  assert.throws(() => validateSettingsUpdate(malformed), /值无效/);

  const extraValue = validUpdate();
  extraValue.secrets.anthropicApiKey = { action: 'keep', value: 'secret' };
  assert.throws(() => validateSettingsUpdate(extraValue), /只有设置新值时/);

  const unknown = validUpdate();
  unknown.secrets.other = { action: 'clear' };
  assert.throws(() => validateSettingsUpdate(unknown), /未知秘密字段/);
});
