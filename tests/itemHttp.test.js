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
const { writeNote, readNote } = require('../src/vault/note');

async function setup(t, readOnly = false) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-item-http-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, syncEnabled: false });
  await fs.mkdir(config.notesDir);
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  t.after(async () => { db.close(); await fs.rm(vaultDir, { recursive: true, force: true }); });
  return { app, config, indexer };
}

test('只提供研究项目看板，旧章节、投稿和回复稿入口返回 404', async t => {
  const { app } = await setup(t);
  const page = await request(app).get('/board/experiment').expect(200);
  assert.match(page.text, /还没有项目/);
  for (const url of ['/board/chapter', '/board/submission', '/board/unknown', '/submissions/letter?path=submissions/paper.md']) {
    await request(app).get(url).expect(404);
  }
});

test('看板保留项目状态和下一步，不显示旧习题进度或审稿派生信息', async t => {
  const ctx = await setup(t);
  const before = await writeNote(ctx.config.notesDir, 'experiments/project.md', {
    data: {
      title: '基线模型', status: 'running', dataset: 'panel', next: '补齐对照实验',
      exercises_done: 7, exercises_total: 20, reviews: [{ comment: '旧审稿数据' }]
    }, body: '项目正文'
  });
  await ctx.indexer.scan();
  const page = await request(ctx.app).get('/board/experiment').expect(200);
  // 页头不再写「共 N 个项目」，数目在各栏标题旁。
  assert.doesNotMatch(page.text, /共 1 个项目/);
  assert.match(page.text, /data-status="running"[^]*?data-column-count>1</);
  assert.match(page.text, /基线模型/);
  assert.match(page.text, /补齐对照实验/);
  assert.match(page.text, /data-board-column data-status="running"/);
  assert.doesNotMatch(page.text, /progress-bar|习题完成度|7\/20 题|旧审稿数据|导出回复稿/);
  assert.equal((await readNote(ctx.config.notesDir, before.path)).hash, before.hash);
  await request(ctx.app).post('/board/status').set('Accept', 'application/json').send({
    workflow: 'experiment', path: before.path, status: 'done', expectedHash: before.hash
  }).expect(200);
  const written = await readNote(ctx.config.notesDir, before.path);
  assert.equal(written.data.status, 'done');
  assert.equal(written.data.exercises_total, 20);
  assert.deepEqual(written.data.reviews, [{ comment: '旧审稿数据' }]);
  assert.equal(written.body, before.body);
  await request(ctx.app).post('/board/status').set('Accept', 'application/json').send({
    workflow: 'experiment', path: before.path, status: 'planned', expectedHash: before.hash
  }).expect(409);
  await request(ctx.app).post('/board/status').set('Accept', 'application/json').send({
    workflow: 'experiment', path: before.path, status: 'planned'
  }).expect(409);
});

test('看板状态验证与只读保护仍生效', async t => {
  const ctx = await setup(t);
  const note = await writeNote(ctx.config.notesDir, 'experiments/project.md', { data: { status: 'planned' }, body: '正文' });
  await ctx.indexer.scan();
  await request(ctx.app).post('/board/status').set('Accept', 'application/json').send({
    workflow: 'experiment', path: note.path, status: 'accepted', expectedHash: note.hash
  }).expect(400);
  await request(ctx.app).post('/board/status').set('Accept', 'application/json').send({
    workflow: 'experiment', path: '../escape.md', status: 'done', expectedHash: note.hash
  }).expect(400);
  assert.equal((await readNote(ctx.config.notesDir, note.path)).hash, note.hash);
  const readOnly = await setup(t, true);
  await request(readOnly.app).get('/board/experiment').expect(200);
  await request(readOnly.app).post('/board/status').send({}).expect(403);
});
