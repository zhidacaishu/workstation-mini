const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('../scripts/http-test-transport.cjs');
const request = require('supertest');

test('HTTP 测试请求跟随实际监听地址族，不进入同端口 IPv4 服务', async t => {
  const server = http.createServer((req, res) => res.end('expected'));
  const other = http.createServer((req, res) => res.end('unrelated'));
  try {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: 0, host: '::', ipv6Only: true }, resolve);
      });
    } catch (error) {
      // 有的容器、虚拟机没有 IPv6：这条测的就是 IPv6 和 IPv4 同端口并存，没有就跳过。
      if (error.code === 'EAFNOSUPPORT' || error.code === 'EADDRNOTAVAIL') { t.skip('本机没有 IPv6'); return; }
      throw error;
    }
    await new Promise((resolve, reject) => {
      other.once('error', reject);
      other.listen(server.address().port, '127.0.0.1', resolve);
    });
    const response = await request(server).get('/').expect(200);
    assert.equal(response.text, 'expected');
  } finally {
    await Promise.all([server, other].filter(item => item.listening).map(item => new Promise(resolve => item.close(resolve))));
  }
});

test('HTTP 测试仍支持显式 IPv4 服务', async () => {
  const server = http.createServer((req, res) => res.end('ipv4'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await request(server).get('/').expect(200);
    assert.equal(response.text, 'ipv4');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
