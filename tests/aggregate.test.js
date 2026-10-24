const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createAggregator, asDateString } = require('../src/aggregate');
const { renderRetrospective, renderBriefing } = require('../src/briefing');
const { writeNote } = require('../src/vault/note');
const { renderLiteratureNote } = require('../src/annotations');
const { loadConfig } = require('../src/config');

const FIXED_NOW = new Date(2026, 2, 17, 9, 0); // 2026-03-17 周二
const TODAY = '2026-03-17';

async function setup() {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-agg-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'reviews'), { recursive: true });

  const config = loadConfig({ vaultDir, dbPath: ':memory:', device: 'desktop' });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const aggregate = createAggregator({ config, db, now: () => FIXED_NOW });

  return {
    vaultDir, notesDir, db, indexer, aggregate, config,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('frontmatter 里的日期无论是字符串还是 Date 都还原成 YYYY-MM-DD', () => {
  assert.equal(asDateString('2026-04-15'), '2026-04-15');
  assert.equal(asDateString(new Date('2026-04-15T00:00:00.000Z')), '2026-04-15');
  assert.equal(asDateString('2026-04-15T00:00:00.000Z'), '2026-04-15');
  assert.equal(asDateString(''), '');
  assert.equal(asDateString(null), '');
  assert.equal(asDateString('随便写的'), '');
});

// deadline 散在邮件、微信和脑子里，聚合本身就是价值。
test('deadline 从投稿、实验和待办三处聚到一条时间轴', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/a.md', {
      data: { title: '平台定价', status: 'under-review', journal: 'ISR', deadline: '2026-03-25' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'experiments/e1.md', {
      data: { title: '基线', status: 'running', deadline: '2026-03-20' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'diary/2026-03-17.md', {
      body: '- [ ] 给导师发邮件 @2026-03-18\n- [ ] 早就该做的 @2026-03-01'
    });
    await ctx.indexer.scan();

    const timeline = ctx.aggregate.deadlines(TODAY);
    assert.deepEqual(
      timeline.map(entry => entry.date),
      ['2026-03-01', '2026-03-18', '2026-03-20', '2026-03-25'],
      '应按日期升序，逾期的排最前'
    );
    assert.equal(timeline[0].overdue, true);
    assert.equal(timeline[3].detail, 'ISR');
    // 用集合比较：来源的先后顺序由日期决定，不该在这里断言中文字符串的排序。
    assert.deepEqual(
      new Set(timeline.map(entry => entry.source)),
      new Set(['实验记录', '投稿追踪', '待办'])
    );
  } finally {
    await ctx.cleanup();
  }
});

test('逾期的 deadline 永远保留，不因为过期就藏起来', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/old.md', {
      data: { title: '早该投的', status: 'drafting', deadline: '2025-01-01' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'submissions/far.md', {
      data: { title: '很久以后', status: 'drafting', deadline: '2027-01-01' }, body: '正文'
    });
    await ctx.indexer.scan();

    const timeline = ctx.aggregate.deadlines(TODAY, 21);
    assert.equal(timeline.length, 1, '视野外的未来项不显示');
    assert.equal(timeline[0].label, '早该投的', '但逾期的必须留着');
  } finally {
    await ctx.cleanup();
  }
});

test('今日快照汇总各模块的实时状态', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'cards', 'english.md'),
      '---\ndeck: 英语\n---\n\n## heterogeneity\n异质性\n\n## endogeneity\n内生性', 'utf8');
    await writeNote(ctx.notesDir, 'reading/econ/ch04.md', {
      data: { title: '第四章', status: 'stuck' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'experiments/e1.md', {
      data: { title: '基线', status: 'running' }, body: '- [ ] 跑完 @2026-03-10'
    });
    await writeNote(ctx.notesDir, 'lit/ABCD1234.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [{ itemID: 10, text: '识别策略', comment: '', page: '12', sortIndex: '0001' }]
      })
    });
    await ctx.indexer.scan();

    const snapshot = await ctx.aggregate.today();
    assert.equal(snapshot.date, TODAY);
    assert.equal(snapshot.weekday, '周二');
    assert.equal(snapshot.diary.writtenToday, false, '今天还没写日记');
    assert.equal(snapshot.review.fresh, 2, '两张新卡');
    assert.equal(snapshot.tasks.overdue, 1);
    assert.equal(snapshot.annotations.pending, 1);
    assert.equal(snapshot.annotations.top[0].id, 'ABCD1234:10');
    assert.equal(snapshot.attention.stuckChapters.length, 1);
    assert.equal(snapshot.attention.runningExperiments.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('时间块从日记 frontmatter 的 plan 字段读出来', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, {
      data: { title: TODAY, plan: ['09:00-11:00 写引言', '14:00-16:00 跑实验', '随手记一条没写时间的'] },
      body: '# 今天'
    });
    await ctx.indexer.scan();

    const snapshot = await ctx.aggregate.today();
    assert.equal(snapshot.diary.writtenToday, true);
    assert.deepEqual(snapshot.diary.plan[0], { from: '09:00', to: '11:00', what: '写引言' });
    assert.deepEqual(snapshot.diary.plan[1], { from: '14:00', to: '16:00', what: '跑实验' });
    assert.deepEqual(snapshot.diary.plan[2], { from: '', to: '', what: '随手记一条没写时间的' },
      '没写时间的也保留，不该被丢掉');
  } finally {
    await ctx.cleanup();
  }
});

