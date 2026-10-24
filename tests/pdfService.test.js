const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const {
  MANIFEST_VERSION,
  PARSE_PROFILE,
  createPdfLibraryService,
  documentId
} = require('../src/pdf/service');

const CONTENT_LIST = [
  { type: 'title', text: '识别策略', page_idx: 0 },
  { type: 'text', text: '工具变量用于处理内生性。', page_idx: 0 },
  { type: 'heading', text: '稳健性', page_idx: 1 },
  { type: 'text', text: '安慰剂检验支持主要结论。', page_idx: 1 }
];
const CONTENT_LIST_TEXT = JSON.stringify(CONTENT_LIST);
const quietLogger = { log() {}, warn() {}, error() {} };

function attachment(key, options = {}) {
  return {
    libraryId: options.libraryId ?? 'user',
    attachmentKey: key,
    parentKey: options.parentKey ?? 'PARENT1',
    parentTitle: options.parentTitle ?? `论文 ${key}`,
    storagePath: `storage:${options.fileName || `${key}.pdf`}`,
    contentType: 'application/pdf',
    linkMode: 0
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(check, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('等待测试条件超时。');
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function makeContext({
  attachments = [attachment('PDF00001')],
  bodies = {},
  readOnly = false,
  configured = true,
  mineruOverrides = {}
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-pdf-service-'));
  const vaultDir = path.join(root, 'vault');
  const sourceDir = path.join(root, 'sources');
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(sourceDir, { recursive: true });

  const sourcePaths = new Map();
  for (const item of attachments) {
    const target = path.join(sourceDir, `${item.libraryId}-${item.attachmentKey}.pdf`);
    const body = bodies[item.attachmentKey] || `%PDF-1.7\nfixture-${item.attachmentKey}\n`;
    await fs.writeFile(target, body);
    sourcePaths.set(`${item.libraryId}:${item.attachmentKey}`, target);
  }

  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    readOnly,
    zoteroDataDir: sourceDir,
    mineruApiToken: configured ? 'test-token' : ''
  });
  const db = openDatabase(':memory:');
  let inventory = { available: true, items: [], attachments: [...attachments] };
  const calls = {
    create: [],
    upload: [],
    wait: [],
    download: []
  };

  const mineru = {
    configured: () => configured,
    async createTask(input) {
      calls.create.push(input);
      return {
        batchId: `batch-${calls.create.length}`,
        uploadUrl: `https://uploads.example.test/${calls.create.length}`
      };
    },
    async uploadFile(input) {
      calls.upload.push({ ...input, bytes: await fs.readFile(input.filePath, 'utf8') });
    },
    async waitForResult(batchId, { signal, onProgress } = {}) {
      calls.wait.push({ batchId, signal });
      await onProgress?.({
        state: 'running',
        progress: { extractedPages: 1, totalPages: 2 }
      });
      return {
        state: 'done',
        progress: { extractedPages: 2, totalPages: 2 },
        zipUrl: 'https://results.example.test/result.zip'
      };
    },
    async downloadResult(input) {
      calls.download.push(input);
      await fs.writeFile(input.targetPath, 'fake zip');
      return { size: 8 };
    },
    ...mineruOverrides
  };

  const inspectStats = { calls: 0, active: 0, peakConcurrency: 0 };

  async function inspectAttachmentPdf(_dataDir, item) {
    inspectStats.calls += 1;
    inspectStats.active += 1;
    inspectStats.peakConcurrency = Math.max(inspectStats.peakConcurrency, inspectStats.active);
    try {
      return await inspectAttachmentPdfImpl(_dataDir, item);
    } finally {
      inspectStats.active -= 1;
    }
  }

  async function inspectAttachmentPdfImpl(_dataDir, item) {
    const target = sourcePaths.get(`${item.libraryId}:${item.attachmentKey}`);
    try {
      if (!target) throw Object.assign(new Error('fixture 没有这个附件的文件'), { code: 'ENOENT' });
      const stats = await fs.stat(target);
      return {
        available: true,
        fileName: item.storagePath.slice('storage:'.length),
        size: stats.size,
        mtimeMs: stats.mtimeMs
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {
        available: false,
        fileName: item.storagePath.slice('storage:'.length),
        size: 0,
        mtimeMs: 0,
        reason: 'PDF 尚未下载到本机。'
      };
    }
  }

  async function baseOpenAttachmentPdf(_dataDir, item) {
    const target = sourcePaths.get(`${item.libraryId}:${item.attachmentKey}`);
    const handle = await fs.open(target, 'r');
    return {
      handle,
      stats: await handle.stat(),
      fileName: item.storagePath.slice('storage:'.length)
    };
  }

  // 测试要能把某次 open 卡住，模拟「读一个大 PDF 要好几秒」。
  let openImpl = baseOpenAttachmentPdf;
  const openAttachmentPdf = (dataDir, item) => openImpl(dataDir, item);

  const service = createPdfLibraryService({
    config,
    db,
    logger: quietLogger,
    mineru,
    readLibraryData: async () => inventory,
    inspectAttachmentPdf,
    openAttachmentPdf,
    readArchive: async () => ({
      markdown: '# 解析正文\n\n工具变量用于处理内生性。\n',
      contentList: CONTENT_LIST,
      contentListText: CONTENT_LIST_TEXT
    })
  });

  return {
    root,
    vaultDir,
    config,
    db,
    service,
    calls,
    sourcePaths,
    attachments,
    inspectStats,
    openAttachmentPdf: baseOpenAttachmentPdf,
    setOpenAttachmentPdf(next) { openImpl = next || baseOpenAttachmentPdf; },
    resetInspectStats() {
      inspectStats.calls = 0;
      inspectStats.active = 0;
      inspectStats.peakConcurrency = 0;
    },
    setInventory(next) { inventory = next; },
    async cleanup() {
      openImpl = baseOpenAttachmentPdf;
      await service.stop().catch(() => {});
      try { db.close(); } catch {}
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

function cacheDirectory(ctx, item) {
  return path.join(ctx.config.mineruCacheDir, String(item.libraryId), item.attachmentKey);
}

function manifestPath(ctx, item) {
  return path.join(cacheDirectory(ctx, item), 'manifest.json');
}

async function sourceMetadata(ctx, item) {
  const target = ctx.sourcePaths.get(`${item.libraryId}:${item.attachmentKey}`);
  const body = await fs.readFile(target);
  const stats = await fs.stat(target);
  return { sha256: sha256(body), size: stats.size, mtimeMs: stats.mtimeMs };
}

async function writeManifest(ctx, item, overrides = {}, { artifacts = false } = {}) {
  const directory = cacheDirectory(ctx, item);
  await fs.mkdir(directory, { recursive: true });
  const source = overrides.source === undefined ? await sourceMetadata(ctx, item) : overrides.source;
  const manifest = {
    version: MANIFEST_VERSION,
    parseProfile: PARSE_PROFILE,
    documentId: documentId(item.libraryId, item.attachmentKey),
    libraryId: String(item.libraryId),
    attachmentKey: item.attachmentKey,
    parentKey: item.parentKey || '',
    title: item.parentTitle || item.storagePath.slice('storage:'.length),
    fileName: item.storagePath.slice('storage:'.length),
    storagePath: item.storagePath,
    state: 'ready',
    batchId: '',
    submissionConfirmed: false,
    progress: null,
    source,
    pageCount: 2,
    error: '',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    // 默认是本机建的缓存；跨设备与旧版本的情形由调用方显式覆盖。
    ownerDevice: ctx.config.device,
    ...overrides
  };
  await fs.writeFile(manifestPath(ctx, item), `${JSON.stringify(manifest, null, 2)}\n`);
  if (artifacts) {
    await fs.writeFile(path.join(directory, 'full.md'), '# 缓存正文\n');
    await fs.writeFile(path.join(directory, 'content_list.json'), CONTENT_LIST_TEXT);
  }
  return manifest;
}

test('PDF 服务完成上传、持久产物和派生索引，缓存不保留 PDF 或 ZIP', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    const queued = await ctx.service.enqueue({
      libraryId: item.libraryId,
      attachmentKey: item.attachmentKey
    });
    assert.equal(queued.state, 'queued');
    await ctx.service.idle();

    const ready = ctx.service.status(documentId(item.libraryId, item.attachmentKey));
    assert.equal(ready.state, 'ready');
    assert.equal(ready.pageCount, 2);
    assert.equal(ctx.calls.create.length, 1);
    assert.equal(ctx.calls.upload.length, 1);
    assert.match(ctx.calls.upload[0].bytes, /^%PDF-/);
    assert.equal(ctx.calls.wait.length, 1);
    assert.equal(ctx.calls.download.length, 1);

    const directory = cacheDirectory(ctx, item);
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      'content_list.json',
      'full.md',
      'manifest.json'
    ]);
    const durable = await fs.readFile(manifestPath(ctx, item), 'utf8');
    assert.doesNotMatch(durable, /test-token|uploads\.example|results\.example/);
    assert.equal(ctx.db.listPdfDocuments().length, 1);
    assert.equal(ctx.db.listPdfChunks(ready.documentId).length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('PDF 完整流水线在进程内严格并发 1', async () => {
  const items = [attachment('PDF00001'), attachment('PDF00002')];
  let active = 0;
  let maximum = 0;
  const ctx = await makeContext({
    attachments: items,
    mineruOverrides: {
      async waitForResult(batchId, { onProgress } = {}) {
        ctx.calls.wait.push({ batchId });
        active += 1;
        maximum = Math.max(maximum, active);
        await onProgress?.({ state: 'running', progress: null });
        await new Promise(resolve => setTimeout(resolve, 15));
        active -= 1;
        return {
          state: 'done',
          progress: null,
          zipUrl: 'https://results.example.test/result.zip'
        };
      }
    }
  });
  try {
    await Promise.all(items.map(item => ctx.service.enqueue({
      libraryId: item.libraryId,
      attachmentKey: item.attachmentKey
    })));
    await ctx.service.idle();
    assert.equal(maximum, 1);
    assert.equal(ctx.calls.create.length, 2);
    assert.equal(ctx.calls.wait.length, 2);
    assert.ok(items.every(item => (
      ctx.service.status(documentId(item.libraryId, item.attachmentKey)).state === 'ready'
    )));
  } finally {
    await ctx.cleanup();
  }
});

test('相同 PDF 哈希直接复用 ready 产物而不再次调用 MinerU', async () => {
  const items = [attachment('PDF00001'), attachment('PDF00002')];
  const shared = '%PDF-1.7\nsame-content\n';
  const ctx = await makeContext({
    attachments: items,
    bodies: { PDF00001: shared, PDF00002: shared }
  });
  try {
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: 'PDF00001' });
    await ctx.service.idle();
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: 'PDF00002' });
    await ctx.service.idle();

    assert.equal(ctx.calls.create.length, 1);
    assert.equal(ctx.calls.upload.length, 1);
    assert.equal(ctx.db.listPdfDocuments().length, 2);
    const second = JSON.parse(await fs.readFile(manifestPath(ctx, items[1]), 'utf8'));
    assert.equal(second.state, 'ready');
    assert.equal(second.reusedFrom, documentId('user', 'PDF00001'));
  } finally {
    await ctx.cleanup();
  }
});

test('重启恢复远端已提交任务而不创建或上传第二次', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {
      state: 'running',
      batchId: 'existing-batch',
      submissionConfirmed: true
    });
    await ctx.service.initialize();
    await ctx.service.idle();

    assert.equal(ctx.calls.create.length, 0);
    assert.equal(ctx.calls.upload.length, 0);
    assert.deepEqual(ctx.calls.wait.map(call => call.batchId), ['existing-batch']);
    assert.equal(ctx.service.status(documentId('user', item.attachmentKey)).state, 'ready');
  } finally {
    await ctx.cleanup();
  }
});

