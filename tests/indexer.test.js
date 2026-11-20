const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch, escapeLike } = require('../src/search');
const { writeNote, deleteNote, listNotes } = require('../src/vault/note');

async function setup(indexerOptions = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-idx-'));
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir, ...indexerOptions });
  const search = createSearch(db);
  return {
    vaultDir,
    db,
    indexer,
    search,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

// 索引里所有能观察到的状态，用于比较「增量更新」与「全量重建」是否一致。
function snapshot(db) {
  return {
    notes: db.raw.prepare(`SELECT path, section, title_raw, body_raw, hash, size FROM notes ORDER BY path`).all(),
    tags: db.raw.prepare(`SELECT path, tag FROM tags ORDER BY path, tag`).all(),
    links: db.raw.prepare(`SELECT from_path, to_target, to_path FROM links ORDER BY from_path, to_target`).all(),
    tasks: db.raw.prepare(`SELECT path, line, done, title, due FROM tasks ORDER BY path, line`).all(),
    fts: db.raw.prepare(`SELECT path, title, body FROM notes_fts ORDER BY path`).all()
  };
}

// 清空索引后强制全量重扫：用来对照增量扫描的结果。应用本身不需要这个操作
// （索引库损坏时整个文件删掉重建），所以只放在测试里。
async function rebuildIndex(ctx) {
  ctx.db.raw.exec('DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM tags; DELETE FROM links; DELETE FROM tasks;');
  return ctx.indexer.scan({ force: true, kind: 'full' });
}

test('首次扫描把笔记、标签、双链一并建进索引', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'diary/2026-08-06.md', {
      data: { title: '今天', tags: ['日记', '计量'] },
      body: '读了 [[reading/econ/ch03]] 的工具变量部分。'
    });
    await writeNote(ctx.vaultDir, 'reading/econ/ch03.md', {
      data: { title: '第三章 工具变量' },
      body: '计量经济学的核心识别策略。'
    });

    const stats = await ctx.indexer.scan();
    assert.equal(stats.added, 2);
    assert.equal(ctx.db.countNotes(), 2);

    assert.deepEqual(
      ctx.db.raw.prepare(`SELECT tag FROM tags WHERE path = ? ORDER BY tag`).all('diary/2026-08-06.md').map(r => r.tag),
      ['日记', '计量']
    );

    const links = ctx.db.outboundLinks('diary/2026-08-06.md');
    assert.equal(links.length, 1);
    assert.equal(links[0].path, 'reading/econ/ch03.md', 'wikilink 应解析到真实笔记');

    const backlinks = ctx.db.backlinks('reading/econ/ch03.md');
    assert.equal(backlinks.length, 1);
    assert.equal(backlinks[0].path, 'diary/2026-08-06.md');
  } finally {
    await ctx.cleanup();
  }
});

test('坏 frontmatter 不阻断后续文件，并保留上一份可用索引', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '旧内容' });
    await writeNote(ctx.vaultDir, 'z.md', { body: '后续文件' });
    await ctx.indexer.scan();

    await fs.writeFile(path.join(ctx.vaultDir, 'a.md'), '---\ntags: [没有闭合\n---\n坏内容');
    await writeNote(ctx.vaultDir, 'later.md', { body: '仍应入库' });
    const stats = await ctx.indexer.scan({ force: true });

    assert.equal(stats.phase, 'degraded');
    assert.equal(stats.failureTotal, 1);
    assert.equal(ctx.db.getNote('a.md').body_raw.trim(), '旧内容');
    assert.equal(ctx.db.getNote('later.md').body_raw.trim(), '仍应入库');
    const status = ctx.indexer.getStatus();
    assert.deepEqual(status.failures, [{
      path: 'a.md', code: 'invalid-frontmatter', reason: '属性区（frontmatter）格式有误，点路径打开后修复', retryable: true
    }]);

    await writeNote(ctx.vaultDir, 'a.md', { body: '修好了' });
    const retried = await ctx.indexer.retry();
    assert.equal(retried.phase, 'ready');
    assert.equal(ctx.indexer.getStatus().failureTotal, 0);
    assert.equal(ctx.db.getNote('a.md').body_raw.trim(), '修好了');
  } finally {
    await ctx.cleanup();
  }
});

test('读取权限错误只降级对应路径，增量成功只清自身失败', async () => {
  let denied = new Set(['a.md', 'b.md']);
  const ctx = await setup({
    readOpenedFile: async (handle, relativePath) => {
      if (denied.has(relativePath)) {
        const error = new Error('private absolute diagnostic');
        error.code = 'EACCES';
        throw error;
      }
      return handle.readFile('utf8');
    }
  });
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '甲' });
    await writeNote(ctx.vaultDir, 'b.md', { body: '乙' });
    await writeNote(ctx.vaultDir, 'c.md', { body: '丙' });
    await ctx.indexer.scan();
    assert.equal(ctx.indexer.getStatus().failureTotal, 2);
    assert.equal(ctx.db.getNote('c.md').title_raw, 'c');

    denied = new Set(['b.md']);
    await ctx.indexer.scan({ paths: ['a.md'] });
    assert.deepEqual(ctx.indexer.getStatus().failures.map(item => item.path), ['b.md']);

    denied = new Set();
    await ctx.indexer.scan({ force: true });
    assert.equal(ctx.indexer.getStatus().phase, 'ready');
  } finally {
    await ctx.cleanup();
  }
});

