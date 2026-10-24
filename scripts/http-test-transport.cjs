// Supertest 默认监听 ::，却总向 127.0.0.1 发请求。macOS 上两种监听
// 可以占用同一端口；使用实际监听的地址族，避免请求进入其它本机服务。
const { Test } = require('supertest');
const serverAddress = Test.prototype.serverAddress;
Test.prototype.serverAddress = function (app, path) {
  const url = serverAddress.call(this, app, path);
  return app.address()?.family === 'IPv6'
    ? url.replace('://127.0.0.1:', '://[::1]:')
    : url;
};
