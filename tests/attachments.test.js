const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { createBlobClient } = require('../src/blobs/client');
const { startBlobServer } = require('../src/blobs/server');
const { reconcileBlobs } = require('../src/blobs/reconcile');
const { renderMarkdown, resolveResourceHref } = require('../src/markdown');
const { writeNote } = require('../src/vault/note');

const FIXED_NOW = new Date(2026, 7, 9, 12, 0); // 2026-08-09
const TOKEN = 'blob-token-for-tests';

/**
 * 起一个真的存储服务，而不是塞一个假客户端。
 *
 * 这条链路的价值恰恰在两端的配合上 —— 路径怎么编码、Range 怎么透传、
 * 404 怎么区分「服务器没有」和「网络断了」。用假对象测等于把要测的东西
 * 换成了自己的想象。
 */
async function setup({ readOnly = false, withServer = true } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-attach-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  let blobServer = null;
  let blobRoot = '';
  if (withServer) {
    blobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blobroot-'));
    blobServer = await startBlobServer(
      { root: blobRoot, clientToken: TOKEN, releaseToken: `${TOKEN}-release`, host: '127.0.0.1', port: 0 },
      { logger: { log() {} } }
    );
  }

  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly,
    blobServerUrl: blobServer?.origin || '',
    blobServerToken: blobServer ? TOKEN : ''
  });

  const blobs = createBlobClient({
    baseUrl: config.blobServerUrl,
    token: config.blobServerToken,
    logger: { log() {}, warn() {} }
  });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const app = createApp(config, {
    db, indexer, blobs,
    search: createSearch(db),
    logger: { log() {}, warn() {} },
    now: () => FIXED_NOW
  });

  return {
    app, db, indexer, config, vaultDir, notesDir, blobs, blobRoot,
    blobOrigin: blobServer?.origin || '',
    async closeServer() {
      if (blobServer) await blobServer.close();
      blobServer = null;
    },
    async cleanup() {
      db.close();
      if (blobServer) await blobServer.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
      if (blobRoot) await fs.rm(blobRoot, { recursive: true, force: true });
    }
  };
}

// ── 上传 ──────────────────────────────────────────────

test('上传的附件同时落本地和存储服务，路径按内容哈希去重', async () => {
  const ctx = await setup();
  try {
    const png = Buffer.from('fake-png-bytes');

    const first = await request(ctx.app)
      .post('/attachments?name=%E5%9B%BE%201.png')
      .set('content-type', 'image/png')
      .send(png);

    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.uploaded, true, '应当已推到存储服务');
    assert.match(first.body.path, /^attachments\/2026-08\/.+-[0-9a-f]{8}\.png$/);
    // URL 是逐段百分号编码的，中文文件名不能直接拼进 Markdown 链接。
    assert.equal(first.body.url, '/attachments/2026-08/%E5%9B%BE-1-3c6ed5fc.png');

    // 本地有。
    assert.deepEqual(await fs.readFile(path.join(ctx.vaultDir, first.body.path)), png);
    // 服务器上也有。
    assert.deepEqual(await fs.readFile(path.join(ctx.blobRoot, first.body.path)), png);

    // 同样的内容再传一次落到同一个路径，不会存两份。
    const second = await request(ctx.app)
      .post('/attachments?name=%E5%9B%BE%201.png')
      .set('content-type', 'image/png')
      .send(png);
    assert.equal(second.body.path, first.body.path);
  } finally {
    await ctx.cleanup();
  }
});

test('文件名里的中文和空格被规范化，但还能看出原来是什么', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app)
      .post('/attachments?name=Figure%202%20-%20final%20draft.PDF')
      .set('content-type', 'application/pdf')
      .send('pdf');
    assert.match(response.body.path, /attachments\/2026-08\/figure-2-final-draft-[0-9a-f]{8}\.pdf$/);
  } finally {
    await ctx.cleanup();
  }
});

