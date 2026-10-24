const fs = require('node:fs');
const fsp = require('node:fs/promises');

// Windows 上 rename 会被瞬时占用打断：杀毒软件、索引服务、编辑器都可能
// 在目标文件上短暂持有句柄。这几个错误码是「再试一下就好」，不是真失败。
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_TIMEOUT_MS = 2000;

/**
 * 原子替换：rename 到目标位置，遇到瞬时占用就退避重试。
 *
 * 笔记正文和二进制附件都靠它落盘 —— 先写临时文件再整体换过去，
 * 写到一半崩溃只会留下临时文件，不会留下半截的真文件。
 */
async function replaceFile(source, target) {
  const deadline = Date.now() + RENAME_RETRY_TIMEOUT_MS;
  let delay = 25;

  for (;;) {
    try {
      await fsp.rename(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error.code) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/**
 * 同步版本。语义和 replaceFile 完全一致，只是不让调用方变成 async。
 *
 * 存在的理由只有一个：设置文件的落盘（electron/config-store.js）是同步的，
 * 而它被夹在「改设置 → 重启运行时 → 失败就回滚」这条路径中间 —— 把它改成
 * 异步会把 async 一路传染到回滚逻辑里，那段代码的时序恰恰是最不该动的。
 * 于是重试逻辑在这里再写一遍，但常量和错误码表还是共用上面那一份：
 * 「哪些错码算瞬时占用」只能有一个答案。
 *
 * 用 Atomics.wait 而不是忙等：忙等会在退避期间烧满一个核，而这里本来就是
 * 在给杀毒软件/索引服务让路，抢 CPU 只会让那边更慢放手。
 */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function replaceFileSync(source, target) {
  const deadline = Date.now() + RENAME_RETRY_TIMEOUT_MS;
  let delay = 25;

  for (;;) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error.code) || Date.now() >= deadline) throw error;
      sleepSync(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}

function endsWithoutNewline(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const { size } = fs.fstatSync(descriptor);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(descriptor, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * 往 JSONL 追加若干行。
 *
 * 上次崩溃可能留下一段没有换行的半行。直接追加的话，第一条新记录会接在它后面，
 * 整行解析失败被读取方当坏行跳过 —— 写入回报成功，数据却丢了。所以先看一眼
 * 文件末尾，缺换行就先补一个，把半行隔离在它自己那一行里。
 */
function appendLinesSync(filePath, lines) {
  const separator = endsWithoutNewline(filePath) ? '\n' : '';
  fs.appendFileSync(filePath, `${separator}${lines.join('\n')}\n`, 'utf8');
}

module.exports = {
  replaceFile,
  replaceFileSync,
  appendLinesSync,
  TRANSIENT_RENAME_ERRORS,
  RENAME_RETRY_TIMEOUT_MS
};
