const test = require('node:test');
const assert = require('node:assert/strict');

const {
  activateRecoveredVault,
  recoveredSettings
} = require('../electron/recovery-activation');

test('恢复设置只切换资料库并关闭自动同步', () => {
  const current = {
    vaultDir: 'D:/old-vault',
    syncEnabled: true,
    device: 'lab-laptop',
    blobServerUrl: 'https://blobs.example.test',
    launchAtLogin: true
  };

  const next = recoveredSettings(current, 'D:/new-vault');

  assert.deepEqual(next, {
    ...current,
    vaultDir: 'D:/new-vault',
    syncEnabled: false
  });
  assert.notEqual(next, current);
});

test('恢复激活关闭首轮 Blob 对账并在 runtime 成功后确认', async () => {
  const calls = [];
  const currentSettings = { vaultDir: '', syncEnabled: true, device: 'desktop' };
  const recovery = {
    async activate() {
      calls.push('activate');
      return { destinationPath: 'D:/restored' };
    },
    async completeActivation() { calls.push('complete'); },
    async failActivation() { calls.push('fail'); }
  };

  const result = await activateRecoveredVault({
    recovery,
    currentSettings,
    async replaceRuntime(next, previous, options) {
      calls.push(['replace', next, previous, options]);
    }
  });

  assert.deepEqual(calls, [
    'activate',
    ['replace', {
      vaultDir: 'D:/restored',
      syncEnabled: false,
      device: 'desktop'
    }, currentSettings, { initialBlobReconcile: false }],
    'complete'
  ]);
  assert.equal(result.nextSettings.device, 'desktop');
});

test('runtime 切换失败才标记激活失败', async () => {
  const calls = [];
  const recovery = {
    async activate() { return { destinationPath: 'D:/restored' }; },
    async completeActivation() { calls.push('complete'); },
    async failActivation() { calls.push('fail'); }
  };

  await assert.rejects(() => activateRecoveredVault({
    recovery,
    currentSettings: { vaultDir: 'D:/old', syncEnabled: true },
    async replaceRuntime() { throw new Error('runtime failed'); }
  }), /runtime failed/);

  assert.deepEqual(calls, ['fail']);
});

test('runtime 已切换后的清理降级不会反向标记激活失败', async () => {
  const calls = [];
  const recovery = {
    async activate() { return { destinationPath: 'D:/restored' }; },
    async completeActivation() {
      calls.push('complete');
      throw new Error('journal cleanup failed');
    },
    async failActivation() { calls.push('fail'); }
  };

  await assert.rejects(() => activateRecoveredVault({
    recovery,
    currentSettings: { vaultDir: 'D:/old', syncEnabled: true },
    async replaceRuntime() { calls.push('replace'); }
  }), /journal cleanup failed/);

  assert.deepEqual(calls, ['replace', 'complete']);
});
