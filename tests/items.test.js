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

async function setup() {
  const notesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-items-'));
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const items = createItems({ db, notesDir });
  return {
    notesDir, db, indexer, items,
    async cleanup() {
      db.close();
      await fs.rm(notesDir, { recursive: true, force: true });
    }
  };
}

// ── 任务抽取 ──────────────────────────────────────────

test('从正文抽取 - [ ] 待办，识别完成状态', () => {
  const tasks = extractTasks([
    '# 今天',
    '- [ ] 跑一遍稳健性检验',
    '- [x] 补充描述性统计',
    '* [X] 大写也认',
    '+ [ ] 加号也认',
    '- 这行不是任务',
    '普通正文'
  ].join('\n'));

  assert.equal(tasks.length, 4);
  assert.equal(tasks[0].title, '跑一遍稳健性检验');
  assert.equal(tasks[0].done, false);
  assert.equal(tasks[0].line, 2);
  assert.equal(tasks[1].done, true);
  assert.equal(tasks[2].done, true, '大写 X 也算完成');
});

test('@日期 被识别成截止日期，并从显示文字里去掉', () => {
  const [task] = extractTasks('- [ ] 给导师发邮件 @2026-08-10');
  assert.equal(task.due, '2026-08-10');
  assert.equal(task.title, '给导师发邮件', '显示时不该还挂着 @日期');
  assert.match(task.text, /@2026-08-10/, '原文保留');
});

test('代码块里的 - [ ] 不算任务', () => {
  const tasks = extractTasks([
    '- [ ] 真待办',
    '',
    '```markdown',
    '- [ ] 这是文档示例',
    '- [x] 这也是',
    '```',
    '',
    '行内 `- [ ] 也不算` 结束。'
  ].join('\n'));

  assert.deepEqual(tasks.map(t => t.title), ['真待办']);
});

test('待办排序：逾期 → 今天 → 有期限 → 无期限', () => {
  const sorted = sortTasks([
    { path: 'a.md', line: 1, title: '无期限', due: null },
    { path: 'a.md', line: 2, title: '将来', due: '2026-09-01' },
    { path: 'a.md', line: 3, title: '逾期', due: '2026-08-01' },
    { path: 'a.md', line: 4, title: '今天', due: '2026-08-06' }
  ], '2026-08-06');

  assert.deepEqual(sorted.map(t => t.title), ['逾期', '今天', '将来', '无期限']);
});

test('任务汇总区分逾期与今天到期', () => {
  const stats = summarize([
    { done: false, due: '2026-08-01' },
    { done: false, due: '2026-08-06' },
    { done: false, due: null },
    { done: true, due: '2026-08-01' }
  ], '2026-08-06');

  assert.equal(stats.total, 4);
  assert.equal(stats.open, 3);
  assert.equal(stats.done, 1);
  assert.equal(stats.overdue, 1, '已完成的逾期项不该再算逾期');
  assert.equal(stats.dueToday, 1);
});

// 任务是派生数据，真相永远是 Markdown 里那一行。
test('改了正文里的待办，索引跟着变，不会出现两份数据打架', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', {
      body: '# 今天\n\n- [ ] 跑稳健性检验\n- [ ] 写引言'
    });
    await ctx.indexer.scan();
    assert.equal(ctx.db.listTasks().length, 2);

    // 在 Markdown 里勾掉一个
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', {
      body: '# 今天\n\n- [x] 跑稳健性检验\n- [ ] 写引言'
    });
    await ctx.indexer.scan();

    const open = ctx.db.listTasks();
    assert.equal(open.length, 1, '勾掉的那条应离开待办列表');
    assert.equal(open[0].title, '写引言');
    assert.equal(ctx.db.listTasks({ includeDone: true }).length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('删掉笔记，它的任务一起消失', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'a.md', { body: '- [ ] 待办' });
    await ctx.indexer.scan();
    assert.equal(ctx.db.listTasks().length, 1);

    await fs.rm(path.join(ctx.notesDir, 'a.md'));
    await ctx.indexer.scan();
    assert.equal(ctx.db.listTasks().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

// ── 状态机 ────────────────────────────────────────────

test('只校验目标状态合法，不限制从哪能到哪', () => {
  assert.equal(workflows.isValidStatus('submission', 'under-review'), true);
  assert.equal(workflows.isValidStatus('submission', '瞎写的'), false);
  assert.equal(workflows.isValidStatus('不存在的流程', 'todo'), false);

  // 科研过程会往回走：已接收的稿子又要改，这不该被拦。
  assert.equal(workflows.isValidStatus('submission', 'accepted'), true);
  assert.equal(workflows.isValidStatus('submission', 'major-revision'), true);
});

test('缺失或非法的状态回退到初始状态，而不是留空', () => {
  assert.equal(workflows.normalizeStatus('experiment', undefined), 'planned');
  assert.equal(workflows.normalizeStatus('experiment', '乱写'), 'planned');
  assert.equal(workflows.normalizeStatus('experiment', 'running'), 'running');
  assert.equal(workflows.normalizeStatus('chapter', ''), 'todo');
});

test('三类条目共用同一套看板结构，不是三份代码', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', {
      data: { title: '基线模型', status: 'running' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'submissions/platform-pricing.md', {
      data: { title: '平台定价', status: 'under-review' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'reading/econ/ch03.md', {
      data: { title: '第三章', status: 'stuck' }, body: '正文'
    });
    await ctx.indexer.scan();

    for (const [key, expected] of [['experiment', 'running'], ['submission', 'under-review'], ['chapter', 'stuck']]) {
      const board = ctx.items.board(key);
      assert.equal(board.total, 1, `${key} 应有 1 个条目`);
      const filled = board.columns.filter(column => column.items.length > 0);
      assert.equal(filled.length, 1);
      assert.equal(filled[0].key, expected);
      // 空列也保留，才看得出「这一档现在是空的」。
      assert.ok(board.columns.length > 1);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('改状态只动 frontmatter 的 status，正文与其它字段原样保留', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', {
      data: { title: '基线模型', status: 'planned', dataset: 'panel-2024', seed: 42 },
      body: '# 基线模型\n\n参数见下表。\n\n- [ ] 跑一遍'
    });
    await ctx.indexer.scan();

    const before = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    await ctx.items.setStatus('experiment', 'experiments/exp-001.md', 'done', before.hash);

    const note = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    assert.equal(note.data.status, 'done');
    assert.equal(note.data.dataset, 'panel-2024', '其它 frontmatter 字段不能丢');
    assert.equal(note.data.seed, 42);
    assert.match(note.body, /参数见下表/, '正文必须原样保留');
    assert.match(note.body, /- \[ \] 跑一遍/);
  } finally {
    await ctx.cleanup();
  }
});

test('状态更新用 hash 防止覆盖外部编辑，并逐字保留非目标 YAML', async () => {
  const ctx = await setup();
  try {
    const relative = 'experiments/exp-date.md';
    await fs.mkdir(path.join(ctx.notesDir, 'experiments'), { recursive: true });
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
    const disk = await readNote(ctx.notesDir, relative);
    await assert.rejects(
      () => ctx.items.setStatus('experiment', relative, 'running', result.hash),
      error => error.status === 409
    );
    assert.equal((await readNote(ctx.notesDir, relative)).hash, disk.hash);

    // 不带版本的调用要被拒绝，而不是当成「跳过检查」直接写 —— 否则任何不带
    // expectedHash 的调用方都能绕过这层保护。
    await assert.rejects(
      () => ctx.items.setStatus('experiment', relative, 'running'),
      error => error.status === 409 && /缺少条目版本/.test(error.message)
    );
    assert.equal((await readNote(ctx.notesDir, relative)).hash, disk.hash);
  } finally {
    await ctx.cleanup();
  }
});

test('非法状态被拒绝，文件不被改动', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'experiments/exp-001.md', {
      data: { status: 'planned' }, body: '正文'
    });
    await ctx.indexer.scan();

    await assert.rejects(
      () => ctx.items.setStatus('experiment', 'experiments/exp-001.md', 'accepted'),
      /不是.*合法状态/,
      'accepted 属于投稿流程，不属于实验流程'
    );

    const note = await readNote(ctx.notesDir, 'experiments/exp-001.md');
    assert.equal(note.data.status, 'planned');
  } finally {
    await ctx.cleanup();
  }
});