test('数据库失败进入 error，拒绝后同一队列仍可恢复', async () => {
  const ctx = await setup();
  const original = ctx.db.replaceNote;
  let fail = true;
  ctx.db.replaceNote = (...args) => {
    if (fail) throw new Error('database write failed');
    return original(...args);
  };
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '内容' });
    await assert.rejects(ctx.indexer.scan(), /database write failed/);
    assert.equal(ctx.indexer.getStatus().phase, 'error');
    assert.equal(ctx.indexer.getStatus().fatal.code, 'database-error');
    fail = false;
    const recovered = await ctx.indexer.retry();
    assert.equal(recovered.phase, 'ready');
    assert.equal(ctx.db.countNotes(), 1);
  } finally {
    await ctx.cleanup();
  }
});

test('retry 在队列中读取最新失败状态，不会被排队前的 ready 状态跳过', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '旧内容' });
    await ctx.indexer.scan();
    await fs.writeFile(path.join(ctx.vaultDir, 'a.md'), '---\ntags: [没有闭合\n---\n坏内容');

    const scan = ctx.indexer.scan({ force: true });
    const retry = ctx.indexer.retry();
    assert.equal((await scan).phase, 'degraded');
    const retried = await retry;

    assert.equal(retried.phase, 'degraded');
    assert.equal(retried.failureTotal, 1);
    assert.equal(ctx.indexer.getStatus().scanKind, 'retry');
    assert.equal(ctx.indexer.getStatus().generation, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('内容没变时走快路径，不重建 FTS', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '内容' });
    assert.equal((await ctx.indexer.scan()).added, 1);

    const second = await ctx.indexer.scan();
    assert.equal(second.unchanged, 1);
    assert.equal(second.updated, 0);
    assert.equal(second.added, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('周期对账时没变的笔记只 lstat，不逐个打开', async () => {
  let opens = 0;
  const fsp = require('node:fs/promises');
  const ctx = await setup({ fsOps: { open: (...args) => { opens += 1; return fsp.open(...args); } } });
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '甲' });
    await writeNote(ctx.vaultDir, 'b/c.md', { body: '乙' });
    await ctx.indexer.scan();
    assert.equal(opens, 2);

    opens = 0;
    const again = await ctx.indexer.scan();
    assert.equal(again.unchanged, 2);
    assert.equal(opens, 0, '未变的文件不该被打开');

    await writeNote(ctx.vaultDir, 'a.md', { body: '甲改' });
    const changed = await ctx.indexer.scan();
    assert.equal(changed.updated, 1);
    assert.equal(opens, 1);

    // 强制重扫仍然逐个重读。
    opens = 0;
    await rebuildIndex(ctx);
    assert.equal(opens, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('mtime 变了但内容没变时只更新 mtime —— git pull 会刷新 mtime', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '内容' });
    await ctx.indexer.scan();
    const before = ctx.db.getNote('a.md');

    // 模拟 git checkout：内容一模一样，只是 mtime 被刷新。
    const filePath = path.join(ctx.vaultDir, 'a.md');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(filePath, future, future);

    const stats = await ctx.indexer.scan();
    assert.equal(stats.unchanged, 1, '内容没变就不该算作更新');
    assert.equal(stats.updated, 0);

    const after = ctx.db.getNote('a.md');
    assert.equal(after.hash, before.hash);
    assert.ok(after.mtime_ms > before.mtime_ms, 'mtime 应被更新，避免每次扫描都重读');
  } finally {
    await ctx.cleanup();
  }
});

test('删掉笔记后索引同步移除，指向它的链接退回待建状态', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '看 [[b]]' });
    await writeNote(ctx.vaultDir, 'b.md', { body: '被指向' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.outboundLinks('a.md')[0].path, 'b.md');

    await deleteNote(ctx.vaultDir, 'b.md');
    const stats = await ctx.indexer.scan();
    assert.equal(stats.removed, 1);
    assert.equal(ctx.db.countNotes(), 1);

    const links = ctx.db.outboundLinks('a.md');
    assert.equal(links.length, 1, '链接本身还在');
    assert.equal(links[0].path, '', '但解析结果应清空，变回待建');
  } finally {
    await ctx.cleanup();
  }
});

test('新写一篇笔记，之前指向它的待建链接自动变成有效链接', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '将来会写 [[future]]' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.outboundLinks('a.md')[0].path, '', '目标还不存在');

    await writeNote(ctx.vaultDir, 'future.md', { body: '写好了' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.outboundLinks('a.md')[0].path, 'future.md', '应自动解析');
  } finally {
    await ctx.cleanup();
  }
});

