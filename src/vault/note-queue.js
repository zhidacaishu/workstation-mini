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

/**
 * 一个文件在锁表里的名字。不区分大小写、Unicode 写法等价的磁盘上，
 * 「English.md」和「english.md」是同一把锁 —— 也就是同一个文件。
 */
async function queueKey(rootDir, relativePath) {
  const identity = await identityFor(rootDir);
  let key = toAbsolute(identity.root, relativePath);
  if (identity.unicodeEquivalent) key = key.normalize('NFC');
  if (identity.caseInsensitive) key = key.toLowerCase();
  return key;
}

// 全局写入闸门。Git 变基要改工作区里的文件：这时应用再写笔记，要么被变基覆盖，
// 要么让变基失败。withWritesPaused 期间新排进来的写入先等着，之前排进来的写完再开始。
let writeGate = Promise.resolve();
// 已经开始排队、还没完成的写入，以及各自排队时看到的闸门。
const inflight = new Set();

/**
 * 暂停笔记写入，跑完 operation 再放开。只用在会改工作区文件的本地 Git 操作上
 * （变基、冲突处理），不要把联网的 fetch 放进来：那会让保存按钮一直转。
 */
async function withWritesPaused(operation) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const previousGate = writeGate;
  const ownGate = previousGate.then(() => gate);
  writeGate = ownGate;
  try {
    const earlier = [...inflight].map(entry => entry.done);
    await previousGate;
    // 只等待设闸前的写入；之后的写入尚未占用文件队列。
    await Promise.allSettled(earlier);
    return await operation();
  } finally {
    release();
  }
}

async function enqueueFile(rootDir, relativePath, operation) {
  // 已经在一个持锁操作里（比如挪卡组时先拿源文件锁、再拿目标文件锁）：这次操作在闸门
  // 落下前就开始了，不能半路停下来等闸门 —— 闸门正等着它结束，那就是死锁。
  const held = heldKeys.getStore();
  const gate = held?.size ? Promise.resolve() : writeGate;
  let finish;
  const entry = { gate, done: new Promise(resolve => { finish = resolve; }) };
  inflight.add(entry);
  try {
    // 新写入先过闸门，再占文件队列，避免挡住闸门正在等待的嵌套写入。
    await gate;
    const key = await queueKey(rootDir, relativePath);

    // 已经握着这把锁就直接跑：再排一次是在等自己。
    // 串行性没丢 —— 外层那次入队仍然拦着其它调用方。
    if (held?.has(key)) return await operation();

    const owned = new Set(held);
    owned.add(key);

    const previous = fileQueues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(() => heldKeys.run(owned, operation));
    fileQueues.set(key, result);
    result.finally(() => {
      if (fileQueues.get(key) === result) fileQueues.delete(key);
    }).catch(() => {});
    return await result;
  } finally {
    inflight.delete(entry);
    finish();
  }
}

function enqueueNote(notesDir, notePath, operation) {
  return enqueueFile(notesDir, notePath, operation);
}

/**
 * 同时握住几个文件的锁。总按锁名排序后依次去拿：两个方向相反的操作
 * （A→B 和 B→A 挪卡组）各拿一把再等另一把，就是死锁，之后这两个文件
 * 的所有写入都会挂住。
 */
async function enqueueFiles(rootDir, relativePaths, operation) {
  const entries = [];
  for (const relativePath of relativePaths) {
    const key = await queueKey(rootDir, relativePath);
    if (!entries.some(entry => entry.key === key)) entries.push({ key, relativePath });
  }
  entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const run = index => index >= entries.length
    ? operation()
    : enqueueFile(rootDir, entries[index].relativePath, () => run(index + 1));
  return run(0);
}

module.exports = { enqueueFile, enqueueFiles, enqueueNote, queueKey, withWritesPaused };