test('没配存储服务时仍能上传到本地，但如实说明没推上去', async () => {
  const ctx = await setup({ withServer: false });
  try {
    const response = await request(ctx.app)
      .post('/attachments?name=a.png')
      .set('content-type', 'image/png')
      .send('bytes');

    assert.equal(response.status, 200);
    assert.equal(response.body.uploaded, false);
    assert.match(response.body.warning, /未配置/);
    assert.ok(await fs.readFile(path.join(ctx.vaultDir, response.body.path)));
  } finally {
    await ctx.cleanup();
  }
});

test('JSON、表单等会被正文解析器认领的类型也按原始字节上传', async () => {
  const ctx = await setup({ withServer: false });
  try {
    for (const [name, type, body] of [
      ['data.json', 'application/json', '{"a":1}'],
      ['broken.json', 'application/json', '{not json'],
      ['form.txt', 'application/x-www-form-urlencoded', 'a=1&b=2']
    ]) {
      const response = await request(ctx.app)
        .post(`/attachments?name=${name}`)
        .set('content-type', type)
        .send(body);
      assert.equal(response.status, 200, `${name} 应当上传成功`);
      assert.equal(response.body.size, Buffer.byteLength(body));
      assert.equal(await fs.readFile(path.join(ctx.vaultDir, response.body.path), 'utf8'), body);
    }

    // 其它路由的 JSON 请求体照常被解析。
    const other = await request(ctx.app)
      .post('/publish/preview')
      .set('accept', 'application/json')
      .send({ path: '../x.md' });
    assert.equal(other.status, 400);
    assert.match(other.body.message, /路径不合法/);
  } finally {
    await ctx.cleanup();
  }
});

test('空内容和只读实例都被拒绝', async () => {
  const ctx = await setup();
  try {
    const empty = await request(ctx.app).post('/attachments?name=a.png').send('');
    assert.equal(empty.status, 400);
  } finally {
    await ctx.cleanup();
  }

  const readOnly = await setup({ readOnly: true });
  try {
    // 带上 Accept: application/json，和前端 requestJson 的真实调用一致。
    const response = await request(readOnly.app)
      .post('/attachments?name=a.png')
      .set('accept', 'application/json')
      .set('content-type', 'image/png')
      .send('bytes');
    assert.equal(response.status, 403);
    assert.match(response.body.message, /只读模式/);
  } finally {
    await readOnly.cleanup();
  }
});

// ── 回源缓存 ──────────────────────────────────────────

test('本地没有的附件会从存储服务取回并缓存下来', async () => {
  const ctx = await setup();
  try {
    // 只放到服务器上，本地故意没有 —— 相当于「另一台设备传的」。
    await fs.mkdir(path.join(ctx.blobRoot, 'attachments', '2026-08'), { recursive: true });
    await fs.writeFile(path.join(ctx.blobRoot, 'attachments/2026-08/remote.png'), 'remote-bytes');

    const local = path.join(ctx.vaultDir, 'attachments/2026-08/remote.png');
    await assert.rejects(() => fs.access(local), '前置条件：本地不该有这个文件');

    const response = await request(ctx.app).get('/attachments/2026-08/remote.png');
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(response.body).toString(), 'remote-bytes');

    // 取回来之后留在本地，离线也能再看。
    assert.equal(await fs.readFile(local, 'utf8'), 'remote-bytes');
  } finally {
    await ctx.cleanup();
  }
});

