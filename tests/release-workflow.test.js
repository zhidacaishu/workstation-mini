const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function normalizeLineEndings(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

const workflowSource = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const workflow = normalizeLineEndings(workflowSource);

function job(name, next, source = workflow) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `缺少 ${name} job`);
  const end = next ? source.indexOf(`  ${next}:\n`, start + 1) : source.length;
  assert.notEqual(end, -1, `缺少 ${next} job`);
  return source.slice(start, end);
}

test('工作流检查兼容 CRLF checkout', () => {
  const crlf = workflow.replace(/\n/g, '\r\n');
  const normalized = normalizeLineEndings(crlf);
  const trigger = normalized.slice(normalized.indexOf('on:\n'), normalized.indexOf('\npermissions:'));

  assert.equal(normalized, workflow);
  assert.match(trigger, /workflow_dispatch:/);
  assert.match(job('preflight', 'windows', normalized), /runs-on: ubuntu-latest/);
  assert.match(job('draft-release', undefined, normalized), /permissions:\n      contents: write/);
});

test('发布只允许手工输入 plain version，且同版本任务不相互取消', () => {
  const trigger = workflow.slice(workflow.indexOf('on:\n'), workflow.indexOf('\npermissions:'));
  assert.match(trigger, /workflow_dispatch:/);
  assert.match(trigger, /version:/);
  assert.match(trigger, /required: true/);
  assert.doesNotMatch(trigger, /\bpush:/);
  assert.match(workflow, /group: release-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.version \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('默认只读，只有最终 draft job 能写仓库内容', () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(job('preflight', 'windows'), /contents: write/);
  assert.doesNotMatch(job('windows', 'macos'), /contents: write/);
  assert.doesNotMatch(job('macos', 'draft-release'), /contents: write/);
  assert.match(job('draft-release'), /permissions:\n      contents: write/);
  assert.equal((workflow.match(/contents: write/g) || []).length, 1);
});

test('两个平台都基于预检 SHA，且签名 secrets 只在 Windows job 中', () => {
  const windows = job('windows', 'macos');
  const macos = job('macos', 'draft-release');
  const draft = job('draft-release');
  assert.match(windows, /needs: preflight/);
  assert.match(macos, /needs: preflight/);
  assert.match(draft, /needs: \[preflight, windows, macos\]/);
  assert.match(windows, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/);
  assert.match(macos, /ref: \$\{\{ needs\.preflight\.outputs\.sha \}\}/);
  assert.match(draft, /uses: actions\/setup-node@v6[\s\S]*node-version: 22/);
  for (const secret of ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WORKSTATION_WINDOWS_PUBLISHER']) {
    assert.match(windows, new RegExp(secret));
    assert.doesNotMatch(`${job('preflight', 'windows')}\n${macos}\n${draft}`, new RegExp(secret));
  }
});

test('最终只创建 draft，并明确不把 Blob 发布带进 Actions', () => {
  const draft = job('draft-release');
  assert.match(draft, /gh release create[^\n]*--draft/);
  assert.match(draft, /gh release edit[^\n]*--draft/);
  assert.match(draft, /SHA256SUMS\.txt/);
  assert.match(draft, /experimental ad-hoc DMG/);
  assert.doesNotMatch(workflow, /^\s*run:\s*npm run publish-release\s*$/m);
  assert.doesNotMatch(workflow, /WORKSTATION_BLOB_RELEASE_TOKEN/);
  assert.doesNotMatch(workflow, /--publish\s+(?:always|onTagOrDraft)/);
  assert.doesNotMatch(workflow, /--draft=false|--latest/);
});

test('Release 查询只有明确 404 才进入不存在分支，其它失败全部关闭', () => {
  const preflight = job('preflight', 'windows');
  const draft = job('draft-release');
  for (const section of [preflight, draft]) {
    assert.match(section, /gh api --include "repos\/\$REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/);
    assert.match(section, /GH_API_EXIT_STATUS="\$gh_status" node scripts\/release-api-response\.js/);
    assert.match(section, /\[ "\$parser_status" -eq 4 \] && return 4/);
    assert.match(section, /\[ "\$release_status" -eq 4 \] \|\| exit "\$release_status"/);
  }
  assert.doesNotMatch(draft, /if gh api "repos\/\$REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/);
});

test('已有 tag 必须匹配固定 SHA，首次 draft 允许 tag 尚不存在', () => {
  const preflight = job('preflight', 'windows');
  const draft = job('draft-release');
  for (const section of [preflight, draft]) {
    assert.match(section, /git ls-remote origin "refs\/tags\/\$RELEASE_TAG" "refs\/tags\/\$RELEASE_TAG\^\{\}"/);
    assert.match(section, /if ! refs="\$\(git ls-remote/);
    assert.match(section, /Unable to read the release tag from origin/);
    assert.match(section, /refs\.get\(`\$\{tag\}\^\{\}`\) \|\| direct/);
    assert.match(section, /git\/commits\/\$commit/);
    assert.match(section, /require_matching_tag_if_present/);
    assert.match(section, /\[ "\$status" -eq 2 \] \|\| return "\$status"/);
  }

  const edit = draft.indexOf('gh release edit');
  const upload = draft.indexOf('gh release upload');
  const checks = [...draft.matchAll(/require_matching_tag_if_present/g)].map(match => match.index);
  assert.ok(checks.some(index => edit < index && index < upload));
  assert.ok(checks.some(index => upload < index));
  assert.doesNotMatch(draft, /draft release tag does not exist/i);
  assert.doesNotMatch(draft, /gh release create[^\n]*"\$\{assets\[@\]\}"/);
});

test('draft 重跑只补缺失白名单资产，拒绝旧额外资产且上传后复验', () => {
  const draft = job('draft-release');
  assert.match(draft, /gh api --paginate --slurp "repos\/\$REPOSITORY\/releases\/\$release_id\/assets\?per_page=100"/);
  assert.match(draft, /node scripts\/release-assets\.js --plan "\$\{assets\[@\]\}"/);
  assert.match(draft, /Accept: application\/octet-stream/);
  assert.match(draft, /releases\/assets\/\$value/);
  assert.match(draft, /cmp --silent "\$downloaded_asset" "\$local_file"/);
  assert.match(draft, /gh release upload "\$RELEASE_TAG" "\$\{missing_assets\[@\]\}"/);
  assert.match(draft, /node scripts\/release-assets\.js --verify "\$\{assets\[@\]\}"/);
  assert.doesNotMatch(draft, /--clobber/);
  assert.doesNotMatch(draft, /releases\/assets\/\$asset_id|delete-asset/);
  assert.ok(draft.lastIndexOf('require_matching_draft') < draft.indexOf('node scripts/release-assets.js --verify'));
});

test('只有通过最终包验证的白名单产物会进入 draft', () => {
  const windows = job('windows', 'macos');
  const macos = job('macos', 'draft-release');
  assert.match(macos, /runs-on: macos-15/);
  assert.match(windows, /npm run desktop:release/);
  assert.match(windows, /npm run verify-release/);
  assert.match(windows, /npm run test:desktop/);
  assert.match(macos, /if \[ "\$\(uname -m\)" != 'arm64' \]/);
  assert.ok(macos.indexOf("uname -m") < macos.indexOf('desktop:build:mac'));
  assert.match(macos, /desktop:build:mac/);
  assert.match(macos, /hdiutil attach -readonly -nobrowse -noautoopen/);
  assert.match(macos, /verify-mac-package\.js/);
  assert.match(macos, /mac-arm64-experimental\.dmg/);
});

test('发布 artifact 只作三天的跨 job 中转', () => {
  const windows = job('windows', 'macos');
  const macos = job('macos', 'draft-release');
  const draft = job('draft-release');

  assert.equal((workflow.match(/uses: actions\/upload-artifact@v6/g) || []).length, 2);
  assert.equal((workflow.match(/uses: actions\/download-artifact@v7/g) || []).length, 2);
  assert.equal((workflow.match(/retention-days: 3/g) || []).length, 2);
  assert.doesNotMatch(workflow, /retention-days: (?!3\b)\d+/);

  assert.match(windows, /name: release-windows-\$\{\{ needs\.preflight\.outputs\.version \}\}[\s\S]*retention-days: 3/);
  assert.match(macos, /name: release-macos-arm64-experimental-\$\{\{ needs\.preflight\.outputs\.version \}\}[\s\S]*retention-days: 3/);
  assert.match(draft, /name: release-windows-\$\{\{ needs\.preflight\.outputs\.version \}\}[\s\S]*path: release-assets\/windows/);
  assert.match(draft, /name: release-macos-arm64-experimental-\$\{\{ needs\.preflight\.outputs\.version \}\}[\s\S]*path: release-assets\/macos/);
});