test('没有 plan 字段时时间块为空，不报错', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, { data: { title: TODAY }, body: '# 今天' });
    await ctx.indexer.scan();
    assert.deepEqual((await ctx.aggregate.today()).diary.plan, []);
  } finally {
    await ctx.cleanup();
  }
});

// ── 回顾 ──────────────────────────────────────────────

test('周回顾区间是周一到今天', async () => {
  const ctx = await setup();
  try {
    // 2026-03-17 是周二，本周一是 03-16
    assert.deepEqual(ctx.aggregate.thisWeek(TODAY), { from: '2026-03-16', to: TODAY });
    assert.deepEqual(ctx.aggregate.thisWeek('2026-03-16'), { from: '2026-03-16', to: '2026-03-16' });
    // 周日应回溯到上周一
    assert.deepEqual(ctx.aggregate.thisWeek('2026-03-22'), { from: '2026-03-16', to: '2026-03-22' });
    assert.deepEqual(ctx.aggregate.thisMonth(TODAY), { from: '2026-03-01', to: TODAY });
  } finally {
    await ctx.cleanup();
  }
});

test('回顾数据全部从已有模块算出来，人只需写反思', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-03-16.md', {
      data: { title: '2026-03-16', mood: 4, focus_minutes: 180 }, body: '# 周一'
    });
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, {
      data: { title: TODAY, mood: 2, focus_minutes: 60 }, body: '# 周二\n- [ ] 拖了很久的事 @2026-01-01'
    });
    await ctx.indexer.scan();

    fsSync.writeFileSync(path.join(ctx.vaultDir, 'reviews', '2026-03-desktop.jsonl'), [
      JSON.stringify({ card_id: 'a', ts: '2026-03-16T10:00:00.000Z', rating: 3 }),
      JSON.stringify({ card_id: 'b', ts: '2026-03-17T10:00:00.000Z', rating: 1 }),
      JSON.stringify({ card_id: 'a', ts: '2026-03-17T11:00:00.000Z', rating: 3 }),
      // 区间外的不该算进来
      JSON.stringify({ card_id: 'c', ts: '2026-02-01T10:00:00.000Z', rating: 3 })
    ].join('\n') + '\n', 'utf8');

    const data = await ctx.aggregate.retrospective(ctx.aggregate.thisWeek(TODAY));
    assert.equal(data.days, 2);
    assert.equal(data.diary.entries, 2);
    assert.equal(data.diary.moodAverage, 3);
    assert.equal(data.diary.focusMinutes, 240);
    assert.equal(data.review.count, 3, '区间外的复习不算');
    assert.equal(data.review.cards, 2);
    assert.equal(data.review.again, 1);
    assert.equal(data.tasks.staleCount, 1, '拖了很久的待办要被看见');
  } finally {
    await ctx.cleanup();
  }
});

test('vault 不是 git 仓库时笔记改动量返回 null，页面据此不显示而不是显示 0', async () => {
  const ctx = await setup();
  try {
    assert.equal(await ctx.aggregate.writingVolume('2026-03-01'), null);
  } finally {
    await ctx.cleanup();
  }
});