test('两边都没有的附件返回 404，而不是 500', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/attachments/2026-08/nowhere.png');
    assert.equal(response.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('存储服务连不上时，本地已有的附件照常可用', async () => {
  const ctx = await setup();
  try {
    await fs.mkdir(path.join(ctx.vaultDir, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(ctx.vaultDir, 'attachments/local.png'), 'local-bytes');

    // 真的把服务器关掉再请求：本地命中就该直接返回，根本不该去碰网络。
    await ctx.closeServer();
    const response = await request(ctx.app).get('/attachments/local.png');
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(response.body).toString(), 'local-bytes');
  } finally {
    await ctx.cleanup();
  }
});

test('音频也走同一套回源逻辑', async () => {
  const ctx = await setup();
  try {
    await fs.mkdir(path.join(ctx.blobRoot, 'audio', 'clip-01'), { recursive: true });
    await fs.writeFile(path.join(ctx.blobRoot, 'audio/clip-01/audio.m4a'), 'sound-bytes');

    const response = await request(ctx.app).get('/media/clip-01/audio.m4a');
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(response.body).toString(), 'sound-bytes');
    assert.equal(
      await fs.readFile(path.join(ctx.vaultDir, 'audio/clip-01/audio.m4a'), 'utf8'),
      'sound-bytes'
    );
  } finally {
    await ctx.cleanup();
  }
});

test('回源路径同样挡住目录穿越', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'secret.md'), 'private');
    const response = await request(ctx.app).get('/attachments/../secret.md');
    assert.ok(response.status >= 400, `实际 ${response.status}`);
    assert.ok(!String(response.text || '').includes('private'));
  } finally {
    await ctx.cleanup();
  }
});

// ── Markdown 渲染 ─────────────────────────────────────

test('笔记里的附件路径被改写成能取到的地址', () => {
  const cases = [
    // 相对 vault 根：应用自己插入的、以及 Obsidian「仓库内绝对路径」的形状。
    ['attachments/2026-08/fig.png', 'reading/book/ch03.md', '/attachments/2026-08/fig.png'],
    ['audio/clip/audio.m4a', 'a.md', '/media/clip/audio.m4a'],
    // 相对笔记目录：notes/reading/book/ 回到 vault 根要三层。
    ['../../../attachments/fig.png', 'reading/book/ch03.md', '/attachments/fig.png'],
    ['../../attachments/fig.png', 'reading/ch.md', '/attachments/fig.png'],
    ['../../audio/clip/a.m4a', 'reading/ch.md', '/media/clip/a.m4a'],
    // 层数不够、落不到受管目录的，保持原样而不是猜。
    ['../attachments/fig.png', 'reading/ch.md', '../attachments/fig.png'],
    ['fig.png', 'reading/ch.md', '/attachments/fig.png'],
    // 已经是绝对地址或外链的一律不动。
    ['/attachments/x.png', 'a.md', '/attachments/x.png'],
    ['https://example.com/x.png', 'a.md', 'https://example.com/x.png'],
    ['data:image/png;base64,AAAA', 'a.md', 'data:image/png;base64,AAAA'],
    // 落不进受管目录的保持原样，不去猜。
    ['../notes/other.png', 'reading/ch.md', '../notes/other.png']
  ];

  for (const [src, notePath, expected] of cases) {
    assert.equal(resolveResourceHref(src, notePath), expected, `${src} @ ${notePath}`);
  }
});

test('渲染出的 img 指向附件路由并带懒加载', () => {
  const html = renderMarkdown('![图](attachments/2026-08/fig.png)', () => '', {
    notePath: 'reading/ch.md'
  });
  assert.match(html, /src="\/attachments\/2026-08\/fig\.png"/);
  assert.match(html, /loading="lazy"/);
});

test('Obsidian 的 ![[图片]] 嵌入不再变成「新建笔记」死链', () => {
  const html = renderMarkdown('![[Pasted image.png]]', () => '', { notePath: 'a.md' });
  assert.match(html, /<img/);
  assert.match(html, /src="\/attachments\/Pasted%20image\.png"/);
  assert.ok(!html.includes('/new?path='), '不该再渲染成待建笔记链接');
});

test('不带感叹号的 [[wikilink]] 仍然是笔记跳转', () => {
  const html = renderMarkdown('[[别的笔记]]', target => (target === '别的笔记' ? '别的笔记.md' : ''), {
    notePath: 'a.md'
  });
  assert.match(html, /href="\/note\/%E5%88%AB%E7%9A%84%E7%AC%94%E8%AE%B0\.md"/);
  assert.ok(!html.includes('<img'));
});

