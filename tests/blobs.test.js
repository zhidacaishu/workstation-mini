const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');

const { createBlobApp } = require('../src/blobs/app');
const { createBlobStore, BlobError } = require('../src/blobs/store');
const { loadBlobConfig } = require('../src/blobs/server');

const TOKEN = 'test-token-0123456789';
const RELEASE_TOKEN = 'release-token-9876543210';

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws-blobs-'));
}

async function withApp(run, options = {}) {
  const root = temporaryRoot();
  try {
    await run(createBlobApp({ root, clientToken: TOKEN, releaseToken: RELEASE_TOKEN, ...options }), root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const auth = agent => agent.set('x-workstation-blob-token', TOKEN);

// ── 鉴权 ────────────────────────────────────────────

test('没有令牌的请求一律 403，且不泄露资源是否存在', async () => {
  await withApp(async (app, root) => {
    await fsp.writeFile(path.join(root, 'secret.bin'), 'x');

    for (const response of [
      await request(app).get('/blobs'),
      await request(app).get('/blobs/secret.bin'),
      await request(app).get('/blobs/does-not-exist.bin'),
      await request(app).put('/blobs/new.bin').send('x'),
      await request(app).delete('/blobs/secret.bin')
    ]) {
      assert.equal(response.status, 403);
      assert.equal(response.body.message, 'Forbidden');
    }

    // 403 被挡住就不该真的删掉东西。
    assert.ok(fs.existsSync(path.join(root, 'secret.bin')));
  });
});

test('令牌错误、为空、或长度不同都判否', async () => {
  await withApp(async app => {
    for (const bad of ['', 'wrong', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await request(app).get('/blobs').set('x-workstation-blob-token', bad);
      assert.equal(response.status, 403);
    }
  });
});

test('不配双令牌、使用旧单令牌或令牌相同都拒绝构造', () => {
  assert.throws(() => createBlobApp({ root: temporaryRoot(), token: TOKEN }), /客户端和发布/);
  assert.throws(() => createBlobApp({ root: temporaryRoot(), clientToken: TOKEN }), /客户端和发布/);
  assert.throws(() => createBlobApp({ root: temporaryRoot(), clientToken: TOKEN, releaseToken: TOKEN }), /必须不同/);
});

test('生产双角色严格限制方法和前缀，列表不能为空或未知', async () => {
  const root = temporaryRoot();
  const app = createBlobApp({ root, clientToken: TOKEN, releaseToken: RELEASE_TOKEN });
  const client = agent => agent.set('x-workstation-blob-token', TOKEN);
  const release = agent => agent.set('x-workstation-blob-token', RELEASE_TOKEN);
  try {
    assert.equal((await client(request(app).put('/blobs/audio/a.m4a')).send('a')).status, 200);
    assert.equal((await client(request(app).put('/blobs/attachments/a.bin')).send('a')).status, 200);
    assert.equal((await client(request(app).put('/blobs/releases/app.exe')).send('a')).status, 403);
    await fsp.mkdir(path.join(root, 'releases'), { recursive: true });
    await fsp.writeFile(path.join(root, 'releases', 'app.exe'), '0123456789');
    assert.equal((await client(request(app).get('/blobs/releases/app.exe'))).status, 200);
    assert.equal((await client(request(app).delete('/blobs/releases/app.exe'))).status, 403);
    assert.equal((await client(request(app).get('/blobs'))).status, 403);
    assert.equal((await client(request(app).get('/blobs').query({ prefix: 'unknown' }))).status, 403);
    assert.equal((await client(request(app).get('/blobs').query({ prefix: 'audio' }))).status, 200);
    assert.equal((await client(request(app).get('/blobs').query({ prefix: 'audio/../../releases' }))).status, 403);

    assert.equal((await release(request(app).put('/blobs/releases/new.exe')).send('x')).status, 200);
    assert.equal((await release(request(app).get('/blobs').query({ prefix: 'releases' }))).status, 200);
    assert.equal((await release(request(app).get('/blobs').query({ prefix: 'releases/../../audio' }))).status, 403);
    assert.equal((await release(request(app).put('/blobs/audio/no.m4a')).send('x')).status, 403);
    assert.equal((await release(request(app).delete('/blobs/releases/new.exe'))).status, 403);

    const head = await client(request(app).head('/blobs/releases/app.exe'));
    assert.equal(head.status, 200);
    assert.equal(head.headers['accept-ranges'], 'bytes');
    const ranged = await client(request(app).get('/blobs/releases/app.exe')).set('range', 'bytes=2-5');
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-range'], 'bytes 2-5/10');
    assert.equal(ranged.headers['content-length'], '4');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ── 上传与下载 ────────────────────────────────────────

test('PUT 原始请求体落盘，GET 原样取回', async () => {
  await withApp(async (app, root) => {
    const payload = Buffer.from('二进制内容 with bytes \0ÿ', 'utf8');

    const put = await auth(request(app).put('/blobs/attachments/fig.png'))
      .set('content-type', 'application/octet-stream')
      .send(payload);
    assert.equal(put.status, 200);
    assert.equal(put.body.ok, true);
    assert.equal(put.body.size, payload.length);

    // 真的落在磁盘上，且路径就是 URL 上那个。
    const onDisk = await fsp.readFile(path.join(root, 'attachments', 'fig.png'));
    assert.deepEqual(onDisk, payload);

    const get = await auth(request(app).get('/blobs/attachments/fig.png'));
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, payload);
  });
});

test('嵌套目录会被自动创建', async () => {
  await withApp(async (app, root) => {
    await auth(request(app).put('/blobs/audio/clip-01/audio.m4a')).send('sound');
    assert.ok(fs.existsSync(path.join(root, 'audio', 'clip-01', 'audio.m4a')));
  });
});

test('重复上传同一路径是覆盖，不是报错', async () => {
  await withApp(async (app, root) => {
    await auth(request(app).put('/blobs/attachments/a.bin')).send('first');
    const second = await auth(request(app).put('/blobs/attachments/a.bin')).send('second-longer');
    assert.equal(second.status, 200);
    assert.equal(await fsp.readFile(path.join(root, 'attachments', 'a.bin'), 'utf8'), 'second-longer');
  });
});

test('取不存在的资源返回 404 而不是 500', async () => {
  await withApp(async app => {
    const response = await auth(request(app).get('/blobs/attachments/nope.bin'));
    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
  });
});

test('支持 Range 请求，音频拖进度条和断点续传靠它', async () => {
  await withApp(async app => {
    await auth(request(app).put('/blobs/audio/clip.m4a')).send('0123456789');

    const full = await auth(request(app).get('/blobs/audio/clip.m4a'));
    assert.equal(full.headers['accept-ranges'], 'bytes');

    const ranged = await auth(request(app).get('/blobs/audio/clip.m4a')).set('range', 'bytes=2-5');
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers['content-range'], 'bytes 2-5/10');
    assert.equal(Buffer.from(ranged.body).toString('utf8'), '2345');
  });
});

test('响应带 nosniff，避免上传的内容被当成 HTML 解析', async () => {
  await withApp(async app => {
    await auth(request(app).put('/blobs/attachments/x.bin')).send('hi');
    const response = await auth(request(app).get('/blobs/attachments/x.bin'));
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  });
});

test('超过上限的上传返回 413，且不留下半截文件', async () => {
  await withApp(async (app, root) => {
    const response = await auth(request(app).put('/blobs/attachments/big.bin')).send('x'.repeat(200));
    assert.equal(response.status, 413);

    // 临时文件和目标文件都不该留下（前缀目录本身是上传时建的，留着无妨）。
    const entries = await fsp.readdir(path.join(root, 'attachments'));
    assert.deepEqual(entries, [], `attachments/ 应为空，实际：${entries.join(', ')}`);
  }, { maxBytes: 100 });
});

// ── 路径安全 ──────────────────────────────────────────

test('路径穿越的各种写法都被拒绝', async () => {
  await withApp(async (app, root) => {
    const outside = path.join(root, '..', `escaped-${process.pid}.txt`);
    await fsp.writeFile(outside, 'secret');

    try {
      for (const attempt of [
        '/blobs/../escaped.txt',
        '/blobs/a/../../escaped.txt',
        '/blobs/%2e%2e/escaped.txt',
        '/blobs/.hidden',
        '/blobs//double'
      ]) {
        const get = await auth(request(app).get(attempt));
        assert.ok(get.status >= 400, `${attempt} 应被拒绝，实际 ${get.status}`);

        const put = await auth(request(app).put(attempt)).send('pwned');
        assert.ok(put.status >= 400, `${attempt} 的写入应被拒绝，实际 ${put.status}`);
      }

      // 越界的那个文件必须原封不动。
      assert.equal(await fsp.readFile(outside, 'utf8'), 'secret');
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });
});

test('指向根目录外面的符号链接读不到东西', async t => {
  const root = temporaryRoot();
  const secretDir = temporaryRoot();
  try {
    const secret = path.join(secretDir, 'passwd');
    await fsp.writeFile(secret, 'root:x:0:0');
    await fsp.mkdir(path.join(root, 'attachments'), { recursive: true });
    try {
      await fsp.symlink(secret, path.join(root, 'attachments', 'link.txt'));
    } catch (error) {
      t.skip(`本机不允许创建符号链接：${error.code}`);
      return;
    }

    const app = createBlobApp({ root, clientToken: TOKEN, releaseToken: RELEASE_TOKEN });
    const response = await auth(request(app).get('/blobs/attachments/link.txt'));

    assert.equal(response.status, 400, '跟随符号链接会变成任意文件读取');
    assert.ok(!String(response.text).includes('root:x'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(secretDir, { recursive: true, force: true });
  }
});

test('目录不能当文件读', async () => {
  await withApp(async (app, root) => {
    await fsp.mkdir(path.join(root, 'attachments', 'folder'), { recursive: true });
    const response = await auth(request(app).get('/blobs/attachments/folder'));
    assert.equal(response.status, 400);
  });
});

// ── 列表（对账） ───────────────────────────────────────

// 列目录一律要带前缀：客户端令牌只被允许看 audio/ 和 attachments/，
// 不带前缀等于要求列出整个根（含 releases/），会被 403 挡掉。
test('列表给出路径、大小和修改时间，按路径排序', async () => {
  await withApp(async app => {
    await auth(request(app).put('/blobs/audio/b/two.m4a')).send('22');
    await auth(request(app).put('/blobs/audio/a/one.m4a')).send('1');
    await auth(request(app).put('/blobs/attachments/fig.png')).send('333');

    const response = await auth(request(app).get('/blobs').query({ prefix: 'audio' }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.blobs.map(blob => blob.path), [
      'audio/a/one.m4a',
      'audio/b/two.m4a'
    ]);
    assert.equal(response.body.blobs[0].size, 1);
    assert.ok(Number.isInteger(response.body.blobs[0].mtimeMs));

    const attachments = await auth(request(app).get('/blobs').query({ prefix: 'attachments' }));
    assert.deepEqual(attachments.body.blobs.map(blob => blob.path), ['attachments/fig.png']);
    assert.equal(attachments.body.blobs[0].size, 3);
  });
});

test('前缀过滤只列该目录下的东西', async () => {
  await withApp(async app => {
    await auth(request(app).put('/blobs/audio/a.m4a')).send('a');
    await auth(request(app).put('/blobs/attachments/b.png')).send('b');

    const response = await auth(request(app).get('/blobs').query({ prefix: 'audio' }));
    assert.deepEqual(response.body.blobs.map(blob => blob.path), ['audio/a.m4a']);
  });
});

test('列表跳过点号目录、符号链接和上传残留的临时文件', async () => {
  await withApp(async (app, root) => {
    const attachments = path.join(root, 'attachments');
    await fsp.mkdir(path.join(attachments, '.git'), { recursive: true });
    await fsp.writeFile(path.join(attachments, '.git', 'config'), 'x');
    await fsp.writeFile(path.join(attachments, 'real.bin'), 'x');
    await fsp.writeFile(path.join(attachments, 'real.bin.tmp-123-abc'), 'x');

    const response = await auth(request(app).get('/blobs').query({ prefix: 'attachments' }));
    assert.deepEqual(response.body.blobs.map(blob => blob.path), ['attachments/real.bin']);
  });
});

test('允许的前缀目录还没建起来时返回空数组而不是报错', async () => {
  await withApp(async app => {
    const response = await auth(request(app).get('/blobs').query({ prefix: 'audio' }));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.blobs, []);

    // 不在角色允许清单里的前缀是 403，不是空列表 —— 别让「查不到」和「不许查」混在一起。
    assert.equal((await auth(request(app).get('/blobs').query({ prefix: 'nothing-here' }))).status, 403);
  });
});

// ── 删除 ──────────────────────────────────────────────

test('删除资源，再删返回 404', async () => {
  await withApp(async (app, root) => {
    await auth(request(app).put('/blobs/attachments/gone.bin')).send('x');
    assert.equal((await auth(request(app).delete('/blobs/attachments/gone.bin'))).status, 200);
    assert.ok(!fs.existsSync(path.join(root, 'attachments', 'gone.bin')));
    assert.equal((await auth(request(app).delete('/blobs/attachments/gone.bin'))).status, 404);
  });
});

// ── 配置 ──────────────────────────────────────────────

test('缺少根目录或任一角色令牌、令牌相同时拒绝启动', () => {
  assert.throws(() => loadBlobConfig({}), /WORKSTATION_BLOB_ROOT/);
  assert.throws(() => loadBlobConfig({ WORKSTATION_BLOB_ROOT: '/tmp/x' }), /WORKSTATION_BLOB_TOKEN/);
  assert.throws(() => loadBlobConfig({ WORKSTATION_BLOB_ROOT: '/tmp/x', WORKSTATION_BLOB_TOKEN: 'a' }), /RELEASE_TOKEN/);
  assert.throws(() => loadBlobConfig({ WORKSTATION_BLOB_ROOT: '/tmp/x', WORKSTATION_BLOB_TOKEN: 'a', WORKSTATION_BLOB_RELEASE_TOKEN: 'a' }), /必须不同/);
});

test('默认只绑回环，端口和上限的非法值直接报错', () => {
  const base = { WORKSTATION_BLOB_ROOT: '/tmp/x', WORKSTATION_BLOB_TOKEN: 't', WORKSTATION_BLOB_RELEASE_TOKEN: 'r' };
  assert.equal(loadBlobConfig(base).host, '127.0.0.1');
  assert.equal(loadBlobConfig(base).port, 4100);
  assert.equal(loadBlobConfig({ ...base, WORKSTATION_BLOB_PORT: '8080' }).port, 8080);
  assert.throws(() => loadBlobConfig({ ...base, WORKSTATION_BLOB_PORT: 'abc' }), /必须是 0-65535/);
  assert.throws(() => loadBlobConfig({ ...base, WORKSTATION_BLOB_MAX_BYTES: '-5' }), /必须是正整数/);
});

// ── store 直接单测 ─────────────────────────────────────

test('store 对非法路径抛的是带状态码的 BlobError', async () => {
  const root = temporaryRoot();
  try {
    const store = createBlobStore({ root });
    await assert.rejects(() => store.stat('../escape'), error => {
      assert.ok(error instanceof BlobError);
      assert.equal(error.status, 400);
      return true;
    });
    await assert.rejects(() => store.stat('missing.bin'), error => {
      assert.equal(error.status, 404);
      return true;
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('前缀本身是指向根目录外面的符号链接时，列表也拿不到东西', async t => {
  const root = temporaryRoot();
  const outsideDir = temporaryRoot();
  try {
    await fsp.writeFile(path.join(outsideDir, 'secret.m4a'), 'x');
    try {
      // 注意链接的是**前缀目录自己**，不是它底下的条目。walk 会跳过子目录里的
      // 符号链接，但起点从来没人查过 —— readdir 跟着走出去，外面的文件名
      // 就全进了对账清单。
      await fsp.symlink(outsideDir, path.join(root, 'audio'));
    } catch (error) {
      t.skip(`本机不允许创建符号链接：${error.code}`);
      return;
    }

    const store = createBlobStore({ root });
    await assert.rejects(() => store.list({ prefix: 'audio' }), error => {
      assert.ok(error instanceof BlobError);
      assert.equal(error.status, 400);
      return true;
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outsideDir, { recursive: true, force: true });
  }
});

test('前缀目录不存在时列表返回空，而不是抛错', async () => {
  const root = temporaryRoot();
  try {
    const store = createBlobStore({ root });
    assert.deepEqual(await store.list({ prefix: 'audio' }), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
