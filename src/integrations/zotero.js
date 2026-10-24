const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// Zotero 7 的本地 API。无需认证，与 Web API v3 同构。
const LOCAL_API = 'http://localhost:23119/api/users/0';

// 已知可用的 userdata schema 版本区间。
//
// zotero.sqlite 的表结构会随 Zotero 版本变化。版本超出这个区间就直接报错，
// 而不是照着旧假设去读 —— 静默读出错误的标注比读不出来糟糕得多。
const KNOWN_SCHEMA_MIN = 120;
const KNOWN_SCHEMA_MAX = 200;

function defaultDataDir() {
  return path.join(os.homedir(), 'Zotero');
}

function sqlitePath(dataDir) {
  return path.join(dataDir || defaultDataDir(), 'zotero.sqlite');
}

/** 题录走本地 API：官方接口，随 Zotero 版本演进，比读库稳。 */
async function fetchItems({ base = LOCAL_API, limit = 100, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/items/top?limit=${limit}&format=json`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return { available: false, reason: `本地 API 返回 ${response.status}` };
    const raw = await response.json();
    return { available: true, items: raw.map(normalizeItem).filter(Boolean) };
  } catch (error) {
    // Zotero 没开着就是这条路径。不是错误，是常态。
    return { available: false, reason: `连不上 Zotero 本地 API（${error.name === 'AbortError' ? '超时' : error.message}）` };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeItem(entry) {
  const data = entry?.data;
  if (!data || !data.title) return null;
  return {
    key: data.key,
    title: String(data.title),
    creators: (data.creators || [])
      .map(c => [c.lastName, c.firstName].filter(Boolean).join(', ') || c.name)
      .filter(Boolean),
    year: String(data.date || '').match(/\d{4}/)?.[0] || '',
    publication: data.publicationTitle || data.proceedingsTitle || '',
    doi: data.DOI || '',
    itemType: data.itemType || '',
    tags: (data.tags || []).map(t => String(t.tag)).filter(Boolean),
    abstract: data.abstractNote || ''
  };
}

function readAnnotationItems(db) {
  const rows = db.prepare(`
    SELECT
      ann.itemID       AS itemID,
      ann.text         AS text,
      ann.comment      AS comment,
      ann.color        AS color,
      ann.pageLabel    AS page,
      ann.sortIndex    AS sortIndex,
      parent.key       AS parentKey,
      titleValue.value AS parentTitle
    FROM itemAnnotations ann
    JOIN itemAttachments att ON att.itemID = ann.parentItemID
    JOIN items parent ON parent.itemID = att.parentItemID
    LEFT JOIN itemData titleData
           ON titleData.itemID = parent.itemID
          AND titleData.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'title')
    LEFT JOIN itemDataValues titleValue ON titleValue.valueID = titleData.valueID
    WHERE ann.text IS NOT NULL
      AND trim(ann.text) != ''
      AND NOT EXISTS (SELECT 1 FROM deletedItems deleted WHERE deleted.itemID = ann.itemID)
      AND NOT EXISTS (SELECT 1 FROM deletedItems deleted WHERE deleted.itemID = att.itemID)
      AND NOT EXISTS (SELECT 1 FROM deletedItems deleted WHERE deleted.itemID = parent.itemID)
    ORDER BY parent.key, ann.sortIndex
  `).all();

  const byItem = new Map();
  for (const row of rows) {
    const entry = byItem.get(row.parentKey) || {
      key: row.parentKey,
      title: row.parentTitle || '(无标题)',
      annotations: []
    };
    entry.annotations.push({
      itemID: Number(row.itemID),
      text: String(row.text || '').trim(),
      comment: String(row.comment || '').trim(),
      color: row.color || '',
      page: row.page || '',
      sortIndex: row.sortIndex || ''
    });
    byItem.set(row.parentKey, entry);
  }
  return [...byItem.values()];
}

/**
 * 附件所在库的全局身份：用户库是 `user`，群组库是 `group-<groupID>`。
 *
 * 不能用 Zotero 的 libraryID：那是本机的自增编号，同一个群组库在两台电脑上
 * 通常不一样。解析缓存按库分目录并随资料库进 Git，用本机编号的话，换一台
 * 设备就对不上 —— 轻则显示未解析，重则被当成「附件已删除」清理掉。
 * groupID 是 Zotero 服务端分配的，各设备一致；用户库每个 Zotero 档案只有一个。
 * 订阅源（feed）之类的库只在本机存在，也没有 storage PDF，不纳入。
 */
function globalLibraryId(type, groupId) {
  if (type === 'user') return 'user';
  if (type === 'group' && Number.isSafeInteger(Number(groupId)) && Number(groupId) > 0) {
    return `group-${Number(groupId)}`;
  }
  return '';
}

function readPdfAttachments(db) {
  return db.prepare(`
    SELECT
      library.type             AS libraryType,
      grp.groupID              AS groupId,
      attachmentItem.key       AS attachmentKey,
      parent.key               AS parentKey,
      titleValue.value         AS parentTitle,
      att.path                 AS storagePath,
      att.contentType          AS contentType,
      att.linkMode             AS linkMode,
      -- Zotero 的回收站是软删除：条目还在 items 里，用户随时能还原。所以这里
      -- 不把回收站条目过滤掉，而是标出来 —— 「在回收站」和「被彻底删除」必须
      -- 分开，否则调用方会把前者当成后者，去清理不该清理的东西。
      (EXISTS (SELECT 1 FROM deletedItems deleted WHERE deleted.itemID = attachmentItem.itemID)
        OR (parent.itemID IS NOT NULL AND EXISTS (
          SELECT 1 FROM deletedItems deleted WHERE deleted.itemID = parent.itemID
        ))) AS trashed
    FROM itemAttachments att
    JOIN items attachmentItem ON attachmentItem.itemID = att.itemID
    JOIN libraries library ON library.libraryID = attachmentItem.libraryID
    LEFT JOIN groups grp ON grp.libraryID = attachmentItem.libraryID
    LEFT JOIN items parent ON parent.itemID = att.parentItemID
    LEFT JOIN itemData titleData
           ON titleData.itemID = parent.itemID
          AND titleData.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'title')
    LEFT JOIN itemDataValues titleValue ON titleValue.valueID = titleData.valueID
    WHERE lower(att.contentType) = 'application/pdf'
      AND att.linkMode IN (0, 1)
      AND att.path LIKE 'storage:%'
    ORDER BY attachmentItem.libraryID, attachmentItem.key
  `).all().map(row => ({
    libraryId: globalLibraryId(row.libraryType, row.groupId),
    attachmentKey: String(row.attachmentKey || ''),
    parentKey: row.parentKey ? String(row.parentKey) : '',
    parentTitle: row.parentTitle ? String(row.parentTitle) : '',
    storagePath: String(row.storagePath || ''),
    contentType: String(row.contentType || ''),
    linkMode: Number(row.linkMode),
    trashed: Boolean(row.trashed)
  })).filter(attachment => attachment.libraryId);
}

/** 标注和 PDF 清单必须来自同一个 SQLite online backup。 */
async function readLibraryDataUncached(dataDir) {
  const readAt = Date.now();
  const source = sqlitePath(dataDir);
  if (!fs.existsSync(source)) {
    return {
      available: false,
      reason: '在所选 Zotero 数据目录中找不到 zotero.sqlite',
      items: [],
      attachments: [],
      trashedAttachments: [],
      readAt: Date.now()
    };
  }

  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), `zotero-copy-${process.pid}-`));
  const copy = path.join(temporaryDir, 'zotero.sqlite');
  let sourceDb;
  let db;
  try {
    sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    await sourceDb.backup(copy);
    db = new Database(copy, { readonly: true });

    const schema = db.prepare(`SELECT version FROM version WHERE schema = 'userdata'`).get()?.version;
    if (!schema || schema < KNOWN_SCHEMA_MIN || schema > KNOWN_SCHEMA_MAX) {
      return {
        available: false,
        reason: `Zotero 数据库 schema 版本 ${schema ?? '未知'} 不在已知区间`
          + `（${KNOWN_SCHEMA_MIN}–${KNOWN_SCHEMA_MAX}）。表结构可能变了，先别读，免得静默取出错误数据。`,
        items: [],
        attachments: [],
        trashedAttachments: [],
        readAt: Date.now()
      };
    }

    const pdfAttachments = readPdfAttachments(db);
    return {
      available: true,
      schema,
      // 这份快照对应的时刻。谁拿它做删除决策，都必须先确认自己要删的东西
      // 不比这个时刻更新 —— 否则就是拿过期信息去删刚产生的结果。
      readAt,
      items: readAnnotationItems(db),
      // attachments 的语义不变：只有在库的附件才进文献页、才允许解析。
      attachments: pdfAttachments.filter(item => !item.trashed),
      trashedAttachments: pdfAttachments.filter(item => item.trashed)
    };
  } catch {
    return {
      available: false,
      reason: '读取 Zotero 数据库失败，请确认数据目录和数据库状态',
      items: [],
      attachments: [],
      trashedAttachments: [],
      readAt: Date.now()
    };
  } finally {
    if (db) db.close();
    if (sourceDb) sourceDb.close();
    await fsp.rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 每次调用都要把整个 zotero.sqlite 做一次 online backup 到临时目录。一条解析
// 路径上 describeLibrary、enqueue、resolveTrustedAttachment 各要一份，大库就是
// 三次几百 MB 的拷贝。这里只做「同一次用户操作内的合并」：窗口很短，源库的
// size/mtime 一变立刻作废，所以看不到比原来更旧的数据。
const LIBRARY_CACHE_TTL_MS = 5_000;
const LIBRARY_CACHE_MAX_ENTRIES = 8;
const libraryCache = new Map();

function sourceSignature(source) {
  // WAL 模式下（Zotero 就是这么跑的）写入先落在 -wal 里，主库的 size/mtime
  // 可以长时间纹丝不动。只看主库的话，缓存该失效的时候不会失效。
  return [source, `${source}-wal`].map(target => {
    try {
      const stats = fs.statSync(target);
      return `${stats.size}:${stats.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }).join('|');
}

