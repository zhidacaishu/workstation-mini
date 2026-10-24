const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createDiary, isValidDateString, shiftDays, readNumber } = require('../src/diary');
const { toLocalDate, renderTemplate, templateVariables, loadTemplate } = require('../src/templates');
const { writeNote } = require('../src/vault/note');

async function setup(nowDate = new Date(2026, 7, 6, 14, 30)) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-diary-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const diary = createDiary({ db, config: { vaultDir, notesDir }, now: () => nowDate });

  return {
    vaultDir, notesDir, db, indexer, diary,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

// toISOString() 给的是 UTC。东八区在早上 8 点前会算成前一天，
// 「今天的日记」会开错文件 —— 这是最容易埋进去又最难发现的一类 bug。
test('日期取本地时区的年月日', () => {
  for (const moment of [
    new Date(2026, 7, 6, 0, 30),
    new Date(2026, 7, 6, 23, 30),
    new Date(2026, 0, 1, 0, 0),
    new Date(2026, 11, 31, 23, 59)
  ]) {
    const expected = [
      moment.getFullYear(),
      String(moment.getMonth() + 1).padStart(2, '0'),
      String(moment.getDate()).padStart(2, '0')
    ].join('-');
    assert.equal(toLocalDate(moment), expected);
  }
});

// 上面那条在任何时区都成立，但恰恰因此证明不了「没用 UTC」——
// 测试跑在 UTC 或负偏移时区时，两者结果可能碰巧一样。
// 这里把时区钉死成东八区（也就是这个应用实际要用的时区）来验证分歧。
test('东八区凌晨不会退回前一天（用 UTC 就会）', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const { toLocalDate } = require('${path.join(__dirname, '..', 'src', 'templates').replace(/\\/g, '\\\\')}');
    const earlyMorning = new Date(2026, 7, 6, 0, 30);
    console.log(JSON.stringify({
      local: toLocalDate(earlyMorning),
      utc: earlyMorning.toISOString().slice(0, 10)
    }));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Asia/Shanghai' }
  });
  const { local, utc } = JSON.parse(output);

  assert.equal(local, '2026-08-06', '本地日期应是 8 月 6 日');
  assert.equal(utc, '2026-08-05', 'UTC 此刻还是 8 月 5 日');
  assert.notEqual(local, utc, '两者必须不同，否则这条测试证明不了任何事');
});

test('日期校验挡住格式对但不存在的日期', () => {
  assert.equal(isValidDateString('2026-08-06'), true);
  assert.equal(isValidDateString('2024-02-29'), true, '闰年 2 月 29 日存在');
  assert.equal(isValidDateString('2026-02-29'), false, '平年没有 2 月 29 日');
  assert.equal(isValidDateString('2026-02-31'), false);
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('26-08-06'), false);
  assert.equal(isValidDateString('../etc/passwd'), false);
});

test('日期加减跨月跨年正确', () => {
  assert.equal(shiftDays('2026-08-06', -1), '2026-08-05');
  assert.equal(shiftDays('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDays('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDays('2024-03-01', -1), '2024-02-29', '闰年');
});

test('打点字段：空、非数字、越界都算没填', () => {
  assert.equal(readNumber(4, { min: 1, max: 5 }), 4);
  assert.equal(readNumber('4', { min: 1, max: 5 }), 4);
  assert.equal(readNumber('', { min: 1, max: 5 }), null, 'frontmatter 里写 mood: 留空');
  assert.equal(readNumber(null), null);
  assert.equal(readNumber(undefined), null);
  assert.equal(readNumber('好', { min: 1, max: 5 }), null);
  assert.equal(readNumber(9, { min: 1, max: 5 }), null, '越界不该画成越界的柱子');
  assert.equal(readNumber(0, { min: 1, max: 5 }), null);
});

test('模板占位符替换，未知占位符原样保留', () => {
  const variables = templateVariables('2026-08-06');
  assert.equal(variables.weekday, '周四', '2026-08-06 是周四');
  assert.equal(renderTemplate('# {{date}} {{weekday}}', variables), '# 2026-08-06 周四');
  assert.equal(renderTemplate('{{unknown}}', variables), '{{unknown}}');
});

test('vault 里的模板覆盖内置模板', async () => {
  const ctx = await setup();
  try {
    assert.equal(loadTemplate(ctx.vaultDir, 'diary').source, 'builtin');

    await fs.mkdir(path.join(ctx.vaultDir, 'templates'), { recursive: true });
    await fs.writeFile(path.join(ctx.vaultDir, 'templates', 'diary.md'), '# {{date}} 我的模板\n');

    const custom = loadTemplate(ctx.vaultDir, 'diary');
    assert.equal(custom.source, 'vault');
    assert.match(ctx.diary.renderNewEntry('2026-08-06'), /2026-08-06 我的模板/);
  } finally {
    await ctx.cleanup();
  }
});

test('内置日记模板带上模板化提问和打点字段', async () => {
  const ctx = await setup();
  try {
    const entry = ctx.diary.renderNewEntry('2026-08-06');
    assert.match(entry, /mood:/);
    assert.match(entry, /focus_minutes:/);
    assert.match(entry, /今天做了什么/);
    assert.match(entry, /卡在哪/);
    assert.match(entry, /明天第一件事/);
    assert.match(entry, /2026-08-06 周四/);
  } finally {
    await ctx.cleanup();
  }
});

test('历年今日只取过去年份的同月同日', async () => {
  const ctx = await setup();
  try {
    for (const date of ['2026-08-06', '2025-08-06', '2024-08-06', '2025-08-07', '2027-08-06']) {
      await writeNote(ctx.notesDir, `diary/${date}.md`, { data: { title: date }, body: '内容' });
    }
    await ctx.indexer.scan();

    const entries = ctx.diary.onThisDay('2026-08-06');
    assert.deepEqual(entries.map(e => e.date), ['2025-08-06', '2024-08-06']);
    assert.equal(entries[0].label, '去年今日');
    assert.equal(entries[1].label, '2 年前的今天');
  } finally {
    await ctx.cleanup();
  }
});

test('趋势序列每天都在，没写的那天是空缺而不是 0', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', {
      data: { mood: 4, focus_minutes: 180 }, body: '今天'
    });
    await writeNote(ctx.notesDir, 'diary/2026-08-04.md', {
      data: { mood: 2, focus_minutes: 60 }, body: '前天'
    });
    await ctx.indexer.scan();

    const series = ctx.diary.trend(7, '2026-08-06');
    assert.equal(series.length, 7, '7 天全都要在序列里');
    assert.equal(series[series.length - 1].date, '2026-08-06');
    assert.equal(series[0].date, '2026-07-31');

    const written = series.find(d => d.date === '2026-08-06');
    assert.equal(written.mood, 4);
    assert.equal(written.focusMinutes, 180);
    assert.equal(written.hasEntry, true);

    // 关键：没写日记的那天值是 null，不是 0。图表要显示空缺，
    // 而不是画一根零高度的柱子假装那天专注了 0 分钟。
    const missing = series.find(d => d.date === '2026-08-05');
    assert.equal(missing.mood, null);
    assert.equal(missing.focusMinutes, null);
    assert.equal(missing.hasEntry, false);
  } finally {
    await ctx.cleanup();
  }
});

