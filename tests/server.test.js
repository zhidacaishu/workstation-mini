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
const { deleteNote, readNote, writeNote } = require('../src/vault/note');

// 固定「现在」。不钉住的话，凡是依赖 today() 的日记测试都只在某一天通过，
// 换一天就红 —— 这种测试比没有测试更糟。
const FIXED_NOW = new Date(2026, 2, 17, 14, 30);
const TODAY = "2026-03-17";
const LAST_YEAR = "2025-03-17";

async function setup({ readOnly = false, now = () => FIXED_NOW, platform } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-srv-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, {
    db,
    indexer,
    search,
    now,
    platform,
    getIndexStatus: () => ({ ...indexer.getStatus(), notes: db.countNotes() })
  });

  return {
    app, db, indexer, config, notesDir,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('首页在 vault 为空时给出引导', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/').expect(200);
    assert.match(response.text, /vault 还是空的/);
  } finally {
    await ctx.cleanup();
  }
});

test('工作区壳提供当前导航、主内容与命令面板语义', async () => {
  const ctx = await setup();
  try {
    const home = await request(ctx.app).get('/').expect(200);
    assert.match(home.text, /class="workspace-sidebar"/);
    assert.match(home.text, /id="main-content" tabindex="-1"/);
    assert.match(home.text, /class="workspace-nav-link is-active" href="\/" aria-current="page"/);
    assert.match(home.text, /<dialog id="palette"[^>]+aria-labelledby="palette-title"/);
    assert.match(home.text, /class="palette-status" role="status" aria-live="polite"/);
    assert.match(home.text, /id="palette-results"[^>]+role="listbox"/);
    assert.match(home.text, /id="toast-region"[^>]+aria-live="polite"/);

    const search = await request(ctx.app).get('/search').expect(200);
    assert.match(search.text, /class="workspace-nav-link is-active" href="\/search" aria-current="page">\s*<span>笔记<\/span>/);

    const board = await request(ctx.app).get('/board/experiment').expect(200);
    assert.match(board.text, /class="workspace-nav-link is-active" href="\/board\/experiment" aria-current="page">\s*<span>看板<\/span>/);

    const health = await request(ctx.app).get('/health').expect(200);
    assert.match(health.text, /<details class="workspace-tools" open>/);
    assert.match(health.text, /class="workspace-nav-link is-active" href="\/health" aria-current="page">知识库体检<\/a>/);
  } finally {
    await ctx.cleanup();
  }
});

test('主修饰键与命令面板提示按平台渲染', async () => {
  // 前端的快捷键判定读的就是 body 上这个属性，而 kbd 文案必须和它一致 ——
  // macOS 上写「Ctrl K」既是错的，也和实际能用的键对不上。
  const mac = await setup({ platform: 'darwin' });
  try {
    const page = await request(mac.app).get('/').expect(200);
    assert.match(page.text, /<body[^>]+data-primary-modifier="meta"/);
    assert.match(page.text, /<kbd>\u2318K<\/kbd>/);
    assert.doesNotMatch(page.text, /<kbd>Ctrl K<\/kbd>/);
  } finally {
    await mac.cleanup();
  }

  const win = await setup({ platform: 'win32' });
  try {
    const page = await request(win.app).get('/').expect(200);
    assert.match(page.text, /<body[^>]+data-primary-modifier="control"/);
    assert.match(page.text, /<kbd>Ctrl K<\/kbd>/);
    assert.doesNotMatch(page.text, /\u2318K/);
  } finally {
    await win.cleanup();
  }
});

test('编辑页输出 dirty guard 所需的渐进增强契约', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/new?path=research/draft').expect(200);
    assert.match(response.text, /<body class="page-focus"[^>]+data-page-path="\/new"/);
    assert.match(response.text, /<form[^>]*class="editform"[^>]*action="\/save"[^>]*data-editor-form[^>]*data-new-note="1">/);
    assert.match(response.text, /data-editor-status role="status" aria-live="polite"/);
    assert.match(response.text, /type="submit" data-editor-save/);
    assert.match(response.text, /name="path" value="research\/draft\.md"/);
    assert.match(response.text, /name="expectedHash" value=""/);
    assert.match(response.text, /name="isNew" value="1"/);
    assert.match(response.text, /class="workspace-nav-link is-active" href="\/search" aria-current="page">\s*<span>笔记<\/span>/);
  } finally {
    await ctx.cleanup();
  }
});