test('重启把不确定的 uploading 状态标为失败且不重复提交', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {
      state: 'uploading',
      batchId: 'ambiguous-batch',
      submissionConfirmed: false
    });
    await ctx.service.initialize();
    await ctx.service.idle();

    const status = ctx.service.status(documentId('user', item.attachmentKey));
    assert.equal(status.state, 'failed');
    assert.match(status.error, /提交至 MinerU 前中断/);
    assert.equal(ctx.calls.create.length, 0);
    assert.equal(ctx.calls.upload.length, 0);
    assert.equal(ctx.calls.wait.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('已确认提交的失败任务仅在源文件相同时复用 batch', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {
      state: 'failed',
      batchId: 'paid-batch',
      submissionConfirmed: true,
      error: '上次轮询失败'
    });
    await ctx.service.initialize();
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey });
    await ctx.service.idle();

    assert.equal(ctx.calls.create.length, 0);
    assert.equal(ctx.calls.upload.length, 0);
    assert.deepEqual(ctx.calls.wait.map(call => call.batchId), ['paid-batch']);
    assert.equal(ctx.service.status(documentId('user', item.attachmentKey)).state, 'ready');
  } finally {
    await ctx.cleanup();
  }
});

test('失败任务的源文件被替换后清除旧缓存并创建新任务', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {
      state: 'failed',
      batchId: 'old-batch',
      submissionConfirmed: true,
      error: '上次失败'
    }, { artifacts: true });
    await ctx.service.initialize();
    const target = ctx.sourcePaths.get(`user:${item.attachmentKey}`);
    await fs.writeFile(target, '%PDF-1.7\nreplacement-content-is-different\n');

    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey });
    await ctx.service.idle();

    assert.equal(ctx.calls.create.length, 1);
    assert.equal(ctx.calls.upload.length, 1);
    assert.notEqual(ctx.calls.wait[0].batchId, 'old-batch');
    const manifest = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(manifest.source.sha256, sha256('%PDF-1.7\nreplacement-content-is-different\n'));
    assert.equal(manifest.state, 'ready');
  } finally {
    await ctx.cleanup();
  }
});