test('vault 是 git 仓库时统计净增行数', async () => {
  const ctx = await setup();
  try {
    execFileSync('git', ['-C', ctx.vaultDir, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', ctx.vaultDir, 'config', 'user.email', 't@e.com']);
    execFileSync('git', ['-C', ctx.vaultDir, 'config', 'user.name', 't']);
    await writeNote(ctx.notesDir, 'a.md', { body: '一\n二\n三\n' });
    execFileSync('git', ['-C', ctx.vaultDir, 'add', '-A']);
    execFileSync('git', ['-C', ctx.vaultDir, 'commit', '-q', '-m', '第一次']);

    const volume = await ctx.aggregate.writingVolume('2020-01-01');
    assert.ok(volume, '应能统计');
    assert.ok(volume.added >= 3, `新增行数应 ≥3，实际 ${volume.added}`);
  } finally {
    await ctx.cleanup();
  }
});

// ── 渲染 ──────────────────────────────────────────────

test('回顾草稿把数字填好，只留反思给人写', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, {
      data: { title: TODAY, mood: 4, focus_minutes: 120 }, body: '# 今天'
    });
    await ctx.indexer.scan();

    const markdown = renderRetrospective(await ctx.aggregate.retrospective(ctx.aggregate.thisWeek(TODAY)));
    assert.match(markdown, /# 周回顾 2026-03-16 → 2026-03-17/);
    assert.match(markdown, /日记：2 天里写了 1 天/);
    assert.match(markdown, /平均情绪 4\.0\/5/);
    assert.match(markdown, /## 反思/);
    assert.match(markdown, /这段时间真正推进了什么/);
    assert.match(markdown, /vault 不是 git 仓库，无法统计/, '统计不了就说清楚，不编一个数字');
  } finally {
    await ctx.cleanup();
  }
});

test('简报开头一句话说完最要紧的', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'cards', 'a.md'), '## 卡一\n背面', 'utf8');
    await writeNote(ctx.notesDir, 'a.md', { body: '- [ ] 逾期的事 @2026-03-01' });
    await ctx.indexer.scan();

    const text = renderBriefing(await ctx.aggregate.today());
    assert.match(text, /# 2026-03-17 周二/);
    assert.match(text, /要复习 1 张卡/);
    assert.match(text, /1 条待办已逾期/);
    assert.match(text, /今天的日记还没写/);
    assert.match(text, /## 待办/);
  } finally {
    await ctx.cleanup();
  }
});

test('什么都没到期时简报明说，而不是给一堆空标题', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, { data: { title: TODAY }, body: '# 今天' });
    await ctx.indexer.scan();

    const text = renderBriefing(await ctx.aggregate.today());
    assert.match(text, /今天没有到期的东西。/);
    assert.ok(!text.includes('## 待办'), '没有待办就不该出现空的待办小节');
    assert.ok(!text.includes('## 临近截止'));
  } finally {
    await ctx.cleanup();
  }
});

test('回顾按本地日划区间，不按 UTC 日', async () => {
  // 复习事件的 ts 是 toISOString()，也就是 UTC 瞬时。直接 slice(0, 10) 拿到的是
  // UTC 日：东八区凌晨 0 点到 8 点记的复习会被算进前一天，于是周/月回顾在区间
  // 两端系统性数错。这条必须钉死时区跑，否则在 UTC 机器上证明不了任何事。
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-agg-tz-'));
  try {
    await fs.mkdir(path.join(vaultDir, 'notes'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'reviews'), { recursive: true });
    // 本地 2026-03-16 07:30（东八区），UTC 还停在 03-15。
    await fs.writeFile(
      path.join(vaultDir, 'reviews', '2026-03-desktop.jsonl'),
      `${JSON.stringify({ card_id: 'deck/卡', ts: '2026-03-15T23:30:00.000Z', rating: 3 })}\n`,
      'utf8'
    );

    const script = `
      const { openDatabase } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db'))});
      const { createAggregator } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'aggregate'))});
      const { loadConfig } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config'))});
      (async () => {
        const config = loadConfig({ vaultDir: ${JSON.stringify(vaultDir)}, dbPath: ':memory:', device: 'desktop' });
        const db = openDatabase(':memory:');
        const aggregate = createAggregator({ config, db, now: () => new Date(2026, 2, 17, 9, 0) });
        const onLocalDay = await aggregate.retrospective({ from: '2026-03-16', to: '2026-03-16' });
        const onUtcDay = await aggregate.retrospective({ from: '2026-03-15', to: '2026-03-15' });
        console.log(JSON.stringify({ local: onLocalDay.review.count, utc: onUtcDay.review.count }));
        db.close();
      })();
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' }
    });
    const seen = JSON.parse(output);

    assert.equal(seen.local, 1, '复习该算在本地日那一天');
    assert.equal(seen.utc, 0, 'UTC 日那一天必须是空的');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});
