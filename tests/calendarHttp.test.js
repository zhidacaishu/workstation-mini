const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const matter = require('gray-matter');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { writeNote } = require('../src/vault/note');

// 2026-08-10 是周一。整个 8 月的网格从 2026-07-27（周一）开始。
const FIXED_NOW = new Date(2026, 7, 10, 14, 30);

async function setup({ readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cal-http-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, device: 'desktop' });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, { db, indexer, search, now: () => FIXED_NOW });

  return {
    app, db, indexer, config, vaultDir, notesDir,
    async seed() {
      await writeNote(notesDir, 'submissions/aer.md', {
        data: { title: '收入不平等与流动性', status: 'drafting', journal: 'AER', deadline: '2026-08-20' },
        body: '# 收入不平等与流动性\n'
      });
      await writeNote(notesDir, 'research/待办.md', {
        body: '# 待办\n\n- [ ] 交伦理审查材料 @2026-08-14\n- [ ] 早就该做的事 @2026-07-01\n'
      });
      await writeNote(notesDir, 'diary/2026-08-12.md', {
        data: { title: '2026-08-12', mood: 4, plan: ['09:00-11:00 写引言', '14:00-16:00 跑回归'] },
        body: '# 2026-08-12\n'
      });
      await indexer.scan();
    },
    async readDiary(date) {
      return fs.readFile(path.join(notesDir, 'diary', `${date}.md`), 'utf8');
    },
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('月视图默认显示当月，网格从周一起铺满 42 天', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const response = await request(ctx.app).get('/calendar').expect(200);

    assert.match(response.text, /2026 年 8 月/);
    // 表头是周一开头。
    assert.match(response.text, /calgrid-head[\s\S]*?周一[\s\S]*?周日/);
    // 42 个格子。
    // [ "] 是为了不把 calday-num / calday-items / calday-load 也数进来。
    assert.equal((response.text.match(/class="calday[ "]/g) || []).length, 42);
    // 网格首尾：2026-07-27 ~ 2026-09-06。
    assert.match(response.text, /day=2026-07-27/);
    assert.match(response.text, /day=2026-09-06/);
  } finally {
    await ctx.cleanup();
  }
});

test('截止、待办与时间块都出现在格子里', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const response = await request(ctx.app).get('/calendar').expect(200);

    assert.match(response.text, /收入不平等与流动性/, 'submission 的 deadline');
    assert.match(response.text, /交伦理审查材料/, '待办的 @日期');
    assert.match(response.text, /写引言/, '日记 frontmatter 的时间块');
    assert.match(response.text, /is-plan/);
  } finally {
    await ctx.cleanup();
  }
});

test('翻月用 ?month=，非法月份是 400', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const next = await request(ctx.app).get('/calendar?month=2026-09').expect(200);
    assert.match(next.text, /2026 年 9 月/);
    // 翻到别的月份时详情栏展开 1 号，不会空掉。
    assert.match(next.text, /2026-09-01/);

    await request(ctx.app).get('/calendar?month=2026-13').expect(400);
    await request(ctx.app).get('/calendar?month=abc').expect(400);
    await request(ctx.app).get('/calendar?day=2026-02-31').expect(400);
  } finally {
    await ctx.cleanup();
  }
});

test('详情栏展开指定的一天', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const response = await request(ctx.app).get('/calendar?month=2026-08&day=2026-08-12').expect(200);

    assert.match(response.text, /2026-08-12 周三/);
    assert.match(response.text, /09:00.*11:00/s);
    assert.match(response.text, /跑回归/);
  } finally {
    await ctx.cleanup();
  }
});

test('排一个时间块，写进那天日记的 plan', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    await request(ctx.app)
      .post('/calendar/plan').type('form')
      .send({ date: '2026-08-12', from: '16:30', to: '17:30', what: '组会' })
      .expect(302)
      .expect('location', '/calendar?month=2026-08&day=2026-08-12');

    const parsed = matter(await ctx.readDiary('2026-08-12'));
    assert.deepEqual(parsed.data.plan, ['09:00-11:00 写引言', '14:00-16:00 跑回归', '16:30-17:30 组会']);
  } finally {
    await ctx.cleanup();
  }
});