test('直接 enqueue 不能绕过 ready PDF 的替换检测', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    const target = ctx.sourcePaths.get(`user:${item.attachmentKey}`);
    await fs.writeFile(target, '%PDF-1.7\nnew-ready-replacement-content\n');

    const queued = await ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey });
    assert.equal(queued.state, 'queued');
    await ctx.service.idle();
    assert.equal(ctx.calls.create.length, 1);
    assert.equal(ctx.service.status(documentId('user', item.attachmentKey)).state, 'ready');
  } finally {
    await ctx.cleanup();
  }
});

test('损坏的 ready 产物降级为 failed 并移除派生索引', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: false });
    ctx.db.replacePdfDocument({
      documentId: documentId('user', item.attachmentKey),
      libraryId: 'user',
      attachmentKey: item.attachmentKey,
      parentKey: item.parentKey,
      title: item.parentTitle,
      fileName: `${item.attachmentKey}.pdf`,
      sourceSha256: 'a'.repeat(64),
      cachePath: '.workstation/mineru/1/PDF00001',
      pageCount: 1,
      indexedAt: '2026-08-30T00:00:00.000Z',
      titleTokens: '论文',
      chunks: [{
        chunkIndex: 0,
        pageIndex: 0,
        heading: '',
        body: '旧索引',
        markdown: '旧索引',
        headingTokens: '',
        bodyTokens: '旧 索引'
      }]
    });
    await ctx.service.initialize();

    const status = ctx.service.status(documentId('user', item.attachmentKey));
    assert.equal(status.state, 'failed');
    assert.match(status.error, /缓存损坏/);
    assert.equal(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)), undefined);
    const durable = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(durable.state, 'failed');
  } finally {
    await ctx.cleanup();
  }
});

