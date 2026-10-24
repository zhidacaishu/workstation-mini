const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createItems } = require('../src/items');
const { writeNote, readNote } = require('../src/vault/note');
const { extractTasks, sortTasks, summarize } = require('../src/tasks');
const workflows = require('../src/workflows');

async function setup(t) {
  const notesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-items-'));
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const items = createItems({ db, notesDir });
  t.after(async () => { db.close(); await fs.rm(notesDir, { recursive: true, force: true }); });
  return { notesDir, db, indexer, items };
}

test('从正文抽取待办，识别完成状态、截止日期并忽略代码示例', () => {
  const tasks = extractTasks([
    '# 今天', '- [ ] 跑检验 @2026-08-10', '- [x] 补统计', '* [X] 大写完成', '+ [ ] 加号任务',
    '- 普通列表', '```markdown', '- [ ] 代码示例', '```', '行内 `- [ ] 示例`'
  ].join('\n'));
  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].title, '跑检验');
  assert.equal(tasks[0].line, 2);
  assert.equal(tasks[0].due, '2026-08-10');
  assert.match(tasks[0].text, /@2026-08-10/);
  assert.equal(tasks[1].done, true);
  assert.equal(tasks[2].done, true);
});

test('待办排序与统计区分逾期、今天、有期限及无期限', () => {
  const tasks = [
    { path: 'a.md', line: 1, title: '无期限', due: null },
    { path: 'a.md', line: 2, title: '将来', due: '2026-09-01' },
    { path: 'a.md', line: 3, title: '逾期', due: '2026-08-01' },
    { path: 'a.md', line: 4, title: '今天', due: '2026-08-06' }
  ];
  assert.deepEqual(sortTasks(tasks, '2026-08-06').map(task => task.title), ['逾期', '今天', '将来', '无期限']);
  assert.deepEqual(summarize([...tasks, { done: true, due: '2026-08-01' }], '2026-08-06'), {
    total: 5, open: 4, done: 1, overdue: 1, dueToday: 1
  });
});

test('任务索引跟随 Markdown 的勾选和删除，不保留第二份状态', async t => {
  const ctx = await setup(t);
  await writeNote(ctx.notesDir, 'work.md', { body: '- [ ] 检验\n- [ ] 引言' });
  await ctx.indexer.scan();
  assert.equal(ctx.db.listTasks().length, 2);
  await writeNote(ctx.notesDir, 'work.md', { body: '- [x] 检验\n- [ ] 引言' });
  await ctx.indexer.scan();
  assert.deepEqual(ctx.db.listTasks().map(task => task.title), ['引言']);
  assert.equal(ctx.db.listTasks({ includeDone: true }).length, 2);
  await fs.rm(path.join(ctx.notesDir, 'work.md'));
  await ctx.indexer.scan();
  assert.equal(ctx.db.listTasks().length, 0);
});

test('只保留研究项目状态机，已移除的工作流不再有效', () => {
  assert.deepEqual(Object.keys(workflows.WORKFLOWS), ['experiment']);
  for (const status of ['planned', 'running', 'done', 'abandoned']) {
    assert.equal(workflows.isValidStatus('experiment', status), true);
  }
  assert.equal(workflows.normalizeStatus('experiment', undefined), 'planned');
  assert.equal(workflows.normalizeStatus('experiment', '乱写'), 'planned');
  assert.equal(workflows.normalizeStatus('experiment', 'running'), 'running');
  for (const key of ['submission', 'chapter', '不存在']) assert.equal(workflows.workflowOf(key), null);
});

test('项目按状态分列，普通阅读和投稿笔记不会变成其他工作流', async t => {
  const ctx = await setup(t);
  await writeNote(ctx.notesDir, 'experiments/baseline.md', { data: { title: '基线', status: 'running' }, body: '正文' });
  await writeNote(ctx.notesDir, 'submissions/paper.md', { data: { status: 'under-review' }, body: '旧投稿' });
  await writeNote(ctx.notesDir, 'reading/ch03.md', { data: { status: 'stuck' }, body: '旧章节' });
  await ctx.indexer.scan();
  const board = ctx.items.board('experiment');
  assert.equal(board.total, 1);
  assert.equal(board.columns.length, 4);
  assert.equal(board.columns.find(column => column.key === 'running').items[0].title, '基线');
  assert.deepEqual(ctx.items.list('chapter'), []);
  assert.deepEqual(ctx.items.board('submission'), { workflow: null, columns: [] });
});