test('代码块里的图片语法和嵌入语法都不被改写', () => {
  const html = renderMarkdown('```\n![[fig.png]]\n![x](attachments/y.png)\n```', () => '', {
    notePath: 'a.md'
  });
  assert.ok(!html.includes('<img'), '代码块里的东西不该被渲染成图片');
  assert.match(html, /!\[\[fig\.png\]\]/);
});

test('块级元素唯一 claim 行号，标题另有稳定 H alias', () => {
  const html = renderMarkdown('# **中文** 标题\n\n- [ ] 待办项 1\n- [ ] 待办项 2\n\n> 引用正文', () => '', {
    notePath: 'test.md'
  });
  assert.match(html, /<span id="H-中文-标题"[^>]*><\/span><h1 id="L1">/);
  assert.match(html, /<li id="L3">/);
  assert.match(html, /<li id="L4">/);
  assert.equal((html.match(/id="L3"/g) || []).length, 1, '同源行嵌套 paragraph 不应重复 claim');
  assert.equal((html.match(/id="L6"/g) || []).length, 1, 'blockquote 与段落只留最具体 claim');
});

test('重复标题使用 -2/-3 后缀，NFC 组合产生同一 fragment', () => {
  const html = renderMarkdown('## Café\n\n## Café\n\n## **Café**', () => '');
  assert.match(html, /id="H-café"/u);
  assert.match(html, /id="H-café-2"/u);
  assert.match(html, /id="H-café-3"/u);
});

test('显式后缀标题与重复派生 alias 全局不碰撞', () => {
  function aliases(markdown) {
    return [...renderMarkdown(markdown, () => '').matchAll(/id="(H-[^"]+)" class="heading-anchor"/g)]
      .map(match => match[1]);
  }

  assert.deepEqual(aliases('# Foo\n\n# Foo-2\n\n# Foo'), ['H-foo', 'H-foo-2', 'H-foo-3']);
  assert.deepEqual(aliases('# Foo\n\n# Foo\n\n# Foo-2'), ['H-foo', 'H-foo-3', 'H-foo-2'],
    '重复 Foo 不得抢占后面显式 Foo-2 的 fragment');
});

test('wikilink 标题和 #L 行号共用 fragment helper', () => {
  const resolve = () => '目标.md';
  assert.match(renderMarkdown('[[目标#中文 标题]]', resolve), /#H-%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98/);
  assert.match(renderMarkdown('[[目标#L12]]', resolve), /#L12/);
});

// ── 对账 ──────────────────────────────────────────────

test('对账双向补齐：服务器缺的推上去，本地缺的拉下来', async () => {
  const ctx = await setup();
  try {
    // 本地手动放的音频（用户往 audio/ 里拖素材就是这个形状）。
    await fs.mkdir(path.join(ctx.vaultDir, 'audio', 'local-clip'), { recursive: true });
    await fs.writeFile(path.join(ctx.vaultDir, 'audio/local-clip/audio.m4a'), 'local-sound');

    // 另一台设备传上去的附件。
    await fs.mkdir(path.join(ctx.blobRoot, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(ctx.blobRoot, 'attachments/remote.png'), 'remote-pic');

    const summary = await reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: { log() {}, warn() {} },
      settleMs: 0
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.uploaded, 1);
    assert.equal(summary.downloaded, 1);

    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/local-clip/audio.m4a'), 'utf8'), 'local-sound');
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'attachments/remote.png'), 'utf8'), 'remote-pic');
  } finally {
    await ctx.cleanup();
  }
});

test('两边大小不一致时只报告，不擅自覆盖任何一边', async () => {
  const ctx = await setup();
  try {
    await fs.mkdir(path.join(ctx.vaultDir, 'attachments'), { recursive: true });
    await fs.mkdir(path.join(ctx.blobRoot, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(ctx.vaultDir, 'attachments/x.png'), 'local-version-longer');
    await fs.writeFile(path.join(ctx.blobRoot, 'attachments/x.png'), 'remote');

    const summary = await reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: { log() {}, warn() {} }
    });

    assert.equal(summary.mismatched.length, 1);
    assert.equal(summary.mismatched[0].path, 'attachments/x.png');
    // 两边都原封不动。
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'attachments/x.png'), 'utf8'), 'local-version-longer');
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'attachments/x.png'), 'utf8'), 'remote');
  } finally {
    await ctx.cleanup();
  }
});