// 这是整个架构最核心的一条约束：SQLite 是纯派生物。
// 删掉它从 Markdown 重建，结果必须与一路增量更新完全一致。
// 它同时支撑了三件事：git 同步不冲突、应用拉取后可重建、换机器零迁移。
test('删掉索引库全量重建，结果与增量更新完全一致', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'diary/2026-08-06.md', {
      data: { tags: ['日记'] },
      body: '# 今天\n\n读了 [[reading/econ/ch03|第三章]]，也翻了 [[还没写的]]。'
    });
    await writeNote(ctx.vaultDir, 'reading/econ/ch03.md', {
      data: { title: '第三章', tags: ['计量', '教材'] },
      body: '工具变量与两阶段最小二乘。'
    });
    await ctx.indexer.scan();

    // 走一遍典型的增量路径：改一篇、加一篇、删一篇。
    await writeNote(ctx.vaultDir, 'diary/2026-08-06.md', {
      data: { tags: ['日记', '计量'] },
      body: '# 今天\n\n改过的内容，仍然链到 [[reading/econ/ch03]]。'
    });
    await writeNote(ctx.vaultDir, 'research/idea.md', { body: '新想法，参考 [[reading/econ/ch03]]。' });
    await writeNote(ctx.vaultDir, 'tmp.md', { body: '临时' });
    await ctx.indexer.scan();
    await deleteNote(ctx.vaultDir, 'tmp.md');
    await ctx.indexer.scan();

    const incremental = snapshot(ctx.db);

    await rebuildIndex(ctx);
    const rebuilt = snapshot(ctx.db);

    assert.deepEqual(rebuilt.notes, incremental.notes, 'notes 表应一致');
    assert.deepEqual(rebuilt.tags, incremental.tags, 'tags 表应一致');
    assert.deepEqual(rebuilt.links, incremental.links, 'links 表应一致');
    assert.deepEqual(rebuilt.tasks, incremental.tasks, 'tasks 表应一致');
    assert.deepEqual(rebuilt.fts, incremental.fts, 'FTS 索引应一致');
  } finally {
    await ctx.cleanup();
  }
});

test('从 v11 索引升级后，未改动的笔记也重算行内代码后的反向链接', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-index-upgrade-'));
  const vaultDir = path.join(dir, 'notes');
  const dbPath = path.join(dir, 'workstation.db');
  let db = openDatabase(dbPath);
  t.after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await fs.mkdir(vaultDir);
  await writeNote(vaultDir, 'source.md', { body: '```example```\n\n[[target]]' });
  await writeNote(vaultDir, 'target.md', { body: '# Target' });
  await createIndexer({ db, vaultDir }).scan();
  db.raw.exec('DELETE FROM links');
  db.raw.pragma('user_version = 11');
  db.close();
  db = openDatabase(dbPath);
  await createIndexer({ db, vaultDir }).scan({ kind: 'initial' });
  assert.deepEqual(db.backlinks('target.md').map(note => note.path), ['source.md']);
});

test('索引库文件损坏时删除重建，而不是让应用起不来', async () => {
  const { openDatabase } = require('../src/db');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-corrupt-db-'));
  const dbPath = path.join(dir, 'workstation.db');
  const warnings = [];
  try {
    await fs.writeFile(dbPath, 'not a sqlite database'.repeat(300));
    await fs.writeFile(`${dbPath}-wal`, 'garbage');
    const db = openDatabase(dbPath, { logger: { warn: message => warnings.push(message) } });
    try {
      assert.equal(db.countNotes(), 0);
      assert.equal(db.raw.pragma('user_version', { simple: true }) > 0, true);
    } finally {
      db.close();
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SQLITE_NOTADB/);

    // 打不开之类不是损坏的错误照常抛出，也不能拿来当删除理由。
    const blocked = path.join(dir, 'directory.db');
    await fs.mkdir(blocked);
    assert.throws(() => openDatabase(blocked, { logger: { warn() {} } }), error => error.code !== 'SQLITE_NOTADB');
    assert.equal((await fs.stat(blocked)).isDirectory(), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('打开后才暴露的页损坏留下标记，下次启动时重建', async () => {
  const { openDatabase, isCorruption } = require('../src/db');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-corrupt-page-'));
  const dbPath = path.join(dir, 'workstation.db');
  const quiet = { warn() {} };
  try {
    assert.equal(isCorruption({ code: 'SQLITE_CORRUPT_INDEX' }), true);
    assert.equal(isCorruption({ code: 'SQLITE_BUSY' }), false);

    const first = openDatabase(dbPath, { logger: quiet });
    const indexer = createIndexer({ db: first, vaultDir: dir });
    // 模拟查询时才报出的损坏。
    first.listIndexed = () => { throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }); };
    await assert.rejects(indexer.scan());
    const status = indexer.getStatus();
    assert.equal(status.fatal.code, 'database-corrupt');
    assert.equal(status.fatal.retryable, false);
    first.raw.prepare(`INSERT INTO notes (path, hash, indexed_at) VALUES ('stale.md', 'h', 'now')`).run();
    first.close();
    await fs.access(`${dbPath}-corrupt`);

    const warnings = [];
    const second = openDatabase(dbPath, { logger: { warn: message => warnings.push(message) } });
    try {
      assert.equal(second.countNotes(), 0, '重启后是一份新库');
    } finally {
      second.close();
    }
    assert.match(warnings[0], /上次运行发现索引库损坏/);
    await assert.rejects(fs.access(`${dbPath}-corrupt`));

    // 不是损坏的错误不留标记。
    const third = openDatabase(dbPath, { logger: quiet });
    try {
      assert.equal(third.reportError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })), false);
    } finally {
      third.close();
    }
    await assert.rejects(fs.access(`${dbPath}-corrupt`));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('全量重建会清掉已删除笔记留下的任务', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'old.md', { body: '- [ ] 已删除的任务 @2026-08-10' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.raw.prepare('SELECT count(*) AS count FROM tasks').get().count, 1);

    await deleteNote(ctx.vaultDir, 'old.md');
    await rebuildIndex(ctx);
    assert.equal(ctx.db.raw.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('并发扫描按调用顺序执行，最终索引反映最新文件', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '版本一' });
    const first = ctx.indexer.scan();
    await writeNote(ctx.vaultDir, 'a.md', { body: '版本二' });
    const second = ctx.indexer.scan({ force: true });
    await Promise.all([first, second]);

    assert.equal(ctx.db.getNote('a.md').body_raw.trim(), '版本二');
  } finally {
    await ctx.cleanup();
  }
});

