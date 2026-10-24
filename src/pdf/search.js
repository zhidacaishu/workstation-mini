const { toBroadMatchExpression, toMatchExpression } = require('../segment');
const { buildSnippet, escapeLike } = require('../search');

function boundedLimit(value, fallback) {
  return Math.min(Math.max(Math.trunc(Number(value) || fallback), 1), 200);
}

// bm25 的绝对值随语料变化，定不出一个通用阈值，但同一次查询内部的相对强弱是
// 可比的：留下至少有最佳命中四分之一强度的行，把「问句里碰巧有个常用词」这类
// 噪声挡在 RAG 之外。分越负越相关，所以这里比的是「不大于 best * 比例」。
const RELEVANCE_RATIO = 0.25;

// 同一篇文献最多贡献几块。title 列在 FTS 里每个 chunk 都重复一份，问句里带上
// 论文标题词时这篇的所有块会整体上浮，一篇长文足以吃掉全部召回名额。
const MAX_PER_DOCUMENT = 2;

// 超过这个长度就当成句子，不再做全表子串兜底。
const FALLBACK_QUERY_MAX_LENGTH = 12;

function aboveRelevanceFloor(rows, ratio) {
  if (!ratio || rows.length === 0) return rows;
  const best = rows[0].score;
  if (!Number.isFinite(best) || best >= 0) return rows;
  const cutoff = best * ratio;
  return rows.filter(row => row.score <= cutoff);
}

