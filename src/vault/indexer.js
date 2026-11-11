const fsp = require('node:fs/promises');
const path = require('node:path');

const { tokenizeToText } = require('../segment');
const { toAbsolute, isSafeRelativePath, toPosix } = require('./paths');
const { listNotes, parseNote, NOTE_EXTENSION } = require('./note');
const { parseWikilinks, buildResolver } = require('./wikilink');
const { extractTasks } = require('../tasks');
const { stripMachineDirectives } = require('../machineDirectives');

const FAILURE_LIMIT = 50;

function sameEntry(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.ino !== 0 && left.ino !== 0n || left.dev !== 0 && left.dev !== 0n)
  );
}

function sameEntries(left, right) {
  return left.length === right.length
    && left.every((entry, index) => sameEntry(entry, right[index]));
}

async function inspectRelativePath(fsOps, vaultDir, relativePath) {
  const segments = toPosix(relativePath).split('/');
  const entries = [];
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments.slice(0, index + 1).join('/');
    let stats;
    try {
      stats = await fsOps.lstat(toAbsolute(vaultDir, current), { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const final = index === segments.length - 1;
    if (stats.isSymbolicLink() || (final ? !stats.isFile() : !stats.isDirectory())) return null;
    entries.push(stats);
  }
  return entries;
}

async function openVerifiedFile(fsOps, vaultDir, relativePath) {
  const before = await inspectRelativePath(fsOps, vaultDir, relativePath);
  if (!before) return null;

  let handle;
  try {
    handle = await fsOps.open(toAbsolute(vaultDir, relativePath), 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const [stats, identity] = await Promise.all([
      handle.stat(),
      handle.stat({ bigint: true })
    ]);
    const after = await inspectRelativePath(fsOps, vaultDir, relativePath);
    if (!stats.isFile() || !after || !sameEntries(before, after) || !sameEntry(identity, after.at(-1))) {
      await handle.close();
      return null;
    }
    return { handle, stats, entries: after };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function createIndexer({
  db,
  vaultDir,
  now = () => new Date().toISOString(),
  onProgress = null,
  fsOps = fsp,
  listNotesFn = listNotes,
  readOpenedFile = handle => handle.readFile('utf8')
}) {
  fsOps = { ...fsp, ...fsOps };
  let queue = Promise.resolve();
  let generation = 0;
  let failureMap = new Map();
  let status = {
    phase: 'indexing',
    scanKind: 'initial',
    generation,
    done: 0,
    total: 0,
    failureTotal: 0,
    failures: [],
    failuresTruncated: false,
    fatal: null,
    updatedAt: now()
  };

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function publicFailures() {
    const failures = [...failureMap.values()]
      .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
    return {
      failureTotal: failures.length,
      failures: failures.slice(0, FAILURE_LIMIT).map(failure => ({ ...failure })),
      failuresTruncated: failures.length > FAILURE_LIMIT
    };
  }

  function publish(patch) {
    status = {
      ...status,
      ...patch,
      ...publicFailures(),
      updatedAt: now()
    };
    onProgress?.(getStatus());
  }

  function getStatus() {
    return {
      ...status,
      failures: status.failures.map(failure => ({ ...failure })),
      fatal: status.fatal ? { ...status.fatal } : null
    };
  }

  function beginScan(scanKind, total) {
    generation += 1;
    publish({
      phase: 'indexing',
      scanKind,
      generation,
      done: 0,
      total,
      fatal: null
    });
  }

  /**
   * 单个文件出的错只记在这个文件名下，扫描接着往下走。以前只认权限错误和 YAML
   * 错误，其余一律让整轮扫描失败：一个 `---toml` 开头的笔记、一个带冒号的论文
   * 标题文件名，就能让排在后面的笔记都进不了索引、删除也不再生效。
   * 数据库错误不经过这里（写库在 indexOne 的 try 之外），仍按整轮失败处理。
   */
  function classifyFileError(relativePath, error, stage) {
    if (stage === 'name') {
      return {
        path: relativePath,
        code: 'unsafe-name',
        reason: '文件名在 Windows 上不可用（含 : ? * " < > | 等字符、以点或空格结尾，或是 CON、AUX 这类保留名），请改名',
        retryable: false
      };
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return {
        path: relativePath,
        code: 'read-denied',
        reason: '文件暂时无法读取',
        retryable: true
      };
    }
    if (stage === 'parse') {
      return {
        path: relativePath,
        code: 'invalid-frontmatter',
        reason: error?.name === 'FrontmatterError' ? error.message : '属性区（frontmatter）格式有误，点路径打开后修复',
        retryable: true
      };
    }
    return {
      path: relativePath,
      code: 'read-failed',
      reason: `文件读取失败（${error?.code || error?.message || '未知错误'}）`,
      retryable: true
    };
  }

  function fatalFor(error) {
    if (db.reportError?.(error)) {
      return {
        code: 'database-corrupt',
        reason: '索引数据库已损坏，重启应用后会自动重建',
        retryable: false
      };
    }
    const database = /sqlite/i.test(String(error?.code || ''))
      || /database|sqlite/i.test(String(error?.message || ''));
    return {
      code: database ? 'database-error' : 'index-system-error',
      reason: database ? '索引数据库操作失败' : '索引扫描遇到系统错误',
      retryable: true
    };
  }

  async function readRecord(relativePath, opened) {
    let raw;
    try {
      raw = await readOpenedFile(opened.handle, relativePath);
    } catch (error) {
      error.indexStage = 'read';
      throw error;
    }

    try {
      const note = parseNote(relativePath, raw, opened.stats);
      const visibleBody = stripMachineDirectives(note.body);
      const links = parseWikilinks(visibleBody);
      return {
        ...note,
        titleTokens: tokenizeToText(note.title),
        bodyTokens: tokenizeToText([note.title, note.tags.join(' '), visibleBody].join('\n')),
        links: dedupeLinks(links),
        tasks: extractTasks(visibleBody),
        indexedAt: now()
      };
    } catch (error) {
      error.indexStage = 'parse';
      throw error;
    }
  }

  function dedupeLinks(links) {
    const seen = new Map();
    for (const link of links) {
      if (!seen.has(link.target)) seen.set(link.target, { target: link.target, toPath: '' });
    }
    return [...seen.values()];
  }

  async function indexOne(relativePath, previous, force) {
    if (!isSafeRelativePath(relativePath)) {
      return { kind: 'failed', failure: classifyFileError(relativePath, null, 'name') };
    }
    let opened;
    let record;
    try {
      // 快路径只用 lstat：周期对账每 30 秒把整个资料库过一遍，绝大多数笔记没变，
      // 不该为了比一下 mtime 就把几千个文件逐个打开。
      if (!force && previous) {
        const entries = await inspectRelativePath(fsOps, vaultDir, relativePath);
        if (!entries) return { kind: 'missing' };
        const current = entries.at(-1);
        if (Math.floor(Number(current.mtimeMs)) === previous.mtimeMs && Number(current.size) === previous.size) {
          return { kind: 'unchanged' };
        }
      }
      opened = await openVerifiedFile(fsOps, vaultDir, relativePath);
      if (!opened) return { kind: 'missing' };
      const mtimeMs = Math.floor(opened.stats.mtimeMs);
      if (!force && previous?.mtimeMs === mtimeMs && previous.size === opened.stats.size) {
        return { kind: 'unchanged' };
      }
      record = await readRecord(relativePath, opened);
      const currentEntries = await inspectRelativePath(fsOps, vaultDir, relativePath);
      if (!currentEntries || !sameEntries(opened.entries, currentEntries)) return { kind: 'missing' };
    } catch (error) {
      return { kind: 'failed', failure: classifyFileError(relativePath, error, error.indexStage || 'read') };
    } finally {
      await opened?.handle.close().catch(() => {});
    }

    const mtimeMs = Math.floor(record.mtimeMs);
    if (!previous) {
      db.replaceNote(record);
      return { kind: 'added' };
    }

    if (record.hash === previous.hash) {
      db.touchNote(relativePath, mtimeMs, record.size, record.indexedAt);
      return { kind: 'unchanged' };
    }

    db.replaceNote(record);
    return { kind: 'updated' };
  }

  function reresolveLinks(stats, touched) {
    if (stats.added || stats.removed) {
      db.resolveAllLinks(buildResolver(db.listPaths()));
    } else if (stats.updated) {
      db.resolveLinksFrom(touched, buildResolver(db.listPaths()));
    }
  }

  function finishScan(scanKind, done, total, stats) {
    const phase = failureMap.size ? 'degraded' : 'ready';
    publish({ phase, scanKind, done, total, fatal: null });
    return { ...stats, phase, failureTotal: failureMap.size };
  }

  function failScan(scanKind, error) {
    publish({ phase: 'error', scanKind, fatal: fatalFor(error) });
    throw error;
  }

  async function scanOnce(options = {}) {
    const { force = false, kind = 'full' } = options;
    const stats = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    try {
      const onDisk = await listNotesFn(vaultDir);
      const eligibleSet = new Set();
      const indexed = new Map(db.listIndexed().map(row => [row.path, row]));
      const touched = [];
      const nextFailures = new Map();
      beginScan(kind, onDisk.length);
      let done = 0;

      for (const relativePath of onDisk) {
        const result = await indexOne(relativePath, indexed.get(relativePath), force);
        if (result.kind === 'failed') {
          eligibleSet.add(relativePath);
          nextFailures.set(relativePath, result.failure);
        } else if (result.kind !== 'missing') {
          eligibleSet.add(relativePath);
          stats[result.kind] += 1;
          if (result.kind === 'added' || result.kind === 'updated') touched.push(relativePath);
        }
        done += 1;
        if (done % 50 === 0 || done === onDisk.length) publish({ done, total: onDisk.length });
      }

      for (const indexedPath of indexed.keys()) {
        if (!eligibleSet.has(indexedPath)) {
          db.removeNote(indexedPath);
          stats.removed += 1;
        }
      }

      reresolveLinks(stats, touched);
      failureMap = nextFailures;
      return finishScan(kind, onDisk.length, onDisk.length, stats);
    } catch (error) {
      return failScan(kind, error);
    }
  }

  function candidatesFrom(paths) {
    return [...new Set(
      paths
        .map(value => toPosix(value))
        .filter(value => value.toLowerCase().endsWith(NOTE_EXTENSION) && isSafeRelativePath(value))
        .filter(value => !value.split('/').some(segment => segment.startsWith('.') || segment === 'node_modules'))
    )];
  }

  async function needsCaseReconciliation(candidates) {
    if (process.platform !== 'win32' || candidates.length === 0) return false;
    const indexed = new Map();
    for (const row of db.listIndexed()) {
      const key = row.path.toLowerCase();
      const aliases = indexed.get(key) || [];
      aliases.push(row.path);
      indexed.set(key, aliases);
    }
    let root;
    try { root = await fsOps.realpath(vaultDir); } catch { return false; }
    for (const candidate of candidates) {
      try {
        // 只用实际拼写判断是否需要对账，不把跟随链接的结果直接拿去入库。
        const actual = toPosix(path.relative(root, await fsOps.realpath(toAbsolute(vaultDir, candidate))));
        if (actual !== candidate || indexed.get(actual.toLowerCase())?.some(alias => alias !== actual)) {
          return true;
        }
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        // 权限等读取错误交给原有逐文件检查，不能把失败误当删除。
      }
    }
    return false;
  }

  async function scanPathsOnce(paths, options = {}) {
    const { kind = 'incremental' } = options;
    const stats = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    const touched = [];
    const candidates = candidatesFrom(paths);
    let done = 0;

    try {
      if (await needsCaseReconciliation(candidates)) return await scanOnce({ kind, force: true });
      beginScan(kind, candidates.length);
      for (const relativePath of candidates) {
        const previous = db.getIndexed(relativePath);
        let link;
        try {
          link = await fsOps.lstat(toAbsolute(vaultDir, relativePath));
        } catch (error) {
          if (error.code !== 'ENOENT') {
            failureMap.set(relativePath, classifyFileError(relativePath, error, 'read'));
            done += 1;
            publish({ done, total: candidates.length });
            continue;
          }
        }
        if (link?.isSymbolicLink()) {
          failureMap.delete(relativePath);
          if (previous) {
            db.removeNote(relativePath);
            stats.removed += 1;
          }
          done += 1;
          publish({ done, total: candidates.length });
          continue;
        }

        const result = await indexOne(relativePath, previous, true);
        if (result.kind === 'failed') {
          failureMap.set(relativePath, result.failure);
        } else if (result.kind === 'missing') {
          failureMap.delete(relativePath);
          if (previous) {
            db.removeNote(relativePath);
            stats.removed += 1;
          }
        } else {
          failureMap.delete(relativePath);
          stats[result.kind] += 1;
          if (result.kind === 'added' || result.kind === 'updated') touched.push(relativePath);
        }
        done += 1;
        publish({ done, total: candidates.length });
      }

      reresolveLinks(stats, touched);
      return finishScan(kind, candidates.length, candidates.length, stats);
    } catch (error) {
      return failScan(kind, error);
    }
  }

  function scan(options = {}) {
    if (Array.isArray(options.paths)) {
      const { paths, kind = 'incremental' } = options;
      return enqueue(() => scanPathsOnce(paths, { kind }));
    }
    return enqueue(() => scanOnce(options));
  }

  function retry() {
    return enqueue(() => {
      if (status.phase === 'ready') {
        return { skipped: '索引没有失败项', phase: 'ready', failureTotal: 0 };
      }
      if (status.phase === 'degraded' && failureMap.size) {
        return scanPathsOnce([...failureMap.keys()], { kind: 'retry' });
      }
      return scanOnce({ force: true, kind: 'retry' });
    });
  }

  function idle() {
    return queue;
  }

  return { scan, retry, getStatus, idle };
}

module.exports = { createIndexer };
