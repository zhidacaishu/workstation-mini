const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { createSimilarityService } = require('../src/similarityService');
const { buildIndex, linkSuggestions, similarTo, retrieve, cosine } = require('../src/similarity');

const quiet = { log() {}, warn() {}, error() {} };

function replaceDocument(db, doc) {
  db.replaceNote({
    path: doc.path,
    section: 'research',
    title: doc.title,
    body: doc.body,
    data: {},
    hash: doc.hash,
    size: doc.body.length,
    mtimeMs: doc.mtimeMs || 1,
    indexedAt: '2026-08-09T00:00:00.000Z',
    titleTokens: doc.title,
    bodyTokens: doc.body,
    tags: [],
    links: [],
    tasks: [],
    annotations: []
  });
}

function seedDb(documents) {
  const db = openDatabase(':memory:');
  for (const doc of documents) replaceDocument(db, doc);
  return db;
}

function corpus(count, vocabulary) {
  let seed = 4242;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const words = [];
  for (let i = 0; i < vocabulary; i += 1) words.push(`术语${i}`);

  const documents = [];
  for (let i = 0; i < count; i += 1) {
    const parts = [];
    for (let k = 0; k < 60; k += 1) {
      parts.push(words[Math.floor(Math.pow(random(), 1.6) * words.length)]);
    }
    const body = parts.join('，');
    documents.push({ path: `research/n${i}.md`, title: `主题${i}`, body, hash: `h${i}`, mtimeMs: i + 1 });
  }
  return documents;
}

// ——————————————————————————————————————————————————————————————
// 两条计算路径必须等价
//
// linkSuggestions 会按用词分布在「两两比较」和「倒排表」之间挑一条。挑错只是慢，
// 但两条路径给出不同结果就是错 —— 用户会发现同一个 vault 每次打开体检页
// 推荐的关联都不一样，而且没人能复现。
// ——————————————————————————————————————————————————————————————