test('中文检索：FTS5 命中的走 FTS5，分词对不上的走 LIKE 兜底', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'reading/econ/ch03.md', {
      data: { title: '第三章' },
      body: '计量经济学的工具变量方法，教材第45页。今天读了平台定价的文献。'
    });
    await ctx.indexer.scan();

    for (const query of ['教材', '计量', '工具变量', '平台定价', '定价']) {
      const result = ctx.search.search(query);
      assert.equal(result.results.length, 1, `「${query}」应搜到`);
      assert.equal(result.results[0].via, 'fts', `「${query}」应由 FTS5 命中`);
    }

    // 分词把「计量经济学」切成「计量 / 经济 / 学的」，查「经济学」FTS5 命中不了，
    // 但原文确实包含它 —— 这正是 LIKE 兜底存在的理由。
    const fallback = ctx.search.search('经济学');
    assert.equal(fallback.results.length, 1, '「经济学」必须能搜到');
    assert.equal(fallback.results[0].via, 'like', '应由 LIKE 兜底命中');
    assert.equal(fallback.usedFallback, true);
  } finally {
    await ctx.cleanup();
  }
});

// 标签写在 frontmatter 里，解析后就不在正文中了。不特意并进索引的话，
// 一篇 tags: [教材] 的笔记搜「教材」会一无所获 —— 而在搜索框里打标签名
// 本来就是最自然的用法。
test('标签本身可以被全文搜到，不必用标签过滤器', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'reading/ch03.md', {
      data: { title: '第三章', tags: ['教材', '计量'] },
      body: '两阶段最小二乘。'
    });
    await ctx.indexer.scan();

    for (const query of ['教材', '计量']) {
      const result = ctx.search.search(query);
      assert.equal(result.results.length, 1, `搜标签「${query}」应命中`);
      assert.equal(result.results[0].path, 'reading/ch03.md');
    }

    // 正文里的词照常能搜到，没有被这个改动影响。
    assert.equal(ctx.search.search('两阶段').results.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('搜索支持按分区和标签过滤', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'diary/a.md', { data: { tags: ['日记'] }, body: '工具变量' });
    await writeNote(ctx.vaultDir, 'reading/b.md', { data: { tags: ['教材'] }, body: '工具变量' });
    await ctx.indexer.scan();

    assert.equal(ctx.search.search('工具变量').results.length, 2);
    assert.equal(ctx.search.search('工具变量', { section: 'diary' }).results.length, 1);
    assert.equal(ctx.search.search('工具变量', { tag: '教材' }).results[0].path, 'reading/b.md');
  } finally {
    await ctx.cleanup();
  }
});

test('escapeLike 转义 SQLite 的 LIKE 通配符', () => {
  assert.equal(escapeLike('100%'), '100\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('c:\\dir'), 'c:\\\\dir');
  assert.equal(escapeLike('普通文本'), '普通文本');
});

test('纯通配符查询只匹配含该字面量的笔记，不匹配全部', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '覆盖率 100% 达成' });
    await writeNote(ctx.vaultDir, 'b.md', { body: '完全没有那个符号' });
    await ctx.indexer.scan();

    // 「%」里没有任何可分词的 token，所以 FTS5 整条路被跳过，只剩 LIKE。
    // 不转义的话 LIKE '%%%' 会匹配到每一篇。
    const results = ctx.search.search('%').results.map(r => r.path);
    assert.deepEqual(results, ['a.md'], '% 应作为字面量而非通配符');
  } finally {
    await ctx.cleanup();
  }
});

test('FTS5 与 LIKE 的分工体现在 via 字段上', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '覆盖率 100% 达成' });
    await writeNote(ctx.vaultDir, 'b.md', { body: '覆盖率 100 次尝试' });
    await ctx.indexer.scan();

    // 「100%」分词后是 token「100」，两篇都含它 —— 这是全文检索的正常召回，
    // 不是 bug。via 字段让调用方能区分是 token 命中还是子串命中。
    const results = ctx.search.search('100%').results;
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.via === 'fts'));
  } finally {
    await ctx.cleanup();
  }
});

