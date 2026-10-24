const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { publishRelease } = require('../scripts/publish-release');

const PUBLISHER = 'CN=Workstation Publisher, O=Research Lab, C=US';
const quietLogger = { log() {} };

function sha512(content) {
  return crypto.createHash('sha512').update(content).digest('base64');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function fixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-publish-'));
  await fsp.mkdir(path.join(directory, 'nested'), { recursive: true });
  await fsp.mkdir(path.join(directory, 'releases'), { recursive: true });
  await fsp.writeFile(path.join(directory, 'app.exe'), 'installer');
  await fsp.writeFile(path.join(directory, 'app.exe.blockmap'), 'blockmap');
  await fsp.writeFile(path.join(directory, 'nested', 'metadata.bin'), 'metadata');
  await fsp.writeFile(path.join(directory, 'latest.yml'), [
    'version: 0.1.0',
    'files:',
    '  - url: app.exe',
    `    sha512: ${sha512('installer')}`,
    '    size: 9',
    '  - url: nested/metadata.bin',
    `    sha512: ${sha512('metadata')}`,
    '    size: 8',
    'path: app.exe',
    `sha512: ${sha512('installer')}`,
    ''
  ].join('\n'));
  await fsp.writeFile(path.join(directory, 'releases', 'keep.txt'), 'keep');
  return directory;
}

function verified(directory) {
  return {
    directory,
    executable: path.join(directory, 'app.exe'),
    manifestPath: path.join(directory, 'latest.yml'),
    payload: ['app.exe', 'nested/metadata.bin', 'app.exe.blockmap']
  };
}

function fakeClient({ remoteFiles, uploads }) {
  return {
    async upload(relative, sourceDir) {
      const content = await fsp.readFile(path.join(sourceDir, ...relative.split('/')));
      uploads.push({ relative, content: content.toString('utf8') });
      remoteFiles.set(relative, {
        path: relative,
        size: content.length,
        sha256: sha256(content)
      });
      return { ok: true, size: content.length };
    },
    async list(options) {
      assert.deepEqual(options, { prefix: 'releases', integrity: 'sha256' });
      return { ok: true, blobs: [...remoteFiles.values()] };
    }
  };
}

test('发布器核对 path、size、SHA-256 后才上传 latest.yml', async () => {
  const directory = await fixture();
  const uploads = [];
  const remoteFiles = new Map();
  try {
    const result = await publishRelease({
      sourceDir: directory,
      packageVersion: '0.1.0',
      publisher: PUBLISHER,
      baseUrl: 'https://blobs.example.com',
      releaseToken: 'release-token',
      verify: async options => {
        assert.notEqual(options.sourceDir, directory);
        assert.match(options.sourceDir.replaceAll('\\', '/'), /\/releases$/);
        assert.equal(await fsp.readFile(path.join(options.sourceDir, 'app.exe'), 'utf8'), 'installer');
        await fsp.writeFile(path.join(directory, 'app.exe'), 'changed after snapshot');
        await fsp.writeFile(path.join(directory, 'app.exe.blockmap'), 'changed blockmap');
        return verified(options.sourceDir);
      },
      createClient: () => fakeClient({ remoteFiles, uploads }),
      logger: quietLogger
    });

    assert.deepEqual(uploads.map(entry => entry.relative), [
      'releases/app.exe',
      'releases/nested/metadata.bin',
      'releases/app.exe.blockmap',
      'releases/latest.yml'
    ]);
    assert.equal(uploads[0].content, 'installer');
    assert.equal(uploads[2].content, 'blockmap');
    assert.deepEqual(result.payload, ['app.exe', 'nested/metadata.bin', 'app.exe.blockmap']);
    assert.equal(await fsp.readFile(path.join(directory, 'releases', 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

for (const [name, mutate, expected] of [
  ['缺少文件', files => files.delete('releases/nested/metadata.bin'), /缺失/],
  ['大小不一致', files => { files.get('releases/app.exe').size += 1; }, /大小不一致/],
  ['SHA-256 不一致', files => { files.get('releases/app.exe').sha256 = '0'.repeat(64); }, /SHA-256 不一致/],
  ['服务端没有摘要', files => { delete files.get('releases/app.exe').sha256; }, /未提供 SHA-256/]
]) {
  test(`远端${name}时绝不上传 latest.yml`, async () => {
    const directory = await fixture();
    const uploads = [];
    const remoteFiles = new Map();
    try {
      await assert.rejects(() => publishRelease({
        sourceDir: directory,
        packageVersion: '0.1.0',
        publisher: PUBLISHER,
        baseUrl: 'https://blobs.example.com',
        releaseToken: 'release-token',
        verify: async options => verified(options.sourceDir),
        createClient: () => {
          const client = fakeClient({ remoteFiles, uploads });
          return {
            ...client,
            async list(options) {
              const result = await client.list(options);
              mutate(remoteFiles);
              return { ok: true, blobs: [...remoteFiles.values()] };
            }
          };
        },
        logger: quietLogger
      }), expected);

      assert.deepEqual(uploads.map(entry => entry.relative), [
        'releases/app.exe',
        'releases/nested/metadata.bin',
        'releases/app.exe.blockmap'
      ]);
    } finally {
      await fsp.rm(directory, { recursive: true, force: true });
    }
  });
}
