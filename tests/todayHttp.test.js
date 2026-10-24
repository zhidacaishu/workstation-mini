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
const { enqueueNote } = require('../src/vault/note-queue');

const FIXED_NOW = new Date(2026, 2, 17, 9, 0); // 2026-03-17 周二
const TODAY = '2026-03-17';

async function setup({ readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-today-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });

  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, { db, indexer, search, now: () => FIXED_NOW });

  return {
    app, db, indexer, config, vaultDir, notesDir,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('首页是聚合视图，开头一句话说完最要紧的', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'cards', 'a.md'), '## 卡一\n背面', 'utf8');
    await writeNote(ctx.notesDir, 'a.md', { body: '- [ ] 早该做的 @2026-03-01' });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/').expect(200);
    assert.match(response.text, /今日/);
    assert.match(response.text, /2026-03-17 周二/);
    assert.match(response.text, /要复习 1 张卡/);
    assert.match(response.text, /1 条待办已逾期/);
    assert.match(response.text, /日记还没写/);
  } finally {
    await ctx.cleanup();
  }
});

test('什么都没到期时首页明说，而不是留一片空白', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, { data: { title: TODAY }, body: '# 今天' });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/').expect(200);
    assert.match(response.text, /今天没有到期的东西。/);
  } finally {
    await ctx.cleanup();
  }
});

test('首页显示今天的时间块', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, {
      data: { title: TODAY, plan: ['09:00-11:00 写引言', '14:00-16:00 跑实验'] },
      body: '# 今天'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/').expect(200);
    assert.match(response.text, /今天的计划/);
    assert.match(response.text, /09:00–11:00/);
    assert.match(response.text, /写引言/);
  } finally {
    await ctx.cleanup();
  }
});

test('首页汇总需要注意的条目', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'reading/econ/ch04.md', {
      data: { title: '第四章', status: 'stuck' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'submissions/a.md', {
      data: {
        title: '平台定价', status: 'major-revision',
        reviews: [{ id: 'R1.1', comment: '识别策略不清楚' }]
      },
      body: '正文'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/').expect(200);
    assert.match(response.text, /需要注意/);
    assert.match(response.text, /1 条意见没回应/);
    assert.match(response.text, /第四章/);
  } finally {
    await ctx.cleanup();
  }
});

test('deadline 时间轴按日期分组，逾期与今天有区分', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'submissions/a.md', {
      data: { title: '早该投的', status: 'drafting', deadline: '2026-03-01' }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'submissions/b.md', {
      data: { title: '今天截止', status: 'drafting', deadline: TODAY }, body: '正文'
    });
    await writeNote(ctx.notesDir, 'c.md', { body: '- [ ] 同一天的待办 @2026-03-01' });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/deadlines').expect(200);
    assert.match(response.text, /is-overdue/);
    assert.match(response.text, /is-today/);
    assert.match(response.text, /早该投的/);
    assert.match(response.text, /同一天的待办/);

    // 2026-03-01 两条应归到同一个日期分组
    const groupCount = (response.text.match(/timeline-date/g) || []).length;
    assert.equal(groupCount, 2, `应有两个日期分组，实际 ${groupCount}`);
  } finally {
    await ctx.cleanup();
  }
});

test('周回顾把数字填好，只留反思给人写', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, `diary/${TODAY}.md`, {
      data: { title: TODAY, mood: 4, focus_minutes: 120 }, body: '# 今天'
    });
    await ctx.indexer.scan();

    const response = await request(ctx.app).get('/retro').expect(200);
    assert.match(response.text, /周回顾/);
    assert.match(response.text, /2026-03-16 → 2026-03-17/);
    assert.match(response.text, /## 反思/);
    assert.match(response.text, /这段时间真正推进了什么/);
    assert.match(response.text, /diary\/retro-2026-03-16\.md/, '应给出建议保存路径');
  } finally {
    await ctx.cleanup();
  }
});

test('月回顾区间是本月一号到今天', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/retro?scope=month').expect(200);
    assert.match(response.text, /月回顾/);
    assert.match(response.text, /2026-03-01 → 2026-03-17/);
    assert.match(response.text, /diary\/retro-2026-03\.md/);
  } finally {
    await ctx.cleanup();
  }
});

