const express = require('express');

const { buildGraph, EDGE_LINK, EDGE_PREREQ } = require('../graph');
const { healthCheck } = require('../similarity');
const { createHighlights } = require('../highlights');
const { createLlm, generateCards, answerFromPassages } = require('../llm');
const { appendCard } = require('../cards');
const { isSafeRelativePath } = require('../vault/paths');
const { httpError, blockWhenReadOnly } = require('./http');

const TOTAL_PASSAGES = 6;
const SOURCE_QUOTA = 3;

function fusePassages(notes, pdfs) {
  const selectedNotes = notes.slice(0, SOURCE_QUOTA);
  const selectedPdfs = pdfs.slice(0, SOURCE_QUOTA);

  if (selectedNotes.length < SOURCE_QUOTA) {
    selectedPdfs.push(...pdfs.slice(
      SOURCE_QUOTA,
      SOURCE_QUOTA + TOTAL_PASSAGES - selectedNotes.length - selectedPdfs.length
    ));
  }
  if (selectedPdfs.length < SOURCE_QUOTA) {
    selectedNotes.push(...notes.slice(
      SOURCE_QUOTA,
      SOURCE_QUOTA + TOTAL_PASSAGES - selectedNotes.length - selectedPdfs.length
    ));
  }

  const passages = [];
  const length = Math.max(selectedNotes.length, selectedPdfs.length);
  for (let index = 0; index < length && passages.length < TOTAL_PASSAGES; index += 1) {
    if (selectedNotes[index]) passages.push(selectedNotes[index]);
    if (selectedPdfs[index] && passages.length < TOTAL_PASSAGES) passages.push(selectedPdfs[index]);
  }
  return passages;
}