/** 强制走两两比较的参考实现。 */
function pairwiseReference(index, existingLinks, { limit = 20, minScore = 0.12 } = {}) {
  const linked = new Set();
  for (const link of existingLinks) {
    linked.add(`${link.from}\0${link.to}`);
    linked.add(`${link.to}\0${link.from}`);
  }
  const out = [];
  for (let i = 0; i < index.documents.length; i += 1) {
    for (let j = i + 1; j < index.documents.length; j += 1) {
      const a = index.documents[i];
      const b = index.documents[j];
      if (linked.has(`${a.path}\0${b.path}`)) continue;
      const score = cosine(index.vectors[i], index.vectors[j]);
      if (score >= minScore) {
        out.push({ a: { path: a.path, title: a.title }, b: { path: b.path, title: b.title }, score });
      }
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

test('用词分散和用词集中的 vault 都得到同样的链接建议', () => {
  // 词表大 → 共享词少 → 走倒排表；词表小 → 几乎两两都共享 → 走两两比较。
  for (const vocabulary of [40, 2000]) {
    const documents = corpus(60, vocabulary);
    const index = buildIndex(documents);
    const links = [{ from: 'research/n0.md', to: 'research/n1.md' }];

    for (const minScore of [0.05, 0.12, 0.4]) {
      const expected = pairwiseReference(index, links, { limit: 30, minScore });
      const actual = linkSuggestions(index, links, { limit: 30, minScore });
      const key = item => `${item.a.path}|${item.b.path}|${item.score.toFixed(12)}`;
      assert.deepEqual(
        actual.map(key).sort(),
        expected.map(key).sort(),
        `词表 ${vocabulary} / 阈值 ${minScore} 下两条路径结果必须一致`
      );
    }
  }
});

test('已经连起来的两篇不再出现在建议里', () => {
  const documents = corpus(30, 50);
  const index = buildIndex(documents);
  const suggestions = linkSuggestions(index, [], { limit: 5, minScore: 0.05 });
  assert.ok(suggestions.length > 0, '先确认这个语料确实能产生建议');

  const [first] = suggestions;
  const withLink = linkSuggestions(
    index,
    [{ from: first.a.path, to: first.b.path }],
    { limit: 5, minScore: 0.05 }
  );
  const stillThere = withLink.some(item => item.a.path === first.a.path && item.b.path === first.b.path);
  assert.equal(stillThere, false, '已连接的组合应被排除，无论链接写在哪个方向');
});

test('分词缓存不改变结果，删掉的笔记会被清出缓存', () => {
  const documents = corpus(20, 80);
  const cache = new Map();

  const fresh = buildIndex(documents);
  const cached = buildIndex(documents, { cache });
  assert.equal(cache.size, documents.length);
  assert.deepEqual(
    cached.vectors.map(vector => [...vector.entries()].sort()),
    fresh.vectors.map(vector => [...vector.entries()].sort()),
    '用不用缓存，相似度向量必须一样'
  );
  assert.deepEqual(
    cached.retrievalVectors.map(vector => [...vector.entries()].sort()),
    fresh.retrievalVectors.map(vector => [...vector.entries()].sort()),
    '用不用缓存，检索向量必须一样'
  );

  // 改一篇：只有它的分词该失效
  const edited = documents.map((doc, i) => (i === 0 ? { ...doc, body: '全新的内容 术语1', hash: 'h0-new' } : doc));
  const after = buildIndex(edited, { cache });
  const expected = buildIndex(edited);
  assert.deepEqual(
    after.vectors.map(vector => [...vector.entries()].sort()),
    expected.vectors.map(vector => [...vector.entries()].sort()),
    '改过一篇之后，带缓存的结果仍要和全新计算一致'
  );

  // 删几篇：缓存不该无限长
  const fewer = edited.slice(0, 5);
  buildIndex(fewer, { cache });
  assert.equal(cache.size, 5, '删掉的笔记要从缓存里清出去');
});

// ——————————————————————————————————————————————————————————————
// 工作线程
// ——————————————————————————————————————————————————————————————

test('工作线程与主线程内联计算给出相同结果', async () => {
  const documents = corpus(40, 300);
  documents[7] = {
    ...documents[7],
    body: `${documents[7].body}，xylophonic`,
    hash: 'h7-singleton'
  };
  const db = seedDb(documents);
  const worker = createSimilarityService({ db, logger: quiet });
  const inline = createSimilarityService({ db, logger: quiet, useWorker: false });

  try {
    const links = [{ from: 'research/n0.md', to: 'research/n1.md' }];
    const [fromWorker, fromInline] = await Promise.all([
      worker.suggestions(links, { limit: 10, minScore: 0.05 }),
      inline.suggestions(links, { limit: 10, minScore: 0.05 })
    ]);
    assert.deepEqual(fromWorker.suggestions, fromInline.suggestions);

    const [similarWorker, similarInline] = await Promise.all([
      worker.similar('research/n3.md', { limit: 5 }),
      inline.similar('research/n3.md', { limit: 5 })
    ]);
    assert.deepEqual(similarWorker.results, similarInline.results);

    const [retrieveWorker, retrieveInline] = await Promise.all([
      worker.retrieve('xylophonic', { limit: 5 }),
      inline.retrieve('xylophonic', { limit: 5 })
    ]);
    assert.deepEqual(retrieveWorker.results, retrieveInline.results);
    assert.deepEqual(retrieveWorker.results.map(result => result.path), ['research/n7.md']);
  } finally {
    await worker.close();
    await inline.close();
    db.close();
  }
});

test('Unicode 路径的同分结果在工作线程和内联模式下顺序一致', async () => {
  const documents = ['research/.md', 'research/😀.md', 'research/a.md'].map(notePath => ({
    path: notePath, title: 'same', body: 'alpha beta', hash: 'same-content', mtimeMs: 1
  }));
  const db = seedDb(documents);
  const worker = createSimilarityService({ db, logger: quiet });
  const inline = createSimilarityService({ db, logger: quiet, useWorker: false });
  try {
    for (const limit of [1, 10]) {
      const options = { limit, minScore: 0.01 };
      const fromWorker = await worker.retrieve('alpha', options);
      assert.deepEqual(fromWorker.results.map(result => result.path),
        documents.map(doc => doc.path).sort().slice(0, limit));
      assert.deepEqual(await inline.retrieve('alpha', options), fromWorker);
      assert.deepEqual(await inline.similar('research/a.md', options), await worker.similar('research/a.md', options));
      assert.deepEqual((await inline.suggestions([], options)).suggestions, (await worker.suggestions([], options)).suggestions);
    }
  } finally {
    await worker.close();
    await inline.close();
    db.close();
  }
});

test('笔记改动后工作线程只收增量，但结果跟着更新', async () => {
  const documents = corpus(12, 60);
  const db = seedDb(documents);
  const service = createSimilarityService({ db, logger: quiet });

  try {
    const before = await service.similar('research/n0.md', { limit: 20, minScore: 0 });
    assert.ok(before.results.length > 0);

    // 换掉一篇的内容，并让它和 n0 完全一致 —— 相似度应该顶到最前面
    const twin = db.getNote('research/n0.md');
    db.replaceNote({
      path: 'research/n5.md',
      section: 'research',
      title: '双胞胎',
      body: twin.body_raw,
      data: {},
      hash: 'h5-new',
      size: twin.body_raw.length,
      mtimeMs: 9999,
      indexedAt: '2026-08-09T00:00:00.000Z',
      titleTokens: '双胞胎',
      bodyTokens: twin.body_raw,
      tags: [], links: [], tasks: [], annotations: []
    });

    const after = await service.similar('research/n0.md', { limit: 20, minScore: 0 });
    assert.equal(after.results[0].path, 'research/n5.md', '内容改成一样之后应排到最前');

    // 删掉再查，不该再出现
    db.removeNote('research/n5.md');
    const removed = await service.similar('research/n0.md', { limit: 20, minScore: 0 });
    assert.equal(
      removed.results.some(item => item.path === 'research/n5.md'),
      false,
      '删掉的笔记要从工作线程的文档集里去掉'
    );
  } finally {
    await service.close();
    db.close();
  }
});

test('工作线程用不了时退回主线程计算，功能不消失', async () => {
  const documents = corpus(10, 50);
  const db = seedDb(documents);
  // useWorker: false 走的就是「线程不可用」那条路径
  const service = createSimilarityService({ db, logger: quiet, useWorker: false });

  try {
    const result = await service.suggestions([], { limit: 5, minScore: 0.05 });
    assert.ok(Array.isArray(result.suggestions), '退化路径必须仍然返回结果');
  } finally {
    await service.close();
    db.close();
  }
});

const inlineDocuments = [
  { path: 'research/c.md', title: 'C', body: 'beta delta', hash: 'c', mtimeMs: 100 },
  { path: 'research/a.md', title: 'A', body: 'alpha beta', hash: 'a', mtimeMs: 1 },
  { path: 'research/b.md', title: 'B', body: 'gamma delta', hash: 'b', mtimeMs: 2 }
];

async function assertFreshInlineResults(service, db) {
  const documents = db.raw.prepare(`
    SELECT path, title_raw AS title, body_raw AS body, hash FROM notes ORDER BY path
  `).all();
  const fresh = buildIndex(documents);
  const options = { limit: 20, minScore: 0.01 };
  for (const query of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    assert.deepEqual((await service.retrieve(query, options)).results, retrieve(fresh, query, options), query);
  }
  for (const notePath of ['research/a.md', 'research/b.md', 'research/c.md', 'research/renamed.md']) {
    assert.deepEqual((await service.similar(notePath, options)).results, similarTo(fresh, notePath, options), notePath);
  }
  for (const links of [[], [{ from: 'research/a.md', to: 'research/b.md' }]]) {
    assert.deepEqual((await service.suggestions(links, options)).suggestions, linkSuggestions(fresh, links, options));
  }
}

for (const [name, change] of [
  ['保留时间戳修改正文', db => replaceDocument(db, { ...inlineDocuments[1], body: 'gamma delta', hash: 'a-edited' })],
  ['修改时间增长但低于最大值', db => replaceDocument(db, { ...inlineDocuments[1], body: 'gamma delta', hash: 'a-edited', mtimeMs: 3 })],
  ['保留时间戳只修改标题', db => replaceDocument(db, { ...inlineDocuments[1], title: 'epsilon', hash: 'a-retitled' })],
  ['相同数量下替换笔记', db => {
    db.removeNote('research/a.md');
    replaceDocument(db, { ...inlineDocuments[1], path: 'research/renamed.md', body: 'epsilon delta', hash: 'replacement' });
  }],
  ['相同内容和时间戳下重命名', db => {
    db.removeNote('research/a.md');
    replaceDocument(db, { ...inlineDocuments[1], path: 'research/renamed.md' });
  }]
]) {
  test(`内联缓存：${name}后所有结果与新索引一致`, async () => {
    const db = seedDb(inlineDocuments);
    const service = createSimilarityService({ db, logger: quiet, useWorker: false });
    try {
      await assertFreshInlineResults(service, db);
      const stamp = () => db.raw.prepare('SELECT count(*) AS c, max(mtime_ms) AS m FROM notes').get();
      const before = stamp();
      change(db);
      assert.deepEqual(stamp(), before, '改动不改变旧缓存键，才能覆盖失效漏洞');
      await assertFreshInlineResults(service, db);
    } finally {
      await service.close();
      db.close();
    }
  });
}

test('内联缓存：空库、增加、删除、删空后恢复都与新索引一致', async () => {
  const db = seedDb([]);
  const service = createSimilarityService({ db, logger: quiet, useWorker: false });
  try {
    await assertFreshInlineResults(service, db);
    for (const doc of inlineDocuments) {
      replaceDocument(db, doc);
      await assertFreshInlineResults(service, db);
    }
    for (const doc of inlineDocuments) {
      db.removeNote(doc.path);
      await assertFreshInlineResults(service, db);
    }
    replaceDocument(db, { ...inlineDocuments[1], body: 'epsilon', hash: 'restored' });
    await assertFreshInlineResults(service, db);
  } finally {
    await service.close();
    db.close();
  }
});

test('内联缓存：未变内容不重复读取全文，更新后只重建一次', async () => {
  const db = seedDb(inlineDocuments);
  let documentReads = 0;
  // 只包装服务的数据库依赖，参考计算和 fixture 写入不计入全文读取次数。
  const trackedDb = { raw: { prepare(sql) {
    const statement = db.raw.prepare(sql);
    if (!/SELECT\s+path,\s*title_raw/i.test(sql)) return statement;
    return { all(...args) { documentReads += 1; return statement.all(...args); } };
  } } };
  const service = createSimilarityService({ db: trackedDb, logger: quiet, useWorker: false });
  try {
    await assertFreshInlineResults(service, db);
    await assertFreshInlineResults(service, db);
    assert.equal(documentReads, 1, '无变化时三个接口共用一次建索引的全文读取');
    replaceDocument(db, { ...inlineDocuments[0], mtimeMs: 200 });
    await assertFreshInlineResults(service, db);
    assert.equal(documentReads, 1, '仅修改时间变化不需要重建内容索引');
    replaceDocument(db, { ...inlineDocuments[1], body: 'epsilon delta', hash: 'a-edited' });
    await assertFreshInlineResults(service, db);
    await assertFreshInlineResults(service, db);
    assert.equal(documentReads, 2, '内容更新后重建一次，之后继续复用缓存');
  } finally {
    await service.close();
    db.close();
  }
});

test('笔记没变时重复请求链接建议走缓存，笔记变了立刻失效', async () => {
  const documents = corpus(70, 120);
  const db = seedDb(documents);
  const service = createSimilarityService({ db, logger: quiet });

  try {
    const options = { limit: 10, minScore: 0.05 };
    const first = await service.suggestions([], options);

    const started = Date.now();
    const second = await service.suggestions([], options);
    const cachedMs = Date.now() - started;

    assert.deepEqual(second.suggestions, first.suggestions, '缓存命中不能改变结果');
    assert.ok(cachedMs < 100, `命中缓存应当很快，实际 ${cachedMs}ms`);

    // 改一篇笔记：缓存必须失效，否则用户改完看到的还是旧建议
    db.replaceNote({
      path: documents[0].path,
      section: 'research',
      title: '换了内容',
      body: '完全不相干的正文 孤立词汇甲 孤立词汇乙',
      data: {},
      hash: 'changed',
      size: 40,
      mtimeMs: 999999,
      indexedAt: '2026-08-09T00:00:00.000Z',
      titleTokens: '换了内容',
      bodyTokens: '完全不相干的正文 孤立词汇甲 孤立词汇乙',
      tags: [], links: [], tasks: [], annotations: []
    });

    const third = await service.suggestions([], options);
    assert.notDeepEqual(third.suggestions, first.suggestions, '笔记改了，建议必须跟着重算');
  } finally {
    await service.close();
    db.close();
  }
});
