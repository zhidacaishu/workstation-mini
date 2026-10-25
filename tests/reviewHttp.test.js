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

const FIXED_NOW = new Date(2026, 2, 17, 14, 30);

async function setup({ readOnly = false, cards = {} } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-rev-http-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'reviews'), { recursive: true });

  for (const [name, content] of Object.entries(cards)) {
    await fs.writeFile(path.join(vaultDir, 'cards', name), content, 'utf8');
  }

  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly,
    device: readOnly ? 'phone' : 'desktop'
  });

  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const search = createSearch(db);
  const app = createApp(config, { db, indexer, search, now: () => FIXED_NOW });

  return {
    app, db, indexer, config, vaultDir, notesDir,
    reviewFiles: () => fsSync.readdirSync(path.join(vaultDir, 'reviews')),
    reviewLines: () => fsSync.readdirSync(path.join(vaultDir, 'reviews'))
      .flatMap(f => fsSync.readFileSync(path.join(vaultDir, 'reviews', f), 'utf8')
        .split('\n').filter(Boolean).map(JSON.parse)),
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

const ENGLISH_DECK = [
  '---', 'deck: 英语生词', 'type: en-word', '---', '',
  '## heterogeneity', '异质性；个体差异。', '',
  '## endogeneity', '内生性'
].join('\n');

test('卡组页统计到期与新卡数量', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    const response = await request(ctx.app).get('/decks').expect(200);
    assert.match(response.text, /英语生词/);
    assert.match(response.text, /共 2 张/);
    assert.match(response.text, /新卡 2 张/);
  } finally {
    await ctx.cleanup();
  }
});

test('没有卡片时卡组页给出格式说明', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/decks').expect(200);
    assert.match(response.text, /还没有卡片/);
    assert.match(response.text, /deck: 英语生词/, '应展示卡片文件格式');
  } finally {
    await ctx.cleanup();
  }
});

test('复习页把队列嵌进页面，正反面都渲染成 HTML', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    const response = await request(ctx.app).get('/review').expect(200);
    assert.match(response.text, /data-queue=/);
    assert.match(response.text, /heterogeneity/);
    assert.match(response.text, /新卡 2 张/);
  } finally {
    await ctx.cleanup();
  }
});

test('答一次题就往事件日志追加一行', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    await request(ctx.app)
      .post('/review/answer')
      .send({ eventId: 'event-http-1', cardId: 'english/heterogeneity', rating: 3, elapsedMs: 4200 })
      .expect(200);

    const lines = ctx.reviewLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event_id, 'event-http-1');
    assert.equal(lines[0].card_id, 'english/heterogeneity');
    assert.equal(lines[0].rating, 3);
    assert.equal(lines[0].elapsed_ms, 4200);

    // 文件名按「年月 + 设备」分，不同设备写不同文件才不会 git 冲突。
    assert.deepEqual(ctx.reviewFiles(), ['2026-03-desktop.jsonl']);
  } finally {
    await ctx.cleanup();
  }
});

