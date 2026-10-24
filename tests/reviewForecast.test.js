const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createReviewService, DEFAULT_NEW_LIMIT } = require('../src/reviewService');
const { appendCard } = require('../src/cards');

// 保留原测试文件作为移除边界回归：预测不再暴露，实际复习队列和事件仍可用。
test('移除负荷预测不影响新卡队列、评分和复习统计', async t => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-boundary-'));
  t.after(() => fs.rm(vaultDir, { recursive: true, force: true }));
  await appendCard(vaultDir, { deckFile: 'research', front: '问题一', back: '答案一' });
  await appendCard(vaultDir, { deckFile: 'research', front: '问题二', back: '答案二' });
  const service = createReviewService({ vaultDir, device: 'desktop', now: () => new Date(2026, 9, 25, 9) });
  assert.equal(Object.hasOwn(service, 'forecast'), false);
  assert.equal(Object.hasOwn(require('../src/reviewService'), 'FORECAST_DAYS'), false);
  assert.equal(DEFAULT_NEW_LIMIT, 20);
  const queue = await service.queue();
  assert.equal(queue.fresh.length, 2);
  assert.equal(queue.due.length, 0);
  await service.answer(queue.cards[0].id, 3, 1000, 'boundary-answer');
  assert.equal((await service.queue()).fresh.length, 1);
  const stats = await service.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.decks[0].learned, 1);
  assert.equal((await service.store.readEvents()).length, 1);
});
