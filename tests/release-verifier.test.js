const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parseLatestYml,
  validateSignatureOutput,
  verifyRelease,
  verifyPackagedPublisher
} = require('../scripts/release-verifier');

const PUBLISHER = 'CN=Workstation Publisher, O=Research Lab, C=US';
const BINARY = Buffer.from('binary');

function digest(buffer = BINARY) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}

function manifest({ version = '0.1.0', url = 'app.exe', size = BINARY.length, sha512 = digest() } = {}) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    ''
  ].join('\n');
}

async function fixture(content = manifest()) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-release-'));
  await fsp.writeFile(path.join(directory, 'app.exe'), BINARY);
  await fsp.writeFile(path.join(directory, 'app.exe.blockmap'), 'blockmap');
  await fsp.writeFile(path.join(directory, 'latest.yml'), content);
  return directory;
}

function validSignature(executable) {
  return JSON.stringify({ Path: executable, Status: 'Valid', Subject: PUBLISHER });
}

test('解析 electron-builder 的 path、files 元数据和版本', () => {
  assert.deepEqual(parseLatestYml(manifest({ version: '1.2.3' })), {
    version: '1.2.3',
    files: ['app.exe'],
    entries: [{ url: 'app.exe', sha512: digest(), size: BINARY.length }],
    path: 'app.exe'
  });
});

test('验证唯一 exe、清单内容、版本、blockmap 和精确签名者', async () => {
  const directory = await fixture();
  try {
    const result = await verifyRelease({
      sourceDir: directory,
      packageVersion: '0.1.0',
      publisher: PUBLISHER,
      runPowerShell: async executable => validSignature(executable)
    });
    assert.equal(path.basename(result.executable), 'app.exe');
    assert.deepEqual(result.payload, ['app.exe', 'app.exe.blockmap']);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('清单 size、sha512 缺失或与内容不符时全部失败', async () => {
  for (const [content, expected] of [
    [manifest({ size: BINARY.length + 1 }), /size/],
    [manifest({ sha512: digest(Buffer.from('other')) }), /sha512/],
    [manifest().replace(`    size: ${BINARY.length}\n`, ''), /有效 size/],
    [manifest().replace(`    sha512: ${digest()}\n`, ''), /缺少.*sha512/]
  ]) {
    const directory = await fixture(content);
    try {
      await assert.rejects(() => verifyRelease({
        sourceDir: directory,
        packageVersion: '0.1.0',
        publisher: PUBLISHER,
        runPowerShell: async executable => validSignature(executable)
      }), expected);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
});

test('缺文件、版本不符、多个 exe 都失败', async () => {
  const missing = await fixture(manifest({ url: 'missing.exe' }));
  try {
    await assert.rejects(() => verifyRelease({ sourceDir: missing, packageVersion: '0.1.0', publisher: PUBLISHER }), /不存在/);
    await assert.rejects(() => verifyRelease({ sourceDir: missing, packageVersion: '9.9.9', publisher: PUBLISHER }), /版本对不上/);
    await fsp.writeFile(path.join(missing, 'second.exe'), 'x');
    await assert.rejects(() => verifyRelease({ sourceDir: missing, packageVersion: '0.1.0', publisher: PUBLISHER }), /正好有一个/);
  } finally {
    await fsp.rm(missing, { recursive: true, force: true });
  }
});

test('签名状态、目标路径、Subject、畸形输出和命令错误全部 fail closed', async () => {
  const executable = path.resolve('app.exe');
  assert.throws(() => validateSignatureOutput('{', { executable, publisher: PUBLISHER }), /无法解析/);
  assert.throws(() => validateSignatureOutput({ Path: executable, Status: 'NotSigned', Subject: PUBLISHER }, { executable, publisher: PUBLISHER }), /签名无效/);
  assert.throws(() => validateSignatureOutput({ Path: path.resolve('other.exe'), Status: 'Valid', Subject: PUBLISHER }, { executable, publisher: PUBLISHER }), /路径/);
  assert.throws(() => validateSignatureOutput({ Path: executable, Status: 'Valid', Subject: ` ${PUBLISHER}` }, { executable, publisher: PUBLISHER }), /签名者/);

  const directory = await fixture();
  try {
    await assert.rejects(() => verifyRelease({
      sourceDir: directory,
      packageVersion: '0.1.0',
      publisher: PUBLISHER,
      runPowerShell: async () => { throw new Error('PowerShell failed'); }
    }), /执行 Authenticode.*failed/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test('清单拒绝路径穿越、非规范路径和缺少文件字段', () => {
  for (const unsafe of ['../evil.exe', 'nested\\evil.exe', '/evil.exe', 'C:/evil.exe', 'nested//evil.exe']) {
    assert.throws(() => parseLatestYml(manifest({ url: unsafe })), /不安全/);
  }
  assert.throws(() => parseLatestYml('version: 1\n'), /没有引用/);
});

test('清单引用不能通过文件或父目录符号链接逃离发布目录', async t => {
  const directory = await fixture(manifest({ url: 'nested/app.exe' }));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-release-outside-'));
  try {
    await fsp.writeFile(path.join(outside, 'app.exe'), BINARY);
    try {
      await fsp.symlink(outside, path.join(directory, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`本机不允许创建符号链接：${error.code}`);
      return;
    }
    await assert.rejects(() => verifyRelease({
      sourceDir: directory,
      packageVersion: '0.1.0',
      publisher: PUBLISHER,
      runPowerShell: async executable => validSignature(executable)
    }), /符号链接越界/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('构建目录中的 app-update.yml 必须包含精确 publisher DN', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-updater-config-'));
  const resources = path.join(directory, 'win-unpacked', 'resources');
  try {
    await fsp.mkdir(resources, { recursive: true });
    await fsp.writeFile(path.join(resources, 'app-update.yml'), [
      'provider: generic',
      'publisherName:',
      `  - ${PUBLISHER}`,
      ''
    ].join('\n'));
    assert.equal(await verifyPackagedPublisher(directory, PUBLISHER), path.join(resources, 'app-update.yml'));
    await assert.rejects(() => verifyPackagedPublisher(directory, 'CN=Other'), /publisherName/);
    await fsp.rm(path.join(resources, 'app-update.yml'));
    await assert.rejects(() => verifyPackagedPublisher(directory, PUBLISHER), /缺少/);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});