test('没配存储服务时对账直接跳过，不报错', async () => {
  const ctx = await setup({ withServer: false });
  try {
    const summary = await reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.blobs });
    assert.equal(summary.ok, true);
    assert.match(summary.skipped, /未配置/);
  } finally {
    await ctx.cleanup();
  }
});

test('对账跳过临时文件和点号条目，避免把残留当成真素材传来传去', async () => {
  const ctx = await setup();
  try {
    await fs.mkdir(path.join(ctx.vaultDir, 'attachments'), { recursive: true });
    await fs.writeFile(path.join(ctx.vaultDir, 'attachments/real.png'), 'real');
    await fs.writeFile(path.join(ctx.vaultDir, 'attachments/real.png.tmp-1-abc'), 'junk');
    await fs.writeFile(path.join(ctx.vaultDir, 'attachments/.DS_Store'), 'junk');

    const summary = await reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: { log() {}, warn() {} },
      settleMs: 0
    });

    assert.equal(summary.uploaded, 1);
    const remote = await ctx.blobs.list({ prefix: 'attachments' });
    assert.deepEqual(remote.blobs.map(blob => blob.path), ['attachments/real.png']);
  } finally {
    await ctx.cleanup();
  }
});

function memoryState() {
  const data = new Map();
  return {
    data,
    async load(prefix) { return new Map(data.get(prefix) || []); },
    async save(prefix, entries) { data.set(prefix, new Map(entries)); }
  };
}