function createKnowledgeRoutes({
  config,
  db,
  now,
  similarity,
  pdfSearch,
  pdfService,
  llm: injectedLlm
}) {
  const router = express.Router();
  const llm = injectedLlm || createLlm({ apiKey: config.anthropicApiKey });
  const pdf = pdfService || { ready: async () => {} };
  const pdfLookup = pdfSearch || {
    retrieve: query => ({ query, results: [], usedFallback: false })
  };
  const highlights = createHighlights({ vaultDir: config.vaultDir, device: config.device, db, now });
  const guard = blockWhenReadOnly(config, '不能写入。');

  /** 双链图谱与知识依赖图共用一个页面，只是边的类型不同。 */
  router.get('/graph', (req, res, next) => {
    try {
      const type = req.query.type === EDGE_PREREQ ? EDGE_PREREQ : EDGE_LINK;
      const graph = buildGraph(db, { type, vaultDir: config.vaultDir });

      res.render('graph', {
        title: type === EDGE_PREREQ ? '知识依赖' : '双链图谱',
        type,
        graph,
        payload: encodeURIComponent(JSON.stringify({ nodes: graph.nodes, edges: graph.edges }))
      });
    } catch (error) {
      next(error);
    }
  });

  /** 知识库体检：孤岛、空壳、待建链接、以及内容相近但还没连起来的两篇。 */
  router.get('/health', async (req, res, next) => {
    try {
      const report = healthCheck(db);
      const links = db.raw.prepare(`SELECT from_path AS "from", to_path AS "to" FROM links WHERE to_path != ''`).all();

      // 链接建议在工作线程里算。这个请求可能要等几秒，但等的只是它自己 ——
      // 期间保存笔记、检索、同步照常。
      const { suggestions } = await similarity.suggestions(links);

      res.render('health', {
        title: '知识库体检',
        report,
        suggestions
      });
    } catch (error) {
      next(error);
    }
  });

  /** 某篇笔记的相似笔记，挂在笔记页侧栏用。 */
  router.get('/api/similar', async (req, res, next) => {
    try {
      const notePath = String(req.query.path || '');
      if (!isSafeRelativePath(notePath)) throw httpError(400, '路径不合法。');
      res.json(await similarity.similar(notePath));
    } catch (error) {
      next(error);
    }
  });

  /**
   * 从本地资料库检索；只有显式请求时才把最终片段交给 LLM。
   */
  router.get('/ask', async (req, res, next) => {
    try {
      const question = String(req.query.q || '').trim();
      const answerRequested = req.query.answer === '1';
      let passages = [];
      let pdfRetrievalError = '';

      if (question) {
        const [noteResult, pdfResult] = await Promise.all([
          similarity.retrieve(question, { limit: TOTAL_PASSAGES }),
          (async () => {
            try {
              await pdf.ready();
              // 兜底开关交给 retrieve 按查询长度决定：整句问句做全表子串匹配
              // 既扫不到东西，又要付一次 pdf_chunks 全表扫描。
              return pdfLookup.retrieve(question, { limit: TOTAL_PASSAGES });
            } catch (error) {
              console.warn('[pdf] 问答检索失败，已退回笔记结果。');
              pdfRetrievalError = 'PDF 全文暂时不可用，已保留笔记检索结果。';
              return { results: [] };
            }
          })()
        ]);
        const notes = noteResult.results.map(passage => ({
          source: 'note',
          path: passage.path,
          title: passage.title,
          body: passage.body,
          score: passage.score,
          via: 'cosine'
        }));
        const pdfs = pdfResult.results.map(passage => ({
          source: 'pdf',
          documentId: passage.documentId,
          chunkIndex: passage.chunkIndex,
          pageNumber: passage.pageNumber,
          heading: passage.heading,
          title: passage.title,
          body: passage.body,
          score: passage.score,
          via: passage.via
        }));
        passages = fusePassages(notes, pdfs);
      }

      let answer = null;
      if (question && answerRequested && llm.configured) {
        answer = await answerFromPassages(llm, { question, passages });
      }

      res.render('ask', {
        title: question ? `问：${question}` : '问资料库',
        question,
        answerRequested,
        passages: passages.map(passage => ({
          ...passage,
          excerpt: passage.body.replace(/\s+/g, ' ').trim().slice(0, 300)
        })),
        answer,
        llmConfigured: llm.configured,
        pdfRetrievalError
      });
    } catch (error) {
      next(error);
    }
  });

  /** 每日高亮回顾。 */
  router.get('/highlights', async (req, res, next) => {
    try {
      res.render('highlights', { title: '每日回顾', items: await highlights.today({ count: 5 }) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/highlights/seen', (req, res, next) => {
    try {
      const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
      res.json({ ok: true, marked: highlights.markSeen(paths).length });
    } catch (error) {
      next(error);
    }
  });

  /** LLM 从选中的笔记段落生成候选卡片。人工审过才入库。 */
  router.post('/api/cards/suggest', guard, async (req, res, next) => {
    try {
      const text = String(req.body.text || '').trim();
      if (text.length < 20) throw httpError(400, '选中的内容太短，出不了卡片。');

      const result = await generateCards(llm, { text, count: Number(req.body.count) || 5 });
      if (!result.available) throw httpError(400, result.reason);
      if (!result.ok) throw httpError(502, result.reason);

      res.json({ ok: true, cards: result.data.cards || [] });
    } catch (error) {
      next(error);
    }
  });

  /** 把审过的候选卡片批量入库。 */
  router.post('/api/cards/accept', guard, async (req, res, next) => {
    try {
      const cards = Array.isArray(req.body.cards) ? req.body.cards : [];
      const deckFile = String(req.body.deckFile || 'inbox').replace(/\.md$/i, '');
      const source = String(req.body.source || '');
      if (cards.length === 0) throw httpError(400, '没有要保存的卡片。');
      if (!isSafeRelativePath(`cards/${deckFile}.md`)) throw httpError(400, '卡组文件名不合法。');

      const saved = [];
      for (const card of cards) {
        if (!card?.front) continue;
        saved.push(await appendCard(config.vaultDir, {
          deckFile, front: card.front, back: card.back || '', type: card.type, source
        }));
      }
      res.json({ ok: true, saved: saved.length, path: saved[0]?.path || '' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createKnowledgeRoutes, fusePassages };