test('评分响应丢失后的同 ID 重试不重复追加，冲突载荷返回 409', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  const payload = { eventId: 'stable-http-event', cardId: 'english/heterogeneity', rating: 3, elapsedMs: 4200 };
  try {
    const first = await request(ctx.app).post('/review/answer').send(payload).expect(200);
    const retried = await request(ctx.app).post('/review/answer').send(payload).expect(200);
    assert.equal(first.body.duplicate, false);
    assert.equal(retried.body.duplicate, true);
    assert.equal(ctx.reviewLines().length, 1);

    await request(ctx.app).post('/review/answer').send({ ...payload, rating: 4 }).expect(409);
    assert.equal(ctx.reviewLines().length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('不存在的卡片不能写入复习日志', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    await request(ctx.app).post('/review/answer').send({
      eventId: 'missing-card-event', cardId: 'english/deleted', rating: 3
    }).expect(404);
    assert.equal(ctx.reviewFiles().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('答过的卡不再出现在当天队列里', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    const before = await request(ctx.app).get('/review').expect(200);
    assert.match(before.text, /新卡 2 张/);

    await request(ctx.app).post('/review/answer')
      .send({ eventId: 'event-http-basic', cardId: 'english/heterogeneity', rating: 3 }).expect(200);

    const after = await request(ctx.app).get('/review').expect(200);
    assert.match(after.text, /新卡 1 张/, '答过的那张应离开新卡队列');
  } finally {
    await ctx.cleanup();
  }
});

test('非法评分被拒绝，日志里不留脏数据', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    await request(ctx.app).post('/review/answer')
      .send({ cardId: 'english/heterogeneity', rating: 99 }).expect(400);
    await request(ctx.app).post('/review/answer')
      .send({ cardId: 'english/heterogeneity', rating: 0 }).expect(400);
    await request(ctx.app).post('/review/answer').send({ rating: 3 }).expect(400);

    assert.equal(ctx.reviewFiles().length, 0);
  } finally {
    await ctx.cleanup();
  }
});

// 只读模式只阻止 Markdown 改动，复习事件仍需落盘。
test('只读模式不能改 Markdown，但可以复习', async () => {
  const ctx = await setup({ readOnly: true, cards: { 'english.md': ENGLISH_DECK } });
  try {
    // 读与复习：全部放行
    await request(ctx.app).get('/decks').expect(200);
    await request(ctx.app).get('/review').expect(200);
    await request(ctx.app).post('/review/answer')
      .send({ eventId: 'event-http-basic', cardId: 'english/heterogeneity', rating: 3 }).expect(200);

    const lines = ctx.reviewLines();
    assert.equal(lines.length, 1, '复习记录必须真的写下来');
    assert.deepEqual(ctx.reviewFiles(), ['2026-03-phone.jsonl'], '每台设备写自己的事件文件');

    // 改 Markdown：一律拒绝
    await request(ctx.app).post('/save').type('form').send({ path: 'a.md', body: 'x' }).expect(403);
    await request(ctx.app).post('/cards/add').send({ front: '新卡' }).expect(403);
    await request(ctx.app).post('/diary/today').type('form').send({ date: '2026-03-17' }).expect(404);

    // 卡片文件确实没被动过
    const cardFile = await fs.readFile(path.join(ctx.vaultDir, 'cards', 'english.md'), 'utf8');
    assert.equal(cardFile, ENGLISH_DECK);
  } finally {
    await ctx.cleanup();
  }
});

test('只读实例使用专用 API 同步复习记录', async () => {
  const ctx = await setup({ readOnly: true, cards: { 'english.md': ENGLISH_DECK } });
  try {
    const calls = [];
    const app = createApp(ctx.config, {
      db: ctx.db,
      indexer: ctx.indexer,
      search: createSearch(ctx.db),
      sync: { syncReviewLogs: async (...args) => {
        calls.push(args);
        return { ok: true, committed: true, pushed: false, changed: false };
      } },
      now: () => FIXED_NOW
    });
    const response = await request(app).post('/review/sync').expect(200);
    assert.equal(response.body.committed, true);
    assert.equal(calls[0][0], 'phone');
  } finally {
    await ctx.cleanup();
  }
});

test('划词建卡把卡片追加到文件末尾，并反链回原笔记', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'reading/econ/ch03.md', { body: '工具变量' });
    await ctx.indexer.scan();

    await request(ctx.app).post('/cards/add').send({
      front: 'heterogeneity',
      back: '异质性',
      deckFile: 'english',
      source: 'reading/econ/ch03.md'
    }).expect(200);

    const content = await fs.readFile(path.join(ctx.vaultDir, 'cards', 'english.md'), 'utf8');
    assert.match(content, /## heterogeneity/);
    assert.match(content, /异质性/);
    assert.match(content, /\[\[reading\/econ\/ch03\]\]/, '应反链回原笔记');

    // 再建一张，不能覆盖前一张
    await request(ctx.app).post('/cards/add')
      .send({ front: 'endogeneity', back: '内生性', deckFile: 'english' }).expect(200);

    const updated = await fs.readFile(path.join(ctx.vaultDir, 'cards', 'english.md'), 'utf8');
    assert.match(updated, /heterogeneity/, '原有卡片必须还在');
    assert.match(updated, /endogeneity/);
  } finally {
    await ctx.cleanup();
  }
});

test('并发建卡不会丢失任何一张', async () => {
  const ctx = await setup();
  try {
    const fronts = Array.from({ length: 20 }, (_, index) => `并发卡片 ${index}`);
    const responses = await Promise.all(fronts.map(front => (
      request(ctx.app).post('/cards/add').send({ front, back: `${front} 的答案`, deckFile: 'parallel' })
    )));
    assert.ok(
      responses.every(response => response.status === 200),
      responses.map(response => `${response.status}: ${response.text}`).join('\n')
    );

    const content = await fs.readFile(path.join(ctx.vaultDir, 'cards', 'parallel.md'), 'utf8');
    for (const front of fronts) {
      assert.equal(content.split(`## ${front}\n`).length - 1, 1, `${front} 应且只应出现一次`);
    }
    assert.equal(content.split('---').length - 1, 2, 'frontmatter 只能有一份');
  } finally {
    await ctx.cleanup();
  }
});

test('建卡拒绝空正面和越界的文件名', async () => {
  const ctx = await setup();
  try {
    await request(ctx.app).post('/cards/add').send({ front: '   ' }).expect(400);
    await request(ctx.app).post('/cards/add')
      .send({ front: 'x', deckFile: '../../escape' }).expect(400);

    assert.equal(fsSync.existsSync(path.join(ctx.vaultDir, 'cards', '..', '..', 'escape.md')), false);
  } finally {
    await ctx.cleanup();
  }
});