async function put(root, relative, content) {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

const exists = target => fs.access(target).then(() => true, () => false);

test('刚写入还在变的本地文件先不上传，稳定之后再传', async () => {
  const ctx = await setup();
  try {
    await put(ctx.vaultDir, 'audio/clip/audio.m4a', 'copying');
    const quiet = { log() {}, warn() {} };
    const first = await reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.blobs, logger: quiet });
    assert.equal(first.uploaded, 0);
    assert.deepEqual(first.deferred, ['audio/clip/audio.m4a']);
    assert.equal(await exists(path.join(ctx.blobRoot, 'audio/clip/audio.m4a')), false);

    const later = await reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: quiet,
      now: () => Date.now() + 120_000
    });
    assert.equal(later.uploaded, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('有同步记录时删除双向传播，本地删除走注入的回收站', async () => {
  const ctx = await setup();
  try {
    const quiet = { log() {}, warn() {} };
    const state = memoryState();
    const trashed = [];
    const run = () => reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: quiet,
      state,
      settleMs: 0,
      removeLocal: async target => { trashed.push(target); await fs.rm(target); }
    });
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await put(ctx.vaultDir, `attachments/${name}.png`, `pic-${name}`);
    }
    const first = await run();
    assert.equal(first.uploaded, 6);
    assert.equal(state.data.get('attachments').size, 6);

    // 本机删了 a：服务器上的也删掉，而不是下一轮再拉回来。
    await fs.rm(path.join(ctx.vaultDir, 'attachments/a.png'));
    // 另一台设备删了 b：本机这份进回收站。
    await fs.rm(path.join(ctx.blobRoot, 'attachments/b.png'));

    const second = await run();
    assert.equal(second.deletedRemote, 1);
    assert.equal(second.deletedLocal, 1);
    assert.equal(second.downloaded, 0);
    assert.equal(second.uploaded, 0);
    assert.equal(await exists(path.join(ctx.blobRoot, 'attachments/a.png')), false);
    assert.equal(await exists(path.join(ctx.vaultDir, 'attachments/a.png')), false);
    assert.equal(await exists(path.join(ctx.vaultDir, 'attachments/b.png')), false);
    assert.deepEqual(trashed, [path.join(ctx.vaultDir, 'attachments', 'b.png')]);
    assert.deepEqual([...state.data.get('attachments').keys()].sort(), [
      'attachments/c.png', 'attachments/d.png', 'attachments/e.png', 'attachments/f.png'
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test('有同步记录时能分清哪一边改过：单边修改覆盖另一边，双边修改才算冲突', async () => {
  const ctx = await setup();
  try {
    const quiet = { log() {}, warn() {} };
    const state = memoryState();
    const run = () => reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.blobs, logger: quiet, state, settleMs: 0 });
    await put(ctx.vaultDir, 'audio/x.m4a', 'v1');
    await put(ctx.vaultDir, 'audio/y.m4a', 'v1');
    await put(ctx.vaultDir, 'audio/z.m4a', 'v1');
    await run();

    await put(ctx.vaultDir, 'audio/x.m4a', 'local-v2');       // 本机改了
    await put(ctx.blobRoot, 'audio/y.m4a', 'remote-v2');      // 别处改了
    await put(ctx.vaultDir, 'audio/z.m4a', 'local-v22');      // 两边都改了
    await put(ctx.blobRoot, 'audio/z.m4a', 'remote-v333');

    const summary = await run();
    assert.equal(summary.uploaded, 1);
    assert.equal(summary.downloaded, 1);
    assert.deepEqual(summary.mismatched.map(item => item.path), ['audio/z.m4a']);
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/x.m4a'), 'utf8'), 'local-v2');
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio/y.m4a'), 'utf8'), 'remote-v2');
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio/z.m4a'), 'utf8'), 'local-v22');
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/z.m4a'), 'utf8'), 'remote-v333');
  } finally {
    await ctx.cleanup();
  }
});

test('一边整个为空或成批消失时不传播删除', async () => {
  const ctx = await setup();
  try {
    const quiet = { log() {}, warn() {} };
    const state = memoryState();
    const run = () => reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.blobs, logger: quiet, state, settleMs: 0 });
    const names = Array.from({ length: 10 }, (_, index) => `attachments/n${index}.png`);
    for (const name of names) await put(ctx.vaultDir, name, name);
    await run();

    // 本地整个目录没了（没挂上、刚换了资料库）：按新环境处理，重新取回，而不是清空服务器。
    await fs.rm(path.join(ctx.vaultDir, 'attachments'), { recursive: true });
    const emptied = await run();
    assert.equal(emptied.deletedRemote, 0);
    assert.equal(emptied.downloaded, 10);

    // 10 个里一次少了 6 个：比例异常，两边都不动，只报告。
    for (const name of names.slice(0, 6)) await fs.rm(path.join(ctx.vaultDir, name));
    const mass = await run();
    assert.equal(mass.deletedRemote, 0);
    assert.equal(mass.downloaded, 0);
    assert.equal(mass.heldDeletions.length, 6);
    for (const name of names) assert.equal(await exists(path.join(ctx.blobRoot, name)), true);
  } finally {
    await ctx.cleanup();
  }
});

test('Git 拉取删掉的托管文件只补齐，不当作本地删除传到服务器', async () => {
  const ctx = await setup();
  try {
    const quiet = { log() {}, warn() {} };
    const state = memoryState();
    const restoreOnly = new Set();
    const run = () => reconcileBlobs({
      vaultDir: ctx.vaultDir, blobs: ctx.blobs, logger: quiet, state, settleMs: 0, restoreOnly
    });
    for (const name of ['a', 'b', 'c']) await put(ctx.vaultDir, `audio/${name}.m4a`, name);
    await run();

    await fs.rm(path.join(ctx.vaultDir, 'audio/a.m4a'));
    restoreOnly.add('audio/a.m4a');
    const summary = await run();
    assert.equal(summary.deletedRemote, 0);
    assert.equal(summary.downloaded, 1);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio/a.m4a'), 'utf8'), 'a');
    assert.equal(restoreOnly.size, 0, '补回之后不再需要保护');
  } finally {
    await ctx.cleanup();
  }
});