test('旧审稿和习题元数据保留原样，但不再生成专属派生字段', async t => {
  const ctx = await setup(t);
  const data = {
    title: '兼容项目', status: 'planned', dataset: 'panel', seed: 42,
    exercises_done: 7, exercises_total: 20,
    reviews: [{ id: 'R1', comment: '保留旧内容', response: '原回复' }]
  };
  await writeNote(ctx.notesDir, 'experiments/legacy.md', { data, body: '# 项目\n\n正文保留' });
  await ctx.indexer.scan();
  const [item] = ctx.items.list('experiment');
  for (const field of ['exercises', 'reviews', 'reviewsOpen']) assert.equal(Object.hasOwn(item, field), false);
  assert.equal(Object.hasOwn(ctx.items, 'responseLetter'), false);
  assert.equal(Object.hasOwn(ctx.items, 'parseReviewComments'), false);
  assert.deepEqual(item.data, data);
  const original = await readNote(ctx.notesDir, item.path);
  await ctx.items.setStatus('experiment', item.path, 'done', item.hash);
  const written = await readNote(ctx.notesDir, item.path);
  assert.deepEqual(written.data, { ...data, status: 'done' });
  assert.equal(written.body, original.body);
});

test('状态更新用 hash 防覆盖，并逐字保留非目标 YAML', async t => {
  const ctx = await setup(t);
  const relative = 'experiments/exp-date.md';
  await fs.mkdir(path.join(ctx.notesDir, 'experiments'));
  const raw = [
    '---', '# 保留注释', 'status: planned # 当前状态', 'day: "2026-08-11"',
    'description: |', '  第一行', '  第二行', 'meta: &meta {nested: [one, two]}',
    'copy: *meta', 'count: 4', 'enabled: true', 'empty: null', '---', '正文保持', ''
  ].join('\n');
  await fs.writeFile(path.join(ctx.notesDir, relative), raw);
  await ctx.indexer.scan();
  const original = await readNote(ctx.notesDir, relative);
  const result = await ctx.items.setStatus('experiment', relative, 'done', original.hash);
  const written = await readNote(ctx.notesDir, relative);
  assert.equal(result.hash, written.hash);
  assert.equal(written.raw, raw.replace('status: planned # 当前状态', 'status: done # 当前状态'));
  assert.equal(written.data.day, '2026-08-11');
  assert.deepEqual(written.data.meta, { nested: ['one', 'two'] });
  assert.deepEqual(written.data.copy, { nested: ['one', 'two'] });
  assert.equal(written.data.count, 4);
  assert.equal(written.data.enabled, true);
  assert.equal(written.data.empty, null);
  assert.equal(written.body, '正文保持\n');
  await writeNote(ctx.notesDir, relative, { data: { ...written.data, external: '保留' }, body: written.body });
  const current = await readNote(ctx.notesDir, relative);
  await assert.rejects(() => ctx.items.setStatus('experiment', relative, 'running', result.hash), error => error.status === 409);
  await assert.rejects(() => ctx.items.setStatus('experiment', relative, 'running'), error => error.status === 409);
  assert.equal((await readNote(ctx.notesDir, relative)).hash, current.hash);
});

test('非法状态被拒绝，文件不改动', async t => {
  const ctx = await setup(t);
  const before = await writeNote(ctx.notesDir, 'experiments/project.md', { data: { status: 'planned' }, body: '正文' });
  await assert.rejects(() => ctx.items.setStatus('experiment', before.path, 'accepted', before.hash), /不是.*合法状态/);
  assert.equal((await readNote(ctx.notesDir, before.path)).hash, before.hash);
});
