const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIncludedResponse,
  classifyIncludedResponse
} = require('../scripts/release-api-response');

function response(status, body = '') {
  return `HTTP/2.0 ${status} status\r\ncontent-type: application/json\r\n\r\n${body}`;
}

test('GitHub Release 200 响应必须有合法 JSON 且 gh 成功', () => {
  const release = { draft: true, target_commitish: 'a'.repeat(40) };
  assert.deepEqual(classifyIncludedResponse(response(200, JSON.stringify(release)), 0), {
    kind: 'found',
    release
  });
  assert.throws(() => classifyIncludedResponse(response(200, '{}'), 1), /HTTP 200.*exit status 1/);
  assert.throws(() => classifyIncludedResponse(response(200, 'not-json'), 0), /invalid release response/);
});

test('只有明确 HTTP 404 且 gh 失败才归类为不存在', () => {
  assert.deepEqual(classifyIncludedResponse(response(404, '{"message":"Not Found"}'), 1), {
    kind: 'not-found'
  });
  assert.throws(() => classifyIncludedResponse(response(404), 0), /HTTP 404.*exit status 0/);
});

test('认证、限流、服务端和传输异常全部 fail closed', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    assert.throws(
      () => classifyIncludedResponse(response(status, '{"message":"failure"}'), 1),
      new RegExp(`HTTP ${status}`)
    );
  }
  assert.throws(() => parseIncludedResponse('network connection failed'), /HTTP status/);
  assert.throws(() => classifyIncludedResponse('', 1), /HTTP status/);
});

test('多段 included 响应使用最后一段 HTTP 状态', () => {
  const output = `${response(301)}\n${response(404, '{"message":"Not Found"}')}`;
  assert.deepEqual(classifyIncludedResponse(output, 1), { kind: 'not-found' });
});
