const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { createPdfSearch } = require('../src/pdf/search');
const { tokenizeToText } = require('../src/segment');

const DOCUMENTS = [
  {
    documentId: '00000000000000000000000000000001',
    title: '因果推断中的工具变量',
    chunks: [
      {
        heading: '内生性',
        body: '工具变量通过外生工具处理内生性，并识别因果效应。'
      },
      {
        heading: '稳健性检验',
        body: '安慰剂检验支持主要结论，并排除同期冲击。'
      }
    ]
  },
  {
    documentId: '00000000000000000000000000000002',
    title: '双重差分研究设计',
    chunks: [
      {
        heading: '平行趋势',
        body: '双重差分依赖平行趋势假设，事件研究图用于检验处理前趋势。'
      },
      {
        heading: '稳健性检验',
        body: '安慰剂时间与替代样本用于稳健性检验。'
      }
    ]
  },
  {
    documentId: '00000000000000000000000000000003',
    title: '平台治理政策评估',
    chunks: [
      {
        heading: '定价机制',
        body: '平台政策改变商家定价与进入决策。'
      },
      {
        heading: '福利分析',
        body: '治理政策同时影响消费者福利与平台收入。'
      }
    ]
  },
  {
    documentId: '00000000000000000000000000000004',
    title: 'Treatment Effect Heterogeneity',
    chunks: [
      {
        heading: 'Causal forest',
        body: 'Causal forests estimate heterogeneous treatment effects across subgroups.'
      },
      {
        heading: 'Average effects',
        body: 'The average treatment effect can conceal subgroup variation.'
      }
    ]
  },
  {
    documentId: '00000000000000000000000000000005',
    title: '计量方法教材',
    chunks: [
      {
        heading: '第三章',
        body: '第三章计量经济学的工具变量方法。'
      },
      {
        heading: '第四章',
        body: '第四章介绍面板数据模型。'
      }
    ]
  },
  {
    documentId: '00000000000000000000000000000006',
    title: '研究方法综述',
    chunks: [
      {
        heading: '变量选择',
        body: '变量选择方法可以改善模型预测，但不处理因果识别。'
      },
      {
        heading: '趋势描述',
        body: '描述性趋势展示样本变化，不构成平行趋势检验。'
      }
    ]
  }
];

const QUERIES = [
  {
    id: 'natural-instrument',
    text: '工具变量如何处理内生性',
    relevant: ['00000000000000000000000000000001:0'],
    natural: true
  },
  {
    id: 'natural-placebo',
    text: '为什么安慰剂检验支持主要结论',
    relevant: ['00000000000000000000000000000001:1'],
    natural: true
  },
  {
    id: 'natural-parallel-trend',
    text: '如何检验双重差分的平行趋势',
    relevant: ['00000000000000000000000000000002:0'],
    natural: true
  },
  {
    id: 'natural-english',
    text: 'How are heterogeneous treatment effects estimated',
    relevant: ['00000000000000000000000000000004:0'],
    natural: true
  },
  {
    id: 'multi-placebo',
    text: '安慰剂检验',
    relevant: [
      '00000000000000000000000000000001:1',
      '00000000000000000000000000000002:1'
    ]
  },
  {
    id: 'title-match',
    text: '平台治理政策评估',
    relevant: [
      '00000000000000000000000000000003:0',
      '00000000000000000000000000000003:1'
    ]
  },
  {
    id: 'heading-match',
    text: 'Causal forest',
    relevant: ['00000000000000000000000000000004:0']
  },
  {
    id: 'multi-robustness',
    text: '稳健性检验',
    relevant: [
      '00000000000000000000000000000001:1',
      '00000000000000000000000000000002:1'
    ]
  },
  {
    id: 'token-boundary-fallback',
    text: '量经',
    relevant: ['00000000000000000000000000000005:0']
  },
  {
    id: 'no-answer',
    text: '贝叶斯神经网络后验校准',
    relevant: []
  }
];