test('笔记页渲染正文、标签和反向链接', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'reading/econ/ch03.md', {
      data: { title: '第三章', tags: ['计量'] },
      body: '工具变量与两阶段最小二乘。'
    });
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', {
      body: '今天读了 [[reading/econ/ch03|第三章]]。'
    });
    await ctx.indexer.scan();

    const note = await request(ctx.app).get('/note/reading/econ/ch03.md').expect(200);
    assert.match(note.text, /两阶段最小二乘/);
    assert.match(note.text, /计量/);
    assert.match(note.text, /反向链接/);
    assert.match(note.text, /2026-08-06/, '应列出链过来的那篇日记');

    const diary = await request(ctx.app).get('/note/diary/2026-08-06.md').expect(200);
    assert.match(diary.text, /href="\/note\/reading\/econ\/ch03\.md"/, 'wikilink 应渲染成链接');
    assert.match(diary.text, /第三章/, '应使用显示文字');
  } finally {
    await ctx.cleanup();
  }
});

test('指向不存在笔记的链接渲染成待建而不是死链', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'a.md', { body: '将来会写 [[还没写的]]。' });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/note/a.md').expect(200);
    assert.match(response.text, /wikilink-missing/);
    assert.match(response.text, /\/new\?path=/);
  } finally {
    await ctx.cleanup();
  }
});

test('搜索页对中文可用，并标出是全文还是子串命中', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'a.md', {
      body: '计量经济学的工具变量方法，教材第45页。'
    });
    await ctx.indexer.scan();

    const fts = await request(ctx.app).get('/search?q=' + encodeURIComponent('教材')).expect(200);
    assert.match(fts.text, /找到 1 篇/);
    assert.match(fts.text, /全文/);

    const fallback = await request(ctx.app).get('/search?q=' + encodeURIComponent('经济学')).expect(200);
    assert.match(fallback.text, /找到 1 篇/, '「经济学」必须能搜到');
    assert.match(fallback.text, /子串/, '应标出走了兜底路径');
  } finally {
    await ctx.cleanup();
  }
});

test('保存笔记后立刻能搜到', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app)
      .post('/save')
      .type('form')
      .send({ path: 'diary/2026-08-06.md', body: '---\ntags: [日记]\n---\n\n今天读了工具变量。' })
      .expect(302)
      .expect('Location', '/note/diary/2026-08-06.md');

    const search = await request(ctx.app).get('/search?q=' + encodeURIComponent('工具变量')).expect(200);
    assert.match(search.text, /找到 1 篇/);

    // 落盘的是 Markdown 文件本身，不是数据库里的一行。
    const raw = await fs.readFile(path.join(ctx.notesDir, 'diary/2026-08-06.md'), 'utf8');
    assert.equal(raw, '---\ntags: [日记]\n---\n\n今天读了工具变量。');
  } finally {
    await ctx.cleanup();
  }
});

test('编辑器保存与删除使用 hash，冲突时不覆盖磁盘内容', async () => {
  const ctx = await setup();
  try {
    const initial = await writeNote(ctx.notesDir, 'research/conflict.md', { body: '初始正文' });
    await ctx.indexer.scan();
    const edit = await request(ctx.app).get('/edit/research/conflict.md').expect(200);
    assert.match(edit.text, new RegExp(`name="expectedHash" value="${initial.hash}"`));
    assert.match(edit.text, /name="isNew" value="0"/);

    const external = await writeNote(ctx.notesDir, 'research/conflict.md', { body: '外部编辑' });
    await request(ctx.app).post('/save').set('Accept', 'application/json').type('form').send({
      path: 'research/conflict.md', body: '过期编辑器内容', expectedHash: initial.hash, isNew: '0'
    }).expect(409);
    assert.equal(await fs.readFile(path.join(ctx.notesDir, 'research/conflict.md'), 'utf8'), '外部编辑\n');

    await request(ctx.app).post('/delete').type('form').send({
      path: 'research/conflict.md', expectedHash: initial.hash
    }).expect(409);
    assert.equal(await fs.readFile(path.join(ctx.notesDir, 'research/conflict.md'), 'utf8'), '外部编辑\n');

    await request(ctx.app).post('/delete').type('form').send({
      path: 'research/conflict.md', expectedHash: external.hash
    }).expect(302);
    await assert.rejects(() => fs.readFile(path.join(ctx.notesDir, 'research/conflict.md')), error => error.code === 'ENOENT');

    // 目标不存在和目标被改过是两回事。以前两种都报「已被其它操作修改」，
    // 于是往一个不存在的路径提交时，错误信息会指向一次根本没发生的并发编辑。
    const missing = await request(ctx.app).post('/save').set('Accept', 'application/json').type('form').send({
      path: 'research/nowhere.md', body: '内容', expectedHash: initial.hash, isNew: '0'
    }).expect(404);
    assert.match(missing.text, /不存在/);
    assert.doesNotMatch(missing.text, /已被其它操作修改/);
  } finally {
    await ctx.cleanup();
  }
});

