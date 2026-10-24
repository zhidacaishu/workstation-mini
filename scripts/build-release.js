#!/usr/bin/env node
const path = require('node:path');
const { spawn } = require('node:child_process');
const { verifyRelease } = require('./release-verifier');
const { version } = require('../package.json');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

/**
 * 跑 electron-builder 的 JS 入口，而不是 node_modules/.bin 里的包装器。
 *
 * 那个包装器在 Windows 上是 .cmd，而自 CVE-2024-27980 修复起（Node 18.20.2 及以后），
 * 带参数 spawn .cmd/.bat 又不开 shell 会直接抛 EINVAL —— 也就是整个发布构建在 CI 上
 * 根本起不来。开 shell 又要自己处理引号转义，且把 publisherName 这种外部值送进命令行解析。
 * 直接用 process.execPath 跑 cli.js 两个问题都没有：跨平台一致，参数不经过任何 shell。
 */
function builderCli(projectDir) {
  return path.join(projectDir, 'node_modules', 'electron-builder', 'cli.js');
}

function builderArgs(projectDir, publisher) {
  return [
    builderCli(projectDir),
    '--win',
    'nsis',
    '--x64',
    '--publish',
    'never',
    `-c.win.signtoolOptions.publisherName=${publisher}`
  ];
}

async function main() {
  required('WIN_CSC_LINK');
  required('WIN_CSC_KEY_PASSWORD');
  const publisher = required('WORKSTATION_WINDOWS_PUBLISHER');
  const projectDir = path.resolve(__dirname, '..');
  await run(process.execPath, builderArgs(projectDir, publisher), { cwd: projectDir });
  await verifyRelease({
    sourceDir: path.join(projectDir, 'dist'),
    packageVersion: version,
    publisher,
    verifyUpdaterConfig: true
  });
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });

module.exports = { main, run, required, builderCli, builderArgs };
