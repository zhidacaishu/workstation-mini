const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const request = require('supertest');

const zotero = require('../src/integrations/zotero');
const { normalizePaper, createJournalTracker, normalizeHttpUrl } = require('../src/integrations/journalTracker');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { parseManagedAnnotations, renderLiteratureNote } = require('../src/annotations');
const { readNote, writeNote } = require('../src/vault/note');
const { enqueueNote } = require('../src/vault/note-queue');

const FIXED_NOW = new Date(2026, 2, 17, 9, 0);

/**
 * 造一个结构与 Zotero 一致的数据库。
 *
 * 这台机器上没有 Zotero，但 sqlite 读取路径是真代码 —— 用合成库把它跑通，
 * 比留着「等有 Zotero 再说」强。schema 版本、表关联、只读打开都照真实结构来。
 */
async function makeZoteroVault({ schemaVersion = 130 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-zotero-'));
  const db = new Database(path.join(dir, 'zotero.sqlite'));

  db.exec(`
    CREATE TABLE version (schema TEXT PRIMARY KEY, version INT NOT NULL);
    CREATE TABLE libraries (
      libraryID INTEGER PRIMARY KEY, type TEXT NOT NULL, editable INT NOT NULL, filesEditable INT NOT NULL
    );
    CREATE TABLE groups (
      groupID INTEGER PRIMARY KEY, libraryID INT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL, version INT NOT NULL
    );
    CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INT NOT NULL, key TEXT);
    CREATE TABLE itemAttachments (
      itemID INTEGER PRIMARY KEY,
      parentItemID INT,
      path TEXT,
      contentType TEXT,
      linkMode INT
    );
    CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);
    CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
    CREATE TABLE itemAnnotations (
      itemID INTEGER PRIMARY KEY, parentItemID INT, type INT,
      text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT
    );
  `);
  db.prepare(`INSERT INTO version VALUES ('userdata', ?)`).run(schemaVersion);
  // 本机编号 1 是用户库，2 是一个群组库（服务端 groupID 4242），3 是订阅源。
  db.prepare(`INSERT INTO libraries VALUES (1, 'user', 1, 1), (2, 'group', 1, 1), (3, 'feed', 0, 0)`).run();
  db.prepare(`INSERT INTO groups VALUES (4242, 2, '课题组', '', 1)`).run();
  db.prepare(`INSERT INTO items VALUES (1, 1, 'ABCD1234')`).run();
  db.prepare(`INSERT INTO items VALUES (2, 1, 'PDF00001')`).run();
  db.prepare(`INSERT INTO items VALUES (3, 2, 'STAND001')`).run();
  db.prepare(`INSERT INTO items VALUES (4, 1, 'LINK0001')`).run();
  db.prepare(`INSERT INTO items VALUES (5, 1, 'DELETE01')`).run();
  db.prepare(`INSERT INTO items VALUES (90, 3, 'FEED0001')`).run();
  db.prepare(`INSERT INTO itemAttachments VALUES (2, 1, 'storage:paper.pdf', 'application/pdf', 0)`).run();
  db.prepare(`INSERT INTO itemAttachments VALUES (3, NULL, 'storage:standalone.pdf', 'application/pdf', 1)`).run();
  db.prepare(`INSERT INTO itemAttachments VALUES (4, 1, '/outside/linked.pdf', 'application/pdf', 2)`).run();
  db.prepare(`INSERT INTO itemAttachments VALUES (5, 1, 'storage:deleted.pdf', 'application/pdf', 0)`).run();
  db.prepare(`INSERT INTO itemAttachments VALUES (90, NULL, 'storage:feed.pdf', 'application/pdf', 0)`).run();
  db.prepare(`INSERT INTO deletedItems VALUES (5)`).run();
  db.prepare(`INSERT INTO fields VALUES (110, 'title')`).run();
  db.prepare(`INSERT INTO itemDataValues VALUES (500, '平台定价与卖家异质性')`).run();
  db.prepare(`INSERT INTO itemData VALUES (1, 110, 500)`).run();
  db.prepare(`INSERT INTO itemAnnotations VALUES (10, 2, 1, '识别策略依赖工具变量的外生性', '这里需要制度背景论证', '#ffd400', '12', '0001')`).run();
  db.prepare(`INSERT INTO itemAnnotations VALUES (11, 2, 1, '两阶段最小二乘', '', '#a28ae5', '15', '0002')`).run();
  // 手绘标注没有文字，不该出现在结果里
  db.prepare(`INSERT INTO itemAnnotations VALUES (12, 2, 3, '', '', '#5fb236', '16', '0003')`).run();
  db.close();
  await fs.mkdir(path.join(dir, 'storage', 'PDF00001'), { recursive: true });
  await fs.mkdir(path.join(dir, 'storage', 'STAND001'), { recursive: true });
  await fs.writeFile(path.join(dir, 'storage', 'PDF00001', 'paper.pdf'), '%PDF-1.7\nfixture\n');
  await fs.writeFile(path.join(dir, 'storage', 'STAND001', 'standalone.pdf'), '%PDF-1.7\nstandalone\n');
  return dir;
}

// ── Zotero ────────────────────────────────────────────

test('同一 Zotero 快照读出标注和 storage PDF 清单', async () => {
  const dir = await makeZoteroVault();
  try {
    const result = await zotero.readLibraryData(dir);
    assert.equal(result.available, true, result.reason);
    assert.deepEqual(result.attachments.map(attachment => ({
      libraryId: attachment.libraryId,
      attachmentKey: attachment.attachmentKey,
      parentKey: attachment.parentKey,
      storagePath: attachment.storagePath,
      linkMode: attachment.linkMode
    })), [
      {
        libraryId: 'user',
        attachmentKey: 'PDF00001',
        parentKey: 'ABCD1234',
        storagePath: 'storage:paper.pdf',
        linkMode: 0
      },
      {
        // 群组库用服务端的 groupID，不用本机编号 2；订阅源里的附件不纳入。
        libraryId: 'group-4242',
        attachmentKey: 'STAND001',
        parentKey: '',
        storagePath: 'storage:standalone.pdf',
        linkMode: 1
      }
    ]);
    const inspected = await zotero.inspectAttachmentPdf(dir, result.attachments[0]);
    assert.equal(inspected.available, true, inspected.reason);
    assert.equal(inspected.fileName, 'paper.pdf');
    assert.ok(inspected.size > 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('回收站里的 PDF 单独列出，不与彻底删除混为一谈', async () => {
  const dir = await makeZoteroVault();
  try {
    const result = await zotero.readLibraryData(dir);
    // 附件本身在回收站里
    assert.deepEqual(
      result.trashedAttachments.map(attachment => attachment.attachmentKey),
      ['DELETE01']
    );
    assert.ok(result.attachments.every(attachment => attachment.trashed === false));
    assert.ok(result.trashedAttachments.every(attachment => attachment.trashed === true));
    assert.ok(!result.attachments.some(attachment => attachment.attachmentKey === 'DELETE01'));

    // 父条目进回收站时，它下面的附件同样只是「在回收站」，不是消失了
    const db = new Database(path.join(dir, 'zotero.sqlite'));
    db.prepare(`INSERT INTO deletedItems VALUES (1)`).run();
    db.close();

    const after = await zotero.readLibraryData(dir);
    assert.deepEqual(
      after.trashedAttachments.map(attachment => attachment.attachmentKey).sort(),
      ['DELETE01', 'PDF00001']
    );
    assert.deepEqual(after.attachments.map(attachment => attachment.attachmentKey), ['STAND001']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Zotero 快照在同一次操作内复用，源库一变立刻作废', async () => {
  const dir = await makeZoteroVault();
  zotero.clearLibraryCache();
  try {
    // 直接数底层读库次数。只断言「两次返回值不是同一个数组」之类的东西，
    // 在完全没有缓存时也成立，等于什么都没测。
    let reads = 0;
    const counted = dataDir => {
      reads += 1;
      return zotero.readLibraryDataUncached(dataDir);
    };

    const first = await zotero.readLibraryData(dir, { read: counted });
    const second = await zotero.readLibraryData(dir, { read: counted });
    assert.equal(reads, 1, '同一次操作内的第二次读取应当复用快照');
    assert.equal(second.available, true);
    assert.equal(second.attachments.length, first.attachments.length);

    // 拿到的是各自的数组副本，谁就地改都污染不到缓存。
    assert.notEqual(first.attachments, second.attachments);
    second.attachments.length = 0;
    assert.equal((await zotero.readLibraryData(dir, { read: counted })).attachments.length, first.attachments.length);
    assert.equal(reads, 1);

    // readAt 是这份快照的时刻，对账要靠它判断自己的信息是不是比 manifest 旧。
    assert.ok(Number.isFinite(first.readAt));
    assert.equal(second.readAt, first.readAt, '复用的快照必须沿用原始读取时刻');

    const db = new Database(path.join(dir, 'zotero.sqlite'));
    db.prepare(`INSERT INTO items VALUES (6, 1, 'NEWPDF01')`).run();
    db.prepare(`INSERT INTO itemAttachments VALUES (6, NULL, 'storage:new.pdf', 'application/pdf', 0)`).run();
    db.close();

    const refreshed = await zotero.readLibraryData(dir, { read: counted });
    assert.equal(reads, 2, '源库改动之后必须重新读，不能继续用缓存');
    assert.ok(refreshed.attachments.some(attachment => attachment.attachmentKey === 'NEWPDF01'));
    assert.ok(refreshed.readAt >= first.readAt);
  } finally {
    zotero.clearLibraryCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WAL 里的改动同样让快照失效，读失败不进缓存', async () => {
  const dir = await makeZoteroVault();
  zotero.clearLibraryCache();
  try {
    let reads = 0;
    const counted = dataDir => {
      reads += 1;
      return zotero.readLibraryDataUncached(dataDir);
    };
    const source = path.join(dir, 'zotero.sqlite');

    // Zotero 自己就跑在 WAL 上：写入先落 -wal，主库的 size/mtime 可以一直不变。
    const writer = new Database(source);
    writer.pragma('journal_mode = WAL');
    await zotero.readLibraryData(dir, { read: counted });
    assert.equal(reads, 1);

    const before = await fs.stat(source);
    writer.prepare(`INSERT INTO items VALUES (7, 1, 'WALPDF01')`).run();
    writer.prepare(`INSERT INTO itemAttachments VALUES (7, NULL, 'storage:wal.pdf', 'application/pdf', 0)`).run();
    const after = await fs.stat(source);
    // 写进程还开着，改动全在 -wal 里 —— 只看主库的话签名根本不动。
    assert.equal(after.size, before.size);

    const refreshed = await zotero.readLibraryData(dir, { read: counted });
    assert.equal(reads, 2, '-wal 变了也必须重新读');
    assert.ok(refreshed.attachments.some(attachment => attachment.attachmentKey === 'WALPDF01'));
    writer.close();

    // 读不出来的结果不该被缓存 5 秒：Zotero 短暂锁库时界面不能一直说读不到。
    zotero.clearLibraryCache();
    let failures = 0;
    const failing = async () => {
      failures += 1;
      return { available: false, reason: '读取失败', items: [], attachments: [], trashedAttachments: [], readAt: Date.now() };
    };
    await zotero.readLibraryData(dir, { read: failing });
    await zotero.readLibraryData(dir, { read: failing });
    assert.equal(failures, 2, '失败结果不该进缓存');
  } finally {
    zotero.clearLibraryCache();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Zotero PDF 路径拒绝穿越、符号链接和非 PDF 内容', async () => {
  const dir = await makeZoteroVault();
  try {
    const base = {
      libraryId: 'user',
      attachmentKey: 'PDF00001',
      storagePath: 'storage:paper.pdf'
    };
    assert.throws(
      () => zotero.attachmentFileName({ ...base, storagePath: 'storage:../secret.pdf' }),
      /文件名无效/
    );
    assert.throws(
      () => zotero.attachmentFileName({ ...base, attachmentKey: '../escape' }),
      /附件标识无效/
    );

    await fs.writeFile(path.join(dir, 'storage', 'PDF00001', 'paper.pdf'), 'not a pdf');
    await assert.rejects(zotero.openAttachmentPdf(dir, base), /内容不是 PDF/);

    if (process.platform !== 'win32') {
      const outside = path.join(dir, 'outside.pdf');
      await fs.writeFile(outside, '%PDF-1.7\noutside\n');
      await fs.rm(path.join(dir, 'storage', 'PDF00001', 'paper.pdf'));
      await fs.symlink(outside, path.join(dir, 'storage', 'PDF00001', 'paper.pdf'));
      await assert.rejects(zotero.openAttachmentPdf(dir, base), /普通文件/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('从 zotero.sqlite 副本读出高亮与批注', async () => {
  const dir = await makeZoteroVault();
  try {
    const result = await zotero.readAnnotations(dir);
    assert.equal(result.available, true, result.reason);
    assert.equal(result.items.length, 1);

    const entry = result.items[0];
    assert.equal(entry.key, 'ABCD1234');
    assert.equal(entry.title, '平台定价与卖家异质性');
    assert.equal(entry.annotations.length, 2, '没有文字的手绘标注不该出现');
    assert.equal(entry.annotations[0].itemID, 10);
    assert.equal(entry.annotations[0].sortIndex, '0001');
    assert.equal(entry.annotations[0].text, '识别策略依赖工具变量的外生性');
    assert.equal(entry.annotations[0].comment, '这里需要制度背景论证');
    assert.equal(entry.annotations[0].page, '12');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// schema 变了却照旧读，会静默取出错误的标注 —— 比读不出来糟糕得多。
test('schema 版本超出已知区间时报错，而不是照旧假设去读', async () => {
  const dir = await makeZoteroVault({ schemaVersion: 999 });
  try {
    const result = await zotero.readAnnotations(dir);
    assert.equal(result.available, false);
    assert.match(result.reason, /schema 版本 999 不在已知区间/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WAL 中尚未 checkpoint 的已提交标注也能读到', async () => {
  const dir = await makeZoteroVault();
  const source = path.join(dir, 'zotero.sqlite');
  const writer = new Database(source);
  try {
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.prepare(`INSERT INTO itemAnnotations VALUES (13, 2, 1, '刚写进 WAL 的标注', '', '#ffd400', '18', '0004')`).run();

    const result = await zotero.readAnnotations(dir);
    assert.equal(result.available, true, result.reason);
    assert.ok(result.items[0].annotations.some(annotation => annotation.text === '刚写进 WAL 的标注'));
  } finally {
    writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('读的是副本，原库不被打开', async () => {
  const dir = await makeZoteroVault();
  try {
    const before = await fs.stat(path.join(dir, 'zotero.sqlite'));
    await zotero.readAnnotations(dir);
    const after = await fs.stat(path.join(dir, 'zotero.sqlite'));

    assert.equal(before.mtimeMs, after.mtimeMs, '原库不该被写');
    // Zotero 运行时原库是锁的，直接开会损坏数据；副本读完必须清掉。
    const leftovers = (await fs.readdir(os.tmpdir())).filter(n => n.startsWith('zotero-copy-'));
    assert.deepEqual(leftovers, [], '临时副本要清理干净');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('找不到 zotero.sqlite 时优雅降级', async () => {
  const result = await zotero.readAnnotations('/nonexistent/zotero');
  assert.equal(result.available, false);
  assert.match(result.reason, /找不到 zotero\.sqlite/);
});

test('Zotero 没开着时题录接口降级而不抛错', async () => {
  // 指向一个必然连不上的端口
  const result = await zotero.fetchItems({ base: 'http://127.0.0.1:1/api/users/0', timeoutMs: 300 });
  assert.equal(result.available, false);
  assert.match(result.reason, /连不上 Zotero 本地 API/);
});

test('题录归一化丢掉没有标题的条目', () => {
  assert.equal(zotero.normalizeItem({ data: { key: 'X' } }), null);
  const item = zotero.normalizeItem({
    data: {
      key: 'ABCD', title: '论文标题', itemType: 'journalArticle',
      date: '2024-06-01', publicationTitle: 'ISR', DOI: '10.1/x',
      creators: [{ lastName: 'Zha', firstName: 'Hongyi' }], tags: [{ tag: '平台' }]
    }
  });
  assert.equal(item.year, '2024');
  assert.deepEqual(item.creators, ['Zha, Hongyi']);
  assert.deepEqual(item.tags, ['平台']);
});

test('文献笔记把高亮和自己的批注分开呈现', () => {
  const markdown = zotero.renderLitNote({
    item: { key: 'ABCD', title: '平台定价', creators: ['Zha, Hongyi'], year: '2024', publication: 'ISR', tags: [] },
    annotations: [{ itemID: 10, text: '识别策略依赖外生性', comment: '需要制度背景', page: '12', sortIndex: '0001' }]
  });

  assert.match(markdown, /zotero: ABCD|zotero: "ABCD"/);
  assert.match(markdown, /ABCD:10/);
  assert.match(markdown, /> 识别策略依赖外生性/, '高亮用引用块');
  assert.match(markdown, /\n需要制度背景/, '自己的批注跟在下面，不混进引用块');
  assert.match(markdown, /（p\.12）/);
  assert.match(markdown, /## 我的想法/);
  assert.equal(zotero.litPath('ABCD/../x'), 'lit/ABCDx.md', '路径要被清洗');
});

// ── journal-tracker ───────────────────────────────────

test('未配置 journal-tracker 时降级', async () => {
  const tracker = createJournalTracker({ baseUrl: '', email: '', password: '' });
  assert.equal(tracker.configured(), false);
  const result = await tracker.papers();
  assert.equal(result.available, false);
  assert.match(result.reason, /应用设置中配置/);
});

test('连不上 journal-tracker 时降级而不抛错', async () => {
  const tracker = createJournalTracker({
    baseUrl: 'http://127.0.0.1:1', email: 'a@b.c', password: 'x', timeoutMs: 300
  });
  const result = await tracker.papers();
  assert.equal(result.available, false);
  assert.match(result.reason, /连接 journal-tracker 失败/);
});

test('论文字段归一，兼容几种常见键名', () => {
  assert.equal(normalizePaper({ title: '   ' }), null);
  const paper = normalizePaper({
    id: 7, title: '平台定价', journal_name: 'ISR', doi: '10.1/x',
    link: 'https://x', published_at: '2026-03-01T00:00:00Z', relevance_score: 0.87
  });
  assert.equal(paper.journal, 'ISR');
  assert.equal(paper.url, 'https://x');
  assert.equal(paper.date, '2026-03-01');
  assert.equal(paper.score, 0.87);
});

test('journal-tracker 只接受绝对 HTTP(S) 地址', () => {
  assert.equal(normalizeHttpUrl('https://tracker.example/paper'), 'https://tracker.example/paper');
  assert.equal(normalizeHttpUrl('http://tracker.local/paper'), 'http://tracker.local/paper');
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '//example.com/x', '/relative', 'not a url']) {
    assert.equal(normalizeHttpUrl(unsafe), '', `应拒绝 ${unsafe}`);
    assert.equal(normalizePaper({ title: '论文', url: unsafe }).url, '');
  }
  assert.equal(createJournalTracker({ baseUrl: 'javascript:alert(1)', email: 'a', password: 'b' }).configured(), false);
});

// ── HTTP ──────────────────────────────────────────────

async function setup({ readOnly = false, zoteroDataDir = '' } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-int-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly,
    zoteroDataDir,
    zoteroApi: 'http://127.0.0.1:1/api/users/0'
  });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, { db, indexer, search, now: () => FIXED_NOW });
  return {
    app, db, indexer, vaultDir, notesDir,
    async cleanup() { db.close(); await fs.rm(vaultDir, { recursive: true, force: true }); }
  };
}

test('外部依赖都不可用时，文献页照常打开并说明原因', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/library').expect(200);
    assert.match(response.text, /连不上 Zotero 本地 API/);
    assert.match(response.text, /应用设置中配置/);
    assert.match(response.text, /应用设置/, '应告诉用户在哪里配置集成');
    assert.match(response.text, /已有剪藏/, '已有剪藏仍应可浏览');
    assert.doesNotMatch(response.text, /剪藏到工作台/, '桌面应用不再暴露 bookmarklet');
  } finally {
    await ctx.cleanup();
  }
});

test('桌面应用不再提供剪藏接收端', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/clip').send({ html: '<p>内容</p>' }).expect(404);
  } finally {
    await ctx.cleanup();
  }
});

test('Library 离线时仍从 Markdown 展示待加工标注', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'lit/local.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '本地平台定价', creators: [], tags: [] },
        annotations: [{ itemID: 10, text: '识别策略', comment: '补制度背景', page: '12', sortIndex: '0001' }]
      })
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/library').expect(200);
    assert.match(response.text, /本地平台定价/);
    assert.match(response.text, /1 条待加工/);
    assert.match(response.text, /识别策略/);
    assert.match(response.text, /补制度背景/);
    assert.match(response.text, /data-note-path="lit\/local\.md"/);
  } finally {
    await ctx.cleanup();
  }
});

test('Library 不截断超过 500 条的本地待加工标注', async () => {
  const ctx = await setup();
  try {
    const annotations = Array.from({ length: 501 }, (_unused, index) => ({
      itemID: index + 1,
      text: `标注 ${index + 1}`,
      comment: '',
      page: '',
      sortIndex: String(index + 1).padStart(4, '0')
    }));
    await writeNote(ctx.notesDir, 'lit/large.md', {
      raw: renderLiteratureNote({
        item: { key: 'LARGE123', title: '大型文献', creators: [], tags: [] },
        annotations
      })
    });
    await ctx.indexer.scan();
    const response = await request(ctx.app).get('/library').expect(200);
    assert.match(response.text, /501 条待加工/);
    assert.equal((response.text.match(/data-process-annotation/g) || []).length, 501);
  } finally {
    await ctx.cleanup();
  }
});

test('非规范路径已有同一 Zotero 文献时拒绝重复创建', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'lit/custom/location.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '已有文献', creators: [], tags: [] },
        annotations: []
      })
    });
    await ctx.indexer.scan();
    const response = await request(ctx.app).post('/library/lit').send({ key: 'ABCD1234' }).expect(409);
    assert.match(response.body.message, /已经存在/);
    await assert.rejects(fs.access(path.join(ctx.notesDir, 'lit', 'ABCD1234.md')));
  } finally {
    await ctx.cleanup();
  }
});

test('文献生成等待规范路径写入，索引滞后时也不覆盖抢先内容', async () => {
  const ctx = await setup();
  const originalFetchItems = zotero.fetchItems;
  const originalReadAnnotations = zotero.readAnnotations;
  let release;
  let prior;
  try {
    zotero.fetchItems = async () => ({
      available: true,
      items: [{ key: 'ABCD1234', title: '平台定价', creators: [], tags: [] }]
    });
    zotero.readAnnotations = async () => ({ available: true, items: [] });

    const notePath = 'lit/ABCD1234.md';
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    prior = enqueueNote(ctx.notesDir, notePath, async () => {
      entered();
      await gate;
      await writeNote(ctx.notesDir, notePath, { body: '# 用户抢先创建的文献笔记' });
    });
    await started;

    let settled = false;
    const pending = request(ctx.app).post('/library/lit').send({ key: 'ABCD1234' })
      .then(response => {
        settled = true;
        return response;
      });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, '文献生成必须等待规范路径上的写入');

    release();
    await prior;
    const response = await pending;
    assert.equal(response.status, 409);
    assert.match((await readNote(ctx.notesDir, notePath)).body, /用户抢先创建/);
  } finally {
    zotero.fetchItems = originalFetchItems;
    zotero.readAnnotations = originalReadAnnotations;
    if (release) release();
    if (prior) await prior.catch(() => {});
    await ctx.cleanup();
  }
});

test('已有文献笔记通过 HTTP 增量同步并迁移旧标注区', async () => {
  const zoteroDataDir = await makeZoteroVault();
  const ctx = await setup({ zoteroDataDir });
  try {
    await writeNote(ctx.notesDir, 'lit/custom/location.md', {
      data: { title: '平台定价与卖家异质性', zotero: 'ABCD1234', tags: ['文献'] },
      body: '# 平台定价与卖家异质性\n\n## 标注\n\n> 识别策略依赖工具变量的外生性  （p.12）\n\n这里需要制度背景论证\n\n## 我的想法\n\n不能覆盖。\n'
    });
    await ctx.indexer.scan();
    const before = await readNote(ctx.notesDir, 'lit/custom/location.md');

    const response = await request(ctx.app).post('/library/lit/sync').send({
      key: 'ABCD1234', expectedHash: before.hash
    }).expect(200);
    assert.equal(response.body.path, 'lit/custom/location.md');
    assert.equal(response.body.migrated, true);
    assert.equal(response.body.pending, 2);
    assert.equal(response.body.pendingAnnotations.length, 2);
    assert.match((await readNote(ctx.notesDir, 'lit/custom/location.md')).raw, /不能覆盖/);
  } finally {
    await ctx.cleanup();
    await fs.rm(zoteroDataDir, { recursive: true, force: true });
  }
});

test('标注加工 HTTP 支持 mark-only 和组合输出', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'lit/local.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '本地平台定价', creators: [], tags: [] },
        annotations: [
          { itemID: 10, text: '识别策略', comment: '补制度背景', sortIndex: '0001' },
          { itemID: 11, text: '异质性', comment: '', sortIndex: '0002' }
        ]
      })
    });
    await ctx.indexer.scan();
    let source = await readNote(ctx.notesDir, 'lit/local.md');

    const combined = await request(ctx.app).post('/library/annotations/process').send({
      notePath: 'lit/local.md',
      annotationId: 'ABCD1234:10',
      expectedHash: source.hash,
      outputs: {
        note: { title: '制度背景', body: '补充制度背景。' },
        card: { deckFile: 'research', front: '识别策略依赖什么？', back: '制度外生性。' },
        task: { title: '补制度背景' }
      }
    }).expect(200);
    assert.deepEqual(combined.body.outputs, ['note', 'card', 'task']);

    source = await readNote(ctx.notesDir, 'lit/local.md');
    const marked = await request(ctx.app).post('/library/annotations/process').send({
      notePath: 'lit/local.md',
      annotationId: 'ABCD1234:11',
      expectedHash: source.hash,
      outputs: {}
    }).expect(200);
    assert.deepEqual(marked.body.outputs, []);
    assert.equal(parseManagedAnnotations((await readNote(ctx.notesDir, 'lit/local.md')).body)
      .every(annotation => annotation.status === 'processed'), true);

    // 加工顺带新建的永久笔记必须立刻进索引。只重扫文献笔记路径的话，research/ 下
    // 这篇要等下一次全量扫描才可见 —— 反链、搜索、直接访问全都落空。
    const permanent = 'research/zotero-ABCD1234-10.md';
    assert.deepEqual(combined.body.writes, {
      notes: [permanent, 'lit/local.md'],
      vault: ['cards/research.md']
    });
    assert.ok(ctx.db.getNote(permanent), '新建的永久笔记应当已在索引里');
    await request(ctx.app).get(`/note/${encodeURIComponent(permanent)}`).expect(200);
  } finally {
    await ctx.cleanup();
  }
});

