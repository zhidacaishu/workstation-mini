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

const NOW = new Date(2026, 9, 24, 9, 0);
const TODAY = '2026-10-24';

async function setup(t, { readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-plan-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false, readOnly });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, {
    db, indexer, search: createSearch(db), now: () => NOW
  });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config, db, indexer };
}

async function seedTasks(ctx) {
  await writeNote(ctx.config.notesDir, 'work.md', {
    body: [
      '- [ ] 已逾期的任务 @2026-10-23',
      '- [ ] 今天的任务 @2026-10-24',
      '- [ ] 未安排的任务',
      '- [x] 已完成的任务 @2026-10-20'
    ].join('\n')
  });
  await ctx.indexer.scan();
}

test('计划默认显示未完成任务，过滤器分别显示未安排、完成与日期任务', async t => {
  const ctx = await setup(t);
  await seedTasks(ctx);

  const all = await request(ctx.app).get('/plan').expect(200);
  assert.match(all.text, /计划/);
  assert.match(all.text, /已逾期的任务/);
  assert.match(all.text, /今天的任务/);
  assert.match(all.text, /未安排的任务/);
  assert.doesNotMatch(all.text, /已完成的任务/);

  const undated = await request(ctx.app).get('/plan?filter=undated').expect(200);
  assert.match(undated.text, /未安排的任务/);
  assert.doesNotMatch(undated.text, /今天的任务/);

  const done = await request(ctx.app).get('/plan?filter=done').expect(200);
  assert.match(done.text, /已完成的任务/);
  assert.doesNotMatch(done.text, /未安排的任务/);

  const overdue = await request(ctx.app).get('/plan?filter=overdue').expect(200);
  assert.match(overdue.text, /已逾期的任务/);
  assert.doesNotMatch(overdue.text, /今天的任务/);

  const dueToday = await request(ctx.app).get('/plan?filter=today').expect(200);
  assert.match(dueToday.text, /今天的任务/);
  assert.doesNotMatch(dueToday.text, /已逾期的任务/);
});

test('月历详情支持跨月，并把任务和项目期限分开提供', async t => {
  const ctx = await setup(t);
  await writeNote(ctx.config.notesDir, 'work.md', { body: '- [ ] 日历任务 @2027-01-02' });
  await writeNote(ctx.config.notesDir, 'experiments/project.md', {
    data: { title: '独立项目期限', deadline: '2027-01-02', status: 'running' }, body: '项目正文'
  });
  await ctx.indexer.scan();

  const calendar = await request(ctx.app)
    .get('/plan?view=calendar&month=2027-01&date=2027-01-02').expect(200);
  assert.match(calendar.text, /2027/);
  assert.match(calendar.text, /日历任务/);
  assert.match(calendar.text, /独立项目期限/);
  assert.match(calendar.text, /month=2026-12/);
  assert.match(calendar.text, /month=2027-02/);

  const deadlines = await request(ctx.app).get('/plan?filter=deadlines').expect(200);
  assert.match(deadlines.text, /日历任务/);
  assert.match(deadlines.text, /独立项目期限/);
});

test('计划中的任务仍使用原更新接口改日期与完成状态', async t => {
  const ctx = await setup(t);
  const note = await writeNote(ctx.config.notesDir, 'task.md', { body: '- [ ] 改期并完成 @2026-10-25' });
  await ctx.indexer.scan();
  const task = ctx.db.listTasks()[0];

  const changed = await request(ctx.app).post('/tasks/update').set('Accept', 'application/json').send({
    path: task.path, line: task.line, expectedHash: note.hash, due: '2026-10-30', done: true
  }).expect(200);
  const updated = await readNote(ctx.config.notesDir, task.path);
  assert.match(updated.body, /- \[x\] 改期并完成 @2026-10-30/);

  const done = await request(ctx.app).get('/plan?filter=done').expect(200);
  assert.match(done.text, /改期并完成/);
  await request(ctx.app).post('/tasks/update').set('Accept', 'application/json').send({
    path: task.path, line: task.line, expectedHash: changed.body.hash, due: '', done: false
  }).expect(200);
  const undated = await request(ctx.app).get('/plan?filter=undated').expect(200);
  assert.match(undated.text, /改期并完成/);
});

test('旧入口直接渲染统一计划页，月历备注保留版本保护', async t => {
  const ctx = await setup(t);
  await seedTasks(ctx);
  for (const [legacy, unified] of [
    ['/tasks', '/plan'],
    ['/calendar', '/plan?view=calendar'],
    ['/deadlines', '/plan?filter=deadlines']
  ]) {
    const response = await request(ctx.app).get(legacy).expect(200);
    const current = await request(ctx.app).get(unified).expect(200);
    const withoutPagePath = html => html.replace(/data-page-path="[^"]*"/, 'data-page-path="/plan"');
    assert.equal(withoutPagePath(response.text), withoutPagePath(current.text));
  }

  const created = await request(ctx.app).post('/plan/notes').set('Accept', 'application/json').send({
    date: TODAY, text: '计划备注', expectedHash: ''
  }).expect(200);
  const htmlSave = await request(ctx.app).post('/calendar/notes').type('form').send({
    date: TODAY, month: '2026-10', text: '计划备注已更新', expectedHash: created.body.hash
  }).expect(302);
  assert.equal(htmlSave.headers.location, '/plan?view=calendar&month=2026-10&date=2026-10-24');

  const current = await readNote(ctx.config.notesDir, 'calendar/2026-10-24.md');
  await writeNote(ctx.config.notesDir, current.path, { data: current.data, body: '外部版本' });
  await request(ctx.app).post('/plan/notes').set('Accept', 'application/json').send({
    date: TODAY, text: '过期保存', expectedHash: current.hash
  }).expect(409);
});

