const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

// 这个库整体是派生数据：删掉它，扫一遍 Markdown 就能重建。
// 所以这里没有数据迁移逻辑——schema 版本对不上就整库重建，比写迁移脚本可靠得多。
// 版本号变了就整库重建。
//
// 不只是「表结构变了」要加，**解析逻辑变了也要加**：索引里存的是解析结果，
// 而增量扫描的快路径靠 mtime 判断，文件没动就不会重新解析。改了标题、标签或
// 分词的算法却不加版本号，旧笔记会一直挂着按旧逻辑算出来的值，直到有人手动
// 重建为止 —— 这种不一致极难察觉。整库是派生数据，重建很便宜，别省这一下。
//
// v2：notes 增加 data_json，把 frontmatter 整体存进索引（日记打点、后续的卡片
//     与实验记录都在 frontmatter 里，一列比每个模块加一张表省事）。
// v3：标题解析改动 —— YAML 把不带引号的 `title: 2026-08-06` 解析成 Date，
//     需要还原成原本的日期字面量。
// v4：新增 tasks 表，从笔记正文的 `- [ ]` 抽取。任务不新建存储，
//     真相是 Markdown 里那一行，这张表只是派生索引。
// v5：新增 literature_annotations 表，从文献笔记 managed marker 派生。
// v6：新增 MinerU PDF 文档、分块与独立全文索引。
const SCHEMA_VERSION = 7;

const SCHEMA = `
  -- 每篇笔记一行。body_raw / title_raw 是原文缓存，供 LIKE 兜底和渲染使用；
  -- 它不是第二个真相源，Markdown 文件才是。
  CREATE TABLE IF NOT EXISTS notes (
    path        TEXT PRIMARY KEY,
    section     TEXT NOT NULL DEFAULT '',
    title_raw   TEXT NOT NULL DEFAULT '',
    body_raw    TEXT NOT NULL DEFAULT '',
    data_json   TEXT NOT NULL DEFAULT '{}',
    hash        TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    mtime_ms    INTEGER NOT NULL DEFAULT 0,
    indexed_at  TEXT NOT NULL
  );

  -- 存的是分词后的 token 串，不是原文。索引与查询共用 segment.js 的分词器。
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED,
    title,
    body,
    tokenize='unicode61'
  );

  CREATE TABLE IF NOT EXISTS tags (
    path TEXT NOT NULL,
    tag  TEXT NOT NULL,
    PRIMARY KEY (path, tag)
  );

  -- to_target 是笔记里写的原始目标（已去扩展名），to_path 是解析结果。
  -- 解析不到时 to_path 为空串，代表「链到一篇还没写的笔记」，这是正常状态。
  CREATE TABLE IF NOT EXISTS links (
    from_path TEXT NOT NULL,
    to_target TEXT NOT NULL,
    to_path   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (from_path, to_target)
  );

  -- 任务是从正文里抽出来的派生数据，不是第二个真相源。
  -- 勾掉一个待办的正确做法是改 Markdown，然后重扫。
  CREATE TABLE IF NOT EXISTS tasks (
    path  TEXT NOT NULL,
    line  INTEGER NOT NULL,
    done  INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    due   TEXT,
    PRIMARY KEY (path, line)
  );

  CREATE TABLE IF NOT EXISTS literature_annotations (
    note_path      TEXT NOT NULL,
    annotation_id  TEXT NOT NULL,
    item_key       TEXT NOT NULL,
    item_id        INTEGER NOT NULL,
    status         TEXT NOT NULL,
    text           TEXT NOT NULL DEFAULT '',
    page           TEXT NOT NULL DEFAULT '',
    outputs_json   TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (note_path, annotation_id)
  );

  CREATE TABLE IF NOT EXISTS pdf_documents (
    document_id     TEXT PRIMARY KEY,
    library_id      TEXT NOT NULL,
    attachment_key  TEXT NOT NULL,
    parent_key      TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    file_name       TEXT NOT NULL,
    source_sha256   TEXT NOT NULL,
    cache_path      TEXT NOT NULL,
    page_count      INTEGER NOT NULL DEFAULT 0,
    indexed_at      TEXT NOT NULL,
    UNIQUE (library_id, attachment_key)
  );

  CREATE TABLE IF NOT EXISTS pdf_chunks (
    document_id   TEXT NOT NULL,
    chunk_index   INTEGER NOT NULL,
    page_index    INTEGER NOT NULL,
    heading       TEXT NOT NULL DEFAULT '',
    body_raw      TEXT NOT NULL,
    markdown_raw  TEXT NOT NULL,
    PRIMARY KEY (document_id, chunk_index),
    FOREIGN KEY (document_id) REFERENCES pdf_documents(document_id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS pdf_chunks_fts USING fts5(
    document_id UNINDEXED,
    chunk_index UNINDEXED,
    title,
    heading,
    body,
    tokenize='unicode61'
  );

  -- 大文件对账的本机记录：上次对账结束时两边都有、且大小一致的文件。
  -- 只用来分辨「一边缺」是新增还是删除（见 blobs/reconcile.js）。丢了也无妨，
  -- 对账会退回只补齐、不删除的保守行为，所以它和整库一样是可删除的派生数据。
  -- 新增表用 IF NOT EXISTS 就能落到旧库上，不需要为它升 SCHEMA_VERSION 重建索引。
  CREATE TABLE IF NOT EXISTS blob_sync_state (
    server TEXT NOT NULL,
    path   TEXT NOT NULL,
    size   INTEGER NOT NULL,
    sha256 TEXT,
    PRIMARY KEY (server, path)
  );

  CREATE INDEX IF NOT EXISTS notes_section_idx ON notes(section);
  CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks(due);
  CREATE INDEX IF NOT EXISTS tasks_done_idx ON tasks(done);
  CREATE INDEX IF NOT EXISTS tags_tag_idx ON tags(tag);
  CREATE INDEX IF NOT EXISTS links_to_path_idx ON links(to_path);
  CREATE INDEX IF NOT EXISTS literature_annotations_status_idx ON literature_annotations(status);
  CREATE INDEX IF NOT EXISTS pdf_documents_attachment_idx ON pdf_documents(library_id, attachment_key);
  CREATE INDEX IF NOT EXISTS pdf_chunks_page_idx ON pdf_chunks(document_id, page_index, chunk_index);
`;

