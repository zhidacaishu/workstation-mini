const net = require('node:net');
const { URL } = require('node:url');

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (net.isIP(host) !== 4) return false;
  const firstOctet = Number(host.split('.')[0]);
  return firstOctet === 127;
}

function normalizeBlobBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('大文件存储服务地址不能为空。');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('大文件存储服务地址必须是有效网址。');
  }

  if (url.username || url.password) {
    throw new Error('大文件存储服务地址不能包含账号或密码。');
  }
  if (url.search || url.hash) {
    throw new Error('大文件存储服务地址不能包含查询参数或片段。');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    throw new Error('大文件存储服务远程地址必须使用 HTTPS；HTTP 只允许 localhost 或回环 IP。');
  }
  if (!url.hostname) throw new Error('大文件存储服务地址缺少主机名。');

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

module.exports = { normalizeBlobBaseUrl, isLoopbackHostname };
