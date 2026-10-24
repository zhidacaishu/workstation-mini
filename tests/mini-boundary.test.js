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

async function setup() {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mini-boundary-'));
  await fs.mkdir(path.join(vaultDir, 'notes'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  return {
    app,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

test('Mini 首页只暴露保留的知识、复习、练习、研究和时间功能', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.app).get('/').expect(200);
    for (const label of ['今日', '笔记', '待办', '历史与草稿', '截止日期']) {
      assert.match(response.text, new RegExp(label));
    }
    for (const removedLabel of ['日记', '历年今日', '图谱', '知识库体检', 'PDF', '影子跟读', '博客发布', '投稿', '教材']) {
      assert.doesNotMatch(response.text, new RegExp(removedLabel), '不应显示已删除入口：' + removedLabel);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('Mini 对已删除能力的页面入口返回 404', async () => {
  const ctx = await setup();
  try {
    const removedPaths = [
      '/diary',
      '/diary/today',
      '/calendar',
      '/retro',
      '/briefing',
      '/graph',
      '/health',
      '/pdf/search',
      '/ask',
      '/shadowing',
      '/publish',
      '/board/submission',
      '/board/chapter'
    ];
    for (const route of removedPaths) {
      const response = await request(ctx.app).get(route);
      assert.equal(response.status, 404, route + ' 应被 Mini 移除');
    }
  } finally {
    await ctx.cleanup();
  }
});