test('新建保存拒绝覆盖已存在路径，JSON 成功响应返回新 hash 与地址', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'research/existing.md', { body: '已有内容' });
    await request(ctx.app).post('/save').set('Accept', 'application/json').type('form').send({
      path: 'research/existing.md', body: '不应覆盖', expectedHash: '', isNew: '1'
    }).expect(409);
    assert.equal(await fs.readFile(path.join(ctx.notesDir, 'research/existing.md'), 'utf8'), '已有内容\n');

    const saved = await request(ctx.app).post('/save').set('Accept', 'application/json').type('form').send({
      path: 'research/new.md', body: '新内容', expectedHash: '', isNew: '1'
    }).expect(200);
    assert.equal(saved.body.redirect, '/note/research/new.md');
    assert.equal(saved.body.hash.length, 64);
  } finally {
    await ctx.cleanup();
  }
});

test('新建保存的最终落盘是独占的，不覆盖检查后抢先创建的文件', async () => {
  const ctx = await setup();
  const originalLink = fs.link;
  try {
    let intercepted = false;
    fs.link = async (source, target) => {
      if (!intercepted && target.endsWith(path.join('research', 'external-race.md'))) {
        intercepted = true;
        await fs.writeFile(target, '外部进程抢先创建\n', 'utf8');
      }
      return originalLink(source, target);
    };

    await request(ctx.app).post('/save').set('Accept', 'application/json').type('form').send({
      path: 'research/external-race.md', body: '不应覆盖', expectedHash: '', isNew: '1'
    }).expect(409);
    assert.equal(intercepted, true, '测试必须命中独占落盘前的外部创建窗口');
    assert.equal(
      await fs.readFile(path.join(ctx.notesDir, 'research/external-race.md'), 'utf8'),
      '外部进程抢先创建\n'
    );
  } finally {
    fs.link = originalLink;
    await ctx.cleanup();
  }
});

test('合法特殊字符按路径段编码，Windows 禁止字符被拒绝', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app)
      .post('/save')
      .type('form')
      .send({ path: 'research/C# notes.md', body: '井号路径' })
      .expect(302)
      .expect('Location', '/note/research/C%23%20notes.md');
    await request(ctx.app).get('/note/research/C%23%20notes.md').expect(200);

    await request(ctx.app)
      .post('/save')
      .type('form')
      .send({ path: 'questions/a?b.md', body: '问号路径' })
      .expect(400);
  } finally {
    await ctx.cleanup();
  }
});

test('HTTP 笔记路径把反斜杠规范为统一的正斜杠身份', async () => {
  const ctx = await setup();
  try {
    const saved = await request(ctx.app).post('/save').set('Accept', 'application/json').type('form').send({
      path: 'research\\canonical.md', body: '统一路径', expectedHash: '', isNew: '1'
    }).expect(200);
    assert.equal(saved.body.redirect, '/note/research/canonical.md');
    assert.equal(await fs.readFile(path.join(ctx.notesDir, 'research', 'canonical.md'), 'utf8'), '统一路径');
    await request(ctx.app).get('/note/research/canonical.md').expect(200);
    await request(ctx.app).get('/note/research%5Ccanonical.md').expect(200);
  } finally {
    await ctx.cleanup();
  }
});

test('拒绝目录穿越路径', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app)
      .post('/save')
      .type('form')
      .send({ path: '../escape.md', body: '不该写出去' })
      .expect(400);

    await request(ctx.app).get('/note/../../etc/passwd').expect(res => {
      assert.ok(res.status === 400 || res.status === 404, `期望 400/404，实际 ${res.status}`);
    });
  } finally {
    await ctx.cleanup();
  }
});

test('拒绝非 .md 的文件名', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app)
      .post('/save')
      .type('form')
      .send({ path: 'notes/evil.js', body: 'console.log(1)' })
      .expect(400);
  } finally {
    await ctx.cleanup();
  }
});

test('不存在的笔记返回 404', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/note/nope.md').expect(404);
    assert.match(response.text, /没有这篇笔记/);
  } finally {
    await ctx.cleanup();
  }
});