test('时间块按开始时间排序，不带时间的沉到最后', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const post = body => request(ctx.app).post('/calendar/plan').type('form').send(body).expect(302);

    await post({ date: '2026-08-12', what: '有空就读文献' });
    await post({ date: '2026-08-12', from: '8:00', to: '9:00', what: '晨读' });

    const parsed = matter(await ctx.readDiary('2026-08-12'));
    assert.deepEqual(parsed.data.plan, [
      '08:00-09:00 晨读', '09:00-11:00 写引言', '14:00-16:00 跑回归', '有空就读文献'
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test('给没有日记的那天排时间块，按模板建一篇', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    await request(ctx.app)
      .post('/calendar/plan').type('form')
      .send({ date: '2026-08-25', from: '10:00', to: '12:00', what: '预答辩' })
      .expect(302);

    const parsed = matter(await ctx.readDiary('2026-08-25'));
    assert.deepEqual(parsed.data.plan, ['10:00-12:00 预答辩']);
    assert.ok(parsed.content.trim().length > 0, '正文应该是日记模板，不是空的');
  } finally {
    await ctx.cleanup();
  }
});

// 这条是整个写入路径最容易出错的地方：js-yaml 把不带引号的 title: 2026-08-12
// 解析成 Date，原样写回会变成 2026-08-12T00:00:00.000Z。只是加一条时间块，
// 却顺手改了用户写的日期。
test('排时间块不会把日期型 frontmatter 改写成 ISO 时间戳', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    // 不带引号的日期 + 数值字段，两种都要原样保住。
    await fs.writeFile(
      path.join(ctx.notesDir, 'diary', '2026-08-13.md'),
      '---\ntitle: 2026-08-13\nmood: 4\nfocus_minutes: 180\ntags: [日记]\n---\n\n# 2026-08-13\n\n正文\n',
      'utf8'
    );
    await ctx.indexer.scan();

    await request(ctx.app)
      .post('/calendar/plan').type('form')
      .send({ date: '2026-08-13', from: '09:00', to: '10:00', what: '读论文' })
      .expect(302);

    const raw = await ctx.readDiary('2026-08-13');
    assert.match(raw, /title: '?2026-08-13'?\n/, `title 被改写了：\n${raw}`);
    assert.equal(raw.includes('T00:00:00'), false, '不能出现 ISO 时间戳');

    const parsed = matter(raw);
    assert.equal(parsed.data.mood, 4, '数值字段必须还是数值');
    assert.equal(parsed.data.focus_minutes, 180);
    assert.deepEqual(parsed.data.tags, ['日记']);
    assert.deepEqual(parsed.data.plan, ['09:00-10:00 读论文']);
    assert.match(parsed.content, /正文/, '正文不能被动');
  } finally {
    await ctx.cleanup();
  }
});

test('重复排同一个时间块不会写两遍', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const body = { date: '2026-08-12', from: '16:30', to: '17:30', what: '组会' };
    await request(ctx.app).post('/calendar/plan').type('form').send(body).expect(302);
    await request(ctx.app).post('/calendar/plan').type('form').send(body).expect(302);

    const parsed = matter(await ctx.readDiary('2026-08-12'));
    assert.equal(parsed.data.plan.filter(line => line === '16:30-17:30 组会').length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('排期的输入校验都是 400，且带能看懂的文案', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const bad = body => request(ctx.app)
      .post('/calendar/plan').set('Accept', 'application/json').send(body).expect(400);

    assert.match((await bad({ date: '2026-02-31', what: 'x' })).body.message, /日期格式/);
    assert.match((await bad({ date: '', what: 'x' })).body.message, /日期格式/);
    assert.match((await bad({ date: '2026-08-12', what: '   ' })).body.message, /不能为空/);
    assert.match((await bad({ date: '2026-08-12', from: '09:00', what: 'x' })).body.message, /要么都填/);
    assert.match((await bad({ date: '2026-08-12', from: '25:00', to: '26:00', what: 'x' })).body.message, /时间格式/);
  } finally {
    await ctx.cleanup();
  }
});