function insertCorpus(db) {
  for (const [documentIndex, document] of DOCUMENTS.entries()) {
    db.replacePdfDocument({
      documentId: document.documentId,
      libraryId: '1',
      attachmentKey: `EVAL${String(documentIndex + 1).padStart(4, '0')}`,
      parentKey: `PARENT${documentIndex + 1}`,
      title: document.title,
      fileName: `eval-${documentIndex + 1}.pdf`,
      sourceSha256: String(documentIndex + 1).repeat(64),
      cachePath: `.workstation/mineru/1/EVAL${documentIndex + 1}`,
      pageCount: document.chunks.length,
      indexedAt: '2026-08-30T00:00:00.000Z',
      titleTokens: tokenizeToText(document.title),
      chunks: document.chunks.map((chunk, chunkIndex) => ({
        chunkIndex,
        pageIndex: chunkIndex,
        heading: chunk.heading,
        body: chunk.body,
        markdown: chunk.body,
        headingTokens: tokenizeToText(chunk.heading),
        bodyTokens: tokenizeToText(chunk.body)
      }))
    });
  }
}

function resultId(result) {
  return `${result.documentId}:${result.chunkIndex}`;
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function evaluate(run, queries = QUERIES) {
  const answerable = queries.filter(query => query.relevant.length > 0);
  const noAnswer = queries.filter(query => query.relevant.length === 0);
  const cutoffs = [1, 3, 5];
  const hitRate = Object.fromEntries(cutoffs.map(cutoff => [cutoff, 0]));
  const recall = Object.fromEntries(cutoffs.map(cutoff => [cutoff, 0]));
  const rankings = {};
  let reciprocalRank = 0;
  let zeroResults = 0;
  let noAnswerEmpty = 0;
  let ftsRelevantHits = 0;
  let likeRelevantHits = 0;

  for (const query of queries) {
    const results = run(query.text).results.slice(0, 5);
    rankings[query.id] = results.map(resultId);
    const relevant = new Set(query.relevant);
    if (relevant.size === 0) {
      if (results.length === 0) noAnswerEmpty += 1;
      continue;
    }

    if (results.length === 0) zeroResults += 1;
    for (const cutoff of cutoffs) {
      const hits = results.slice(0, cutoff).filter(result => relevant.has(resultId(result))).length;
      hitRate[cutoff] += hits > 0 ? 1 : 0;
      recall[cutoff] += hits / relevant.size;
    }
    const firstRelevant = results.findIndex(result => relevant.has(resultId(result)));
    if (firstRelevant >= 0) reciprocalRank += 1 / (firstRelevant + 1);
    for (const result of results) {
      if (!relevant.has(resultId(result))) continue;
      if (result.via === 'like') likeRelevantHits += 1;
      else if (result.via === 'fts') ftsRelevantHits += 1;
    }
  }

  return {
    rankings,
    metrics: {
      hitRate: Object.fromEntries(cutoffs.map(cutoff => [cutoff, rounded(hitRate[cutoff] / answerable.length)])),
      recall: Object.fromEntries(cutoffs.map(cutoff => [cutoff, rounded(recall[cutoff] / answerable.length)])),
      mrr5: rounded(reciprocalRank / answerable.length),
      zeroResultRate: rounded(zeroResults / answerable.length),
      noAnswerEmptyRate: rounded(noAnswerEmpty / noAnswer.length),
      relevantHits: { fts: ftsRelevantHits, like: likeRelevantHits }
    }
  };
}

test('RAG 检索指标按 query 宏平均且正确处理空排名', () => {
  const queries = [
    { id: 'multi', text: 'multi', relevant: ['d:1', 'd:3'] },
    { id: 'missing', text: 'missing', relevant: ['x:0'] },
    { id: 'none', text: 'none', relevant: [] }
  ];
  const fixtures = {
    multi: [
      { documentId: 'd', chunkIndex: 1, via: 'fts' },
      { documentId: 'z', chunkIndex: 0, via: 'fts' },
      { documentId: 'd', chunkIndex: 3, via: 'like' }
    ],
    missing: [],
    none: []
  };
  const evaluation = evaluate(text => ({ results: fixtures[text] }), queries);

  assert.deepEqual(evaluation.metrics, {
    hitRate: { 1: 0.5, 3: 0.5, 5: 0.5 },
    recall: { 1: 0.25, 3: 0.5, 5: 0.5 },
    mrr5: 0.5,
    zeroResultRate: 0.5,
    noAnswerEmptyRate: 1,
    relevantHits: { fts: 1, like: 1 }
  });
});

test('固定 PDF corpus 分开评测 strict、broad 与 LIKE 贡献', t => {
  const db = openDatabase(':memory:');
  try {
    insertCorpus(db);
    const pdfSearch = createPdfSearch(db);
    const systems = {
      strictBm25: query => pdfSearch.search(query, { limit: 5, includeFallback: false }),
      strictWithLike: query => pdfSearch.search(query, { limit: 5, includeFallback: true }),
      broadBm25: query => pdfSearch.retrieve(query, { limit: 5, includeFallback: false }),
      broadWithLike: query => pdfSearch.retrieve(query, { limit: 5, includeFallback: true })
    };
    const evaluations = Object.fromEntries(
      Object.entries(systems).map(([name, run]) => [name, evaluate(run)])
    );

    for (const [name, evaluation] of Object.entries(evaluations)) {
      t.diagnostic(`${name}: ${JSON.stringify(evaluation.metrics)}`);
    }

    const naturalQueries = QUERIES.filter(query => query.natural);
    const strictNatural = evaluate(systems.strictBm25, naturalQueries);
    const broadNatural = evaluate(systems.broadBm25, naturalQueries);
    assert.ok(
      broadNatural.metrics.zeroResultRate < strictNatural.metrics.zeroResultRate,
      'broad BM25 应降低自然语言问句的零结果率'
    );

    assert.deepEqual(evaluations.strictBm25.rankings['token-boundary-fallback'], []);
    assert.deepEqual(
      evaluations.strictWithLike.rankings['token-boundary-fallback'],
      ['00000000000000000000000000000005:0']
    );
    assert.deepEqual(evaluations.broadBm25.rankings['title-match'].slice(0, 2), [
      '00000000000000000000000000000003:1',
      '00000000000000000000000000000003:0'
    ]);
    assert.deepEqual(
      Object.fromEntries(Object.entries(evaluations).map(([name, value]) => [name, value.metrics])),
      {
        strictBm25: {
          hitRate: { 1: 0.444444, 3: 0.444444, 5: 0.444444 },
          recall: { 1: 0.277778, 3: 0.444444, 5: 0.444444 },
          mrr5: 0.444444,
          zeroResultRate: 0.555556,
          noAnswerEmptyRate: 1,
          relevantHits: { fts: 7, like: 0 }
        },
        strictWithLike: {
          hitRate: { 1: 0.555556, 3: 0.555556, 5: 0.555556 },
          recall: { 1: 0.388889, 3: 0.555556, 5: 0.555556 },
          mrr5: 0.555556,
          zeroResultRate: 0.444444,
          noAnswerEmptyRate: 1,
          relevantHits: { fts: 7, like: 1 }
        },
        broadBm25: {
          hitRate: { 1: 0.888889, 3: 0.888889, 5: 0.888889 },
          recall: { 1: 0.722222, 3: 0.888889, 5: 0.888889 },
          mrr5: 0.888889,
          zeroResultRate: 0.111111,
          noAnswerEmptyRate: 1,
          relevantHits: { fts: 11, like: 0 }
        },
        broadWithLike: {
          hitRate: { 1: 1, 3: 1, 5: 1 },
          recall: { 1: 0.833333, 3: 1, 5: 1 },
          mrr5: 1,
          zeroResultRate: 0,
          noAnswerEmptyRate: 1,
          relevantHits: { fts: 11, like: 1 }
        }
      }
    );
  } finally {
    db.close();
  }
});