test('成功快照确认附件删除后才清理缓存和索引', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));

    await ctx.service.describeLibrary({
      available: false,
      reason: 'Zotero 暂时不可用',
      items: [],
      attachments: []
    });
    await fs.access(cacheDirectory(ctx, item));
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));

    // 同一个库里还有别的附件，说明这是一份正常的快照，而这一篇确实没了。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [attachment('OTHER001')]
    });
    await assert.rejects(fs.access(cacheDirectory(ctx, item)));
    assert.equal(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)), undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('Zotero 回收站里的附件保留缓存，彻底删除才清理', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    const id = documentId('user', item.attachmentKey);

    // 回收站是软删除，条目随时能还原；而 MinerU 产物只有重新上传解析才回得来。
    const described = await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [],
      trashedAttachments: [item]
    });
    assert.deepEqual(described, [], '回收站里的附件不该出现在文献页');
    await fs.access(cacheDirectory(ctx, item));
    assert.ok(ctx.db.getPdfDocument(id), '回收站不该动派生索引');
    assert.equal(ctx.service.status(id)?.state, 'ready');

    // 清空回收站之后条目彻底不在了，这时才清理。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [attachment('OTHER001')],
      trashedAttachments: []
    });
    await assert.rejects(fs.access(cacheDirectory(ctx, item)));
    assert.equal(ctx.db.getPdfDocument(id), undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('别的设备建的缓存即使快照里找不到附件也不清理，也不接手它的任务', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  const running = attachment('PDF00002');
  try {
    await writeManifest(ctx, item, { ownerDevice: 'other-laptop' }, { artifacts: true });
    await writeManifest(ctx, running, {
      ownerDevice: 'other-laptop',
      state: 'running',
      batchId: 'batch-remote',
      submissionConfirmed: true,
      source: null,
      updatedAt: new Date().toISOString()
    });
    await ctx.service.initialize();
    const id = documentId('user', item.attachmentKey);
    const runningId = documentId('user', running.attachmentKey);

    // 群组库在另一台设备上换了本机编号、或新电脑上 Zotero 还没同步完时都是这个形状。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [attachment('OTHER001')]
    });
    await fs.access(cacheDirectory(ctx, item));
    assert.ok(ctx.db.getPdfDocument(id));
    assert.equal(ctx.service.status(id)?.state, 'ready');

    await ctx.service.idle();
    assert.equal(ctx.calls.wait.length, 0, '别的设备正在跑的任务不该在这里重复轮询');
    const onDisk = JSON.parse(await fs.readFile(manifestPath(ctx, running), 'utf8'));
    assert.equal(onDisk.state, 'running', '也不该改写别的设备的 manifest');
    assert.equal(ctx.service.status(runningId)?.state, 'running');
  } finally {
    await ctx.cleanup();
  }
});

test('旧版本没有归属的缓存不做自动清理', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, { ownerDevice: undefined }, { artifacts: true });
    await ctx.service.initialize();
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [attachment('OTHER001')]
    });
    await fs.access(cacheDirectory(ctx, item));
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
  } finally {
    await ctx.cleanup();
  }
});

test('空库、同 key 换了库编号、成批消失时都不清理本机缓存', async () => {
  const items = Array.from({ length: 8 }, (_, index) => attachment(`PDF0000${index + 1}`));
  const ctx = await makeContext({ attachments: items });
  try {
    for (const item of items) await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    const exists = item => fs.access(cacheDirectory(ctx, item)).then(() => true, () => false);

    // 1. 这个库在快照里一条附件都没有：更像是选错了数据目录。
    await ctx.service.describeLibrary({ available: true, items: [], attachments: [] });
    for (const item of items) assert.equal(await exists(item), true);

    // 2. 同一个 key 出现在另一个库编号下：同一个群组库在这台机器上编号不同。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [attachment('OTHER001'), attachment(items[0].attachmentKey, { libraryId: 'group-7' })]
    });
    assert.equal(await exists(items[0]), true);

    // 3. 8 篇里有 7 篇同时从快照里消失：比例异常，整轮保留。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [items[0]]
    });
    for (const item of items) assert.equal(await exists(item), true);

    // 只少一篇时照常清理。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: items.slice(0, 7)
    });
    assert.equal(await exists(items[7]), false);
    for (const item of items.slice(0, 7)) assert.equal(await exists(item), true);
  } finally {
    await ctx.cleanup();
  }
});

