const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { writeNote } = require('../src/vault/note');
const { isAvailable } = require('../src/checkDraft');

const CHECKER = process.env.WORKSTATION_TEST_CHECK_DRAFT || '';
const FIXED_NOW = new Date(2026, 2, 17, 14, 30);

async function setup({ readOnly = false, checker = '' } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mis-http-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });

  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly,
    checkDraftPath: checker,
    device: 'desktop'
  });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, { db, indexer, search, now: () => FIXED_NOW });

  return {
    app, db, indexer, config, vaultDir, notesDir,
    mistakeLines(source) {
      const dir = path.join(vaultDir, 'mistakes', source);
      if (!fsSync.existsSync(dir)) return [];
      return fsSync.readdirSync(dir).flatMap(f =>
        fsSync.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
    },
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('错题本页在没有记录时说明两个来源', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/mistakes').expect(200);
    assert.match(response.text, /还没有记录/);
    assert.match(response.text, /写作错题/);
    assert.match(response.text, /习题错题/);
  } finally {
    await ctx.cleanup();
  }
});

test('没配检查器时页面明确说明怎么启用，而不是假装功能不存在', async () => {
  const ctx = await setup({ checker: '' });
  try {
    const response = await request(ctx.app).get('/mistakes').expect(200);
    assert.match(response.text, /应用设置/);
  } finally {
    await ctx.cleanup();
  }
});

test('没配检查器时调用检查接口返回可读的错误', async () => {
  const ctx = await setup({ checker: '' });
  try {
    await writeNote(ctx.notesDir, 'research/draft.md', { body: 'text' });
    await ctx.indexer.scan();

    const response = await request(ctx.app)
      .post('/mistakes/check')
      .send({ path: 'research/draft.md' })
      .expect(400);
    assert.match(response.body.message, /应用设置/);
  } finally {
    await ctx.cleanup();
  }
});

// 错误处理要按请求类型返回：fetch 要 JSON，直接访问要 HTML。
test('API 请求拿到 JSON 错误，页面请求拿到 HTML 错误', async () => {
  const ctx = await setup();
  try {
    const json = await request(ctx.app)
      .post('/mistakes/check')
      .set('Accept', 'application/json')
      .send({ path: '../escape.md' })
      .expect(400);
    assert.equal(json.body.ok, false);
    assert.match(json.body.message, /路径不合法/);

    const html = await request(ctx.app).get('/note/nope.md').expect(404);
    assert.match(html.text, /<html/, '页面请求应返回 HTML');
  } finally {
    await ctx.cleanup();
  }
});

test('手工录入习题错题并出现在统计里', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app)
      .post('/mistakes/exercise')
      .type('form')
      .send({ subject: '计量教材 ch03', category: '工具变量', reason: 'concept',
              detail: '把两个条件记混了', note: '相关性对内生变量，外生性对误差项' })
      .expect(302);

    const lines = ctx.mistakeLines('exercise');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].category, '工具变量');
    assert.equal(lines[0].tier, 'concept');

    const page = await request(ctx.app).get('/mistakes').expect(200);
    assert.match(page.text, /习题高频错误/);
    assert.match(page.text, /工具变量/);
    assert.match(page.text, /概念混淆/);
  } finally {
    await ctx.cleanup();
  }
});

test('同一题型犯多次会被统计出来 —— 这正是错题本的意义', async () => {
  const ctx = await setup();
  try {
    for (let i = 0; i < 3; i += 1) {
      await request(ctx.app).post('/mistakes/exercise').type('form')
        .send({ subject: `第 ${i} 题`, category: '工具变量', reason: 'concept', detail: `第 ${i} 次记混` })
        .expect(302);
    }
    const page = await request(ctx.app).get('/mistakes').expect(200);
    const row = page.text.match(/<td>工具变量<\/td>\s*<td class="count-cell">(\d+)/);
    assert.ok(row, '应有工具变量这一行');
    assert.equal(row[1], '3');
  } finally {
    await ctx.cleanup();
  }
});

test('题型为空时拒绝录入', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/mistakes/exercise').type('form')
      .send({ subject: 'x', category: '   ' }).expect(400);
    assert.equal(ctx.mistakeLines('exercise').length, 0);
  } finally {
    await ctx.cleanup();
  }
});