test('章节进度算出习题完成度，没填就是 null 而不是 0%', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'reading/econ/ch03.md', {
      data: { title: '第三章', status: 'exercises', exercises_done: 7, exercises_total: 20 }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'reading/econ/ch04.md', {
      data: { title: '第四章', status: 'todo' }, body: '正文'
    });
    await ctx.indexer.scan();

    const chapters = ctx.items.list('chapter');
    const ch03 = chapters.find(c => c.path.endsWith('ch03.md'));
    const ch04 = chapters.find(c => c.path.endsWith('ch04.md'));

    assert.deepEqual(ch03.exercises, { done: 7, total: 20, percent: 35 });
    assert.equal(ch04.exercises, null, '没填题数就不该显示 0%');
  } finally {
    await ctx.cleanup();
  }
});

// ── 审稿意见 ──────────────────────────────────────────

test('审稿意见逐条带状态，未回应的数量单独统计', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/platform.md', {
      data: {
        title: '平台定价', status: 'major-revision',
        reviews: [
          { id: 'R1.1', comment: '识别策略不清楚', status: 'done', response: '已在 3.2 节补充' },
          { id: 'R1.2', comment: '缺少稳健性检验' },
          { id: 'R2.1', comment: '文献综述不全', status: 'done', response: '已补 5 篇' }
        ]
      },
      body: '正文'
    });
    await ctx.indexer.scan();

    const [paper] = ctx.items.list('submission');
    assert.equal(paper.reviews.length, 3);
    assert.equal(paper.reviewsOpen, 1, '大修时漏回一条意见代价很大，未回应数要显眼');
    assert.equal(paper.reviews[0].done, true);
    assert.equal(paper.reviews[1].done, false);
  } finally {
    await ctx.cleanup();
  }
});

test('导出 response letter 草稿，未回应的显式标出来', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/platform.md', {
      data: {
        title: '平台定价', status: 'major-revision',
        reviews: [
          { id: 'R1.1', comment: '识别策略不清楚', status: 'done', response: '已在 3.2 节补充' },
          { id: 'R1.2', comment: '缺少稳健性检验' }
        ]
      },
      body: '正文'
    });
    await ctx.indexer.scan();

    const letter = ctx.items.responseLetter(ctx.items.list('submission')[0]);
    assert.match(letter, /Response to Reviewers/);
    assert.match(letter, /## R1\.1/);
    assert.match(letter, /> 识别策略不清楚/);
    assert.match(letter, /已在 3\.2 节补充/);
    assert.match(letter, /（尚未回应）/, '没回应的必须显式标出，不能悄悄跳过');
  } finally {
    await ctx.cleanup();
  }
});

test('没有审稿意见时不导出空壳', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/a.md', { data: { status: 'drafting' }, body: '正文' });
    await ctx.indexer.scan();
    assert.equal(ctx.items.responseLetter(ctx.items.list('submission')[0]), '');
  } finally {
    await ctx.cleanup();
  }
});