test('空查询返回空结果而不是全部笔记', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'a.md', { body: '内容' });
    await ctx.indexer.scan();
    assert.deepEqual(ctx.search.search('   ').results, []);
  } finally {
    await ctx.cleanup();
  }
});

// ——————————————————————————————————————————————————————————————
// 增量扫描
//
// 文件监听给到的是「哪几个路径变了」，所以扫描要能只看这几个。这里的核心约束
// 和全量重建那条是同一个：**增量走一遍的结果，必须和从零全量扫出来的一模一样**。
// 两条路径分叉的话，用户会看到搜索结果里有幽灵笔记或漏掉的笔记，而且极难复现。
// ——————————————————————————————————————————————————————————————

/** 把同一个 vault 用全新的库全量扫一遍，作为对照。 */
async function fullRebuildSnapshot(vaultDir) {
  const db = openDatabase(':memory:');
  try {
    await createIndexer({ db, vaultDir }).scan();
    return snapshot(db);
  } finally {
    db.close();
  }
}

test('增量扫描的结果与全量重建一致：新增、修改、删除', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'research/甲.md', {
      data: { title: '甲', tags: ['计量'] },
      body: '内生性问题。参见 [[research/乙]]。\n\n- [ ] 复读一遍'
    });
    await writeNote(ctx.vaultDir, 'research/丙.md', { data: { title: '丙' }, body: '断点回归。' });
    await ctx.indexer.scan();

    // 模拟外部编辑器的三种动作
    await writeNote(ctx.vaultDir, 'research/乙.md', { data: { title: '乙' }, body: '工具变量。' });
    await writeNote(ctx.vaultDir, 'research/甲.md', {
      data: { title: '甲', tags: ['计量', '因果'] },
      body: '内生性问题改过了。参见 [[research/乙]]。'
    });
    await deleteNote(ctx.vaultDir, 'research/丙.md');

    await ctx.indexer.scan({ paths: ['research/乙.md', 'research/甲.md', 'research/丙.md'] });

    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('Windows 普通删除不列目录或重读其他笔记', async () => {
  let reads = 0, listings = 0;
  const ctx = await setup({
    platform: 'win32',
    readOpenedFile: handle => { reads += 1; return handle.readFile('utf8'); },
    listNotesFn: dir => { listings += 1; return listNotes(dir); }
  });
  try {
    for (let i = 0; i < 100; i += 1) {
      await writeNote(ctx.vaultDir, 'note-' + i + '.md', { body: '# Note ' + i + '\n\n- [ ] Task\n' });
    }
    await ctx.indexer.scan();
    reads = 0; listings = 0;
    await fs.unlink(path.join(ctx.vaultDir, 'note-0.md'));
    const result = await ctx.indexer.scan({ paths: ['note-0.md'] });
    assert.equal(result.removed, 1);
    assert.equal(reads, 0);
    assert.equal(listings, 0);
    assert.equal(ctx.db.countNotes(), 99);
    assert.equal(ctx.db.listTasks({ includeDone: true }).length, 99);
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally { await ctx.cleanup(); }
});

test('Windows 删除大小写别名清理旧索引，不重读无关笔记', async () => {
  const reads = [];
  const ctx = await setup({
    platform: 'win32',
    readOpenedFile: (handle, relativePath) => { reads.push(relativePath); return handle.readFile('utf8'); }
  });
  try {
    await writeNote(ctx.vaultDir, 'English.md', { body: '# English\n\n- [ ] Task\n' });
    await writeNote(ctx.vaultDir, 'other.md', { body: '# Other\n' });
    await ctx.indexer.scan();
    reads.length = 0;
    await fs.unlink(path.join(ctx.vaultDir, 'English.md'));
    const result = await ctx.indexer.scan({ paths: ['ENGLISH.md'] });
    assert.equal(result.removed, 1);
    assert.deepEqual(reads, []);
    assert.ok(!ctx.db.getNote('English.md'));
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally { await ctx.cleanup(); }
});

test('Windows 大小写对账只强制读取本批路径，正文大小和时间未变也更新', async () => {
  const reads = [];
  let canonicalRoot;
  const ctx = await setup({
    platform: 'win32',
    fsOps: { realpath: async absolute => absolute.endsWith(path.sep + 'ENGLISH.md')
      ? path.join(canonicalRoot, 'English.md') : fs.realpath(absolute) },
    readOpenedFile: (handle, relativePath) => { reads.push(relativePath); return handle.readFile('utf8'); }
  });
  try {
    canonicalRoot = await fs.realpath(ctx.vaultDir);
    await writeNote(ctx.vaultDir, 'English.md', { body: '# Before\n' });
    await writeNote(ctx.vaultDir, 'other.md', { body: '# Other\n' });
    await ctx.indexer.scan();
    const original = await fs.stat(path.join(ctx.vaultDir, 'English.md'));
    await fs.writeFile(path.join(ctx.vaultDir, 'English.md'), '# After!\n');
    await fs.utimes(path.join(ctx.vaultDir, 'English.md'), original.atime, original.mtime);
    reads.length = 0;
    await ctx.indexer.scan({ paths: ['ENGLISH.md'] });
    assert.deepEqual(reads, ['English.md']);
    assert.match(ctx.db.getNote('English.md').body_raw, /After!/);
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally { await ctx.cleanup(); }
});

test('Windows 大小写对账保留无关笔记的读取失败状态', async () => {
  let denyRead = false;
  let canonicalRoot;
  const ctx = await setup({
    platform: 'win32',
    fsOps: { realpath: async absolute => absolute.endsWith(path.sep + 'ENGLISH.md')
      ? path.join(canonicalRoot, 'English.md') : fs.realpath(absolute) },
    readOpenedFile: (handle, relativePath) => {
      if (denyRead && relativePath === 'other.md') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return handle.readFile('utf8');
    }
  });
  try {
    canonicalRoot = await fs.realpath(ctx.vaultDir);
    await writeNote(ctx.vaultDir, 'English.md', { body: '# English' });
    await writeNote(ctx.vaultDir, 'other.md', { body: '# Other' });
    await ctx.indexer.scan();
    denyRead = true;
    await ctx.indexer.scan({ paths: ['other.md'] });
    assert.equal(ctx.indexer.getStatus().phase, 'degraded');
    await ctx.indexer.scan({ paths: ['ENGLISH.md'] });
    assert.equal(ctx.indexer.getStatus().phase, 'degraded');
    assert.equal(ctx.indexer.getStatus().failureTotal, 1);
    assert.equal(ctx.indexer.getStatus().failures[0].path, 'other.md');
    assert.ok(ctx.db.getNote('other.md'));
  } finally { await ctx.cleanup(); }
});

test('Windows 增量扫描统一大小写别名，并清除旧版本留下的重复索引', { skip: process.platform !== 'win32' }, async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'Folder/English.md', { body: '# English\n\n- [ ] One task\n' });
    await ctx.indexer.scan();
    await ctx.indexer.scan({ paths: ['folder/english.MD', 'FOLDER/ENGLISH.md'] });
    assert.equal(ctx.db.countNotes(), 1);
    assert.equal(ctx.db.listTasks({ includeDone: true }).length, 1);
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));

    // 模拟旧版遗留的大小写重复行，规范拼写事件也应该对账清除它。
    ctx.db.raw.exec(`
      INSERT INTO notes SELECT 'folder/english.md', section, title_raw, body_raw, data_json, hash, size, mtime_ms, indexed_at FROM notes;
      INSERT INTO notes_fts SELECT 'folder/english.md', title, body FROM notes_fts;
      INSERT INTO tasks SELECT 'folder/english.md', line, done, title, due FROM tasks;
    `);
    assert.equal(ctx.db.countNotes(), 2);
    assert.equal(ctx.db.listTasks({ includeDone: true }).length, 2);
    await ctx.indexer.scan({ paths: ['Folder/English.md'] });
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('Windows 大小写改名、普通改名与别名删除和全量重建一致', { skip: process.platform !== 'win32' }, async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'Folder/English.md', { body: '# English\n\n- [ ] One task\n' });
    await ctx.indexer.scan();
    await fs.rename(path.join(ctx.vaultDir, 'Folder', 'English.md'), path.join(ctx.vaultDir, 'Folder', 'ENGLISH.md'));
    await ctx.indexer.scan({ paths: ['Folder/ENGLISH.md'] });
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
    await fs.rename(path.join(ctx.vaultDir, 'Folder', 'ENGLISH.md'), path.join(ctx.vaultDir, 'Folder', 'Renamed.md'));
    await ctx.indexer.scan({ paths: ['folder/english.md', 'folder/renamed.md'] });
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
    await fs.unlink(path.join(ctx.vaultDir, 'Folder', 'Renamed.md'));
    await ctx.indexer.scan({ paths: ['FOLDER/RENAMED.MD'] });
    assert.equal(ctx.db.countNotes(), 0);
    assert.equal(ctx.db.listTasks({ includeDone: true }).length, 0);
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('大小写敏感文件系统上的两篇不同笔记不会被合并', async t => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'A.md'), '# Upper\n');
    await fs.writeFile(path.join(ctx.vaultDir, 'a.md'), '# Lower\n');
    if ((await fs.readdir(ctx.vaultDir)).filter(name => /^[Aa]\.md$/.test(name)).length !== 2) {
      t.skip('当前文件系统不区分大小写');
      return;
    }
    await ctx.indexer.scan({ paths: ['A.md', 'a.md'] });
    assert.equal(ctx.db.countNotes(), 2);
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('增量新增笔记会让指向它的「待建链接」接上', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'research/甲.md', { data: { title: '甲' }, body: '见 [[research/乙]]。' });
    await ctx.indexer.scan();

    const before = ctx.db.raw.prepare(`SELECT to_path FROM links WHERE from_path = ?`).get('research/甲.md');
    assert.equal(before.to_path, '', '乙还没写，应该是待建状态');

    // 只告诉扫描器「乙出现了」，甲没被提及
    await writeNote(ctx.vaultDir, 'research/乙.md', { data: { title: '乙' }, body: '正文。' });
    await ctx.indexer.scan({ paths: ['research/乙.md'] });

    const after = ctx.db.raw.prepare(`SELECT to_path FROM links WHERE from_path = ?`).get('research/甲.md');
    assert.equal(after.to_path, 'research/乙.md', '新增笔记必须让别处的待建链接重新解析');
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('增量删除笔记会让指向它的链接退回待建', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'research/甲.md', { data: { title: '甲' }, body: '见 [[research/乙]]。' });
    await writeNote(ctx.vaultDir, 'research/乙.md', { data: { title: '乙' }, body: '正文。' });
    await ctx.indexer.scan();

    await deleteNote(ctx.vaultDir, 'research/乙.md');
    await ctx.indexer.scan({ paths: ['research/乙.md'] });

    const after = ctx.db.raw.prepare(`SELECT to_path FROM links WHERE from_path = ?`).get('research/甲.md');
    assert.equal(after.to_path, '', '被指向的笔记删掉后，链接应退回待建而不是消失');
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('增量扫描忽略非 .md、越界路径和点号目录', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'research/甲.md', { data: { title: '甲' }, body: '正文。' });
    await ctx.indexer.scan();
    const before = snapshot(ctx.db);

    // 这些路径都不该进索引：全量扫描同样会跳过它们，两边必须一致
    await fs.mkdir(path.join(ctx.vaultDir, '.trash'), { recursive: true });
    await fs.writeFile(path.join(ctx.vaultDir, '.trash', '偷渡.md'), '# 不该被索引');
    await fs.writeFile(path.join(ctx.vaultDir, 'note.txt'), '不是 markdown');

    await ctx.indexer.scan({
      paths: ['.trash/偷渡.md', 'note.txt', '../外面.md', '/绝对路径.md', 'C:\\盘符.md', '']
    });

    assert.deepEqual(snapshot(ctx.db), before, '这些路径一个都不该改变索引');
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
  }
});