test('Accept: application/json 时返回整理好的时间块列表', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const response = await request(ctx.app)
      .post('/calendar/plan').set('Accept', 'application/json')
      .send({ date: '2026-08-12', from: '16:30', to: '17:30', what: '组会' })
      .expect(200);

    assert.equal(response.body.ok, true);
    assert.equal(response.body.block, '16:30-17:30 组会');
    assert.deepEqual(response.body.plan.map(block => block.what), ['写引言', '跑回归', '组会']);
    assert.equal(response.body.plan[2].from, '16:30');
  } finally {
    await ctx.cleanup();
  }
});

test('/calendar.ics 是合法日历，截止是全天、时间块是浮动时间', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const response = await request(ctx.app).get('/calendar.ics').expect(200);

    assert.match(response.headers['content-type'], /text\/calendar/);
    assert.match(response.headers['content-disposition'], /workstation\.ics/);
    const text = response.text;

    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(text.trimEnd().endsWith('END:VCALENDAR'));
    assert.ok(text.includes('DTSTART;VALUE=DATE:20260820'), '投稿截止是全天事件');
    assert.ok(text.includes('DTSTART:20260812T090000'), '时间块是浮动本地时间');
    assert.equal(/DTSTART:\d{8}T\d{6}Z/.test(text), false, '不该有 UTC 时间');
    assert.ok(text.includes('CATEGORIES:时间块'));
  } finally {
    await ctx.cleanup();
  }
});

test('/api/calendar/agenda 给出当天议程', async () => {
  const ctx = await setup();
  try {
    await ctx.seed();
    const response = await request(ctx.app).get('/api/calendar/agenda?date=2026-08-12').expect(200);

    assert.equal(response.body.ok, true);
    assert.equal(response.body.date, '2026-08-12');
    assert.equal(response.body.weekday, '周三');
    assert.deepEqual(response.body.plan.map(block => block.from), ['09:00', '14:00']);

    const today = await request(ctx.app).get('/api/calendar/agenda').expect(200);
    assert.equal(today.body.date, '2026-08-10', '不给日期就是今天');

    await request(ctx.app).get('/api/calendar/agenda?date=nope').expect(400);
  } finally {
    await ctx.cleanup();
  }
});

test('只读模式：能看不能改，磁盘不留痕迹', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await ctx.seed();
    await request(ctx.app).get('/calendar').expect(200);
    await request(ctx.app).get('/calendar.ics').expect(200);
    await request(ctx.app).get('/api/calendar/agenda').expect(200);

    const before = await ctx.readDiary('2026-08-12');
    const response = await request(ctx.app)
      .post('/calendar/plan').set('Accept', 'application/json')
      .send({ date: '2026-08-12', from: '16:30', to: '17:30', what: '组会' })
      .expect(403);
    assert.match(response.body.message, /只读模式/);

    assert.equal(await ctx.readDiary('2026-08-12'), before, '文件不能被改动');
    // 也不该凭空建出新日记。
    await assert.rejects(() => ctx.readDiary('2026-08-25'));
  } finally {
    await ctx.cleanup();
  }
});

test('只读模式下页面不渲染排期表单', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await ctx.seed();
    const response = await request(ctx.app).get('/calendar').expect(200);
    assert.equal(response.text.includes('data-plan-form'), false);
  } finally {
    await ctx.cleanup();
  }
});

test('空资料库也能渲染出完整网格', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/calendar').expect(200);
    // [ "] 是为了不把 calday-num / calday-items / calday-load 也数进来。
    assert.equal((response.text.match(/class="calday[ "]/g) || []).length, 42);
    assert.match(response.text, /这天还没排/);
  } finally {
    await ctx.cleanup();
  }
});
