const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateVersionInput,
  extractChangelogSection,
  validateReleaseMetadata
} = require('../scripts/release-preflight');

function metadata(overrides = {}) {
  const version = overrides.version || '0.2.0';
  return {
    version,
    packageJson: { version },
    packageLock: { version, packages: { '': { version } } },
    changelog: '# 更新日志\n\n## 未发布\n\n下一版。\n\n## 0.2.0\n\n- 完成发布闭环。\n\n## 0.1.0\n\n- 初版。\n',
    ...overrides
  };
}

test('只接受无 v 前缀、无空白的完整 SemVer', () => {
  for (const good of ['0.2.0', '1.0.0-rc.1', '1.2.3+build.4']) {
    assert.equal(validateVersionInput(good), good);
  }
  for (const bad of ['', 'v0.2.0', ' 0.2.0', '01.2.3', '1.2', '1.2.3\nanything']) {
    assert.throws(() => validateVersionInput(bad), /SemVer/);
  }
});

test('package、lock 两处版本与 CHANGELOG 正式章节形成同一闭环', () => {
  assert.deepEqual(validateReleaseMetadata(metadata()), {
    version: '0.2.0',
    tag: 'v0.2.0',
    notes: '## 0.2.0\n\n- 完成发布闭环。\n'
  });
});

test('任一 package 版本不一致都失败', () => {
  assert.throws(() => validateReleaseMetadata(metadata({ packageJson: { version: '0.1.0' } })), /package.json/);
  assert.throws(() => validateReleaseMetadata(metadata({
    packageLock: { version: '0.1.0', packages: { '': { version: '0.2.0' } } }
  })), /package-lock.json 的版本/);
  assert.throws(() => validateReleaseMetadata(metadata({
    packageLock: { version: '0.2.0', packages: { '': { version: '0.1.0' } } }
  })), /packages\[''\]/);
});

test('CHANGELOG 缺失、重复或空章节都失败，未发布不能代替版本节', () => {
  assert.throws(() => extractChangelogSection('## 未发布\n\n- x\n', '0.2.0'), /实际有 0 个/);
  assert.throws(() => extractChangelogSection('## 0.2.0\n\n- a\n\n## 0.2.0\n\n- b\n', '0.2.0'), /实际有 2 个/);
  assert.throws(() => extractChangelogSection('## 0.2.0\n\n## 0.1.0\n\n- old\n', '0.2.0'), /不能为空/);
  assert.throws(() => extractChangelogSection('## [0.2.0]\n\n- x\n', '0.2.0'), /实际有 0 个/);
});
