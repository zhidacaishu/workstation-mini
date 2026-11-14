const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForApi } = require('./desktop-test-utils');

test('桌面 API 等待会继续请求异步返回的未就绪结果，直到实际就绪', async () => {
  let calls = 0;
  const page = {
    isClosed: () => false,
    evaluate: async (_fn, endpoint) => {
      assert.equal(endpoint, '/status');
      calls += 1;
      await new Promise(resolve => setImmediate(resolve));
      return { phase: calls < 3 ? 'building' : 'ready' };
    }
  };
  const result = await waitForApi(page, '/status', value => value.phase === 'ready', { interval: 1, timeout: 1000 });
  assert.deepEqual(result, { phase: 'ready' });
  assert.equal(calls, 3);
});

test('桌面 API 等待未就绪时超时失败，并提供最后的实际响应', async () => {
  const page = { isClosed: () => false, evaluate: async () => ({ phase: 'building' }) };
  await assert.rejects(waitForApi(page, '/status', value => value.phase === 'ready', { interval: 5, timeout: 50 }),
    /等待 \/status 超时.*building/);
});
