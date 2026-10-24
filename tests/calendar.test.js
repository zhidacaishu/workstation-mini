const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createCalendar, formatBlock, padTime, CELL_ENTRY_LIMIT } = require('../src/calendar');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { writeNote } = require('../src/vault/note');

// 2026-08-10 是周一。8 月网格覆盖 2026-07-27 ~ 2026-09-06。
const FIXED_NOW = new Date(2026, 7, 10, 14, 30);

async function setup() {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cal-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const config = loadConfig({ vaultDir, dbPath: ':memory:', device: 'desktop' });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const calendar = createCalendar({ config, db, indexer, now: () => FIXED_NOW });

  return {
    calendar, config, db, indexer, notesDir, vaultDir,
    async note(relativePath, options) {
      await writeNote(notesDir, relativePath, options);
      await indexer.scan();
    },
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

function cellsOf(grid) {
  return new Map(grid.weeks.flat().map(cell => [cell.date, cell]));
}

test('网格是 6×7，周一起，整月完整落在里面', async () => {
  const ctx = await setup();
  try {
    const grid = await ctx.calendar.month('2026-08');

    assert.equal(grid.weeks.length, 6);
    assert.ok(grid.weeks.every(week => week.length === 7));
    assert.equal(grid.from, '2026-07-27');
    assert.equal(grid.to, '2026-09-06');
    assert.deepEqual(grid.weekdayHeaders, ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);

    const cells = cellsOf(grid);
    assert.equal(cells.size, 42);
    assert.equal(cells.get('2026-08-01').inMonth, true);
    assert.equal(cells.get('2026-08-31').inMonth, true);
    assert.equal(cells.get('2026-07-27').inMonth, false, '上月的补格');
    assert.equal(cells.get('2026-09-06').inMonth, false, '下月的补格');
  } finally {
    await ctx.cleanup();
  }
});

test('今天、周末、月份归属这三个标记都对', async () => {
  const ctx = await setup();
  try {
    const cells = cellsOf(await ctx.calendar.month('2026-08'));

    assert.equal(cells.get('2026-08-10').isToday, true);
    assert.equal(cells.get('2026-08-11').isToday, false);
    assert.equal(cells.get('2026-08-15').isWeekend, true, '周六');
    assert.equal(cells.get('2026-08-16').isWeekend, true, '周日');
    assert.equal(cells.get('2026-08-14').isWeekend, false, '周五');
    assert.equal(cells.get('2026-08-10').dayOfMonth, 10);
    assert.equal(cells.get('2026-08-10').weekday, '周一');
  } finally {
    await ctx.cleanup();
  }
});

test('缺省月份就是当月，翻月导航指向前后一个月', async () => {
  const ctx = await setup();
  try {
    const grid = await ctx.calendar.month();
    assert.equal(grid.month, '2026-08');
    assert.equal(grid.prevMonth, '2026-07');
    assert.equal(grid.nextMonth, '2026-09');
    assert.equal(grid.thisMonth, '2026-08');
    assert.equal(grid.today, '2026-08-10');
    assert.equal(grid.label, '2026 年 8 月');

    const december = await ctx.calendar.month('2026-12');
    assert.equal(december.nextMonth, '2027-01', '跨年');
    assert.equal(december.thisMonth, '2026-08', 'thisMonth 始终是真实的当月');
  } finally {
    await ctx.cleanup();
  }
});

test('截止与待办落到各自的格子，逾期项带 overdue 标记', async () => {
  const ctx = await setup();
  try {
    await ctx.note('submissions/aer.md', {
      data: { status: 'drafting', journal: 'AER', deadline: '2026-08-20' },
      body: '# 投稿\n'
    });
    await ctx.note('research/待办.md', {
      body: '# 待办\n\n- [ ] 交材料 @2026-08-14\n- [ ] 早该做的 @2026-08-03\n'
    });

    const cells = cellsOf(await ctx.calendar.month('2026-08'));

    const deadline = cells.get('2026-08-20').entries;
    assert.equal(deadline.length, 1);
    assert.equal(deadline[0].source, '投稿追踪');
    assert.equal(deadline[0].detail, 'AER');
    assert.equal(deadline[0].overdue, false);

    assert.equal(cells.get('2026-08-14').entries[0].label, '交材料');
    assert.equal(cells.get('2026-08-14').entries[0].source, '待办');
    assert.equal(cells.get('2026-08-03').entries[0].overdue, true, '早于今天');
    assert.equal(cells.get('2026-08-05').entries.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('一天条目太多时截断并报出还剩几条', async () => {
  const ctx = await setup();
  try {
    const lines = Array.from({ length: CELL_ENTRY_LIMIT + 3 }, (unused, index) => (
      `- [ ] 第 ${index + 1} 件事 @2026-08-18`
    ));
    await ctx.note('research/待办.md', { body: `# 待办\n\n${lines.join('\n')}\n` });

    const cell = cellsOf(await ctx.calendar.month('2026-08')).get('2026-08-18');
    assert.equal(cell.entryCount, CELL_ENTRY_LIMIT + 3);
    assert.equal(cell.entries.length, CELL_ENTRY_LIMIT, '格子里只放得下这么多');
    assert.equal(cell.overflow, 3);
  } finally {
    await ctx.cleanup();
  }
});

test('时间块与日记标记只出现在写了日记的那天', async () => {
  const ctx = await setup();
  try {
    await ctx.note('diary/2026-08-12.md', {
      data: { plan: ['09:00-11:00 写引言', '不带时间的一条'] },
      body: '# 日记\n'
    });
    await ctx.note('diary/2026-08-13.md', { data: { mood: 3 }, body: '# 日记\n' });

    const cells = cellsOf(await ctx.calendar.month('2026-08'));

    assert.equal(cells.get('2026-08-12').hasDiary, true);
    assert.deepEqual(cells.get('2026-08-12').plan, [
      { from: '09:00', to: '11:00', what: '写引言' },
      { from: '', to: '', what: '不带时间的一条' }
    ]);

    assert.equal(cells.get('2026-08-13').hasDiary, true, '写了日记但没排时间块');
    assert.deepEqual(cells.get('2026-08-13').plan, []);

    assert.equal(cells.get('2026-08-14').hasDiary, false);
    assert.deepEqual(cells.get('2026-08-14').plan, []);
  } finally {
    await ctx.cleanup();
  }
});

test('没有卡片时复习负荷全是 0，不是缺格子', async () => {
  const ctx = await setup();
  try {
    const grid = await ctx.calendar.month('2026-08');
    assert.ok(grid.weeks.flat().every(cell => cell.reviewDue === 0));
    assert.equal(grid.peakReview, 0);
    assert.equal(grid.backlog, 0);
    assert.equal(grid.totals.reviewDue, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('汇总数字和格子里的内容对得上', async () => {
  const ctx = await setup();
  try {
    await ctx.note('research/待办.md', {
      body: '# 待办\n\n- [ ] A @2026-08-14\n- [ ] B @2026-08-14\n- [ ] C @2026-08-20\n'
    });
    await ctx.note('diary/2026-08-12.md', {
      data: { plan: ['09:00-11:00 写引言', '14:00-16:00 跑回归'] },
      body: '# 日记\n'
    });

    const grid = await ctx.calendar.month('2026-08');
    assert.equal(grid.totals.entries, 3);
    assert.equal(grid.totals.plan, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('窗口外的日期不进网格', async () => {
  const ctx = await setup();
  try {
    await ctx.note('research/待办.md', {
      // 网格是 2026-07-27 ~ 2026-09-06，这两个都在外面。
      body: '# 待办\n\n- [ ] 太早 @2026-07-26\n- [ ] 太晚 @2026-09-07\n'
    });

    const grid = await ctx.calendar.month('2026-08');
    assert.equal(grid.totals.entries, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('历史月份也能渲染 —— deadlines() 只能向前看，日历不能', async () => {
  const ctx = await setup();
  try {
    await ctx.note('research/待办.md', { body: '# 待办\n\n- [ ] 三月的事 @2026-03-12\n' });

    const grid = await ctx.calendar.month('2026-03');
    const cells = cellsOf(grid);
    assert.equal(grid.month, '2026-03');
    assert.equal(cells.get('2026-03-12').entries.length, 1);
    assert.equal(cells.get('2026-03-12').entries[0].overdue, true);
    assert.ok(grid.weeks.flat().every(cell => !cell.isToday), '今天不在这个月里');
  } finally {
    await ctx.cleanup();
  }
});

test('day() 给出一天的详情', async () => {
  const ctx = await setup();
  try {
    await ctx.note('diary/2026-08-12.md', {
      data: { plan: ['09:00-11:00 写引言'] },
      body: '# 日记\n'
    });
    await ctx.note('research/待办.md', { body: '# 待办\n\n- [ ] 交材料 @2026-08-12\n' });

    const detail = await ctx.calendar.day('2026-08-12');
    assert.equal(detail.date, '2026-08-12');
    assert.equal(detail.weekday, '周三');
    assert.equal(detail.isToday, false);
    assert.equal(detail.isPast, false);
    assert.equal(detail.daysFromToday, 2);
    assert.equal(detail.entries.length, 1);
    assert.equal(detail.plan.length, 1);
    assert.equal(detail.diary.exists, true);
    assert.equal(detail.diary.path, 'diary/2026-08-12.md');

    const today = await ctx.calendar.day();
    assert.equal(today.date, '2026-08-10');
    assert.equal(today.isToday, true);

    const past = await ctx.calendar.day('2026-08-01');
    assert.equal(past.isPast, true);
    assert.equal(past.daysFromToday, -9);
    assert.equal(past.diary.exists, false);
    assert.deepEqual(past.plan, []);
  } finally {
    await ctx.cleanup();
  }
});

test('icsEntries 把截止做成全天、时间块做成定时，并按日期排序', async () => {
  const ctx = await setup();
  try {
    await ctx.note('submissions/aer.md', {
      data: { status: 'drafting', deadline: '2026-08-20' },
      body: '# 投稿\n'
    });
    await ctx.note('diary/2026-08-12.md', {
      data: { plan: ['14:00-16:00 跑回归', '09:00-11:00 写引言'] },
      body: '# 日记\n'
    });

    const entries = ctx.calendar.icsEntries({});
    assert.deepEqual(entries.map(entry => [entry.date, entry.from || '全天']), [
      ['2026-08-12', '09:00'],
      ['2026-08-12', '14:00'],
      ['2026-08-20', '全天']
    ]);
    assert.equal(entries[0].summary, '写引言');
    assert.equal(entries[0].categories, '时间块');
    assert.equal(entries[2].categories, '投稿追踪');
    assert.ok(entries.every(entry => entry.key), '每条都要有稳定的 key 来派生 UID');
  } finally {
    await ctx.cleanup();
  }
});

test('addPlanBlock 返回整理好的列表，并把时间补零', async () => {
  const ctx = await setup();
  try {
    const result = await ctx.calendar.addPlanBlock('2026-08-12', { from: '9:00', to: '11:00', what: '写引言' });
    assert.equal(result.block, '09:00-11:00 写引言');
    assert.equal(result.path, 'diary/2026-08-12.md');
    assert.deepEqual(result.plan, [{ from: '09:00', to: '11:00', what: '写引言' }]);
  } finally {
    await ctx.cleanup();
  }
});

test('新日记独占创建抢输后重读外部文件并合并 plan', async () => {
  const ctx = await setup();
  const originalLink = fs.link;
  try {
    const notePath = 'diary/2026-08-22.md';
    let intercepted = false;
    fs.link = async (source, target) => {
      if (!intercepted && target.endsWith(path.join('diary', '2026-08-22.md'))) {
        intercepted = true;
        await fs.writeFile(target, [
          '---', 'title: 外部创建', 'custom: 保留', 'plan: ["08:00-09:00 外部计划"]', '---', '',
          '# 外部日记', '', '用户正文。', ''
        ].join('\n'), 'utf8');
      }
      return originalLink(source, target);
    };

    await ctx.calendar.addPlanBlock('2026-08-22', {
      from: '09:00', to: '10:00', what: '应用计划'
    });
    assert.equal(intercepted, true, '测试必须命中独占创建前的外部创建窗口');
    const note = await require('../src/vault/note').readNote(ctx.notesDir, notePath);
    assert.deepEqual(note.data.plan, ['08:00-09:00 外部计划', '09:00-10:00 应用计划']);
    assert.equal(note.data.custom, '保留');
    assert.match(note.body, /外部日记/);
    assert.match(note.body, /用户正文/);
  } finally {
    fs.link = originalLink;
    await ctx.cleanup();
  }
});

test('并发排期串行重读，同项去重且不同项都保留', async () => {
  const ctx = await setup();
  try {
    const blocks = [
      { from: '09:00', to: '10:00', what: 'A' },
      { from: '10:00', to: '11:00', what: 'B' },
      { from: '09:00', to: '10:00', what: 'A' }
    ];
    const results = await Promise.all(blocks.map(block => ctx.calendar.addPlanBlock('2026-08-22', block)));
    const note = await require('../src/vault/note').readNote(ctx.notesDir, 'diary/2026-08-22.md');
    assert.deepEqual(note.data.plan, ['09:00-10:00 A', '10:00-11:00 B']);
    assert.ok(results.every(result => result.hash));
  } finally {
    await ctx.cleanup();
  }
});

test('排期只改 plan 节点，保留其它 frontmatter 与正文原文', async () => {
  const ctx = await setup();
  try {
    const relative = 'diary/2026-08-12.md';
    const raw = [
      '---', '# 保留注释', 'title: "2026-08-12"', 'plan: ["09:00-10:00 A"] # 原计划',
      'description: |', '  第一行', '  第二行', 'meta: &meta {nested: [one, two]}',
      'copy: *meta', '---', '', '# 正文', ''
    ].join('\n');
    await fs.mkdir(path.join(ctx.notesDir, 'diary'), { recursive: true });
    await fs.writeFile(path.join(ctx.notesDir, relative), raw);
    await ctx.indexer.scan();

    await ctx.calendar.addPlanBlock('2026-08-12', { from: '10:00', to: '11:00', what: 'B' });
    const written = await require('../src/vault/note').readNote(ctx.notesDir, relative);
    assert.deepEqual(written.data.plan, ['09:00-10:00 A', '10:00-11:00 B']);
    assert.equal(
      written.raw.replace(/plan: .* # 原计划/, 'plan: ["09:00-10:00 A"] # 原计划'),
      raw,
      'plan 值之外的原文必须逐字保留'
    );
  } finally {
    await ctx.cleanup();
  }
});

test('stale calendar hash 返回 409 且不改磁盘', async () => {
  const ctx = await setup();
  try {
    await ctx.note('diary/2026-08-12.md', { data: { plan: ['09:00-10:00 A'] }, body: '正文\n' });
    const before = await require('../src/vault/note').readNote(ctx.notesDir, 'diary/2026-08-12.md');
    await ctx.calendar.addPlanBlock('2026-08-12', { what: 'B', expectedHash: before.hash });
    const current = await require('../src/vault/note').readNote(ctx.notesDir, 'diary/2026-08-12.md');
    await assert.rejects(
      () => ctx.calendar.addPlanBlock('2026-08-12', { what: 'C', expectedHash: before.hash }),
      error => error.status === 409
    );
    assert.equal((await require('../src/vault/note').readNote(ctx.notesDir, 'diary/2026-08-12.md')).hash, current.hash);
  } finally {
    await ctx.cleanup();
  }
});

test('addPlanBlock 的校验', async () => {
  const ctx = await setup();
  try {
    const fails = (date, block, pattern) => assert.rejects(
      () => ctx.calendar.addPlanBlock(date, block), pattern
    );

    await fails('2026-02-31', { what: 'x' }, /日期格式/);
    await fails('2026-08-12', { what: '' }, /不能为空/);
    await fails('2026-08-12', { what: '  ' }, /不能为空/);
    await fails('2026-08-12', { from: '09:00', what: 'x' }, /要么都填/);
    await fails('2026-08-12', { to: '09:00', what: 'x' }, /要么都填/);
    await fails('2026-08-12', { from: '9:5', to: '10:00', what: 'x' }, /时间格式/);
    await fails('2026-08-12', { from: '24:00', to: '25:00', what: 'x' }, /时间格式/);
  } finally {
    await ctx.cleanup();
  }
});

test('时间块的字符串格式', () => {
  assert.equal(padTime('9:00'), '09:00');
  assert.equal(padTime('09:00'), '09:00');
  assert.equal(formatBlock({ from: '9:00', to: '11:00', what: '写引言' }), '09:00-11:00 写引言');
  assert.equal(formatBlock({ from: '', to: '', what: '读文献' }), '读文献');
});

test('日记尚未进入索引时，当天详情仍从磁盘读取 hash 和计划', async () => {
  const ctx = await setup();
  try {
    const relative = 'diary/2026-08-12.md';
    await writeNote(ctx.notesDir, relative, {
      data: { plan: ['09:00-10:00 磁盘计划'] },
      body: '正文\n'
    });
    assert.equal(ctx.db.getNote(relative), undefined);

    const detail = await ctx.calendar.day('2026-08-12');
    assert.equal(detail.diary.exists, true);
    assert.notEqual(detail.diary.hash, '');
    assert.deepEqual(detail.plan, [{ from: '09:00', to: '10:00', what: '磁盘计划' }]);
  } finally {
    await ctx.cleanup();
  }
});

test('当天详情使用磁盘上的新计划而不是陈旧索引', async () => {
  const ctx = await setup();
  try {
    const relative = 'diary/2026-08-12.md';
    await ctx.note(relative, { data: { plan: ['09:00-10:00 旧计划'] }, body: '正文\n' });
    await writeNote(ctx.notesDir, relative, { data: { plan: ['11:00-12:00 新计划'] }, body: '正文\n' });

    const detail = await ctx.calendar.day('2026-08-12');
    assert.deepEqual(detail.plan, [{ from: '11:00', to: '12:00', what: '新计划' }]);
  } finally {
    await ctx.cleanup();
  }
});

test('日记在索引之外被删掉时，当天详情降级而不是 500', async () => {
  // diary.exists() 查的是索引，hash 读的是磁盘。在 Obsidian 里删掉一篇日记、
  // 而监听还没对账完的那个窗口里两者会不一致；这个函数同时供日历页和提醒调度器
  // 轮询的 agenda 接口使用，抛出去等于日历打不开、提醒也一起停摆。
  const ctx = await setup();
  try {
    const relative = 'diary/2026-08-12.md';
    await ctx.note(relative, { data: { plan: ['09:00-10:00 A'] }, body: '正文\n' });

    const indexed = await ctx.calendar.day('2026-08-12');
    assert.equal(indexed.diary.exists, true);
    assert.notEqual(indexed.diary.hash, '');

    // 绕过 indexer 直接删文件，索引因此停留在旧状态。
    await fs.rm(path.join(ctx.notesDir, relative));
    assert.ok(ctx.db.getNote(relative), '前提：索引里还留着这条记录');

    const stale = await ctx.calendar.day('2026-08-12');
    assert.equal(stale.diary.exists, false, '磁盘说了算');
    assert.equal(stale.diary.hash, '');
    assert.deepEqual(stale.plan, [], '文件没了就不该再报计划');
    assert.equal(stale.date, '2026-08-12');
  } finally {
    await ctx.cleanup();
  }
});

test('手写成标量的 plan 不会被排新块时覆盖掉', async () => {
  const ctx = await setup();
  try {
    // 在 Obsidian 里手写 `plan: 09:00-10:00 写论文` 是完全合理的 YAML。
    // 以前只认数组，于是这里会被当成空列表，新块一排就把原来那条整条抹掉。
    await ctx.note('diary/2026-08-12.md', {
      raw: '---\ntitle: "2026-08-12"\nplan: 09:00-10:00 写论文\nmood: 4\n---\n\n正文\n'
    });

    const result = await ctx.calendar.addPlanBlock('2026-08-12', { from: '14:00', to: '15:00', what: '组会' });

    assert.deepEqual(result.plan.map(block => `${block.from}-${block.to} ${block.what}`), [
      '09:00-10:00 写论文',
      '14:00-15:00 组会'
    ]);

    const day = await ctx.calendar.day('2026-08-12');
    assert.equal(day.plan.length, 2, '原来手写的那条必须还在');
    // 其余 frontmatter 一个字都不能动。
    const raw = await fs.readFile(path.join(ctx.notesDir, 'diary', '2026-08-12.md'), 'utf8');
    assert.match(raw, /mood: 4/);
  } finally {
    await ctx.cleanup();
  }
});

test('plan 排序按时刻而不是字符串，手写的 9:00 排在 10:00 前面', async () => {
  const ctx = await setup();
  try {
    await ctx.note('diary/2026-08-12.md', {
      raw: '---\ntitle: "2026-08-12"\nplan:\n  - 10:00-11:00 组会\n  - 9:00-9:30 晨读\n---\n\n正文\n'
    });

    // '9:00' > '10:00' 是真的（比的是首字符），按字符串排会把晨读甩到最后。
    const result = await ctx.calendar.addPlanBlock('2026-08-12', { from: '14:00', to: '15:00', what: '写作' });
    assert.deepEqual(result.plan.map(block => block.what), ['晨读', '组会', '写作']);
    assert.deepEqual(result.plan.map(block => block.from), ['09:00', '10:00', '14:00'], '读出来要补零');
  } finally {
    await ctx.cleanup();
  }
});
