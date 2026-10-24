const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createBlobClient } = require('../src/blobs/client');
const { createBlobRestore, downloadMissingBlobs } = require('../src/blobs/restore');
const { startBlobServer } = require('../src/blobs/server');

const TOKEN = 'restore-client-token';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-restore-server-'));
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-restore-vault-'));
  const server = await startBlobServer({
    root,
    clientToken: TOKEN,
    releaseToken: `${TOKEN}-release`,
    host: '127.0.0.1',
    port: 0
  }, { logger: { log() {} } });
  const client = createBlobClient({
    baseUrl: server.origin,
    token: TOKEN,
    logger: { log() {}, warn() {} }
  });
  return {
    root,
    vaultDir,
    origin: server.origin,
    client,
    async cleanup() {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

async function put(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

async function directoryLink(target, link) {
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

async function assertNoDownloadTemps(vaultDir) {
  assert.ok(!(await fs.readdir(vaultDir)).some(name => name.startsWith('.blob-download.tmp-')));
}

test('Blob list 拒绝未知完整性算法', async () => {
  const ctx = await setupServer();
  try {
    const response = await fetch(`${ctx.origin}/blobs?prefix=attachments&integrity=md5`, {
      headers: { 'x-workstation-blob-token': TOKEN }
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /完整性算法/);
  } finally {
    await ctx.cleanup();
  }
});

test('Blob list 按需返回 SHA-256，正常列表不承担 hash 成本', async () => {
  const ctx = await setupServer();
  try {
    const content = Buffer.from('restore-integrity');
    await put(ctx.root, 'attachments/document.bin', content);

    const ordinary = await ctx.client.list({ prefix: 'attachments' });
    assert.equal(ordinary.ok, true);
    assert.equal(ordinary.blobs[0].sha256, undefined);

    const verified = await ctx.client.list({ prefix: 'attachments', integrity: 'sha256' });
    assert.equal(verified.ok, true);
    assert.equal(verified.blobs[0].size, content.length);
    assert.equal(verified.blobs[0].sha256, sha256(content));
  } finally {
    await ctx.cleanup();
  }
});

test('恢复在 Blob list 阶段取消时抛回取消原因而非 partial', async () => {
  const ctx = await setupServer();
  const controller = new AbortController();
  const reason = new DOMException('restore cancelled', 'AbortError');
  controller.abort(reason);
  try {
    await assert.rejects(
      downloadMissingBlobs({
        vaultDir: ctx.vaultDir,
        blobs: ctx.client,
        signal: controller.signal
      }),
      error => error === reason
    );
  } finally {
    await ctx.cleanup();
  }
});

test('下载先校验大小与摘要再独占落盘，失败不留临时文件或覆盖目标', async () => {
  const ctx = await setupServer();
  try {
    const content = Buffer.from('verified-download');
    await put(ctx.root, 'audio/session/audio.m4a', content);
    const progress = [];
    const downloaded = await ctx.client.download('audio/session/audio.m4a', ctx.vaultDir, {
      expectedSize: content.length,
      expectedSha256: sha256(content),
      exclusive: true,
      onProgress: update => progress.push(update)
    });
    assert.equal(downloaded.ok, true);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio', 'session', 'audio.m4a'), 'utf8'), content.toString());
    assert.equal(progress.at(-1).received, content.length);

    await fs.writeFile(path.join(ctx.vaultDir, 'audio', 'session', 'audio.m4a'), 'local-owner');
    const conflict = await ctx.client.download('audio/session/audio.m4a', ctx.vaultDir, {
      expectedSize: content.length,
      expectedSha256: sha256(content),
      exclusive: true
    });
    assert.equal(conflict.conflict, true);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio', 'session', 'audio.m4a'), 'utf8'), 'local-owner');

    const mismatch = await ctx.client.download('audio/session/audio.m4a', ctx.vaultDir, {
      expectedSize: content.length,
      expectedSha256: '0'.repeat(64),
      exclusive: true
    });
    assert.equal(mismatch.integrity, true);
    const directory = await fs.readdir(path.join(ctx.vaultDir, 'audio', 'session'));
    assert.deepEqual(directory, ['audio.m4a']);
  } finally {
    await ctx.cleanup();
  }
});

test('Blob managed root 为 symlink 时下载不写出资料库', async t => {
  const ctx = await setupServer();
  const outside = path.join(ctx.root, 'outside-target');
  try {
    await fs.mkdir(outside);
    await put(ctx.root, 'attachments/escape.bin', 'remote');
    try {
      await directoryLink(outside, path.join(ctx.vaultDir, 'attachments'));
    } catch (error) {
      t.skip(`本机不允许创建目录链接：${error.code}`);
      return;
    }
    const result = await ctx.client.download('attachments/escape.bin', ctx.vaultDir, {
      expectedSize: 6,
      expectedSha256: sha256('remote'),
      exclusive: true
    });
    assert.equal(result.ok, false);
    await assert.rejects(() => fs.access(path.join(outside, 'escape.bin')));
    await assertNoDownloadTemps(ctx.vaultDir);
  } finally {
    await ctx.cleanup();
  }
});

test('Blob nested ancestor 为 symlink 时下载不写出资料库', async t => {
  const ctx = await setupServer();
  const outside = path.join(ctx.root, 'outside-nested');
  try {
    await fs.mkdir(outside);
    await fs.mkdir(path.join(ctx.vaultDir, 'audio'));
    await put(ctx.root, 'audio/session/escape.m4a', 'remote');
    try {
      await directoryLink(outside, path.join(ctx.vaultDir, 'audio', 'session'));
    } catch (error) {
      t.skip(`本机不允许创建目录链接：${error.code}`);
      return;
    }
    const result = await ctx.client.download('audio/session/escape.m4a', ctx.vaultDir, {
      expectedSize: 6,
      expectedSha256: sha256('remote'),
      exclusive: true
    });
    assert.equal(result.ok, false);
    await assert.rejects(() => fs.access(path.join(outside, 'escape.m4a')));
    await assertNoDownloadTemps(ctx.vaultDir);
  } finally {
    await ctx.cleanup();
  }
});

test('下载中取消不发布最终文件且清理根内临时文件', async () => {
  const ctx = await setupServer();
  const controller = new AbortController();
  try {
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    await put(ctx.root, 'audio/large/cancel.m4a', content);
    const result = await ctx.client.download('audio/large/cancel.m4a', ctx.vaultDir, {
      signal: controller.signal,
      expectedSize: content.length,
      expectedSha256: sha256(content),
      exclusive: true,
      onProgress() {
        controller.abort(new DOMException('cancelled', 'AbortError'));
      }
    });
    assert.equal(result.aborted, true);
    await assert.rejects(() => fs.access(path.join(ctx.vaultDir, 'audio', 'large', 'cancel.m4a')));
    await assertNoDownloadTemps(ctx.vaultDir);
  } finally {
    await ctx.cleanup();
  }
});

test('恢复只下载缺失文件，保留一致文件并拒绝覆盖本地冲突', async () => {
  const ctx = await setupServer();
  try {
    const existing = Buffer.from('already-local');
    const conflict = Buffer.from('remote-version');
    const missing = Buffer.from('download-me');
    await put(ctx.root, 'attachments/existing.bin', existing);
    await put(ctx.root, 'attachments/conflict.bin', conflict);
    await put(ctx.root, 'audio/take/missing.m4a', missing);
    await put(ctx.vaultDir, 'attachments/existing.bin', existing);
    await put(ctx.vaultDir, 'attachments/conflict.bin', 'local-version!');

    const result = await downloadMissingBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.client });

    assert.equal(result.downloaded, 1);
    assert.equal(result.existing, 1);
    assert.equal(result.partial, true);
    assert.deepEqual(result.failed.map(item => [item.path, item.code, item.retryable]), [
      ['attachments/conflict.bin', 'local-conflict', false]
    ]);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'attachments', 'conflict.bin'), 'utf8'), 'local-version!');
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio', 'take', 'missing.m4a'), 'utf8'), missing.toString());
  } finally {
    await ctx.cleanup();
  }
});