test('别的设备上停滞过久的任务可以由本机显式重新解析接手', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {
      ownerDevice: 'other-laptop',
      state: 'running',
      batchId: 'batch-remote',
      submissionConfirmed: true,
      source: null,
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    await ctx.service.initialize();
    await ctx.service.enqueue(item);
    await ctx.service.idle();
    const saved = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(saved.state, 'ready');
    assert.equal(saved.ownerDevice, ctx.config.device);
  } finally {
    await ctx.cleanup();
  }
});

test('不归本机的缓存在本机源 PDF 被替换后标为失效并撤掉索引，但不删磁盘目录', async () => {
  for (const owner of [undefined, 'other-laptop']) {
    const ctx = await makeContext();
    const item = ctx.attachments[0];
    try {
      await writeManifest(ctx, item, { ownerDevice: owner }, { artifacts: true });
      await ctx.service.initialize();
      const id = documentId('user', item.attachmentKey);
      const before = await fs.readFile(manifestPath(ctx, item), 'utf8');
      await fs.writeFile(ctx.sourcePaths.get(`user:${item.attachmentKey}`), '%PDF-1.7\nreplaced-and-longer\n');

      await ctx.service.describeLibrary({ available: true, items: [], attachments: [item], readAt: Date.now() });
      assert.equal(ctx.service.status(id)?.state, 'failed', `owner=${owner}`);
      assert.match(ctx.service.status(id)?.error, /已替换/);
      assert.equal(ctx.db.getPdfDocument(id), undefined);
      await fs.access(path.join(cacheDirectory(ctx, item), 'full.md'));
      assert.equal(await fs.readFile(manifestPath(ctx, item), 'utf8'), before, '不改写不归本机的 manifest');

      // 重新解析接手这份缓存。
      await ctx.service.enqueue(item);
      await ctx.service.idle();
      const saved = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
      assert.equal(saved.state, 'ready');
      assert.equal(saved.ownerDevice, ctx.config.device);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('解析前按磁盘上的 manifest 判断：启动后才经 Git 拉下来的别机任务不被覆盖', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await ctx.service.initialize();
    // 启动之后，Git 拉下来另一台设备刚开始的解析任务。
    await writeManifest(ctx, item, {
      ownerDevice: 'other-laptop',
      state: 'running',
      batchId: 'batch-remote',
      submissionConfirmed: true,
      source: null,
      updatedAt: new Date().toISOString()
    });
    const before = await fs.readFile(manifestPath(ctx, item), 'utf8');
    await assert.rejects(ctx.service.enqueue(item), error => error.status === 409 && /other-laptop/.test(error.message));
    assert.equal(await fs.readFile(manifestPath(ctx, item), 'utf8'), before);
    assert.equal(ctx.calls.create.length, 0, '不能重复提交 MinerU 任务');

    // 那台设备把它跑完了：本机直接用它的结果，并补进本机的派生索引。
    await writeManifest(ctx, item, { ownerDevice: 'other-laptop' }, { artifacts: true });
    const status = await ctx.service.enqueue(item);
    assert.equal(status.state, 'ready');
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
    assert.equal(ctx.calls.create.length, 0);
    const saved = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(saved.ownerDevice, 'other-laptop', '内容没变时不改写别的设备的 manifest');
  } finally {
    await ctx.cleanup();
  }
});

// ── 旧版本按本机 libraryID 存的缓存 ──────────────────────

async function writeLegacy(ctx, item, localLibraryId, overrides = {}) {
  const source = overrides.source === undefined ? await sourceMetadata(ctx, item) : overrides.source;
  return writeManifest(ctx, { ...item, libraryId: String(localLibraryId) }, { source, ...overrides }, { artifacts: true });
}

const legacyDirectory = (ctx, localLibraryId, key) => path.join(ctx.config.mineruCacheDir, String(localLibraryId), key);
const exists = target => fs.access(target).then(() => true, () => false);

test('旧缓存按附件 key 迁移到全局库身份下，只换身份字段', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    const legacy = await writeLegacy(ctx, item, 1);
    await ctx.service.initialize();

    const migratedPath = manifestPath(ctx, item);
    const saved = JSON.parse(await fs.readFile(migratedPath, 'utf8'));
    assert.equal(saved.libraryId, 'user');
    assert.equal(saved.documentId, documentId('user', item.attachmentKey));
    assert.equal(saved.updatedAt, legacy.updatedAt, '迁移不改 updatedAt，各设备产出才一致');
    assert.deepEqual(Object.keys(saved), Object.keys(legacy), '字段顺序不变');
    assert.equal(await exists(legacyDirectory(ctx, 1, item.attachmentKey)), false);
    assert.equal(await exists(path.join(ctx.config.mineruCacheDir, '1')), false, '空的旧库目录一并删掉');
    await fs.access(path.join(cacheDirectory(ctx, item), 'full.md'));

    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
    assert.equal(ctx.db.getPdfDocument(documentId('1', item.attachmentKey)), undefined);
    assert.equal(ctx.service.status(documentId('user', item.attachmentKey))?.state, 'ready');
  } finally {
    await ctx.cleanup();
  }
});

