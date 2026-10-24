const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function fail(message) {
  throw new Error(message);
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function findFiles(root, predicate) {
  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(target, predicate));
    else if (entry.isFile() && predicate(target)) matches.push(target);
  }
  return matches;
}

function assertArm64Only(target, label) {
  const architectures = run('lipo', ['-archs', target]).split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== 'arm64') {
    fail(`${label} 必须是纯 arm64，实际为：${architectures.join(', ') || '未知'}`);
  }
}

function main() {
  if (process.platform !== 'darwin') fail('macOS 包只能在 macOS 上验证。');
  const outputDir = path.resolve(process.argv[2] || path.join('dist', 'mac-arm64'));
  if (!fs.existsSync(outputDir)) fail(`找不到 macOS 构建目录：${outputDir}`);

  const apps = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
    .map(entry => path.join(outputDir, entry.name));
  if (apps.length !== 1) fail(`预期恰有一个 .app，实际找到 ${apps.length} 个：${outputDir}`);

  const appBundle = apps[0];
  const contents = path.join(appBundle, 'Contents');
  const infoPlist = path.join(contents, 'Info.plist');
  const executableName = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', infoPlist]);
  const executable = path.join(contents, 'MacOS', executableName);
  if (!fs.statSync(executable).isFile()) fail(`找不到主程序：${executable}`);
  assertArm64Only(executable, '主程序');

  const helper = path.join(contents, 'Resources', 'rename-exclusive');
  if (!fs.statSync(helper).isFile()) fail('缺少恢复原子激活 helper。');
  assertArm64Only(helper, '恢复原子激活 helper');
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', helper], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const unpacked = path.join(contents, 'Resources', 'app.asar.unpacked');
  if (!fs.existsSync(unpacked)) fail('缺少 app.asar.unpacked，原生模块无法从 ASAR 外加载。');
  const addons = findFiles(unpacked, target =>
    target.includes(`${path.sep}node_modules${path.sep}better-sqlite3${path.sep}`)
    && path.basename(target) === 'darwin-arm64.node'
  );
  if (addons.length !== 1) fail(`预期恰有一个 better-sqlite3 darwin-arm64.node，实际找到 ${addons.length} 个。`);
  assertArm64Only(addons[0], 'better-sqlite3 原生模块');

  for (const name of ['trayTemplate.png', 'trayTemplate@2x.png']) {
    const resource = path.join(contents, 'Resources', name);
    if (!fs.statSync(resource).isFile()) fail(`缺少菜单栏 template 资源：${name}`);
  }

  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const signatureResult = spawnSync('codesign', ['-dvvv', appBundle], { encoding: 'utf8' });
  const signature = `${signatureResult.stdout || ''}\n${signatureResult.stderr || ''}`;
  if (signatureResult.error) throw signatureResult.error;
  if (signatureResult.status !== 0) fail(`无法读取签名信息：${signature.trim()}`);
  if (!signature.includes('Signature=adhoc')) fail('应用签名不是明确的 ad-hoc 签名。');
  if (/^Authority=/m.test(signature)) fail('ad-hoc 包不应声明 Developer ID Authority。');

  process.stdout.write(`${executable}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`macOS 包验证失败：${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, assertArm64Only };
