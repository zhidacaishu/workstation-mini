const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  renameExclusive,
  bundledHelperPath,
  isHelperAvailable,
  ExclusiveRenameError,
  DESTINATION_EXISTS_EXIT
} = require('../src/recovery/rename-exclusive');
const { buildNativeHelper } = require('../scripts/build-native-helper');

async function temporaryPaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-exclusive-rename-'));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.mkdir(source);
  return { root, source, destination };
}

test('Darwin helper 在开发态与打包态选择各自固定位置', () => {
  const development = path.join('workspace', 'src', 'recovery');
  const resources = path.join('Applications', 'Workstation.app', 'Contents', 'Resources');
  const packaged = path.join(resources, 'app.asar', 'src', 'recovery');

  assert.equal(
    bundledHelperPath('darwin', 'arm64', { sourceDir: development, resourcesPath: resources }),
    path.resolve(development, '..', '..', 'build', 'native', 'darwin-arm64', 'rename-exclusive')
  );
  assert.equal(
    bundledHelperPath('darwin', 'arm64', { sourceDir: packaged, resourcesPath: resources }),
    path.join(resources, 'rename-exclusive')
  );
});

test('macOS 打包先编译 helper 并把它作为签名资源包含', () => {
  const { scripts, build } = require('../package.json');
  assert.match(scripts['desktop:dir:mac'], /^node scripts\/build-native-helper\.js --arch arm64 && /);
  assert.match(scripts['desktop:build:mac'], /^node scripts\/build-native-helper\.js --arch arm64 && /);
  assert.deepEqual(build.mac.binaries, ['Contents/Resources/rename-exclusive']);
  assert.deepEqual(build.mac.extraResources, [{
    from: 'build/native/darwin-${arch}/rename-exclusive',
    to: 'rename-exclusive'
  }]);
});

test('Darwin helper 构建固定架构、输出位置且不经过 shell', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-helper-build-'));
  const calls = [];
  try {
    const result = await buildNativeHelper({
      platform: 'darwin',
      arch: 'arm64',
      projectDir: root,
      async runner(program, args) {
        calls.push({ program, args });
        const output = args.at(-1);
        await fs.writeFile(output, 'helper');
      }
    });
    const expected = path.join(root, 'build', 'native', 'darwin-arm64', 'rename-exclusive');
    assert.equal(result.output, expected);
    assert.equal(calls[0].program, process.env.CC || 'cc');
    assert.deepEqual(calls[0].args, [
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64',
      path.join(root, 'build', 'rename-exclusive.c'), '-o', expected
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Darwin helper 使用固定参数与 shell false', async () => {
  const ctx = await temporaryPaths();
  const calls = [];
  try {
    await renameExclusive(ctx.source, ctx.destination, {
      platform: 'darwin',
      arch: 'arm64',
      helperPath: '/Applications/Workstation/rename-exclusive',
      async runner(program, args, options) {
        calls.push({ program, args, options });
      }
    });
    assert.deepEqual(calls[0].args, [ctx.source, ctx.destination]);
    assert.equal(calls[0].program, '/Applications/Workstation/rename-exclusive');
    assert.equal(calls[0].options.shell, false);
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true });
  }
});

test('helper 的目标存在退出码只映射安全类别', async () => {
  const ctx = await temporaryPaths();
  try {
    await assert.rejects(() => renameExclusive(ctx.source, ctx.destination, {
      platform: 'darwin',
      helperPath: '/safe/helper',
      async runner() {
        throw Object.assign(new Error('/secret/source -> /secret/destination'), {
          code: DESTINATION_EXISTS_EXIT,
          stderr: 'private path'
        });
      }
    }), error => error instanceof ExclusiveRenameError
      && error.code === 'destination-exists'
      && !error.message.includes('secret'));
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true });
  }
});

test('当前平台目标已存在时不会覆盖且 source 保持原样', async t => {
  // 这条要真的调用本平台的 helper。构建它需要 C 编译器，而编译器不是跑这个
  // 项目的前提（见 scripts/build-native-helper.js），所以没有产物时明确 skip，
  // 而不是让没装编译器的机器上永远挂着一条红色。
  if (!isHelperAvailable()) {
    t.skip('本机没有编译出恢复 helper，跳过真实 rename。');
    return;
  }
  const ctx = await temporaryPaths();
  try {
    await fs.writeFile(path.join(ctx.source, 'candidate.txt'), 'candidate');
    await fs.mkdir(ctx.destination);
    await fs.writeFile(path.join(ctx.destination, 'owner.txt'), 'competitor');
    await assert.rejects(() => renameExclusive(ctx.source, ctx.destination), error => (
      error.code === 'destination-exists'
    ));
    assert.equal(await fs.readFile(path.join(ctx.source, 'candidate.txt'), 'utf8'), 'candidate');
    assert.equal(await fs.readFile(path.join(ctx.destination, 'owner.txt'), 'utf8'), 'competitor');
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true });
  }
});

test('当前平台 helper 并发抢占同一名称时恰有一个成功', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip('当前平台使用内核目录 rename 的 no-replace 语义。');
    return;
  }
  if (!isHelperAvailable()) {
    t.skip('本机没有编译出恢复 helper，跳过真实并发抢占。');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-exclusive-race-'));
  try {
    const destination = path.join(root, 'destination');
    const sources = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const source = path.join(root, `source-${index}`);
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, 'owner'), String(index));
      return source;
    }));
    const results = await Promise.allSettled(sources.map(source => renameExclusive(source, destination)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.filter(result => result.status === 'rejected')
      .every(result => result.reason.code === 'destination-exists'));
    assert.match(await fs.readFile(path.join(destination, 'owner'), 'utf8'), /^\d+$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