function clearLibraryCache() {
  libraryCache.clear();
}

function cloneLibraryData(value) {
  // 调用方拿到的是自己的数组副本，免得谁就地排序或删元素污染了缓存。
  return {
    ...value,
    items: [...(value.items || [])],
    attachments: [...(value.attachments || [])],
    trashedAttachments: [...(value.trashedAttachments || [])]
  };
}

// read 可注入：不然「这次是不是复用了缓存」在外面根本观测不到，测试只能去断言
// 一些无缓存时同样成立的东西，写出来是绿的却什么也没守住。
async function readLibraryData(dataDir, { read = readLibraryDataUncached } = {}) {
  const source = sqlitePath(dataDir);
  const signature = sourceSignature(source);
  const cached = libraryCache.get(source);
  if (cached && cached.signature === signature && Date.now() < cached.expiresAt) {
    return cloneLibraryData(await cached.promise);
  }

  const promise = read(dataDir);
  if (libraryCache.size >= LIBRARY_CACHE_MAX_ENTRIES) libraryCache.clear();
  libraryCache.set(source, { signature, expiresAt: Date.now() + LIBRARY_CACHE_TTL_MS, promise });
  try {
    const value = await promise;
    // 读失败不缓存：Zotero 短暂锁库的话，界面不该连着 5 秒都说读不到。
    if (!value.available) libraryCache.delete(source);
    return cloneLibraryData(value);
  } catch (error) {
    libraryCache.delete(source);
    throw error;
  }
}