test('标注加工拒绝过期 hash 且不覆盖用户编辑', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'lit/local.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '本地平台定价', creators: [], tags: [] },
        annotations: [{ itemID: 10, text: '识别策略', sortIndex: '0001' }]
      })
    });
    await ctx.indexer.scan();
    const old = await readNote(ctx.notesDir, 'lit/local.md');
    await writeNote(ctx.notesDir, 'lit/local.md', { raw: `${old.raw}\n用户编辑。\n` });

    await request(ctx.app).post('/library/annotations/process').send({
      notePath: 'lit/local.md', annotationId: 'ABCD1234:10', expectedHash: old.hash, outputs: {}
    }).expect(409);
    assert.match((await readNote(ctx.notesDir, 'lit/local.md')).raw, /用户编辑/);
  } finally {
    await ctx.cleanup();
  }
});

test('只读模式隐藏文献写控件并拒绝所有标注写路由', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await writeNote(ctx.notesDir, 'lit/local.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '本地平台定价', creators: [], tags: [] },
        annotations: [{ itemID: 10, text: '识别策略', sortIndex: '0001' }]
      })
    });
    await ctx.indexer.scan();
    const page = await request(ctx.app).get('/library').expect(200);
    assert.doesNotMatch(page.text, /data-make-lit|data-sync-lit|data-process-annotation|data-annotation-dialog/);
    await request(ctx.app).post('/library/lit').send({ key: 'ABCD' }).expect(403);
    await request(ctx.app).post('/library/lit/sync').send({ key: 'ABCD1234' }).expect(403);
    await request(ctx.app).post('/library/annotations/process').send({
      notePath: 'lit/local.md', annotationId: 'ABCD1234:10', outputs: {}
    }).expect(403);
  } finally {
    await ctx.cleanup();
  }
});