test('两台设备各自迁移同一份旧缓存，产出逐字节相同', async () => {
  const group = attachment('PDF00001', { libraryId: 'group-4242' });
  const outputs = [];
  for (let device = 0; device < 2; device += 1) {
    const ctx = await makeContext({ attachments: [group] });
    try {
      // 旧目录名是当初写缓存那台设备的本机编号 2；这台设备上它可能是别的编号，
      // 但附件 key 在这台的快照里属于 group-4242，就迁到那里。
      await writeLegacy(ctx, group, 2, { source: { sha256: 'a'.repeat(64), size: 1, mtimeMs: 1 } });
      await ctx.service.initialize();
      outputs.push(await fs.readFile(manifestPath(ctx, group), 'utf8'));
    } finally {
      await ctx.cleanup();
    }
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(JSON.parse(outputs[0]).libraryId, 'group-4242');
});

test('这台设备上找不到或有歧义的旧缓存保持只读，照样可检索、不被清理', async () => {
  const ctx = await makeContext({
    attachments: [attachment('OTHER001'), attachment('TWICE001'), attachment('TWICE001', { libraryId: 'group-9' })]
  });
  try {
    const source = { sha256: 'b'.repeat(64), size: 1, mtimeMs: 1 };
    await writeLegacy(ctx, attachment('GONE0001'), 3, { source });
    await writeLegacy(ctx, attachment('TWICE001'), 3, { source });
    const before = await fs.readFile(path.join(legacyDirectory(ctx, 3, 'GONE0001'), 'manifest.json'), 'utf8');
    await ctx.service.initialize();

    for (const key of ['GONE0001', 'TWICE001']) {
      assert.equal(await exists(path.join(legacyDirectory(ctx, 3, key), 'full.md')), true);
      assert.ok(ctx.db.getPdfDocument(documentId('3', key)), `${key} 仍在全文索引里`);
    }
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [attachment('OTHER001'), attachment('TWICE001'), attachment('TWICE001', { libraryId: 'group-9' })]
    });
    assert.equal(await exists(legacyDirectory(ctx, 3, 'GONE0001')), true, '对账不碰没迁移的旧缓存');
    assert.equal(await fs.readFile(path.join(legacyDirectory(ctx, 3, 'GONE0001'), 'manifest.json'), 'utf8'), before);
  } finally {
    await ctx.cleanup();
  }
});

test('新旧目录同时存在时以新目录为准，旧的不重复进索引', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await writeLegacy(ctx, item, 1);
    await ctx.service.initialize();
    assert.deepEqual(ctx.db.listPdfDocuments().map(row => row.documentId), [documentId('user', item.attachmentKey)]);
    assert.equal(await exists(legacyDirectory(ctx, 1, item.attachmentKey)), true, '不替用户删掉旧目录');
  } finally {
    await ctx.cleanup();
  }
});

test('迁移在改名后、重写前中断过，下次加载时补完', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    const legacy = await writeLegacy(ctx, item, 1);
    await fs.mkdir(path.dirname(cacheDirectory(ctx, item)), { recursive: true });
    await fs.rename(legacyDirectory(ctx, 1, item.attachmentKey), cacheDirectory(ctx, item));
    await ctx.service.initialize();
    const saved = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(saved.libraryId, 'user');
    assert.equal(saved.updatedAt, legacy.updatedAt);
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
  } finally {
    await ctx.cleanup();
  }
});

test('启动时读不到 Zotero 就等文献页的快照再迁移；只读模式从不迁移', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeLegacy(ctx, item, 1);
    ctx.setInventory({ available: false, reason: 'Zotero 暂时不可用', items: [], attachments: [] });
    await ctx.service.initialize();
    assert.equal(await exists(legacyDirectory(ctx, 1, item.attachmentKey)), true);
    assert.ok(ctx.db.getPdfDocument(documentId('1', item.attachmentKey)));

    const described = await ctx.service.describeLibrary({ available: true, items: [], attachments: [item] });
    assert.equal(described[0].state, 'ready', '迁移后文献页直接显示可检索');
    assert.equal(await exists(legacyDirectory(ctx, 1, item.attachmentKey)), false);
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
    assert.equal(ctx.db.getPdfDocument(documentId('1', item.attachmentKey)), undefined);
  } finally {
    await ctx.cleanup();
  }

  const readOnly = await makeContext({ readOnly: true });
  try {
    await writeLegacy(readOnly, readOnly.attachments[0], 1);
    await readOnly.service.initialize();
    await readOnly.service.describeLibrary({ available: true, items: [], attachments: readOnly.attachments });
    assert.equal(await exists(legacyDirectory(readOnly, 1, readOnly.attachments[0].attachmentKey)), true);
    assert.ok(readOnly.db.getPdfDocument(documentId('1', readOnly.attachments[0].attachmentKey)));
  } finally {
    await readOnly.cleanup();
  }
});

