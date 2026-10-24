#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

function requestedArch(argv = process.argv.slice(2), fallback = process.arch) {
  const index = argv.indexOf('--arch');
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!['arm64', 'x64'].includes(value)) throw new Error('原生 helper 架构参数不合法。');
  return value;
}

/**
 * 这次构建是不是「可失败」的。
 *
 * 这个 helper 只在 macOS 打包时作为签名资源用到，以及 darwin/linux 上恢复流程
 * 真正激活新资料库那一步。它不该挡在 `npm install`、`npm start` 和 `npm test`
 * 前面 —— 机器上没有 C 编译器时那些命令会全部硬失败，而失败信息只有一句
 * 「spawn cc ENOENT」，看起来像是项目坏了。win32 早就走 skipped 了，
 * 没有编译器的 darwin/linux 应该是同一个待遇：告警、降级、继续。
 *
 * 真正需要产物的 desktop:build:mac / desktop:dir:mac 不传这个开关，照样硬失败。
 */
function isOptional(argv = process.argv.slice(2)) {
  return argv.includes('--optional');
}

async function buildNativeHelper({
  platform = process.platform,
  arch = requestedArch(),
  projectDir = path.resolve(__dirname, '..'),
  runner = run
} = {}) {
  if (platform === 'win32') return { skipped: true };
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`不支持为 ${platform} 构建恢复 helper。`);

  const source = path.join(projectDir, 'build', 'rename-exclusive.c');
  const outputDir = path.join(projectDir, 'build', 'native', `${platform}-${arch}`);
  const output = path.join(outputDir, 'rename-exclusive');
  await fsp.mkdir(outputDir, { recursive: true });
  const args = platform === 'darwin'
    ? ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-arch', arch, source, '-o', output]
    : ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output];
  await runner(process.env.CC || 'cc', args);
  await fsp.chmod(output, 0o755);
  return { skipped: false, output };
}

if (require.main === module) {
  const optional = isOptional();
  buildNativeHelper().catch(error => {
    if (optional) {
      process.stderr.write(
        `恢复 helper 未能构建（${error.message}）。\n`
        + '这不影响笔记、复习、同步等功能；只有在本机执行「恢复资料库」的最后一步激活时会用到它。\n'
        + '需要的话装一个 C 编译器后重跑（Debian/Ubuntu：sudo apt-get install -y build-essential；macOS：xcode-select --install）。\n'
      );
      return;
    }
    process.stderr.write(`恢复 helper 构建失败：${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildNativeHelper, requestedArch, isOptional, run };