// 文件本身坏了（不是 SQLite、页损坏）。只认这两类：权限、磁盘满、被别的进程
// 锁住都不是「删掉重建」能解决的，删了反而把现场毁掉。better-sqlite3 报的是
// 扩展错误码（SQLITE_CORRUPT_INDEX 之类），所以按前缀认。
function isCorruption(error) {
  const code = String(error?.code || '');
  return code === 'SQLITE_NOTADB' || code.startsWith('SQLITE_CORRUPT');
}

// 页损坏的库往往能正常打开，要到查询时才报错；那时库正被整个进程共用，没法
// 当场换掉。于是先在旁边留个标记，下次启动时据此删掉重建。
function corruptionMarker(dbPath) {
  return `${dbPath}-corrupt`;
}

function removeDatabaseFiles(dbPath) {
  for (const suffix of ['', '-shm', '-wal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function initializeDatabase(dbPath) {
  let db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // schema 版本变了就重建。因为整库都是派生数据，丢掉没有代价，
    // 而写错的迁移脚本会静默产生坏索引。
    const currentVersion = db.pragma('user_version', { simple: true });
    if (currentVersion !== 0 && currentVersion !== SCHEMA_VERSION) {
      db.close();
      if (dbPath !== ':memory:') removeDatabaseFiles(dbPath);
      db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
    }

    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function openDatabase(dbPath, { logger = console } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  // 索引库损坏（断电、云盘同步把 WAL 搅乱）时，用户能做的唯一一件事就是删掉
  // 它重建 —— 而它是派生数据，删掉没有任何代价。与其让应用起不来、再让用户
  // 去找 workstation.db 手工删，不如这里直接做。
  if (dbPath !== ':memory:' && fs.existsSync(corruptionMarker(dbPath))) {
    logger.warn?.(`[db] 上次运行发现索引库损坏，已删除并重建：${dbPath}`);
    removeDatabaseFiles(dbPath);
    fs.rmSync(corruptionMarker(dbPath), { force: true });
  }

  let db;
  try {
    db = initializeDatabase(dbPath);
  } catch (error) {
    if (dbPath === ':memory:' || !isCorruption(error)) throw error;
    logger.warn?.(`[db] 索引库损坏（${error.code}），已删除并重建：${dbPath}`);
    removeDatabaseFiles(dbPath);
    db = initializeDatabase(dbPath);
  }

  const statements = {
    upsertNote: db.prepare(`
      INSERT INTO notes (path, section, title_raw, body_raw, data_json, hash, size, mtime_ms, indexed_at)
      VALUES (@path, @section, @titleRaw, @bodyRaw, @dataJson, @hash, @size, @mtimeMs, @indexedAt)
      ON CONFLICT(path) DO UPDATE SET
        section    = excluded.section,
        title_raw  = excluded.title_raw,
        body_raw   = excluded.body_raw,
        data_json  = excluded.data_json,
        hash       = excluded.hash,
        size       = excluded.size,
        mtime_ms   = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `),
    touchNote: db.prepare(`UPDATE notes SET mtime_ms = ?, size = ?, indexed_at = ? WHERE path = ?`),
    deleteNote: db.prepare(`DELETE FROM notes WHERE path = ?`),
    deleteFts: db.prepare(`DELETE FROM notes_fts WHERE path = ?`),
    insertFts: db.prepare(`INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)`),
    deleteTags: db.prepare(`DELETE FROM tags WHERE path = ?`),
    insertTag: db.prepare(`INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)`),
    deleteLinks: db.prepare(`DELETE FROM links WHERE from_path = ?`),
    deleteTasks: db.prepare(`DELETE FROM tasks WHERE path = ?`),
    insertTask: db.prepare(`INSERT OR REPLACE INTO tasks (path, line, done, title, due) VALUES (?, ?, ?, ?, ?)`),
    deleteAnnotations: db.prepare(`DELETE FROM literature_annotations WHERE note_path = ?`),
    insertAnnotation: db.prepare(`
      INSERT OR REPLACE INTO literature_annotations
      (note_path, annotation_id, item_key, item_id, status, text, page, outputs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertLink: db.prepare(`INSERT OR IGNORE INTO links (from_path, to_target, to_path) VALUES (?, ?, ?)`),
    allIndexed: db.prepare(`SELECT path, hash, size, mtime_ms AS mtimeMs FROM notes`),
    oneIndexed: db.prepare(`SELECT path, hash, size, mtime_ms AS mtimeMs FROM notes WHERE path = ?`),
    allPaths: db.prepare(`SELECT path FROM notes ORDER BY path`),
    getNote: db.prepare(`SELECT * FROM notes WHERE path = ?`),
    countNotes: db.prepare(`SELECT count(*) AS c FROM notes`),
    upsertPdfDocument: db.prepare(`
      INSERT INTO pdf_documents
      (document_id, library_id, attachment_key, parent_key, title, file_name,
       source_sha256, cache_path, page_count, indexed_at)
      VALUES (@documentId, @libraryId, @attachmentKey, @parentKey, @title, @fileName,
              @sourceSha256, @cachePath, @pageCount, @indexedAt)
      ON CONFLICT(document_id) DO UPDATE SET
        library_id = excluded.library_id,
        attachment_key = excluded.attachment_key,
        parent_key = excluded.parent_key,
        title = excluded.title,
        file_name = excluded.file_name,
        source_sha256 = excluded.source_sha256,
        cache_path = excluded.cache_path,
        page_count = excluded.page_count,
        indexed_at = excluded.indexed_at
    `),
    deletePdfDocument: db.prepare(`DELETE FROM pdf_documents WHERE document_id = ?`),
    deletePdfChunks: db.prepare(`DELETE FROM pdf_chunks WHERE document_id = ?`),
    insertPdfChunk: db.prepare(`
      INSERT INTO pdf_chunks (document_id, chunk_index, page_index, heading, body_raw, markdown_raw)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    deletePdfFts: db.prepare(`DELETE FROM pdf_chunks_fts WHERE document_id = ?`),
    insertPdfFts: db.prepare(`
      INSERT INTO pdf_chunks_fts (document_id, chunk_index, title, heading, body)
      VALUES (?, ?, ?, ?, ?)
    `),
    getPdfDocument: db.prepare(`
      SELECT document_id AS documentId, library_id AS libraryId,
             attachment_key AS attachmentKey, parent_key AS parentKey,
             title, file_name AS fileName, source_sha256 AS sourceSha256,
             cache_path AS cachePath, page_count AS pageCount, indexed_at AS indexedAt
      FROM pdf_documents WHERE document_id = ?
    `),
    listPdfDocuments: db.prepare(`
      SELECT document_id AS documentId, library_id AS libraryId,
             attachment_key AS attachmentKey, parent_key AS parentKey,
             title, file_name AS fileName, source_sha256 AS sourceSha256,
             cache_path AS cachePath, page_count AS pageCount, indexed_at AS indexedAt
      FROM pdf_documents ORDER BY title, file_name
    `)
  };

  // 一篇笔记的全部派生行一次性替换。分成多条语句写会在崩溃时留下
  // notes 有行但 notes_fts 没行这类不一致状态。
  const replaceNote = db.transaction(record => {
    statements.upsertNote.run({
      path: record.path,
      section: record.section,
      titleRaw: record.title,
      bodyRaw: record.body,
      dataJson: JSON.stringify(record.data || {}),
      hash: record.hash,
      size: record.size,
      mtimeMs: record.mtimeMs,
      indexedAt: record.indexedAt
    });

    statements.deleteFts.run(record.path);
    statements.insertFts.run(record.path, record.titleTokens, record.bodyTokens);

    statements.deleteTags.run(record.path);
    for (const tag of record.tags) statements.insertTag.run(record.path, tag);

    statements.deleteLinks.run(record.path);
    for (const link of record.links) {
      statements.insertLink.run(record.path, link.target, link.toPath || '');
    }

    statements.deleteTasks.run(record.path);
    for (const task of record.tasks || []) {
      statements.insertTask.run(record.path, task.line, task.done ? 1 : 0, task.title, task.due);
    }

    statements.deleteAnnotations.run(record.path);
    for (const annotation of record.annotations || []) {
      statements.insertAnnotation.run(
        record.path,
        annotation.id,
        annotation.itemKey,
        annotation.itemId,
        annotation.status,
        annotation.text,
        annotation.page,
        JSON.stringify(annotation.outputs || [])
      );
    }
  });

  const removeNote = db.transaction(notePath => {
    statements.deleteNote.run(notePath);
    statements.deleteFts.run(notePath);
    statements.deleteTags.run(notePath);
    statements.deleteLinks.run(notePath);
    statements.deleteTasks.run(notePath);
    statements.deleteAnnotations.run(notePath);
    // 指向这篇的链接不删：笔记被删掉后，那些链接变回「待建」状态，
    // 而不是凭空消失。重新解析时 to_path 会被置空。
  });

  const replacePdfDocument = db.transaction(record => {
    statements.deletePdfFts.run(record.documentId);
    statements.deletePdfChunks.run(record.documentId);
    statements.upsertPdfDocument.run({
      documentId: record.documentId,
      libraryId: String(record.libraryId),
      attachmentKey: record.attachmentKey,
      parentKey: record.parentKey || '',
      title: record.title || record.fileName,
      fileName: record.fileName,
      sourceSha256: record.sourceSha256,
      cachePath: record.cachePath,
      pageCount: record.pageCount,
      indexedAt: record.indexedAt
    });
    for (const chunk of record.chunks) {
      statements.insertPdfChunk.run(
        record.documentId,
        chunk.chunkIndex,
        chunk.pageIndex,
        chunk.heading,
        chunk.body,
        chunk.markdown
      );
      statements.insertPdfFts.run(
        record.documentId,
        chunk.chunkIndex,
        record.titleTokens,
        chunk.headingTokens,
        chunk.bodyTokens
      );
    }
  });

  const removePdfDocument = db.transaction(documentId => {
    statements.deletePdfFts.run(documentId);
    statements.deletePdfDocument.run(documentId);
  });

  return {
    raw: db,

    /**
     * 调用方遇到数据库错误时报上来。是损坏就留标记，下次启动重建，并返回 true
     * 好让调用方把提示改成「重启即可恢复」。
     */
    reportError(error) {
      if (dbPath === ':memory:' || !isCorruption(error)) return false;
      try {
        fs.writeFileSync(corruptionMarker(dbPath), `${error.code}\n`, 'utf8');
      } catch {}
      return true;
    },

    replaceNote,
    removeNote,
    replacePdfDocument,
    removePdfDocument,

    getPdfDocument(documentId) {
      return statements.getPdfDocument.get(documentId);
    },

    listPdfDocuments() {
      return statements.listPdfDocuments.all();
    },

    listPdfChunks(documentId, { pageIndex } = {}) {
      if (Number.isInteger(pageIndex)) {
        return db.prepare(`
          SELECT chunk_index AS chunkIndex, page_index AS pageIndex, heading,
                 body_raw AS body, markdown_raw AS markdown
          FROM pdf_chunks WHERE document_id = ? AND page_index = ? ORDER BY chunk_index
        `).all(documentId, pageIndex);
      }
      return db.prepare(`
        SELECT chunk_index AS chunkIndex, page_index AS pageIndex, heading,
               body_raw AS body, markdown_raw AS markdown
        FROM pdf_chunks WHERE document_id = ? ORDER BY chunk_index
      `).all(documentId);
    },

    touchNote(notePath, mtimeMs, size, indexedAt) {
      statements.touchNote.run(mtimeMs, size, indexedAt, notePath);
    },

    listIndexed() {
      return statements.allIndexed.all();
    },

    // 单篇的索引元信息。增量扫描只关心少数几个路径，没必要把整张表拉进内存
    // 再建一个 Map —— 全量扫描才需要那样做。
    getIndexed(notePath) {
      return statements.oneIndexed.get(notePath);
    },

    listPaths() {
      return statements.allPaths.all().map(row => row.path);
    },

    /** 渲染双链时用来把 [[路径]] 显示成笔记标题。 */
    listNoteTitles() {
      return db.prepare('SELECT path, title_raw AS title FROM notes').all();
    },

    getNote(notePath) {
      return statements.getNote.get(notePath);
    },

    countNotes() {
      return statements.countNotes.get().c;
    },

    /**
     * 只解析指定几篇笔记「射出去」的链接。
     *
     * 笔记内容改了但没有增删文件时，受影响的只有它自己那几条链接：别人指向
     * 它的链接早就解析过了，它的路径也没变。这时候没必要扫全表 —— 一个几千篇
     * 的 vault 里链接有十几万行，每敲一次保存都全量重解析是纯浪费。
     *
     * 有笔记新增或删除时不能用这个函数：那会改变**其它**笔记里「待建链接」的
     * 解析结果，必须走 resolveAllLinks。
     */
    resolveLinksFrom: db.transaction((paths, resolve) => {
      const select = db.prepare(`SELECT from_path, to_target, to_path FROM links WHERE from_path = ?`);
      const update = db.prepare(`UPDATE links SET to_path = ? WHERE from_path = ? AND to_target = ?`);
      let changed = 0;
      for (const notePath of paths) {
        for (const row of select.all(notePath)) {
          const resolved = resolve(row.to_target) || '';
          if (resolved !== row.to_path) {
            update.run(resolved, row.from_path, row.to_target);
            changed += 1;
          }
        }
      }
      return changed;
    }),

    // 新增或删除笔记后，所有链接的解析结果都可能变化：新写的笔记会让
    // 之前的「待建」链接变成有效链接。这一步是纯内存查表，很便宜。
    resolveAllLinks: db.transaction(resolve => {
      const rows = db.prepare(`SELECT from_path, to_target, to_path FROM links`).all();
      const update = db.prepare(`UPDATE links SET to_path = ? WHERE from_path = ? AND to_target = ?`);
      let changed = 0;
      for (const row of rows) {
        const resolved = resolve(row.to_target) || '';
        if (resolved !== row.to_path) {
          update.run(resolved, row.from_path, row.to_target);
          changed += 1;
        }
      }
      return changed;
    }),

    backlinks(notePath) {
      return db.prepare(`
        SELECT links.from_path AS path, notes.title_raw AS title, notes.section AS section
        FROM links
        JOIN notes ON notes.path = links.from_path
        WHERE links.to_path = ?
        ORDER BY notes.path
      `).all(notePath);
    },

    outboundLinks(notePath) {
      return db.prepare(`
        SELECT links.to_target AS target, links.to_path AS path, notes.title_raw AS title
        FROM links LEFT JOIN notes ON notes.path = links.to_path
        WHERE links.from_path = ? ORDER BY links.to_target
      `).all(notePath);
    },

    countPendingAnnotations() {
      return db.prepare(`SELECT count(*) AS count FROM literature_annotations WHERE status = 'pending'`).get().count;
    },

    listPendingAnnotations({ limit = 50, itemKey = '' } = {}) {
      return db.prepare(`
        SELECT literature_annotations.note_path AS notePath,
               literature_annotations.annotation_id AS id,
               literature_annotations.item_key AS itemKey,
               literature_annotations.item_id AS itemId,
               literature_annotations.text,
               literature_annotations.page,
               notes.title_raw AS noteTitle,
               notes.hash
        FROM literature_annotations
        JOIN notes ON notes.path = literature_annotations.note_path
        WHERE literature_annotations.status = 'pending'
          AND (? = '' OR literature_annotations.item_key = ?)
        ORDER BY notes.mtime_ms DESC, literature_annotations.annotation_id
        LIMIT ?
      `).all(String(itemKey), String(itemKey), Math.max(1, Number(limit) || 50));
    },

    annotationCountsByItem() {
      return db.prepare(`
        SELECT item_key AS itemKey,
               count(*) AS total,
               sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
        FROM literature_annotations GROUP BY item_key
      `).all();
    },

    listTasks({ includeDone = false } = {}) {
      return db.prepare(`
        SELECT tasks.path, tasks.line, tasks.done, tasks.title, tasks.due,
               notes.title_raw AS noteTitle, notes.section, notes.hash
        FROM tasks JOIN notes ON notes.path = tasks.path
        ${includeDone ? '' : 'WHERE tasks.done = 0'}
        ORDER BY tasks.path, tasks.line
      `).all().map(row => ({ ...row, done: row.done === 1 }));
    },

    /** 某个分区里带状态的条目，供 E6 看板使用。 */
    listItems(section) {
      return db.prepare(`
        SELECT path, title_raw AS title, data_json AS dataJson, hash, mtime_ms AS mtimeMs
        FROM notes WHERE section = ? ORDER BY path
      `).all(section);
    },

    /** 某个存储服务、某个前缀下的对账记录：path → size。 */
    listBlobSyncState(server, prefix) {
      const rows = db.prepare(`
        SELECT path, size, sha256 FROM blob_sync_state
        WHERE server = ? AND substr(path, 1, ?) = ?
      `).all(String(server), String(prefix).length + 1, `${prefix}/`);
      return new Map(rows.map(row => [row.path, row.sha256 ? { size: row.size, sha256: row.sha256 } : row.size]));
    },

    replaceBlobSyncState: db.transaction((server, prefix, entries) => {
      db.prepare(`DELETE FROM blob_sync_state WHERE server = ? AND substr(path, 1, ?) = ?`)
        .run(String(server), String(prefix).length + 1, `${prefix}/`);
      const insert = db.prepare(`INSERT INTO blob_sync_state (server, path, size, sha256) VALUES (?, ?, ?, ?)`);
      for (const [blobPath, value] of entries) insert.run(String(server), blobPath, typeof value === 'number' ? value : value.size, value.sha256 || null);
    }),

    listTags() {
      return db.prepare(`
        SELECT tag, count(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag ASC
      `).all();
    },

    close() {
      db.close();
    }
  };
}

module.exports = { openDatabase, isCorruption, SCHEMA_VERSION };