// 桌面只读模式能看、能搜、能复习，但不能改 Markdown。
test('索引状态、非破坏性重扫与内部失败重试形成稳定 HTTP 契约', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'a.md', { body: '旧内容' });
    await ctx.indexer.scan();
    await fs.writeFile(path.join(ctx.notesDir, 'a.md'), '---\ntags: [没有闭合\n---\n坏内容');
    await writeNote(ctx.notesDir, 'later.md', { body: '后续内容' });

    const rescanned = await request(ctx.app).post('/api/reindex').expect(200);
    assert.equal(rescanned.body.phase, 'degraded');
    assert.equal(rescanned.body.failureTotal, 1);
    assert.equal(ctx.db.getNote('a.md').body_raw.trim(), '旧内容');
    assert.equal(ctx.db.getNote('later.md').body_raw.trim(), '后续内容');

    const status = await request(ctx.app).get('/api/index-status').expect(200);
    assert.deepEqual(Object.keys(status.body).sort(), [
      'done', 'failureTotal', 'failures', 'failuresTruncated', 'fatal', 'generation',
      'notes', 'phase', 'scanKind', 'total', 'updatedAt'
    ]);
    assert.deepEqual(status.body.failures, [{
      path: 'a.md', code: 'invalid-frontmatter', reason: 'frontmatter 格式无法解析', retryable: true
    }]);

    await writeNote(ctx.notesDir, 'a.md', { body: '修好了' });
    await writeNote(ctx.notesDir, 'not-a-failure.md', { body: '调用方不能指定我' });
    const retried = await request(ctx.app)
      .post('/api/index-retry')
      .send({ paths: ['not-a-failure.md'] })
      .expect(200);
    assert.equal(retried.body.phase, 'ready');
    assert.equal(ctx.db.getNote('a.md').body_raw.trim(), '修好了');
    assert.equal(ctx.db.getNote('not-a-failure.md'), undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('只读实例拒绝资料源写操作，但允许派生索引维护', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await writeNote(ctx.notesDir, 'a.md', { body: '内容' });
    await ctx.indexer.scan();

    // 读路径全部正常
    await request(ctx.app).get('/').expect(200);
    await request(ctx.app).get('/note/a.md').expect(200);
    await request(ctx.app).get('/search?q=' + encodeURIComponent('内容')).expect(200);

    // 写路径全部 403
    await request(ctx.app).post('/save').type('form').send({ path: 'b.md', body: 'x' }).expect(403);
    await request(ctx.app).post('/delete').type('form').send({ path: 'a.md' }).expect(403);
    await request(ctx.app).post('/api/reindex').expect(200);
    await request(ctx.app).post('/api/index-retry').expect(200);
    await request(ctx.app).get('/new').expect(403);
    await request(ctx.app).get('/edit/a.md').expect(403);

    // 文件确实没被动过
    assert.equal((await fs.readFile(path.join(ctx.notesDir, 'a.md'), 'utf8')).trim(), '内容');
  } finally {
    await ctx.cleanup();
  }
});

test('只读实例的页面不渲染编辑入口', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await writeNote(ctx.notesDir, 'a.md', { body: '内容' });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/note/a.md').expect(200);
    assert.ok(!response.text.includes('href="/edit/'), '不该出现编辑链接');
    assert.ok(!response.text.includes('href="/new"'), '不该出现新建入口');
    assert.ok(!response.text.includes('/static/selection-card.js'), '只读模式不该加载写入脚本');
    assert.match(response.text, /<body class="page-reading is-readonly"/);
    assert.match(response.text, /<div class="workspace-sidebar-footer">[\s\S]*class="readonly-status" title="可浏览、搜索和复习，不能修改笔记"/);
    assert.match(response.text, /<header class="workspace-toolbar">[\s\S]*class="readonly-status readonly-status-compact" title="可浏览、搜索和复习，不能修改笔记" aria-label="只读模式：可浏览、搜索和复习，不能修改笔记"/);
    assert.match(response.text, /<dialog id="palette" class="palette" data-readonly="1"/);
    assert.match(response.headers['content-security-policy'], /worker-src 'self'/);
  } finally {
    await ctx.cleanup();
  }
});

test('命令面板接口：无查询词时返回最近笔记', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'a.md', { data: { title: '甲' }, body: '内容' });
    await ctx.indexer.scan();

    const empty = await request(ctx.app).get('/api/search').expect(200);
    assert.equal(empty.body.results[0].title, '甲');

    const hit = await request(ctx.app).get('/api/search?q=' + encodeURIComponent('内容')).expect(200);
    assert.equal(hit.body.results.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('命令面板在只读实例里拿到只读标记', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    const response = await request(ctx.app).get('/').expect(200);
    assert.match(response.text, /data-readonly="1"/);
    assert.match(response.text, /id="palette"/);
  } finally {
    await ctx.cleanup();
  }
});

test('笔记正文里的原始 HTML 不被渲染', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'a.md', { body: '<script>alert(1)</script>\n\n正文' });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/note/a.md').expect(200);
    assert.ok(!response.text.includes('<script>alert(1)</script>'), '不应原样输出 script 标签');
  } finally {
    await ctx.cleanup();
  }
});
