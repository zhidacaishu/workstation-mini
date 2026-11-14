// waitForFunction 检查返回值的真值，async 谓词的 Promise 会立即被当成成功。
// 请求条件必须在测试进程中等待响应，再决定是否继续轮询。
const { setTimeout: delay } = require('node:timers/promises');

async function waitForApi(page, endpoint, condition, { timeout = 30000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let failure;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      }, endpoint);
      if (await condition(last)) return last;
      failure = null;
    } catch (error) {
      if (page.isClosed()) throw error;
      failure = error;
    }
    await delay(interval);
  }
  throw new Error('等待 ' + endpoint + ' 超时：' + (failure?.message || JSON.stringify(last)));
}

module.exports = { waitForApi };
