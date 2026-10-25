const test = require('node:test');
const assert = require('node:assert/strict');

const { activateRecoveredVault } = require('../electron/recovery-activation');

test('恢复激活切换资料库并关闭自动同步，不再传递大文件运行参数', async () => {
  const currentSettings = { vaultDir: '/previous', device: 'desktop', syncEnabled: true };
  const calls = [];
  const recovery = {
    async activate() { calls.push('activate'); return { destinationPath: '/restored', outcome: 'complete' }; },
    async completeActivation() { calls.push('complete'); }
  };
  const result = await activateRecoveredVault({
    recovery,
    currentSettings,
    async replaceRuntime(...args) {
      calls.push('replace');
      assert.equal(args.length, 2);
      assert.deepEqual(args[0], { vaultDir: '/restored', device: 'desktop', syncEnabled: false });
      assert.equal(args[1], currentSettings);
    }
  });
  assert.deepEqual(calls, ['activate', 'replace', 'complete']);
  assert.equal(result.nextSettings.syncEnabled, false);
  assert.equal(currentSettings.vaultDir, '/previous');
  assert.equal(currentSettings.syncEnabled, true);
});

test('恢复运行时切换失败时保留失败报告，不确认完成', async () => {
  const failure = new Error('新资料库无法打开');
  const calls = [];
  const recovery = {
    async activate() { return { destinationPath: '/restored' }; },
    async failActivation() { calls.push('failed'); },
    async completeActivation() { calls.push('complete'); }
  };
  await assert.rejects(activateRecoveredVault({
    recovery,
    currentSettings: { vaultDir: '/previous', syncEnabled: true },
    async replaceRuntime() { throw failure; }
  }), error => error === failure);
  assert.deepEqual(calls, ['failed']);
});