test('旧服务不支持摘要列表时明确降级，仍只调用 list/download', async () => {
  const calls = [];
  const blobs = {
    async list(options) {
      calls.push(['list', { ...options, signal: Boolean(options.signal) }]);
      if (options.integrity) return { available: true, ok: false, reason: 'unsupported' };
      return {
        available: true,
        ok: true,
        blobs: options.prefix === 'attachments'
          ? [{ path: 'attachments/legacy.bin', size: 6 }]
          : []
      };
    },
    async download(relative, targetDir, options) {
      calls.push(['download', relative, options.expectedSize, options.expectedSha256, options.exclusive]);
      await put(targetDir, relative, 'legacy');
      return { available: true, ok: true };
    },
    async upload() { assert.fail('恢复不得上传'); },
    async remove() { assert.fail('恢复不得删除'); }
  };
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-legacy-restore-'));
  try {
    const result = await downloadMissingBlobs({ vaultDir, blobs });
    assert.equal(result.integrityUnavailable, true);
    assert.equal(result.partial, true);
    assert.equal(result.downloaded, 1);
    assert.deepEqual(calls.filter(call => call[0] === 'download'), [
      ['download', 'attachments/legacy.bin', 6, '', true]
    ]);
    assert.equal(calls.filter(call => call[0] === 'list').length, 4);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('带摘要的列表超时或服务端出错时按列出失败处理，不降级成不校验摘要', async () => {
  for (const failure of [
    { available: true, ok: false, transient: true, reason: 'The operation was aborted due to timeout' },
    { available: true, ok: false, status: 503, reason: 'HTTP 503' }
  ]) {
    const calls = [];
    const blobs = {
      async list(options) {
        calls.push(options.integrity || '');
        if (options.integrity) return failure;
        return { available: true, ok: true, blobs: [{ path: 'attachments/a.bin', size: 1 }] };
      },
      async download() { assert.fail('列表没拿到摘要时不该开始下载'); }
    };
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-restore-timeout-'));
    try {
      const result = await downloadMissingBlobs({ vaultDir, blobs });
      assert.equal(result.integrityUnavailable, false);
      assert.equal(result.partial, true);
      assert.deepEqual(result.failed.map(item => [item.path, item.code, item.retryable]), [
        ['audio', 'list-failed', true],
        ['attachments', 'list-failed', true]
      ]);
      assert.deepEqual(calls, ['sha256', 'sha256']);
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  }
});

test('重试只选择上轮可重试失败路径，并持续报告本地冲突', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blob-retry-'));
  const attempts = new Map();
  const downloads = [];
  const metadata = [
    { path: 'attachments/good.bin', size: 4, sha256: sha256('good') },
    { path: 'attachments/retry.bin', size: 5, sha256: sha256('retry') },
    { path: 'attachments/conflict.bin', size: 6, sha256: sha256('remote') }
  ];
  const blobs = {
    async list({ prefix }) {
      return { ok: true, blobs: prefix === 'attachments' ? metadata : [] };
    },
    async download(relative, targetDir) {
      downloads.push(relative);
      const count = (attempts.get(relative) || 0) + 1;
      attempts.set(relative, count);
      if (relative.endsWith('retry.bin') && count === 1) return { ok: false, missing: true };
      const content = relative.endsWith('good.bin') ? 'good' : 'retry';
      await put(targetDir, relative, content);
      return { ok: true };
    }
  };
  try {
    await put(vaultDir, 'attachments/conflict.bin', 'local!');
    const restore = createBlobRestore({ blobs });
    const first = await restore.run({ vaultDir });
    assert.deepEqual(first.failed.map(item => [item.path, item.code]), [
      ['attachments/retry.bin', 'missing-remote'],
      ['attachments/conflict.bin', 'local-conflict']
    ]);
    assert.deepEqual(restore.pending(), ['attachments/retry.bin']);

    const second = await restore.retry({ vaultDir });
    assert.equal(second.downloaded, 1);
    assert.equal(second.partial, true);
    assert.deepEqual(second.failed.map(item => [item.path, item.code, item.retryable]), [
      ['attachments/conflict.bin', 'local-conflict', false]
    ]);
    assert.deepEqual(restore.pending(), []);
    assert.deepEqual(downloads, [
      'attachments/good.bin',
      'attachments/retry.bin',
      'attachments/retry.bin'
    ]);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('待重试路径从远端消失时继续标记 partial', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blob-vanished-retry-'));
  let listAttempt = 0;
  const blobs = {
    async list({ prefix }) {
      listAttempt += 1;
      return {
        ok: true,
        blobs: prefix === 'attachments' && listAttempt === 1
          ? [{ path: 'attachments/vanished.bin', size: 1, sha256: sha256('x') }]
          : []
      };
    },
    async download() { return { ok: false, missing: true }; }
  };
  try {
    const restore = createBlobRestore({ blobs, prefixes: ['attachments'] });
    const first = await restore.run({ vaultDir });
    assert.deepEqual(first.failed.map(item => item.path), ['attachments/vanished.bin']);

    const second = await restore.retry({ vaultDir });
    assert.equal(second.partial, true);
    assert.deepEqual(second.failed.map(item => [item.path, item.code]), [
      ['attachments/vanished.bin', 'missing-remote']
    ]);
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});