test('回顾草稿能存成笔记', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/retro/save').type('form')
      .send({ path: 'diary/retro-2026-03-16.md', body: '# 周回顾\n\n## 反思\n\n推进了引言。' })
      .expect(302)
      .expect('Location', '/note/diary/retro-2026-03-16.md');

    const raw = await fs.readFile(path.join(ctx.notesDir, 'diary/retro-2026-03-16.md'), 'utf8');
    assert.match(raw, /推进了引言/);
  } finally {
    await ctx.cleanup();
  }
});

test('已存在的回顾不被覆盖', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'diary/retro-2026-03-16.md', { body: '# 已经写过的反思' });
    await ctx.indexer.scan();

    await request(ctx.app).post('/retro/save').type('form')
      .send({ path: 'diary/retro-2026-03-16.md', body: '# 新草稿' })
      .expect(409);

    const raw = await fs.readFile(path.join(ctx.notesDir, 'diary/retro-2026-03-16.md'), 'utf8');
    assert.match(raw, /已经写过的反思/, '绝不能覆盖已写的回顾');
  } finally {
    await ctx.cleanup();
  }
});

test('回顾创建等待同路径写入，抢先创建后返回冲突且不覆盖', async () => {
  const ctx = await setup();
  try {
    const notePath = 'diary/retro-2026-03-16.md';
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const prior = enqueueNote(ctx.notesDir, notePath, async () => {
      entered();
      await gate;
      await writeNote(ctx.notesDir, notePath, { body: '# 抢先保存的回顾' });
    });
    await started;

    let settled = false;
    const pending = request(ctx.app).post('/retro/save').type('form')
      .send({ path: notePath, body: '# 过期草稿' })
      .then(response => {
        settled = true;
        return response;
      });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, '回顾创建必须等待同一路径写入');

    release();
    await prior;
    const response = await pending;
    assert.equal(response.status, 409);
    const raw = await fs.readFile(path.join(ctx.notesDir, notePath), 'utf8');
    assert.match(raw, /抢先保存的回顾/);
    assert.doesNotMatch(raw, /过期草稿/);
  } finally {
    await ctx.cleanup();
  }
});

test('简报有页面版和纯文本版，内容一致', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.vaultDir, 'cards', 'a.md'), '## 卡一\n背面', 'utf8');
    await ctx.indexer.scan();

    const page = await request(ctx.app).get('/briefing').expect(200);
    assert.match(page.text, /每日简报/);
    assert.match(page.text, /要复习 1 张卡/);
    assert.match(page.text, /纯文本预览/);
    assert.doesNotMatch(page.text, /cron|固定端口/, '桌面应用不应说明外部拉取方式');

    const markdown = await request(ctx.app).get('/briefing.md').expect(200);
    assert.match(markdown.headers['content-type'], /text\/markdown/);
    assert.match(markdown.text, /# 2026-03-17 周二/);
    assert.match(markdown.text, /要复习 1 张卡/);
  } finally {
    await ctx.cleanup();
  }
});

test('只读实例能看所有聚合视图，但不能保存回顾', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await ctx.indexer.scan();

    for (const url of ['/', '/deadlines', '/retro', '/briefing', '/briefing.md']) {
      await request(ctx.app).get(url).expect(200);
    }
    await request(ctx.app).post('/retro/save').type('form')
      .send({ path: 'diary/retro.md', body: 'x' }).expect(403);

    const home = await request(ctx.app).get('/').expect(200);
    assert.ok(!home.text.includes('写今天的日记'), '只读实例不该出现新建入口');
  } finally {
    await ctx.cleanup();
  }
});

test('保存回顾拒绝越界路径与非 .md 文件名', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/retro/save').type('form')
      .send({ path: '../escape.md', body: 'x' }).expect(400);
    await request(ctx.app).post('/retro/save').type('form')
      .send({ path: 'diary/evil.js', body: 'x' }).expect(400);
  } finally {
    await ctx.cleanup();
  }
});
