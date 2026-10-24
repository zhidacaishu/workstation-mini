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
const { appendCard } = require('../src/cards');

async function setup(t, readOnly = false) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-boundary-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, syncEnabled: false });
  await fs.mkdir(config.notesDir);
  const db = openDatabase(':memory:');
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  return { app, vaultDir };
}

test('错题页面、写入接口和静态脚本均已移除，只读模式也不再挂载', async t => {
  for (const readOnly of [false, true]) {
    const { app } = await setup(t, readOnly);
    const page = await request(app).get('/mistakes').expect(404);
    assert.match(page.text, /找不到页面/);
    await request(app).get('/static/mistakes.js').expect(404);
    for (const endpoint of ['check', 'exercise', 'card']) {
      const response = await request(app).post(`/mistakes/${endpoint}`)
        .send({ category: '旧入口', path: 'research/draft.md', id: 'legacy' }).expect(404);
      assert.equal(response.body.ok, false);
    }
  }
});

test('保留页面不再展示错题入口，已有日志和卡组保持不变且仍可复习', async t => {
  const { app, vaultDir } = await setup(t);
  const logDir = path.join(vaultDir, 'mistakes', 'exercise');
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, '2026-10-desktop.jsonl');
  const log = '{"id":"legacy","source":"exercise","category":"旧记录","ts":"2026-10-01T00:00:00Z"}\n';
  await fs.writeFile(logFile, log);
  const card = await appendCard(vaultDir, {
    deckFile: 'exercise-mistakes', front: '已保存的问题', back: '已保存的答案'
  });
  const cardPath = path.join(vaultDir, card.path);
  const originalCard = await fs.readFile(cardPath, 'utf8');

  for (const url of ['/', '/search', '/decks', '/tasks', '/calendar', '/history', '/deadlines', '/health']) {
    const page = await request(app).get(url).expect(200);
    assert.doesNotMatch(page.text, /href="\/mistakes(?:["/])|>错题</);
  }
  const review = await request(app).get('/review').expect(200);
  const queue = JSON.parse(decodeURIComponent(review.text.match(/data-queue="([^"]+)"/)[1]));
  assert.equal(queue.length, 1);
  assert.match(queue[0].front, /已保存的问题/);
  await request(app).post('/review/answer')
    .send({ cardId: queue[0].id, rating: 3, eventId: 'legacy-card-review' }).expect(200);
  for (const endpoint of ['check', 'exercise', 'card']) {
    await request(app).post(`/mistakes/${endpoint}`).send({ id: 'legacy' }).expect(404);
  }
  assert.equal(await fs.readFile(logFile, 'utf8'), log);
  assert.equal(await fs.readFile(cardPath, 'utf8'), originalCard);
});