test('删除执行前重新核对：列表之后又变过的文件不删', async () => {
  const ctx = await setup();
  try {
    const quiet = { log() {}, warn() {} };
    const state = memoryState();
    let listCalls = 0;
    let hook = null;
    const blobs = {
      ...ctx.blobs,
      async list(options) {
        listCalls += 1;
        if (hook) await hook(listCalls);
        return ctx.blobs.list(options);
      },
      async remove(relative) {
        return ctx.blobs.remove(relative);
      }
    };
    const run = () => reconcileBlobs({ vaultDir: ctx.vaultDir, blobs, logger: quiet, state, settleMs: 0 });
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) await put(ctx.vaultDir, `audio/${name}.m4a`, name);
    await run();

    // a：本机删了，但在「列表 → 删除」之间另一台设备传上来一个新版本。
    // b：另一台设备删了，但在这之间本机重新录了一版。
    await fs.rm(path.join(ctx.vaultDir, 'audio/a.m4a'));
    await fs.rm(path.join(ctx.blobRoot, 'audio/b.m4a'));
    listCalls = 0;
    hook = async call => {
      if (call !== 2) return;
      await put(ctx.blobRoot, 'audio/a.m4a', 'a-new-version-from-elsewhere');
      await put(ctx.vaultDir, 'audio/b.m4a', 'b-re-recorded-longer');
    };
    const summary = await run();
    assert.equal(summary.deletedRemote, 0);
    assert.equal(summary.deletedLocal, 0);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio/a.m4a'), 'utf8'), 'a-new-version-from-elsewhere');
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/b.m4a'), 'utf8'), 'b-re-recorded-longer');
  } finally {
    await ctx.cleanup();
  }
});

test('mtime 在未来的文件视为已写完，照常上传', async () => {
  const ctx = await setup();
  try {
    await put(ctx.vaultDir, 'audio/rec.wav', 'recorded');
    const future = new Date(Date.now() + 24 * 3600_000);
    await fs.utimes(path.join(ctx.vaultDir, 'audio/rec.wav'), future, future);
    const logs = [];
    const summary = await reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: { log: message => logs.push(message), warn() {} }
    });
    assert.equal(summary.uploaded, 1);
    assert.deepEqual(summary.deferred, []);

    await put(ctx.vaultDir, 'audio/fresh.wav', 'still copying');
    const deferred = await reconcileBlobs({
      vaultDir: ctx.vaultDir,
      blobs: ctx.blobs,
      logger: { log: message => logs.push(message), warn() {} }
    });
    assert.deepEqual(deferred.deferred, ['audio/fresh.wav']);
    assert.ok(logs.some(message => /推迟到下一轮/.test(message)), '推迟要在日志里说出来');
  } finally {
    await ctx.cleanup();
  }
});

// ── 笔记页整链路 ───────────────────────────────────────

test('笔记页里的图片能一路取到存储服务上的那份', async () => {
  const ctx = await setup();
  try {
    await fs.mkdir(path.join(ctx.blobRoot, 'attachments', '2026-08'), { recursive: true });
    await fs.writeFile(path.join(ctx.blobRoot, 'attachments/2026-08/plot.png'), 'plot-bytes');

    await writeNote(ctx.notesDir, 'research/topic.md', {
      body: '# 结果\n\n![实验结果](attachments/2026-08/plot.png)\n'
    });
    await ctx.indexer.scan();

    const page = await request(ctx.app).get('/note/research/topic.md');
    assert.equal(page.status, 200);
    assert.match(page.text, /src="\/attachments\/2026-08\/plot\.png"/);

    const image = await request(ctx.app).get('/attachments/2026-08/plot.png');
    assert.equal(image.status, 200);
    assert.equal(Buffer.from(image.body).toString(), 'plot-bytes');
  } finally {
    await ctx.cleanup();
  }
});