test('旧格式的库编号不能再用来发起解析', async () => {
  const ctx = await makeContext();
  try {
    await assert.rejects(ctx.service.enqueue({ libraryId: '1', attachmentKey: 'PDF00001' }), /身份无效/);
  } finally {
    await ctx.cleanup();
  }
});

test('新解析的 manifest 记录本机为归属设备', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await ctx.service.enqueue(item);
    await ctx.service.idle();
    const saved = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(saved.state, 'ready');
    assert.equal(saved.ownerDevice, ctx.config.device);
  } finally {
    await ctx.cleanup();
  }
});

test('对账重新哈希期间不会删掉同一篇正在处理的缓存', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    const id = documentId('user', item.attachmentKey);

    // 把源文件换掉：size 和内容都变了，对账会触发一次重新哈希。
    const sourcePath = ctx.sourcePaths.get(`user:${item.attachmentKey}`);
    await fs.writeFile(sourcePath, '%PDF-1.7\nreplaced-and-longer\n');

    // 卡住重新哈希，模拟读一个大 PDF 要好几秒。
    const gate = deferred();
    const original = ctx.openAttachmentPdf;
    ctx.setOpenAttachmentPdf(async (dataDir, attachmentItem) => {
      await gate.promise;
      return original(dataDir, attachmentItem);
    });

    const describing = ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [item],
      readAt: Date.now()
    });
    await waitFor(() => ctx.service.isBusy(id));

    // 这期间点「重新解析」：必须明确报错。回一个「当前状态」的话路由照样是
    // 202 + ok:true，前端会先弹「已加入解析队列」再弹「解析完成」并刷新页面 ——
    // 用户收到两条成功提示，实际什么都没发生。
    await assert.rejects(
      ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey }),
      /正在核对或处理中/
    );
    assert.equal(ctx.calls.create.length, 0, '不该在对账进行中发起 MinerU 任务');

    gate.resolve();
    await describing;
    await ctx.service.idle();

    // 源文件确实变了，旧缓存该走 —— 但走的是旧缓存，没有任何解析成果被浪费。
    assert.equal(ctx.calls.create.length, 0);
    assert.equal(ctx.service.status(id), null);
    assert.equal(ctx.db.getPdfDocument(id), undefined);
    await assert.rejects(fs.access(cacheDirectory(ctx, item)));
  } finally {
    await ctx.cleanup();
  }
});

test('对账不会拿过期的库快照删掉比它更新的解析成果', async () => {
  const ctx = await makeContext({
    attachments: [attachment('PDF00001'), attachment('PDF00002')]
  });
  const [kept, target] = ctx.attachments;
  try {
    await writeManifest(ctx, kept, {}, { artifacts: true });
    await ctx.service.initialize();
    const targetId = documentId('user', target.attachmentKey);

    // 对账一轮可以跑几分钟。先记下「库快照被读取的时刻」，之后发生的事情
    // 这份快照都不知道。
    const snapshotAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 5));

    // 快照之后，用户对第二篇点了解析并且跑完了。
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: target.attachmentKey });
    await ctx.service.idle();
    assert.equal(ctx.service.status(targetId)?.state, 'ready');
    assert.equal(ctx.calls.create.length, 1);
    assert.ok(Date.parse(ctx.service.status(targetId).updatedAt) > snapshotAt);

    // 现在用那份过期快照做对账。它里面没有第二篇，按旧逻辑就会认定
    // 「Zotero 里已经没有这篇」，把刚付费解析出来的东西连目录带索引删掉。
    // 只重读 manifest 挡不住 —— 重读看到的是 ready，照样会删。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [kept],
      trashedAttachments: [],
      readAt: snapshotAt
    });

    assert.equal(ctx.service.status(targetId)?.state, 'ready', '刚解析完的成果被过期快照删掉了');
    assert.ok(ctx.db.getPdfDocument(targetId), '派生索引也被一起删了');
    await fs.access(cacheDirectory(ctx, target));

    // 但快照比 manifest 新时，该清理还是要清理。
    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [kept],
      trashedAttachments: [],
      readAt: Date.now()
    });
    assert.equal(ctx.service.status(targetId), null);
    assert.equal(ctx.db.getPdfDocument(targetId), undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('临时目录建不出来时不会永久占住这篇文献', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  const realTmpdir = os.tmpdir;
  try {
    await ctx.service.initialize();
    const id = documentId('user', item.attachmentKey);

    os.tmpdir = () => path.join(ctx.root, 'no-such-dir', 'nested');
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey });
    await ctx.service.idle();
    os.tmpdir = realTmpdir;

    assert.equal(ctx.service.status(id)?.state, 'failed');
    assert.equal(ctx.service.isBusy(id), false, '锁泄漏了，这篇再也解析不了');

    // 锁没漏的话，重试要能真正跑起来。
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey });
    await ctx.service.idle();
    assert.equal(ctx.service.status(id)?.state, 'ready');
    assert.equal(ctx.calls.create.length, 1);
  } finally {
    os.tmpdir = realTmpdir;
    await ctx.cleanup();
  }
});