async function readAnnotations(dataDir) {
  const result = await readLibraryData(dataDir);
  if (!result.available) return { available: false, reason: result.reason, items: [] };
  return { available: true, schema: result.schema, items: result.items };
}

function attachmentFileName(attachment) {
  const key = String(attachment?.attachmentKey || '');
  const storagePath = String(attachment?.storagePath || '');
  if (!/^[A-Za-z0-9]+$/.test(key)) throw new Error('Zotero 附件标识无效。');
  if (!storagePath.startsWith('storage:')) throw new Error('Zotero 附件不是 storage 文件。');
  const fileName = storagePath.slice('storage:'.length);
  if (!fileName || fileName !== path.basename(fileName) || /[\\/]/.test(fileName) || !/\.pdf$/i.test(fileName)) {
    throw new Error('Zotero PDF 文件名无效。');
  }
  return { key, fileName };
}

async function openAttachmentPdf(dataDir, attachment) {
  const { key, fileName } = attachmentFileName(attachment);
  const storageRoot = path.join(dataDir || defaultDataDir(), 'storage');
  const rootStats = await fsp.lstat(storageRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Zotero storage 目录无效。');
  const rootReal = await fsp.realpath(storageRoot);
  const attachmentDir = path.join(storageRoot, key);
  const directoryStats = await fsp.lstat(attachmentDir);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) throw new Error('Zotero 附件目录无效。');
  const directoryReal = await fsp.realpath(attachmentDir);
  const directoryRelative = path.relative(rootReal, directoryReal);
  if (!directoryRelative || directoryRelative.startsWith('..') || path.isAbsolute(directoryRelative)) {
    throw new Error('Zotero 附件目录越过 storage 边界。');
  }

  const absolutePath = path.join(attachmentDir, fileName);
  const fileStats = await fsp.lstat(absolutePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw new Error('Zotero 附件不是普通文件。');
  const fileReal = await fsp.realpath(absolutePath);
  const fileRelative = path.relative(rootReal, fileReal);
  if (!fileRelative || fileRelative.startsWith('..') || path.isAbsolute(fileRelative)) {
    throw new Error('Zotero 附件越过 storage 边界。');
  }

  let handle;
  try {
    handle = await fsp.open(absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Zotero 附件不是普通文件。');
    const magic = Buffer.alloc(5);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== magic.length || magic.toString('ascii') !== '%PDF-') {
      throw new Error('Zotero 附件内容不是 PDF。');
    }
    return { handle, stats, fileName };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}

async function inspectAttachmentPdf(dataDir, attachment) {
  try {
    const opened = await openAttachmentPdf(dataDir, attachment);
    await opened.handle.close();
    return {
      available: true,
      fileName: opened.fileName,
      size: opened.stats.size,
      mtimeMs: opened.stats.mtimeMs
    };
  } catch (error) {
    const authored = String(error.message || '').startsWith('Zotero ');
    return {
      available: false,
      fileName: (() => {
        try { return attachmentFileName(attachment).fileName; } catch { return ''; }
      })(),
      reason: error.code === 'ENOENT'
        ? 'PDF 尚未下载到本机。'
        : authored
          ? error.message
          : '无法读取本机 Zotero PDF。'
    };
  }
}

/** 文献笔记的路径：notes/lit/<key>.md */
function litPath(key) {
  return `lit/${String(key).replace(/[^A-Za-z0-9_-]/g, '')}.md`;
}

/**
 * 把题录和标注渲染成一篇文献笔记。
 *
 * 高亮原文用引用块，自己的批注跟在下面 —— 读的时候要一眼分得出
 * 哪句是作者写的、哪句是自己想的。
 */
function renderLitNote(options) {
  return require('../annotations').renderLiteratureNote(options);
}

module.exports = {
  LOCAL_API,
  KNOWN_SCHEMA_MIN,
  KNOWN_SCHEMA_MAX,
  defaultDataDir,
  sqlitePath,
  fetchItems,
  normalizeItem,
  readLibraryData,
  readLibraryDataUncached,
  globalLibraryId,
  clearLibraryCache,
  LIBRARY_CACHE_TTL_MS,
  readAnnotations,
  attachmentFileName,
  openAttachmentPdf,
  inspectAttachmentPdf,
  litPath,
  renderLitNote
};
