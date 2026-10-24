const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const zotero = require('../src/integrations/zotero');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createPdfSearch } = require('../src/pdf/search');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { tokenizeToText } = require('../src/segment');

const DOCUMENT_ID = '0123456789abcdef0123456789abcdef';

async function setup({ readOnly = false, pdfService, pdfSearch } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-pdf-http-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly,
    mineruApiToken: 'test-only-token',
    zoteroApi: 'http://127.0.0.1:1/api/users/0'
  });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const app = createApp(config, {
    db,
    indexer,
    search: createSearch(db),
    pdfService,
    pdfSearch: pdfSearch || createPdfSearch(db)
  });
  return {
    app,
    db,
    config,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

function fakePdfService(overrides = {}) {
  return {
    ready: async () => {},
    describeLibrary: async () => [],
    enqueue: async () => ({
      documentId: DOCUMENT_ID,
      state: 'queued',
      progress: null,
      error: '',
      updatedAt: '2026-08-30T00:00:00.000Z',
      pageCount: 0
    }),
    status: () => null,
    preview: () => null,
    ...overrides
  };
}

function insertPdf(db) {
  const body = '计量经济学中的工具变量用于处理内生性。';
  db.replacePdfDocument({
    documentId: DOCUMENT_ID,
    libraryId: '1',
    attachmentKey: 'PDF00001',
    parentKey: 'PARENT1',
    title: '因果推断论文',
    fileName: 'paper.pdf',
    sourceSha256: 'a'.repeat(64),
    cachePath: '.workstation/mineru/1/PDF00001',
    pageCount: 2,
    indexedAt: '2026-08-30T00:00:00.000Z',
    titleTokens: tokenizeToText('因果推断论文'),
    chunks: [
      {
        chunkIndex: 0,
        pageIndex: 0,
        heading: '方法',
        body,
        markdown: '# 方法\n\n<img src=x onerror=alert(1)>\n\n![远端图](https://evil.example/image.png)\n\n工具变量用于处理内生性。',
        headingTokens: tokenizeToText('方法'),
        bodyTokens: tokenizeToText(body)
      },
      {
        chunkIndex: 1,
        pageIndex: 1,
        heading: '稳健性',
        body: '安慰剂检验支持主要结论。',
        markdown: '安慰剂检验支持主要结论。',
        headingTokens: tokenizeToText('稳健性'),
        bodyTokens: tokenizeToText('安慰剂检验支持主要结论。')
      }
    ]
  });
}

test('解析路由只传附件身份并返回 202', async () => {
  const calls = [];
  const ctx = await setup({
    pdfService: fakePdfService({
      enqueue: async value => {
        calls.push(value);
        return { documentId: DOCUMENT_ID, state: 'queued', progress: null, error: '' };
      }
    })
  });
  try {
    const response = await request(ctx.app).post('/library/pdfs/parse').send({
      libraryId: '1',
      attachmentKey: 'PDF00001',
      filePath: '/Users/person/Zotero/storage/PDF00001/paper.pdf',
      token: 'must-not-pass',
      uploadUrl: 'https://signed.example.test/file'
    }).expect(202);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.state, 'queued');
    assert.deepEqual(calls, [{ libraryId: '1', attachmentKey: 'PDF00001' }]);
    assert.doesNotMatch(JSON.stringify(response.body), /person|must-not-pass|signed\.example/);
  } finally {
    await ctx.cleanup();
  }
});

test('解析路由校验必填身份、映射可操作错误并隐藏未知错误', async () => {
  const missing = await setup({ pdfService: fakePdfService() });
  try {
    await request(missing.app).post('/library/pdfs/parse').send({ attachmentKey: 'PDF00001' }).expect(400);
  } finally {
    await missing.cleanup();
  }

  const configured = await setup({
    pdfService: fakePdfService({
      enqueue: async () => { throw new Error('请先在应用设置中配置 MinerU API Token。'); }
    })
  });
  try {
    const response = await request(configured.app).post('/library/pdfs/parse').send({
      libraryId: '1', attachmentKey: 'PDF00001'
    }).expect(400);
    assert.match(response.body.message, /配置 MinerU API Token/);
  } finally {
    await configured.cleanup();
  }

  const unknown = await setup({
    pdfService: fakePdfService({
      enqueue: async () => {
        throw new Error('failed /Users/person/private.pdf https://signed.example.test Bearer secret');
      }
    })
  });
  try {
    const response = await request(unknown.app).post('/library/pdfs/parse').send({
      libraryId: '1', attachmentKey: 'PDF00001'
    }).expect(500);
    assert.match(response.body.message, /应用内部错误/);
    assert.doesNotMatch(JSON.stringify(response.body), /person|signed\.example|Bearer|secret/);
  } finally {
    await unknown.cleanup();
  }
});

