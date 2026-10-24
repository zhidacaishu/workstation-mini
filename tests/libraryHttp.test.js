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
const { writeNote } = require('../src/vault/note');

async function setup(t, { readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-library-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false, readOnly });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });

  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config, indexer };
}

async function addNote(config, notePath, note, modifiedAt) {
  await writeNote(config.notesDir, notePath, note);
  if (modifiedAt) {
    const timestamp = new Date(modifiedAt);
    await fs.utimes(path.join(config.notesDir, notePath), timestamp, timestamp);
  }
}

function assertBefore(text, first, second) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.ok(firstIndex >= 0, `expected ${first} in page`);
  assert.ok(secondIndex >= 0, `expected ${second} in page`);
  assert.ok(firstIndex < secondIndex, `expected ${first} before ${second}`);
}

test('空查询浏览最近文档，按 mtime 倒序再按路径排序', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/z-last.md', { data: { title: '较早文档' }, body: '旧正文' }, '2026-01-01T00:00:00Z');
  await addNote(config, 'reading/b-tied.md', { data: { title: '同时间 B' }, body: 'B 正文' }, '2026-02-01T00:00:00Z');
  await addNote(config, 'reading/a-tied.md', { data: { title: '同时间 A' }, body: 'A 正文' }, '2026-02-01T00:00:00Z');
  await indexer.scan();

  const response = await request(app).get('/search').expect(200);
  assert.match(response.text, /<title>笔记资料库/);
  assert.match(response.text, /reading\/a-tied\.md/);
  assert.match(response.text, /reading\/b-tied\.md/);
  assert.match(response.text, /reading\/z-last\.md/);
  assertBefore(response.text, 'reading/a-tied.md', 'reading/b-tied.md');
  assertBefore(response.text, 'reading/b-tied.md', 'reading/z-last.md');
});

test('无 query 时可单独按分区或标签浏览', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/kept.md', { data: { title: '阅读保留', tags: ['重点'] }, body: '阅读正文' });
  await addNote(config, 'diary/other.md', { data: { title: '日记条目', tags: ['日记'] }, body: '日记正文' });
  await indexer.scan();

  const section = await request(app).get('/search?section=reading').expect(200);
  assert.match(section.text, /阅读保留/);
  assert.doesNotMatch(section.text, /日记条目/);

  const tag = await request(app).get('/search?tag=' + encodeURIComponent('日记')).expect(200);
  assert.match(tag.text, /日记条目/);
  assert.doesNotMatch(tag.text, /阅读保留/);
});

test('无 query 的 section 和 tag 取交集', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/match.md', { data: { title: '阅读重点', tags: ['重点'] }, body: '交集结果' });
  await addNote(config, 'reading/wrong-tag.md', { data: { title: '阅读普通', tags: ['普通'] }, body: '不应出现' });
  await addNote(config, 'diary/wrong-section.md', { data: { title: '日记重点', tags: ['重点'] }, body: '不应出现' });
  await indexer.scan();

  const response = await request(app)
    .get('/search?section=reading&tag=' + encodeURIComponent('重点'))
    .expect(200);
  assert.match(response.text, /阅读重点/);
  assert.match(response.text, /reading\/match\.md/);
  assert.doesNotMatch(response.text, /阅读普通/);
  assert.doesNotMatch(response.text, /日记重点/);
});

test('有 query 时仍使用全文搜索结果', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/hit.md', { data: { title: '命中文档' }, body: '独特检索词出现在正文。' });
  await addNote(config, 'reading/miss.md', { data: { title: '未命中文档' }, body: '完全不同的内容。' });
  await indexer.scan();

  const response = await request(app).get('/search?q=' + encodeURIComponent('独特检索词')).expect(200);
  assert.match(response.text, /<title>搜索：独特检索词/);
  assert.match(response.text, /命中文档/);
  assert.doesNotMatch(response.text, /未命中文档/);
});

test('今日限制项目数量，项目期限不重复待办也不被前八条待办挤掉', async t => {
  const { app, config, indexer } = await setup(t);
  const date = new Date();
  const localDate = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  const today = localDate(date);
  date.setDate(date.getDate() + 10);
  for (let i = 0; i < 4; i += 1) {
    await addNote(config, `experiments/project-${i}.md`, {
      data: { title: `研究项目 ${i}`, status: 'running', next: '下一次实验', ...(i === 0 ? { deadline: localDate(date) } : {}) },
      body: '项目内容'
    });
  }
  await addNote(config, 'tasks.md', { body: Array.from({ length: 9 }, (_, i) => `- [ ] 待办 ${i} @${today}`).join('\n') });
  await indexer.scan();
  const response = await request(app).get('/').expect(200);
  assert.equal((response.text.match(/class="research-entry/g) || []).length, 2);
  assert.doesNotMatch(response.text, /class="statrow"/);
  const deadlines = response.text.match(/<ul class="desk-deadlines">([\s\S]*?)<\/ul>/)[1];
  assert.match(deadlines, /研究项目 0/);
  assert.doesNotMatch(deadlines, /待办 \d/);
});

test('笔记标签直接筛选资料库，不再附加同名全文搜索', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'research/tags.md', { data: { title: '标签示例', tags: ['评测'] }, body: '正文没有标签关键词' });
  await indexer.scan();
  const response = await request(app).get('/note/research/tags.md').expect(200);
  assert.match(response.text, /href="\/search\?tag=%E8%AF%84%E6%B5%8B"/);
  assert.doesNotMatch(response.text, /tag=[^"]*&q=/);
});

test('空资料库和只读模式均可打开资料库页面', async t => {
  const empty = await setup(t);
  const emptyPage = await request(empty.app).get('/search').expect(200);
  assert.match(emptyPage.text, /还没有笔记/);

  const readOnly = await setup(t, { readOnly: true });
  await addNote(readOnly.config, 'archive/readonly.md', { data: { title: '只读文档' }, body: '仍可浏览' });
  await readOnly.indexer.scan();
  const readOnlyPage = await request(readOnly.app).get('/search').expect(200);
  assert.match(readOnlyPage.text, /只读文档/);
  assert.match(readOnlyPage.text, /archive\/readonly\.md/);
});
