const { validateRemote } = require('../src/recovery/git');
const { validDirectoryName } = require('../src/recovery/service');

const SOURCE_KINDS = new Set(['git', 'local']);

function validateRecoveryMode(value) {
  if (!['first-run', 'restore', 'repair-blobs'].includes(value)) {
    throw new Error('未知恢复模式。');
  }
  return value;
}

function validateRepairStart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new Error('当前资料库修复不接受参数。');
  }
  return {};
}

function validateRecoveryStart(value, { mode = 'restore' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('恢复选项无效。');
  }
  const allowed = new Set(['sourceKind', 'remote', 'directoryName', 'restoreBlobs']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('恢复选项包含不允许的字段。');
  }
  if (!SOURCE_KINDS.has(value.sourceKind)) throw new Error('恢复来源无效。');
  const directoryName = validDirectoryName(value.directoryName);
  const remote = value.sourceKind === 'git' ? validateRemote(value.remote) : undefined;
  if (value.sourceKind === 'local' && value.remote !== undefined) {
    throw new Error('本地恢复不能提交 Git 远端。');
  }
  return {
    sourceKind: value.sourceKind,
    ...(remote ? { remote } : {}),
    directoryName,
    restoreBlobs: value.restoreBlobs === true,
    mode: mode === 'first-run' ? 'restore' : validateRecoveryMode(mode)
  };
}

module.exports = { validateRecoveryMode, validateRecoveryStart, validateRepairStart };