test('写了日记但没填打点字段，算有日记但没有数值', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', { data: { title: '今天' }, body: '只写了正文' });
    await ctx.indexer.scan();

    const series = ctx.diary.trend(3, '2026-08-06');
    const today = series.find(d => d.date === '2026-08-06');
    assert.equal(today.hasEntry, true, '日记确实存在');
    assert.equal(today.mood, null, '但没填情绪');

    const summary = ctx.diary.summarize(series);
    assert.equal(summary.entryCount, 1);
    assert.equal(summary.moodCount, 0);
    assert.equal(summary.moodAverage, null, '没有数据时不该算出 0 或 NaN');
  } finally {
    await ctx.cleanup();
  }
});

test('汇总统计只对有值的天求平均', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', { data: { mood: 5, focus_minutes: 120 }, body: 'a' });
    await writeNote(ctx.notesDir, 'diary/2026-08-05.md', { data: { mood: 3, focus_minutes: 60 }, body: 'b' });
    await writeNote(ctx.notesDir, 'diary/2026-08-04.md', { data: { title: '没填' }, body: 'c' });
    await ctx.indexer.scan();

    const summary = ctx.diary.summarize(ctx.diary.trend(7, '2026-08-06'));
    assert.equal(summary.entryCount, 3);
    assert.equal(summary.moodCount, 2);
    assert.equal(summary.moodAverage, 4, '(5+3)/2，不该被没填的那天拉低');
    assert.equal(summary.focusTotal, 180);
    assert.equal(summary.focusMax, 120);
  } finally {
    await ctx.cleanup();
  }
});

test('frontmatter 存进索引，schema 升级后仍可查询', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/2026-08-06.md', {
      data: { mood: 4, focus_minutes: 180, custom: '任意字段' }, body: '内容'
    });
    await ctx.indexer.scan();

    const row = ctx.db.getNote('diary/2026-08-06.md');
    const data = JSON.parse(row.data_json);
    assert.equal(data.mood, 4);
    assert.equal(data.custom, '任意字段', 'frontmatter 整体存下来，后续模块不用改 schema');
  } finally {
    await ctx.cleanup();
  }
});

test('diary/ 下的回顾笔记不算日记，不进历年今日和日记列表', async () => {
  const ctx = await setup();
  try {
    // todayRoutes 建议的周回顾保存路径就是这个形状，它和日记同处 diary/ 分区。
    // 只按 section 查的话，dateFromPath 认不出它，日期是空串、yearsAgo 算成 2026，
    // 首页会顶着一条「2026 年前的今天」。
    for (const date of ['2026-08-06', '2025-08-06']) {
      await writeNote(ctx.notesDir, `diary/${date}.md`, { data: { title: date }, body: '内容' });
    }
    await writeNote(ctx.notesDir, 'diary/retro-2026-08-06.md', { data: { title: '周回顾' }, body: '反思' });
    await writeNote(ctx.notesDir, 'diary/retro-2026-08.md', { data: { title: '月回顾' }, body: '反思' });
    await ctx.indexer.scan();

    const entries = ctx.diary.onThisDay('2026-08-06');
    assert.deepEqual(entries.map(e => e.date), ['2025-08-06']);
    assert.ok(entries.every(e => e.date), '每条都必须有真正的日期');

    const listed = ctx.diary.list(30).map(e => e.path);
    assert.deepEqual(listed, ['diary/2026-08-06.md', 'diary/2025-08-06.md']);

    const written = ctx.diary.trend(3, '2026-08-06').filter(day => day.hasEntry).map(day => day.date);
    assert.deepEqual(written, ['2026-08-06']);
  } finally {
    await ctx.cleanup();
  }
});
