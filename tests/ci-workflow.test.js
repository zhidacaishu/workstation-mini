const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function normalizeLineEndings(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

const workflowSource = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const workflow = normalizeLineEndings(workflowSource);

function job(name, next, source = workflow) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `缺少 ${name} job`);
  const end = next ? source.indexOf(`  ${next}:\n`, start + 1) : source.length;
  assert.notEqual(end, -1, `缺少 ${next} job`);
  return source.slice(start, end);
}

test('CI 工作流检查兼容 CRLF checkout', () => {
  const normalized = normalizeLineEndings(workflow.replace(/\n/g, '\r\n'));

  assert.equal(normalized, workflow);
  assert.match(job('regression', 'verify', normalized), /runs-on: ubuntu-24\.04/);
  assert.match(job('verify', 'verify-mac', normalized), /runs-on: windows-latest/);
  assert.match(job('verify-mac', undefined, normalized), /runs-on: macos-15/);
});

test('CI 与发布流程使用受支持的 Apple Silicon runner', () => {
  const release = normalizeLineEndings(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.match(job('verify-mac'), /runs-on: macos-15\s/);
  assert.match(job('macos', 'publish', release), /runs-on: macos-15\s/);
});

test('CI 保留跨平台构建与打包态冒烟门禁', () => {
  const regression = job('regression', 'verify');
  const windows = job('verify', 'verify-mac');
  const macos = job('verify-mac');

  assert.match(regression, /run: npm test/);
  assert.match(windows, /run: npm test/);
  assert.match(windows, /run: npm run desktop:dir/);
  assert.match(windows, /WORKSTATION_EXECUTABLE=/);
  assert.match(windows, /run: npm run test:desktop/);
  const windowsBuild = windows.indexOf('run: npm run desktop:dir');
  const windowsPackagedTest = windows.indexOf('run: npm run test:desktop');
  assert.ok(windows.indexOf('run: npm test') < windowsBuild);
  assert.ok(windows.indexOf('WORKSTATION_EXECUTABLE=') < windowsPackagedTest);
  assert.ok(windowsBuild < windowsPackagedTest);
  assert.equal((windows.match(/run: npm run test:desktop/g) || []).length, 1);
  assert.match(macos, /run: npm run desktop:dir:mac/);
  assert.match(macos, /verify-mac-package/);
  assert.match(macos, /run: npm run test:desktop/);
  assert.match(macos, /Assert no macOS update manifest was produced/);
});

test('CI 只缓存依赖，不保存构建 artifact', () => {
  assert.equal((workflow.match(/uses: actions\/setup-node@v6/g) || []).length, 3);
  assert.equal((workflow.match(/cache: npm/g) || []).length, 3);
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /actions\/download-artifact/);
  assert.doesNotMatch(workflow, /retention-days:/);
});

test('NSIS 开发安装器只允许手工明确构建', () => {
  const windows = job('verify', 'verify-mac');
  const build = windows.slice(windows.indexOf('      - name: Build NSIS installer'));

  assert.match(build, /if: github\.event_name == 'workflow_dispatch' && inputs\.build_installer/);
  assert.match(build, /run: npm run desktop:build/);
  assert.doesNotMatch(build, /github\.event_name == 'push'/);
});
