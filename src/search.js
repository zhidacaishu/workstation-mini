const { tokenize, toMatchExpression } = require('./segment');

const DEFAULT_LIMIT = 50;
const SNIPPET_RADIUS = 40;

// SQLite LIKE 的通配符要转义，否则用户搜「100%」会变成「以 100 开头的任意内容」。
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, character => `\\${character}`);
}

/**
 * 从原文里截一段包含查询词的片段。
 *
 * 不用 FTS5 的 snippet()：FTS 表里存的是分词后的 token 串，snippet 出来是
 * 「计量 经济 学的 工具」这样带空格的形式，读起来不像原文。
 */
function buildSnippet(bodyRaw, query) {
  const body = String(bodyRaw || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';

  const needles = [query, ...tokenize(query)].filter(Boolean);
  let position = -1;
  for (const needle of needles) {
    position = body.toLowerCase().indexOf(String(needle).toLowerCase());
    if (position !== -1) break;
  }
  if (position === -1) return body.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, position - SNIPPET_RADIUS);
  const end = Math.min(body.length, position + SNIPPET_RADIUS * 2);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

function buildFilterClause(filters, params, alias = 'notes') {
  let clause = '';
  if (filters.section) {
    clause += ` AND ${alias}.section = ?`;
    params.push(filters.section);
  }
  if (filters.tag) {
    clause += ` AND EXISTS (SELECT 1 FROM tags WHERE tags.path = ${alias}.path AND tags.tag = ?)`;
    params.push(String(filters.tag).toLowerCase());
  }
  if (filters.excludeSection) {
    clause += ` AND ${alias}.section != ?`;
    params.push(filters.excludeSection);
  }
  return clause;
}

function createSearch(db) {
  /**
   * 搜索笔记。
   *
   * 分两路合并：
   *   1. FTS5 —— 走分词后的 token 串，带 bm25 相关度排序，是主力。
   *   2. LIKE —— 对原文做子串匹配，兜住分词边界对不上的情况。
   *      「计量经济学」被切成「计量 / 经济 / 学的」，所以查「经济学」FTS5 命中不了，
   *      但原文确实包含它。个人笔记量级下全表 LIKE 是毫秒级的。
   *
   * FTS5 的结果排在前面（有相关度排序），只有 LIKE 命中的补在后面。
   */
  function search(query, options = {}) {
    const text = String(query ?? '').trim();
    const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), 200);
    const filters = { section: options.section || '', tag: options.tag || '' };

    if (!text) return { query: text, results: [], usedFallback: false };

    const results = [];
    const seen = new Set();

    const matchExpression = toMatchExpression(text);
    if (matchExpression) {
      const params = [matchExpression];
      const clause = buildFilterClause(filters, params);
      const rows = db.raw.prepare(`
        SELECT notes.path, notes.title_raw AS title, notes.section, notes.body_raw AS body,
               bm25(notes_fts) AS score
        FROM notes_fts
        JOIN notes ON notes.path = notes_fts.path
        WHERE notes_fts MATCH ?${clause}
        ORDER BY score
        LIMIT ${limit}
      `).all(...params);

      for (const row of rows) {
        seen.add(row.path);
        results.push({
          path: row.path,
          title: row.title,
          section: row.section,
          snippet: buildSnippet(row.body, text),
          via: 'fts'
        });
      }
    }

    let usedFallback = false;
    if (results.length < limit) {
      const params = [`%${escapeLike(text)}%`, `%${escapeLike(text)}%`];
      const clause = buildFilterClause(filters, params);
      const rows = db.raw.prepare(`
        SELECT notes.path, notes.title_raw AS title, notes.section, notes.body_raw AS body
        FROM notes
        WHERE (notes.body_raw LIKE ? ESCAPE '\\' OR notes.title_raw LIKE ? ESCAPE '\\')${clause}
        ORDER BY notes.path
        LIMIT ${limit}
      `).all(...params);

      for (const row of rows) {
        if (seen.has(row.path)) continue;
        if (results.length >= limit) break;
        seen.add(row.path);
        usedFallback = true;
        results.push({
          path: row.path,
          title: row.title,
          section: row.section,
          snippet: buildSnippet(row.body, text),
          via: 'like'
        });
      }
    }

    return { query: text, results, usedFallback };
  }

  /**
   * 浏览资料库。空搜索不是「搜不到」，而是按最近修改时间列出可继续阅读的笔记；
   * 分区和标签过滤在这里与全文检索共用同一套语义。
   */
  function browse(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_LIMIT, 1), 200);
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const filters = { section: options.section || '', tag: options.tag || '', excludeSection: options.excludeSection || '' };
    const params = [];
    const clause = buildFilterClause(filters, params);
    const rows = db.raw.prepare(`
      SELECT notes.path, notes.title_raw AS title, notes.section,
             notes.mtime_ms, notes.body_raw AS body
      FROM notes
      WHERE 1 = 1${clause}
      ORDER BY notes.mtime_ms DESC, notes.path ASC
      LIMIT ${limit} OFFSET ${offset}
    `).all(...params);

    return rows.map(row => ({
      path: row.path,
      title: row.title,
      section: row.section,
      mtime_ms: row.mtime_ms,
      snippet: buildSnippet(String(row.body)
        .replace(/^#{1,6}\s+.+$/m, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
        .replace(/^[ \t]*[-*+]\s+(?:\[[ xX]\]\s*)?/gm, '')
        .replace(/[*`#]/g, ''), '')
    }));
  }

  function recent(limit = 20, { excludeSection = '' } = {}) {
    return browse({ limit, excludeSection }).map(({ mtime_ms, ...note }) => ({ ...note, mtimeMs: mtime_ms }));
  }

  /** 和 browse 同一套筛选条件下一共有多少篇，供翻页和「共 N 篇」使用。 */
  function count(options = {}) {
    const params = [];
    const clause = buildFilterClause({ section: options.section || '', tag: options.tag || '' }, params);
    return db.raw.prepare(`SELECT count(*) AS total FROM notes WHERE 1 = 1${clause}`).get(...params).total;
  }

  return { search, browse, count, recent, buildSnippet, PAGE_SIZE: DEFAULT_LIMIT };
}

module.exports = { createSearch, buildSnippet, escapeLike };
