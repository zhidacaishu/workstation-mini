const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const { toAbsolute } = require('./paths');

const fileQueues = new Map();
const identityProbes = new Map();

// 当前这条异步调用链已经持有哪几把锁。
//
// 队列是「同一路径串行」，但没有可重入性：操作内部再对同一路径排一次队，
// 排的是自己后面，于是永远等不到 —— 而且那个 key 从此再也解不开，之后
// 所有对这篇笔记的写入全都挂住。这类嵌套在业务上是合理的（一个写入过程里
// 顺带落一篇派生笔记），所以这里认出重入并直接执行，而不是让它自锁。
const heldKeys = new AsyncLocalStorage();

async function sameFile(original, alias, nonce) {
  try {
    const [left, right] = await Promise.all([fs.stat(original), fs.stat(alias)]);
    if (left.dev === right.dev && left.ino === right.ino) return true;
    return await fs.readFile(alias, 'utf8') === nonce;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function probeIdentity(rootDir) {
  const resolvedRoot = await fs.realpath(rootDir);
  const nonce = randomUUID();
  const filename = `.workstation-fs-Probe-é.tmp-${nonce}`;
  const original = path.join(resolvedRoot, filename);
  const caseAlias = path.join(resolvedRoot, filename.replace('Probe', 'probe'));
  const unicodeAlias = path.join(resolvedRoot, filename.normalize('NFD'));

  try {
    await fs.writeFile(original, nonce, { encoding: 'utf8', flag: 'wx' });
    return {
      root: resolvedRoot,
      caseInsensitive: await sameFile(original, caseAlias, nonce),
      unicodeEquivalent: await sameFile(original, unicodeAlias, nonce)
    };
  } finally {
    await fs.rm(original, { force: true });
  }
}

function identityFor(rootDir) {
  const cacheKey = path.resolve(rootDir);
  let probe = identityProbes.get(cacheKey);
  if (!probe) {
    probe = probeIdentity(cacheKey).catch(() => ({
      root: cacheKey,
      caseInsensitive: true,
      unicodeEquivalent: true
    }));
    identityProbes.set(cacheKey, probe);
  }
  return probe;
}

async function enqueueFile(rootDir, relativePath, operation) {
  const identity = await identityFor(rootDir);
  let key = toAbsolute(identity.root, relativePath);
  if (identity.unicodeEquivalent) key = key.normalize('NFC');
  if (identity.caseInsensitive) key = key.toLowerCase();

  // 已经握着这把锁就直接跑：再排一次是在等自己。
  // 串行性没丢 —— 外层那次入队仍然拦着其它调用方。
  const held = heldKeys.getStore();
  if (held?.has(key)) return operation();

  const owned = new Set(held);
  owned.add(key);

  const previous = fileQueues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => heldKeys.run(owned, operation));
  fileQueues.set(key, result);
  result.finally(() => {
    if (fileQueues.get(key) === result) fileQueues.delete(key);
  }).catch(() => {});
  return result;
}

function enqueueNote(notesDir, notePath, operation) {
  return enqueueFile(notesDir, notePath, operation);
}

module.exports = { enqueueFile, enqueueNote };