test('equal-size edits sync by digest; modified content wins over deletion', async () => {
  const ctx = await setup();
  try {
    const state = memoryState();
    const run = () => reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.blobs, state, settleMs: 0, logger: { log() {}, warn() {} } });
    await put(ctx.vaultDir, 'audio/a.srt', 'OLD!');
    await put(ctx.vaultDir, 'audio/keep.srt', 'KEEP');
    await run();
    await put(ctx.vaultDir, 'audio/a.srt', 'NEW!');
    assert.equal((await run()).uploaded, 1);
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/a.srt'), 'utf8'), 'NEW!');
    await put(ctx.vaultDir, 'audio/a.srt', 'EDIT');
    await fs.rm(path.join(ctx.blobRoot, 'audio/a.srt'));
    const result = await run();
    assert.equal(result.deletedLocal, 0);
    assert.equal(result.uploaded, 1);
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/a.srt'), 'utf8'), 'EDIT');
    await put(ctx.blobRoot, 'audio/a.srt', 'RMT!');
    assert.equal((await run()).downloaded, 1);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio/a.srt'), 'utf8'), 'RMT!');
  } finally { await ctx.cleanup(); }
});

test('conditional writes reject stale remote digest and legacy state cannot delete', async () => {
  const ctx = await setup();
  try {
    await put(ctx.blobRoot, 'audio/a.srt', 'OLD!');
    await put(ctx.blobRoot, 'audio/keep.srt', 'KEEP');
    await put(ctx.vaultDir, 'audio/keep.srt', 'KEEP');
    const state = memoryState();
    await state.save('audio', new Map([['audio/a.srt', 4], ['audio/keep.srt', 4]]));
    const run = () => reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: ctx.blobs, state, settleMs: 0, logger: { log() {}, warn() {} } });
    assert.equal((await run()).downloaded, 1);
    const remote = await ctx.blobs.list({ prefix: 'audio', integrity: 'sha256' });
    const old = remote.blobs.find(blob => blob.path === 'audio/a.srt').sha256;
    await put(ctx.blobRoot, 'audio/a.srt', 'NEW!');
    assert.equal((await ctx.blobs.remove('audio/a.srt', { expectedSha256: old })).ok, false);
    assert.equal((await ctx.blobs.upload('audio/a.srt', ctx.vaultDir, { expectedSha256: old })).ok, false);
    assert.equal(await fs.readFile(path.join(ctx.blobRoot, 'audio/a.srt'), 'utf8'), 'NEW!');
  } finally { await ctx.cleanup(); }
});

test('download cannot replace a locally edited file after its snapshot', async () => {
  const ctx = await setup();
  try {
    await put(ctx.blobRoot, 'audio/a.srt', 'REMOTE');
    await put(ctx.vaultDir, 'audio/a.srt', 'EDIT');
    const result = await ctx.blobs.download('audio/a.srt', ctx.vaultDir, { expectedLocalSha256: '0'.repeat(64) });
    assert.equal(result.ok, false);
    assert.equal(await fs.readFile(path.join(ctx.vaultDir, 'audio/a.srt'), 'utf8'), 'EDIT');
  } finally { await ctx.cleanup(); }
});

test('local digest scan accepts cancellation before starting I/O', async () => {
  const { fingerprint } = require('../src/blobs/integrity');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fingerprint('/nonexistent', 'audio/a.srt', { signal: controller.signal }), { name: 'AbortError' });
});

test('legacy blob service cannot silently perform unguarded reconciliation', async () => {
  const ctx = await setup();
  try {
    const legacy = { ...ctx.blobs, list: async () => ({ ok: true, blobs: [] }) };
    await put(ctx.vaultDir, 'audio/a.srt', 'LOCAL');
    const result = await reconcileBlobs({ vaultDir: ctx.vaultDir, blobs: legacy, settleMs: 0, logger: { warn() {} } });
    assert.equal(result.ok, false);
    assert.match(result.failed[0].reason, /升级/);
    assert.equal(result.uploaded + result.deletedLocal + result.deletedRemote, 0);
  } finally { await ctx.cleanup(); }
});
