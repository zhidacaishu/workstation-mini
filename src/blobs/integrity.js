const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { ensureSafeFilePath } = require('../vault/paths');
const cache = new Map();
async function fingerprint(root, relative, { signal } = {}) {
  signal?.throwIfAborted();
  const absolute = await ensureSafeFilePath(root, relative);
  const before = await fsp.stat(absolute);
  const signature = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':');
  if (cache.get(absolute)?.signature === signature) return cache.get(absolute).value;
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(absolute, { signal })) digest.update(chunk);
  await ensureSafeFilePath(root, relative);
  const after = await fsp.stat(absolute);
  if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== signature) {
    throw new Error('文件正在变化，稍后重试。');
  }
  const value = { size: after.size, sha256: digest.digest('hex'), mtimeMs: after.mtimeMs };
  if (cache.size > 10000) cache.clear();
  cache.set(absolute, { signature, value });
  return value;
}
module.exports = { fingerprint };