test('计划列表不依赖当月备注文件是否可解析', async t => {
  const ctx = await setup(t);
  await seedTasks(ctx);
  await fs.mkdir(path.join(ctx.config.notesDir, 'calendar'));
  await fs.writeFile(path.join(ctx.config.notesDir, 'calendar', TODAY + '.md'), '---\ntags: [broken\n---\n备注');
  const response = await request(ctx.app).get('/plan?view=list').expect(200);
  assert.match(response.text, /今天的任务/);
});

test('损坏的单日备注不阻断月历，修复前禁止内联覆盖', async t => {
  const ctx = await setup(t);
  await seedTasks(ctx);
  const relative = 'calendar/' + TODAY + '.md';
  const absolute = path.join(ctx.config.notesDir, relative);
  const broken = '---\ntags: [broken\n---\n备注';
  await fs.mkdir(path.dirname(absolute));
  await fs.writeFile(absolute, broken);
  for (const url of ['/plan?view=calendar', '/calendar']) {
    const page = await request(ctx.app).get(url).expect(200);
    assert.match(page.text, /今天的任务/);
    assert.match(page.text, /需修复/);
    assert.match(page.text, /href="\/edit\/calendar\/2026-10-24.md"/);
    assert.doesNotMatch(page.text, /data-calendar-form/);
  }
  const otherDay = await request(ctx.app).get('/plan?view=calendar&date=2026-10-25').expect(200);
  assert.match(otherDay.text, /data-calendar-form/);
  const current = await readNote(ctx.config.notesDir, relative, { tolerateInvalid: true });
  await request(ctx.app).post('/plan/notes').send({ date: TODAY, text: '', expectedHash: current.hash }).expect(409);
  assert.equal(await fs.readFile(absolute, 'utf8'), broken);
  const editor = await request(ctx.app).get('/edit/' + relative).expect(200);
  assert.match(editor.text, /笔记格式有误/);
  await request(ctx.app).post('/save').send({ path: relative, body: '# 修复后的备注', expectedHash: current.hash, isNew: '0' }).expect(302);
  const repaired = await request(ctx.app).get('/plan?view=calendar').expect(200);
  assert.match(repaired.text, /data-calendar-form/);
  assert.match(repaired.text, /修复后的备注/);
});

test('只读月历遇到损坏备注仍可浏览，但不提供编辑入口', async t => {
  const ctx = await setup(t, { readOnly: true });
  const absolute = path.join(ctx.config.notesDir, 'calendar', TODAY + '.md');
  await fs.mkdir(path.dirname(absolute));
  await fs.writeFile(absolute, '---\ntags: [broken\n---\n备注');
  const page = await request(ctx.app).get('/plan?view=calendar').expect(200);
  assert.match(page.text, /需修复/);
  assert.doesNotMatch(page.text, /href="\/edit\/|data-calendar-form/);
});

test('只读模式可浏览计划但拒绝任务与月历备注写入', async t => {
  const ctx = await setup(t, { readOnly: true });
  await writeNote(ctx.config.notesDir, 'readonly.md', { body: '- [ ] 只读任务' });
  await ctx.indexer.scan();

  await request(ctx.app).get('/plan').expect(200);
  await request(ctx.app).post('/plan/notes').send({ date: TODAY, text: '不应写入' }).expect(403);
  await request(ctx.app).post('/tasks/update').send({}).expect(403);
});

test('计划页记住上次的视图：直接打开 /plan 时沿用，显式参数优先', async t => {
  const ctx = await setup(t);
  const first = await request(ctx.app).get('/plan?view=calendar').expect(200);
  const cookie = first.headers['set-cookie'].find(value => value.startsWith('plan_view='));
  assert.match(cookie, /plan_view=calendar/);
  assert.match(cookie, /HttpOnly/);
  const again = await request(ctx.app).get('/plan').set('Cookie', 'plan_view=calendar').expect(200);
  assert.match(again.text, /data-plan-view="calendar"/);
  const explicit = await request(ctx.app).get('/plan?view=list&filter=undated').set('Cookie', 'plan_view=calendar').expect(200);
  assert.match(explicit.text, /data-plan-view="list"/);
});

test('未闭围栏内的快速添加仍可索引，保留原文且只用有效日期排期', async t => {
  const { app, config, db } = await setup(t);
  const prefix = '\uFEFF---\r\ntitle: 备注\r\n---\r\n';
  const body = '记录  \r\n\r\n```python\r\nprint(1)  ';
  const file = 'calendar/' + TODAY + '.md';
  await writeNote(config.notesDir, file, { raw: prefix + body });
  await request(app).post('/plan/tasks').set('Accept', 'application/json').send({ text: '复核 @2026-02-31', due: TODAY }).expect(200);
  assert.equal((await readNote(config.notesDir, file)).raw, prefix + '- [ ] 复核 @2026-02-31 @' + TODAY + '\r\n\r\n' + body);
  assert.deepEqual(db.listTasks().map(t => [t.title, t.due]), [['复核 @2026-02-31', TODAY]]);
});