test('挖空卡的题面不会把答案泄露到页面上', async () => {
  const ctx = await setup({
    cards: {
      'econ.md': '---\ndeck: 计量\n---\n\n## 工具变量的两个条件\n需要满足 {{相关性}} 和 {{外生性}}。'
    }
  });
  try {
    const response = await request(ctx.app).get('/review').expect(200);
    const queue = JSON.parse(decodeURIComponent(response.text.match(/data-queue="([^"]*)"/)[1]));

    assert.equal(queue.length, 1);
    assert.equal(queue[0].type, 'cloze');
    assert.match(queue[0].question, /＿＿＿＿/);
    assert.ok(!queue[0].question.includes('相关性'), '题面里不能出现答案');
    assert.match(queue[0].back, /相关性/, '答案面才有答案');
  } finally {
    await ctx.cleanup();
  }
});

// 实机渲染时发现的问题：hidden 属性被样式盖掉，四个评分按钮在揭示答案之前
// 就露出来了，人可以不经回忆直接打分 —— 主动回忆这件事就废了。
// 浏览器默认的 [hidden] { display: none } 优先级极低，任何带 display 的类都能盖掉。
test('样式表必须强制 [hidden] 生效，否则复习会提前露出评分按钮', async () => {
  const css = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'styles.css'), 'utf8');
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    '缺了这条规则，.rating-row 的 display:flex 会盖掉 hidden 属性'
  );
});

test('复习页在揭示答案前不把答案写进可见区域', async () => {
  const ctx = await setup({ cards: { 'english.md': ENGLISH_DECK } });
  try {
    const response = await request(ctx.app).get('/review').expect(200);
    // 答案确实在页面里（队列是一次性嵌入的），但必须待在 hidden 容器内。
    assert.match(response.text, /id="review-back" hidden/);
    assert.match(response.text, /id="review-ratings" hidden/);
  } finally {
    await ctx.cleanup();
  }
});

test('按卡组筛选复习', async () => {
  const ctx = await setup({
    cards: {
      'english.md': ENGLISH_DECK,
      'econ.md': '---\ndeck: 计量\n---\n\n## 工具变量\n满足相关性与外生性。'
    }
  });
  try {
    const all = await request(ctx.app).get('/review').expect(200);
    assert.match(all.text, /新卡 3 张/);

    const scoped = await request(ctx.app)
      .get('/review?deck=' + encodeURIComponent('计量')).expect(200);
    assert.match(scoped.text, /新卡 1 张/);
    assert.ok(!scoped.text.includes('heterogeneity'), '别的卡组不该混进来');
  } finally {
    await ctx.cleanup();
  }
});

test('开始复习计数应用全局新卡上限，并保留全部到期卡', async () => {
  const cardBody = (deck, count) => ['---', 'deck: ' + deck, '---', '',
    ...Array.from({ length: count }, (_, index) => '## Question ' + index + '\n\nAnswer\n')].join('\n');
  const ctx = await setup({ cards: {
    'first.md': cardBody('第一组', 15),
    'second.md': cardBody('第二组', 10)
  } });
  try {
    const initial = await request(ctx.app).get('/review').expect(200);
    const queueOf = html => JSON.parse(decodeURIComponent(html.match(/data-queue="([^"]*)"/)[1]));
    const firstCard = queueOf(initial.text)[0];
    await request(ctx.app).post('/review/answer').send({
      cardId: firstCard.id, rating: 1, eventId: 'forgotten-card'
    }).expect(200);

    const logPath = path.join(ctx.vaultDir, 'reviews', ctx.reviewFiles()[0]);
    const event = ctx.reviewLines()[0];
    event.ts = new Date(FIXED_NOW.getTime() - 86400000).toISOString();
    await fs.writeFile(logPath, JSON.stringify(event) + '\n');

    const decks = await request(ctx.app).get('/decks').expect(200);
    const session = await request(ctx.app).get('/review').expect(200);
    const actualQueue = queueOf(session.text);
    const buttonCount = Number(decks.text.match(/class="button-count">(\d+)/)[1]);
    assert.equal(buttonCount, 21, '1 张到期卡 + 本轮最多 20 张新卡');
    assert.equal(buttonCount, actualQueue.length);
    assert.match(decks.text, /新卡 24 张/, '全量新卡统计不能被本轮上限截断');
    assert.match(decks.text, /<th scope="col">已学<\/th>/);
    assert.doesNotMatch(decks.text, /已掌握/);
    assert.match(decks.text, /class="deck-progress-label">1 \/ 15/,
      '评分为“忘了”的卡片只计入已学，不应宣称已掌握');

    const home = await request(ctx.app).get('/').expect(200);
    assert.match(home.text, /今日复习<\/span><strong>21<\/strong>/);
    const scoped = await request(ctx.app).get('/review?deck=' + encodeURIComponent('第二组')).expect(200);
    assert.equal(queueOf(scoped.text).length, 10, '卡组内不足 20 张时全部载入');
  } finally {
    await ctx.cleanup();
  }
});