test('只读模式阻止解析但保留 PDF 搜索与预览', async () => {
  let enqueued = false;
  const service = fakePdfService({
    enqueue: async () => { enqueued = true; },
    status: id => id === DOCUMENT_ID
      ? { documentId: id, state: 'ready', progress: null, error: '', pageCount: 2 }
      : null
  });
  const ctx = await setup({ readOnly: true, pdfService: service });
  try {
    insertPdf(ctx.db);
    await request(ctx.app).post('/library/pdfs/parse').send({
      libraryId: '1', attachmentKey: 'PDF00001'
    }).expect(403);
    assert.equal(enqueued, false);
    await request(ctx.app).get('/library/pdfs/search?q=' + encodeURIComponent('工具变量')).expect(200);
    await request(ctx.app).get(`/library/pdfs/${DOCUMENT_ID}`).expect(404);
  } finally {
    await ctx.cleanup();
  }
});

test('status 路由校验 ID、返回 404 并只输出脱敏状态', async () => {
  let readyCalls = 0;
  const ctx = await setup({
    pdfService: fakePdfService({
      ready: async () => { readyCalls += 1; },
      status: id => id === DOCUMENT_ID
        ? {
            documentId: id,
            state: 'running',
            progress: { extractedPages: 2, totalPages: 5 },
            error: '',
            updatedAt: '2026-08-30T00:00:00.000Z',
            pageCount: 0
          }
        : null
    })
  });
  try {
    await request(ctx.app).get('/library/pdfs/not-an-id/status').expect(400);
    await request(ctx.app).get('/library/pdfs/ffffffffffffffffffffffffffffffff/status').expect(404);
    const response = await request(ctx.app).get(`/library/pdfs/${DOCUMENT_ID}/status`).expect(200);
    assert.deepEqual(response.body, {
      ok: true,
      documentId: DOCUMENT_ID,
      state: 'running',
      progress: { extractedPages: 2, totalPages: 5 },
      error: '',
      updatedAt: '2026-08-30T00:00:00.000Z',
      pageCount: 0
    });
    assert.ok(readyCalls >= 3);
  } finally {
    await ctx.cleanup();
  }
});

test('PDF search 路由先于参数路由并返回页码、原文片段和稳定链接', async () => {
  const ctx = await setup({ pdfService: fakePdfService() });
  try {
    insertPdf(ctx.db);
    const response = await request(ctx.app)
      .get('/library/pdfs/search?q=' + encodeURIComponent('工具变量'))
      .expect(200);
    assert.match(response.text, /PDF 全文搜索/);
    assert.match(response.text, /找到 1 个正文片段/);
    assert.match(response.text, /第 1 页/);
    assert.match(response.text, /工具变量/);
    assert.match(response.text, new RegExp(`/library/pdfs/${DOCUMENT_ID}\\?chunk=0#chunk-0`));
    assert.doesNotMatch(response.text, /sourceSha256|cachePath|\.workstation\/mineru/);
  } finally {
    await ctx.cleanup();
  }
});

