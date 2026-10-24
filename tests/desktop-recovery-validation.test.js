const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRecoveryMode,
  validateRecoveryStart,
  validateRepairStart
} = require('../electron/recovery-validation');

test('恢复开始参数只保留语义字段并规范布尔值', () => {
  assert.deepEqual(validateRecoveryStart({
    sourceKind: 'git',
    remote: 'git@example.com:owner/vault.git',
    directoryName: 'restored-vault',
    restoreBlobs: true
  }), {
    sourceKind: 'git',
    remote: 'git@example.com:owner/vault.git',
    directoryName: 'restored-vault',
    restoreBlobs: true,
    mode: 'restore'
  });

  assert.deepEqual(validateRecoveryStart({
    sourceKind: 'local',
    directoryName: 'copy',
    restoreBlobs: 'yes'
  }, { mode: 'first-run' }), {
    sourceKind: 'local',
    directoryName: 'copy',
    restoreBlobs: false,
    mode: 'restore'
  });
});

test('renderer 不能提交路径、命令、删除目标或重试文件列表', () => {
  for (const [field, value] of [
    ['destinationParent', 'D:/vaults'],
    ['destinationPath', 'D:/vaults/restored'],
    ['stagingRoot', 'D:/vaults/.staging'],
    ['deletePath', 'D:/source'],
    ['gitArgs', ['push']],
    ['retryPaths', ['audio/private.wav']],
    ['token', 'secret']
  ]) {
    assert.throws(() => validateRecoveryStart({
      sourceKind: 'local', directoryName: 'copy', [field]: value
    }), /不允许/);
  }
});

test('恢复输入拒绝危险远端和目标路径', () => {
  assert.throws(() => validateRecoveryStart({
    sourceKind: 'git', remote: 'https://token@example.com/vault.git', directoryName: 'copy'
  }), /凭据/);
  assert.throws(() => validateRecoveryStart({
    sourceKind: 'git', remote: 'file:///tmp/vault', directoryName: 'copy'
  }), /HTTPS|SSH/);
  assert.throws(() => validateRecoveryStart({
    sourceKind: 'local', remote: 'git@example.com:owner/vault.git', directoryName: 'copy'
  }), /不能提交 Git/);
  assert.throws(() => validateRecoveryStart({
    sourceKind: 'local', directoryName: '../copy'
  }), /目录名/);
});

test('当前资料库修复不接受 renderer 参数', () => {
  assert.deepEqual(validateRepairStart({}), {});
  assert.throws(() => validateRepairStart({ vaultDir: 'D:/other' }), /不接受参数/);
  assert.throws(() => validateRepairStart({ retryPaths: ['audio/a.wav'] }), /不接受参数/);
});

test('恢复窗口模式只有首次启动、恢复和当前库修复', () => {
  for (const mode of ['first-run', 'restore', 'repair-blobs']) {
    assert.equal(validateRecoveryMode(mode), mode);
  }
  assert.throws(() => validateRecoveryMode('delete'), /未知恢复模式/);
});