test('增量扫描不跟随符号链接，和全量扫描保持一致', async t => {
  const ctx = await setup();
  try {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-outside-'));
    await fs.writeFile(path.join(outside, '外部.md'), '---\ntitle: 外部\n---\n\nvault 之外的内容。');

    try {
      await fs.symlink(path.join(outside, '外部.md'), path.join(ctx.vaultDir, '链接.md'));
    } catch {
      // Windows 上没有开发者模式就建不了符号链接，跳过即可。
      t.skip('当前环境不允许创建符号链接');
      return;
    }

    await ctx.indexer.scan({ paths: ['链接.md'] });
    assert.equal(ctx.db.countNotes(), 0, '符号链接不该被索引');
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));

    await fs.rm(outside, { recursive: true, force: true });
  } finally {
    await ctx.cleanup();
  }
});

test('已有笔记被替换为符号链接时增量扫描移除旧索引', async t => {
  const ctx = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-outside-'));
  try {
    await writeNote(ctx.vaultDir, 'source.md', { body: '链接到 [[target]]' });
    await writeNote(ctx.vaultDir, 'target.md', { body: '原内容' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.countNotes(), 2);

    const target = path.join(ctx.vaultDir, 'target.md');
    await fs.rm(target);
    await fs.writeFile(path.join(outside, 'target.md'), '# 外部内容');
    try {
      await fs.symlink(path.join(outside, 'target.md'), target);
    } catch {
      t.skip('当前环境不允许创建符号链接');
      return;
    }

    const result = await ctx.indexer.scan({ paths: ['target.md'] });
    assert.equal(result.removed, 1);
    assert.equal(ctx.db.getNote('target.md'), undefined);
    assert.equal(ctx.db.raw.prepare('SELECT to_path FROM links WHERE from_path = ?').get('source.md').to_path, '');
    assert.deepEqual(snapshot(ctx.db), await fullRebuildSnapshot(ctx.vaultDir));
  } finally {
    await ctx.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('注入的 symlink 判定也会移除旧索引并重解析链接', async () => {
  let targetIsSymlink = false;
  const ctx = await setup({
    fsOps: {
      lstat: async (target, options) => {
        if (targetIsSymlink && path.basename(target) === 'target.md') {
          return { isSymbolicLink: () => true };
        }
        return fs.lstat(target, options);
      }
    }
  });
  try {
    await writeNote(ctx.vaultDir, 'source.md', { body: '链接到 [[target]]' });
    await writeNote(ctx.vaultDir, 'target.md', { body: '原内容' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.raw.prepare('SELECT to_path FROM links WHERE from_path = ?').get('source.md').to_path, 'target.md');

    await fs.rm(path.join(ctx.vaultDir, 'target.md'));
    targetIsSymlink = true;
    const result = await ctx.indexer.scan({ paths: ['target.md'] });

    assert.equal(result.removed, 1);
    assert.equal(ctx.db.getNote('target.md'), undefined);
    assert.equal(ctx.db.raw.prepare('SELECT to_path FROM links WHERE from_path = ?').get('source.md').to_path, '');
  } finally {
    await ctx.cleanup();
  }
});

test('全扫列举后路径变成 symlink 时移除旧索引且不读取目标', async () => {
  let ineligible = false;
  let openedTarget = false;
  const ctx = await setup({
    listNotesFn: async vaultDir => {
      const notes = await listNotes(vaultDir);
      ineligible = true;
      return notes;
    },
    fsOps: {
      lstat: async (target, options) => {
        const stats = await fs.lstat(target, options);
        if (ineligible && path.basename(target) === 'target.md') {
          return new Proxy(stats, {
            get(value, key) {
              if (key === 'isSymbolicLink') return () => true;
              const member = Reflect.get(value, key, value);
              return typeof member === 'function' ? member.bind(value) : member;
            }
          });
        }
        return stats;
      },
      open: async (...args) => {
        if (path.basename(args[0]) === 'target.md') openedTarget = true;
        return fs.open(...args);
      }
    }
  });
  try {
    await writeNote(ctx.vaultDir, 'source.md', { body: '链接到 [[target]]' });
    await writeNote(ctx.vaultDir, 'target.md', { body: '原内容' });
    ineligible = false;
    await ctx.indexer.scan({ paths: ['source.md', 'target.md'] });
    assert.equal(ctx.db.countNotes(), 2);

    ineligible = false;
    openedTarget = false;
    const result = await ctx.indexer.scan({ force: true });

    assert.equal(result.removed, 1);
    assert.equal(openedTarget, false);
    assert.equal(ctx.db.getNote('target.md'), undefined);
    assert.equal(ctx.db.raw.prepare('SELECT to_path FROM links WHERE from_path = ?').get('source.md').to_path, '');
  } finally {
    await ctx.cleanup();
  }
});

test('全扫读取后路径身份改变时不提交外部内容并移除旧索引', async () => {
  let replaceAfterRead = false;
  let identityChanged = false;
  const ctx = await setup({
    readOpenedFile: async (handle, relativePath) => {
      const raw = await handle.readFile('utf8');
      if (replaceAfterRead && relativePath === 'target.md') identityChanged = true;
      return raw;
    },
    fsOps: {
      lstat: async (target, options) => {
        const stats = await fs.lstat(target, options);
        if (identityChanged && path.basename(target) === 'target.md') {
          return new Proxy(stats, {
            get(value, key) {
              if (key === 'ino') return value.ino + 1n;
              const member = Reflect.get(value, key, value);
              return typeof member === 'function' ? member.bind(value) : member;
            }
          });
        }
        return stats;
      }
    }
  });
  try {
    await writeNote(ctx.vaultDir, 'target.md', { body: '上一份可用内容' });
    await ctx.indexer.scan();
    await writeNote(ctx.vaultDir, 'target.md', { body: '竞态中的新内容' });

    replaceAfterRead = true;
    const result = await ctx.indexer.scan({ force: true });

    assert.equal(result.removed, 1);
    assert.equal(ctx.db.getNote('target.md'), undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('增量扫描不依赖 mtime 和大小判断变更', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.vaultDir, 'research/甲.md', { data: { title: '甲' }, body: '正文甲。' });
    await ctx.indexer.scan();

    const target = path.join(ctx.vaultDir, 'research', '甲.md');
    const before = await fs.stat(target);
    const raw = await fs.readFile(target, 'utf8');
    await fs.writeFile(target, raw.replace('正文甲', '正文乙'));
    await fs.utimes(target, before.atime, before.mtime);

    const changed = await ctx.indexer.scan({ paths: ['research/甲.md'] });
    assert.equal(changed.updated, 1, '监听已报告变更时必须重读文件');
    assert.match(ctx.db.getNote('research/甲.md').body_raw, /正文乙/);

    const unchanged = await ctx.indexer.scan({ paths: ['research/甲.md'] });
    assert.equal(unchanged.unchanged, 1);
    assert.equal(unchanged.updated, 0, '内容 hash 没变就不该重建派生行');
  } finally {
    await ctx.cleanup();
  }
});

test('Windows 删除未入库失败文件的大小写别名会立即清除旧错误', async () => {
  const reads = [];
  const ctx = await setup({
    platform: 'win32',
    readOpenedFile: (handle, relativePath) => { reads.push(relativePath); return handle.readFile('utf8'); }
  });
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'Broken.md'), '---\ntags: [broken\n---\ncontent');
    await writeNote(ctx.vaultDir, 'other.md', { body: '# Other\n' });
    await ctx.indexer.scan();
    assert.equal(ctx.indexer.getStatus().failureTotal, 1);
    assert.equal(ctx.db.getNote('Broken.md'), undefined);
    reads.length = 0;
    await fs.unlink(path.join(ctx.vaultDir, 'Broken.md'));
    const result = await ctx.indexer.scan({ paths: ['BROKEN.md'] });
    assert.equal(result.phase, 'ready');
    assert.equal(result.failureTotal, 0);
    assert.deepEqual(ctx.indexer.getStatus().failures, []);
    assert.deepEqual(reads, [], '删除错误记录不重读无关笔记');
    assert.equal(ctx.db.countNotes(), 1);
  } finally { await ctx.cleanup(); }
});