test('PDF preview 定位 chunk、按页导航且不加载远端图片或原始 HTML', async () => {
  const ctx = await setup({
    pdfService: fakePdfService({
      preview: (id, { chunkIndex } = {}) => {
        if (id !== DOCUMENT_ID) return null;
        const chunks = ctx.db.listPdfChunks(id);
        const selected = chunks.find(chunk => chunk.chunkIndex === Number(chunkIndex)) || chunks[0];
        return {
          document: {
            ...ctx.db.getPdfDocument(id),
            sourceSha256: 'a'.repeat(64),
            cachePath: '/Users/person/vault/.workstation/mineru/1/PDF00001'
          },
          chunks: chunks.filter(chunk => chunk.pageIndex === selected.pageIndex),
          selectedChunk: selected.chunkIndex,
          pageIndex: selected.pageIndex,
          pageNumber: selected.pageIndex + 1,
          previousChunk: selected.pageIndex === 1 ? 0 : null,
          nextChunk: selected.pageIndex === 0 ? 1 : null
        };
      }
    })
  });
  try {
    insertPdf(ctx.db);
    const first = await request(ctx.app).get(`/library/pdfs/${DOCUMENT_ID}?chunk=0`).expect(200);
    assert.match(first.text, /id="chunk-0"/);
    assert.match(first.text, /class="prose pdf-chunk is-selected"/);
    assert.match(first.text, new RegExp(`/library/pdfs/${DOCUMENT_ID}\\?chunk=1`));
    assert.doesNotMatch(first.text, /<img\b/i);
    assert.doesNotMatch(first.text, /evil\.example|\/Users\/person|sourceSha256|cachePath/);
    assert.match(first.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(first.text, />远端图</);

    const second = await request(ctx.app).get(`/library/pdfs/${DOCUMENT_ID}?chunk=1`).expect(200);
    assert.match(second.text, /第 2 页/);
    assert.match(second.text, new RegExp(`/library/pdfs/${DOCUMENT_ID}\\?chunk=0`));
    await request(ctx.app).get(`/library/pdfs/${DOCUMENT_ID}?chunk=-1`).expect(400);
    await request(ctx.app).get('/library/pdfs/ffffffffffffffffffffffffffffffff').expect(404);
  } finally {
    await ctx.cleanup();
  }
});

test('文献页合并 API 范围外父条目与独立 PDF，并白名单输出附件字段', async () => {
  const originalFetchItems = zotero.fetchItems;
  const originalReadLibraryData = zotero.readLibraryData;
  zotero.fetchItems = async () => ({
    available: true,
    items: [{
      key: 'VISIBLE1',
      title: 'API 内条目',
      creators: [],
      year: '',
      publication: '',
      tags: []
    }]
  });
  zotero.readLibraryData = async () => ({
    available: true,
    items: [],
    attachments: []
  });
  const service = fakePdfService({
    describeLibrary: async () => [
      {
        libraryId: 1,
        attachmentKey: 'HIDDEN01',
        parentKey: 'OUTSIDE1',
        parentTitle: 'API 范围外论文',
        documentId: DOCUMENT_ID,
        fileName: 'outside.pdf',
        localAvailable: true,
        size: 2048,
        tokenConfigured: true,
        state: 'unparsed',
        progress: null,
        error: '',
        storagePath: 'storage:private.pdf',
        sourceSha256: 'sensitive-hash',
        cachePath: '/Users/person/private-cache'
      },
      {
        libraryId: 2,
        attachmentKey: 'STAND001',
        parentKey: '',
        parentTitle: '',
        documentId: 'fedcba9876543210fedcba9876543210',
        fileName: 'standalone.pdf',
        localAvailable: true,
        size: 4096,
        tokenConfigured: true,
        state: 'ready',
        progress: null,
        error: '',
        pageCount: 3
      }
    ]
  });
  const ctx = await setup({ pdfService: service });
  try {
    const response = await request(ctx.app).get('/library').expect(200);
    assert.match(response.text, /API 范围外论文/);
    assert.match(response.text, /outside\.pdf/);
    assert.match(response.text, /独立 PDF 附件/);
    assert.match(response.text, /standalone\.pdf/);
    assert.match(response.text, /data-library-id="1"/);
    assert.match(response.text, /data-attachment-key="HIDDEN01"/);
    assert.doesNotMatch(response.text, /storage:private|sensitive-hash|\/Users\/person|private-cache/);
  } finally {
    zotero.fetchItems = originalFetchItems;
    zotero.readLibraryData = originalReadLibraryData;
    await ctx.cleanup();
  }
});

test('只读文献页隐藏上传控件和确认 dialog，但保留搜索与 ready 预览', async () => {
  const originalFetchItems = zotero.fetchItems;
  const originalReadLibraryData = zotero.readLibraryData;
  zotero.fetchItems = async () => ({
    available: true,
    items: [{ key: 'PARENT1', title: '论文', creators: [], year: '', publication: '', tags: [] }]
  });
  zotero.readLibraryData = async () => ({ available: true, items: [], attachments: [] });
  const service = fakePdfService({
    describeLibrary: async () => [
      {
        libraryId: 1,
        attachmentKey: 'PDF00001',
        parentKey: 'PARENT1',
        parentTitle: '论文',
        documentId: DOCUMENT_ID,
        fileName: 'paper.pdf',
        localAvailable: true,
        size: 1024,
        tokenConfigured: true,
        state: 'ready',
        pageCount: 2,
        progress: null,
        error: ''
      }
    ]
  });
  const ctx = await setup({ readOnly: true, pdfService: service });
  try {
    const response = await request(ctx.app).get('/library').expect(200);
    assert.match(response.text, /搜索 PDF 全文/);
    assert.match(response.text, new RegExp(`/library/pdfs/${DOCUMENT_ID}`));
    assert.doesNotMatch(response.text, /data-parse-pdf|data-pdf-dialog/);
  } finally {
    zotero.fetchItems = originalFetchItems;
    zotero.readLibraryData = originalReadLibraryData;
    await ctx.cleanup();
  }
});