function createPdfSearch(db) {
  function run(text, matchExpression, {
    limit,
    includeFallback,
    relevanceRatio = 0,
    maxPerDocument = 0
  }) {
    const results = [];
    const seen = new Set();
    const perDocument = new Map();

    function accept(row, via) {
      const key = `${row.documentId}:${row.chunkIndex}`;
      if (seen.has(key) || results.length >= limit) return false;
      const used = perDocument.get(row.documentId) || 0;
      if (maxPerDocument && used >= maxPerDocument) return false;
      seen.add(key);
      perDocument.set(row.documentId, used + 1);
      results.push({
        ...row,
        pageNumber: row.pageIndex + 1,
        snippet: buildSnippet(row.body, text),
        via
      });
      return true;
    }

    if (matchExpression) {
      // 单篇配额必须在 SQL 里做，不能靠「多取几条再在 JS 里筛」。
      //
      // title 列在 FTS 里每个 chunk 都重复一份，一篇 40 块的长文能包揽 bm25
      // 排行前几十名；用固定倍数的候选窗口去截，其它文献根本进不了窗口，
      // 配额腾出来的名额没人填，最后返回的条数反而比不设配额还少。
      // ROW_NUMBER() 按文献分区排名，每篇只留前 N 块，之后再按全局分数排序。
      //
      // 内层 CTE 只带 (documentId, chunkIndex, score)，正文最后才 join 回来，
      // 免得为了排名把几万行正文都拉进内存。
      const rows = maxPerDocument
        ? db.raw.prepare(`
          WITH matched AS (
            SELECT document_id AS documentId, chunk_index AS chunkIndex,
                   bm25(pdf_chunks_fts) AS score
            FROM pdf_chunks_fts
            WHERE pdf_chunks_fts MATCH ?
          ),
          ranked AS (
            SELECT documentId, chunkIndex, score,
                   ROW_NUMBER() OVER (
                     PARTITION BY documentId ORDER BY score, chunkIndex
                   ) AS documentRank
            FROM matched
          )
          SELECT documents.document_id AS documentId, documents.title,
                 documents.file_name AS fileName, documents.parent_key AS parentKey,
                 ranked.chunkIndex, chunks.page_index AS pageIndex,
                 chunks.heading, chunks.body_raw AS body, ranked.score
          FROM ranked
          JOIN pdf_documents documents ON documents.document_id = ranked.documentId
          JOIN pdf_chunks chunks
            ON chunks.document_id = ranked.documentId
           AND chunks.chunk_index = ranked.chunkIndex
          WHERE ranked.documentRank <= ?
          ORDER BY ranked.score, ranked.documentId, ranked.chunkIndex
          LIMIT ${limit}
        `).all(matchExpression, maxPerDocument)
        : db.raw.prepare(`
          SELECT documents.document_id AS documentId, documents.title,
                 documents.file_name AS fileName, documents.parent_key AS parentKey,
                 chunks.chunk_index AS chunkIndex, chunks.page_index AS pageIndex,
                 chunks.heading, chunks.body_raw AS body,
                 bm25(pdf_chunks_fts) AS score
          FROM pdf_chunks_fts
          JOIN pdf_documents documents ON documents.document_id = pdf_chunks_fts.document_id
          JOIN pdf_chunks chunks
            ON chunks.document_id = pdf_chunks_fts.document_id
           AND chunks.chunk_index = pdf_chunks_fts.chunk_index
          WHERE pdf_chunks_fts MATCH ?
          ORDER BY score, documents.document_id, chunks.chunk_index
          LIMIT ${limit}
        `).all(matchExpression);
      // 分数下限拿全局最佳命中做基准；它一定是所在文献的第 1 名，不会被配额筛掉。
      for (const row of aboveRelevanceFloor(rows, relevanceRatio)) accept(row, 'fts');
    }

    let usedFallback = false;
    if (includeFallback && results.length < limit) {
      const pattern = `%${escapeLike(text)}%`;
      const rows = db.raw.prepare(`
        SELECT documents.document_id AS documentId, documents.title,
               documents.file_name AS fileName, documents.parent_key AS parentKey,
               chunks.chunk_index AS chunkIndex, chunks.page_index AS pageIndex,
               chunks.heading, chunks.body_raw AS body
        FROM pdf_chunks chunks
        JOIN pdf_documents documents ON documents.document_id = chunks.document_id
        WHERE chunks.body_raw LIKE ? ESCAPE '\\'
           OR chunks.heading LIKE ? ESCAPE '\\'
           OR documents.title LIKE ? ESCAPE '\\'
        ORDER BY documents.title, documents.document_id, chunks.chunk_index
        LIMIT ${limit}
      `).all(pattern, pattern, pattern);
      for (const row of rows) {
        if (accept(row, 'like')) usedFallback = true;
      }
    }

    return { query: text, results, usedFallback };
  }

  /**
   * 用户在 PDF 全文页显式敲的关键词搜索：词是他自己写的，命中什么都该看得见，
   * 所以不设分数下限也不限制单篇的条数。
   */
  function search(query, { limit = 50, includeFallback = true } = {}) {
    const text = String(query || '').trim();
    if (!text) return { query: text, results: [], usedFallback: false };
    return run(text, toMatchExpression(text), {
      limit: boundedLimit(limit, 50),
      includeFallback
    });
  }

  /**
   * 给 /ask 的 RAG 召回。这里的输入是自然语言问句，进的是模型的上下文，
   * 所以要挑：弱命中会挤掉真正相关的笔记，还会让模型拿着无关片段编引用。
   *
   * 子串兜底默认关掉。它对「量经」这种被分词切开的短词有用，但整句问句逐字
   * 出现在正文里的概率约等于零，只会换来一次 pdf_chunks 全表扫描；所以只在
   * 查询短到像个词的时候才开。
   */
  function retrieve(query, {
    limit = 6,
    includeFallback = null,
    relevanceRatio = RELEVANCE_RATIO,
    maxPerDocument = MAX_PER_DOCUMENT
  } = {}) {
    const text = String(query || '').trim();
    if (!text) return { query: text, results: [], usedFallback: false };
    const matchExpression = toBroadMatchExpression(text);
    if (!matchExpression) return { query: text, results: [], usedFallback: false };
    return run(text, matchExpression, {
      limit: boundedLimit(limit, 6),
      includeFallback: includeFallback === null ? text.length <= FALLBACK_QUERY_MAX_LENGTH : includeFallback,
      relevanceRatio,
      maxPerDocument
    });
  }

  return { search, retrieve };
}

module.exports = { createPdfSearch, RELEVANCE_RATIO, MAX_PER_DOCUMENT, FALLBACK_QUERY_MAX_LENGTH };