// 闭环的最后一步：犯过的错进复习队列，用的还是 P2 那套 FSRS 引擎。
test('错题转卡片后能被复习引擎读到', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/mistakes/exercise').type('form')
      .send({ subject: '计量 ch03', category: '工具变量', reason: 'concept',
              detail: '条件记混', note: '相关性 + 外生性' })
      .expect(302);

    const id = ctx.mistakeLines('exercise')[0].id;
    const created = await request(ctx.app).post('/mistakes/card').send({ id }).expect(200);
    assert.equal(created.body.path, 'cards/exercise-mistakes.md');

    const cardFile = await fs.readFile(path.join(ctx.vaultDir, 'cards', 'exercise-mistakes.md'), 'utf8');
    assert.match(cardFile, /## 工具变量/);
    assert.match(cardFile, /条件记混/);
    assert.match(cardFile, /相关性 \+ 外生性/);
    assert.match(cardFile, /概念混淆/, '错因应写进卡片背面');

    // 关键：复习引擎认得这张卡，没有第二套调度器。
    const decks = await request(ctx.app).get('/decks').expect(200);
    assert.match(decks.text, /共 1 张/);
    assert.match(decks.text, /exercise-mistakes/);
  } finally {
    await ctx.cleanup();
  }
});

test('找不到的错题 ID 返回 404', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).post('/mistakes/card')
      .send({ id: '不存在' }).expect(404);
    assert.match(response.body.message, /找不到这条错题/);
  } finally {
    await ctx.cleanup();
  }
});

test('只读实例可以看错题本，但不能记录也不能建卡', async () => {
  const ctx = await setup({ readOnly: true });
  try {
    await request(ctx.app).get('/mistakes').expect(200);

    await request(ctx.app).post('/mistakes/exercise').type('form')
      .send({ category: '工具变量' }).expect(403);
    await request(ctx.app).post('/mistakes/check')
      .send({ path: 'a.md' }).expect(403);
    await request(ctx.app).post('/mistakes/card').send({ id: 'x' }).expect(403);

    assert.equal(ctx.mistakeLines('exercise').length, 0);
  } finally {
    await ctx.cleanup();
  }
});

// 端到端：跑真实检查器 → 落库 → 统计 → 转卡片。
test('对真实稿件跑检查器并落库成统计', { skip: !isAvailable(CHECKER) && '本机没有 academic-writing' }, async () => {
  const ctx = await setup({ checker: CHECKER });
  try {
    await writeNote(ctx.notesDir, 'research/draft.md', {
      body: [
        '# Introduction', '',
        'Our method is superior to existing approaches。 The behaviour and',
        'the behavior of users differ in general.'
      ].join('\n')
    });
    await ctx.indexer.scan();

    const result = await request(ctx.app)
      .post('/mistakes/check')
      .send({ path: 'research/draft.md' })
      .expect(200);

    assert.equal(result.body.ok, true);
    assert.ok(result.body.hardCount > 0, '这段文字确实有必改问题');
    assert.ok(result.body.recorded > 0);

    const page = await request(ctx.app).get('/mistakes').expect(200);
    assert.match(page.text, /写作高频错误/);
    assert.match(page.text, /全角标点残留/);

    // 重复检查同一份稿件不该把统计冲爆。
    await request(ctx.app).post('/mistakes/check').send({ path: 'research/draft.md' }).expect(200);
    const firstCount = ctx.mistakeLines('writing').length;
    await request(ctx.app).post('/mistakes/check').send({ path: 'research/draft.md' }).expect(200);

    const page2 = await request(ctx.app).get('/mistakes').expect(200);
    const before = page.text.match(/全角标点残留<\/td>\s*<td class="count-cell">(\d+)/)[1];
    const after = page2.text.match(/全角标点残留<\/td>\s*<td class="count-cell">(\d+)/)[1];
    assert.equal(after, before, `重复检查后统计不该变（${before} → ${after}，日志行数 ${firstCount}）`);
  } finally {
    await ctx.cleanup();
  }
});
