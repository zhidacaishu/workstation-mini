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
const { readNote, writeNote } = require('../src/vault/note');

async function setup(t, { readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-calendar-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false, readOnly });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, {
    db, indexer, search: createSearch(db), now: () => new Date(2026, 9, 24, 9)
  });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config, db, indexer };
}

function save(app, date, text, expectedHash = '') {
  return request(app).post('/calendar/notes').set('Accept', 'application/json')
    .send({ date, text, expectedHash });
}

test('按天新增、修改和清空备注，月历与搜索同步更新', async t => {
  const { app, config, db } = await setup(t);
  const created = await save(app, '2026-10-24', '组会准备\n整理实验结果 <draft>').expect(200);
  const note = await readNote(config.notesDir, 'calendar/2026-10-24.md');
  assert.equal(note.body.trim(), '组会准备\n整理实验结果 <draft>');
  const calendar = await request(app).get('/calendar').expect(200);
  assert.match(calendar.text, /2026 年 10 月/);
  assert.match(calendar.text, /整理实验结果 &lt;draft&gt;/);
  const search = await request(app).get('/api/search?q=组会准备').expect(200);
  assert.ok(search.body.results.some(item => item.path === note.path));

  const updated = await save(app, '2026-10-24', '组会材料已整理', created.body.hash).expect(200);
  assert.equal((await readNote(config.notesDir, note.path)).body, '组会材料已整理');
  await save(app, '2026-10-24', '', updated.body.hash).expect(200);
  await assert.rejects(fs.readFile(path.join(config.notesDir, note.path)), { code: 'ENOENT' });
  assert.equal(db.getNote(note.path), undefined);
  await save(app, '2026-10-24', '重新记录').expect(200);
});

test('跨年翻月展示外部 Markdown 备注和截止事项，并保护外部编辑', async t => {
  const { app, config, indexer } = await setup(t);
  const notePath = 'calendar/2027-01-02.md';
  const note = await writeNote(config.notesDir, notePath, {
    data: { title: '新年计划', tags: ['计划'] }, body: '外部编辑器写的备注'
  });
  await writeNote(config.notesDir, 'research/next.md', {
    body: '# 研究任务\n\n- [ ] 提交实验报告 @2027-01-02\n'
  });
  await indexer.scan();
  const page = await request(app).get('/calendar?month=2027-01&date=2027-01-02').expect(200);
  assert.match(page.text, /month=2026-12/);
  assert.match(page.text, /month=2027-02/);
  assert.match(page.text, /外部编辑器写的备注/);
  assert.match(page.text, /提交实验报告/);
  assert.match(page.text, /name="date" value="2027-01-02"/);

  const edited = await writeNote(config.notesDir, notePath, { data: note.data, body: '外部的新版本' });
  await save(app, '2027-01-02', '过期页面的内容', note.hash).expect(409);
  assert.equal((await readNote(config.notesDir, notePath)).hash, edited.hash);
  await save(app, '2027-01-02', '合并后的备注', edited.hash).expect(200);
  assert.deepEqual((await readNote(config.notesDir, notePath)).tags, ['计划']);
});

test('只读模式可浏览备注，无法保存修改', async t => {
  const { app, config } = await setup(t, { readOnly: true });
  await writeNote(config.notesDir, 'calendar/2026-10-24.md', { body: '今天的备忘' });
  const page = await request(app).get('/calendar').expect(200);
  assert.match(page.text, /今天的备忘/);
  assert.doesNotMatch(page.text, /data-calendar-form/);
  await save(app, '2026-10-24', '更改').expect(403);
});