test('读不动的文件不消耗对账的重新哈希名额', async () => {
  const many = Array.from({ length: 12 }, (unused, index) => attachment(`PDF${String(index).padStart(5, '0')}`));
  const ctx = await makeContext({ attachments: many });
  try {
    for (const item of many) await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();

    // 全部换掉源文件，让 12 篇都需要重新哈希；前 8 篇读不动（Zotero 正在写）。
    for (const item of many) {
      await fs.writeFile(ctx.sourcePaths.get(`user:${item.attachmentKey}`), '%PDF-1.7\nreplaced-longer\n');
    }
    const broken = new Set(many.slice(0, 8).map(item => item.attachmentKey));
    const original = ctx.openAttachmentPdf;
    ctx.setOpenAttachmentPdf(async (dataDir, item) => {
      if (broken.has(item.attachmentKey)) throw new Error('Zotero 附件暂时读不了。');
      return original(dataDir, item);
    });

    await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: many,
      readAt: Date.now()
    });

    // 名额只在真的读完一遍时才扣。否则前 8 篇会把每轮的名额烧光，
    // 后面 4 篇永远轮不到对账。
    for (const item of many.slice(8)) {
      assert.equal(
        ctx.service.status(documentId('user', item.attachmentKey)),
        null,
        `${item.attachmentKey} 没轮到对账，源文件已变却仍留着旧缓存`
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

test('文献页对每个附件只探测一次，并发有上限', async () => {
  const many = Array.from({ length: 24 }, (unused, index) => attachment(`PDF${String(index).padStart(5, '0')}`));
  const ctx = await makeContext({ attachments: many });
  try {
    await writeManifest(ctx, many[0], {}, { artifacts: true });
    await ctx.service.initialize();
    ctx.resetInspectStats();

    const described = await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: many
    });
    assert.equal(described.length, many.length);
    assert.equal(
      ctx.inspectStats.calls,
      many.length,
      `每个附件应当只探测一次，实际 ${ctx.inspectStats.calls} 次`
    );
    // 双边：并发不能失控，但退化成完全串行同样是回归（几千个附件会很慢）。
    assert.ok(
      ctx.inspectStats.peakConcurrency <= 8,
      `探测并发应当有上限，实际峰值 ${ctx.inspectStats.peakConcurrency}`
    );
    assert.ok(
      ctx.inspectStats.peakConcurrency > 1,
      `探测不该退化成串行，实际峰值 ${ctx.inspectStats.peakConcurrency}`
    );
  } finally {
    await ctx.cleanup();
  }
});

test('附件记录仍在但本机 PDF 缺失时保留缓存和索引', async () => {
  const ctx = await makeContext();
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    await fs.rm(ctx.sourcePaths.get(`user:${item.attachmentKey}`));

    const described = await ctx.service.describeLibrary({
      available: true,
      items: [],
      attachments: [item]
    });
    assert.equal(described[0].localAvailable, false);
    await fs.access(cacheDirectory(ctx, item));
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
  } finally {
    await ctx.cleanup();
  }
});

test('只读模式可重建和读取索引，但禁止排队与缓存清理', async () => {
  const ctx = await makeContext({ readOnly: true });
  const item = ctx.attachments[0];
  try {
    await writeManifest(ctx, item, {}, { artifacts: true });
    await ctx.service.initialize();
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));

    await assert.rejects(
      ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey }),
      /只读模式/
    );
    await ctx.service.describeLibrary({ available: true, items: [], attachments: [] });
    await fs.access(cacheDirectory(ctx, item));
    assert.ok(ctx.db.getPdfDocument(documentId('user', item.attachmentKey)));
    assert.equal(ctx.calls.create.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('stop 中止活动远端等待并保留可恢复 manifest', async () => {
  const started = deferred();
  const ctx = await makeContext({
    mineruOverrides: {
      async waitForResult(batchId, { signal } = {}) {
        ctx.calls.wait.push({ batchId, signal });
        started.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
  });
  const item = ctx.attachments[0];
  try {
    await ctx.service.enqueue({ libraryId: 'user', attachmentKey: item.attachmentKey });
    await started.promise;
    await ctx.service.stop();

    const manifest = JSON.parse(await fs.readFile(manifestPath(ctx, item), 'utf8'));
    assert.equal(manifest.state, 'submitted');
    assert.equal(manifest.submissionConfirmed, true);
    assert.equal(ctx.service.status(documentId('user', item.attachmentKey)).state, 'submitted');
  } finally {
    await ctx.cleanup();
  }
});
