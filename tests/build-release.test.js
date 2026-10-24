const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { builderCli, builderArgs, run, required } = require('../scripts/build-release');

const projectDir = path.resolve(__dirname, '..');

test('构建走 electron-builder 的 JS 入口，而不是 .bin 里的 .cmd 包装器', () => {
  const cli = builderCli(projectDir);

  // 自 CVE-2024-27980 修复起（Node 18.20.2 及以后），带参数 spawn .cmd/.bat 又不开 shell
  // 会抛 EINVAL。之前这里指向 node_modules/.bin/electron-builder.cmd，于是签名构建
  // 在 windows-latest 上根本起不来，而 CI 又只跑这一条路径。
  assert.ok(!cli.endsWith('.cmd'), `不能指向 .cmd 包装器：${cli}`);
  assert.ok(!cli.endsWith('.bat'), `不能指向 .bat 包装器：${cli}`);
  assert.equal(path.extname(cli), '.js');
  assert.ok(
    !cli.split(path.sep).includes('.bin'),
    'node_modules/.bin 下的都是平台包装器，不能直接 spawn'
  );
  assert.ok(fs.existsSync(cli), `electron-builder 的 CLI 入口应存在：${cli}`);
});

test('正式构建把完整 publisher DN 放在 electron-builder 26 的正确层级', () => {
  const publisher = 'CN=Workstation Publisher, O=Research Lab, C=US';
  const args = builderArgs(projectDir, publisher);

  assert.ok(args.includes(`-c.win.signtoolOptions.publisherName=${publisher}`));
  assert.equal(args.some(argument => argument.startsWith('-c.win.publisherName=')), false);
  assert.equal(args.at(-1), `-c.win.signtoolOptions.publisherName=${publisher}`);
});

test('run 用 process.execPath 跑得起来，退出码非零时 reject', async () => {
  await run(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await assert.rejects(
    () => run(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' }),
    /退出码 3/
  );
});

test('缺少签名相关环境变量时明确报出是哪一个', () => {
  const saved = process.env.WS_TEST_ABSENT_VAR;
  delete process.env.WS_TEST_ABSENT_VAR;
  try {
    assert.throws(() => required('WS_TEST_ABSENT_VAR'), /缺少环境变量 WS_TEST_ABSENT_VAR/);
    process.env.WS_TEST_ABSENT_VAR = '  ';
    assert.throws(() => required('WS_TEST_ABSENT_VAR'), /缺少环境变量/, '只有空白也算没配');
    process.env.WS_TEST_ABSENT_VAR = 'value';
    assert.equal(required('WS_TEST_ABSENT_VAR'), 'value');
  } finally {
    if (saved === undefined) delete process.env.WS_TEST_ABSENT_VAR;
    else process.env.WS_TEST_ABSENT_VAR = saved;
  }
});
