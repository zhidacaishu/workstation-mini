const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');

const { loadConfig } = require('../src/config');
const {
  MANIFEST_VERSION,
  PARSE_PROFILE,
  documentId
} = require('../src/pdf/service');
const { startRuntime, closeServer } = require('../src/runtime');

const quietLogger = { log() {}, warn() {}, error() {} };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakePdfService(overrides = {}) {
  return {
    initialize: async () => ({ manifests: 0, ready: 0 }),
    ready: async () => {},
    describeLibrary: async () => [],
    enqueue: async () => ({ state: 'queued', progress: null, error: '' }),
    status: () => null,
    preview: () => null,
    stop: async () => {},
    idle: async () => {},
    ...overrides
  };
}

async function writePdfCache(vaultDir, {
  state = 'ready',
  batchId = '',
  submissionConfirmed = false
} = {}) {
  const libraryId = 'user';
  const attachmentKey = 'PDF00001';
  const id = documentId(libraryId, attachmentKey);
  const directory = path.join(vaultDir, '.workstation', 'mineru', libraryId, attachmentKey);
  const contentList = [
    { type: 'title', text: '识别策略', page_idx: 0 },
    { type: 'text', text: '工具变量用于处理内生性。', page_idx: 0 }
  ];
  const manifest = {
    version: MANIFEST_VERSION,
    parseProfile: PARSE_PROFILE,
    documentId: id,
    libraryId,
    attachmentKey,
    parentKey: 'PARENT1',
    title: '因果推断论文',
    fileName: 'paper.pdf',
    storagePath: 'storage:paper.pdf',
    state,
    batchId,
    submissionConfirmed,
    progress: null,
    source: { sha256: 'a'.repeat(64), size: 128, mtimeMs: 1 },
    pageCount: state === 'ready' ? 1 : 0,
    error: '',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z'
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(directory, 'full.md'), '# 识别策略\n\n工具变量用于处理内生性。\n');
  await fs.writeFile(path.join(directory, 'content_list.json'), JSON.stringify(contentList));
  return { directory, manifest, contentList };
}

async function makeRuntime(options = {}, runtimeOptions = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-runtime-'));
  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    syncEnabled: false,
    internalToken: 'desktop-session-token',
    ...options
  });
  const runtime = await startRuntime(config, { logger: quietLogger, ...runtimeOptions });
  return { vaultDir, runtime };
}

test('运行时拒绝无令牌或非动态回环配置', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-runtime-invalid-'));
  try {
    await assert.rejects(
      startRuntime(loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false }), { logger: quietLogger }),
      /缺少会话令牌/
    );
    await assert.rejects(
      startRuntime({
        ...loadConfig({
          vaultDir,
          dbPath: ':memory:',
          syncEnabled: false,
          internalToken: 'token'
        }),
        port: 4000
      }, { logger: quietLogger }),
      /随机的 127\.0\.0\.1 端口/
    );
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('运行时监听随机回环端口，并要求内部令牌', async () => {
  const ctx = await makeRuntime();
  try {
    assert.match(ctx.runtime.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.doesNotMatch(ctx.runtime.origin, /:0$/);

    const denied = await fetch(ctx.runtime.origin);
    assert.equal(denied.status, 403);

    const allowed = await fetch(ctx.runtime.origin, {
      headers: { 'x-workstation-internal-token': 'desktop-session-token' }
    });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /科研工作台|工作台|vault 还是空的/);
  } finally {
    await ctx.runtime.stop();
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

test('stop 可重复调用并真正释放监听端口', async () => {
  const ctx = await makeRuntime();
  const origin = ctx.runtime.origin;
  try {
    await Promise.all([ctx.runtime.stop(), ctx.runtime.stop(), ctx.runtime.stop()]);
    await assert.rejects(fetch(origin), /fetch failed|ECONNREFUSED/);
  } finally {
    await ctx.runtime.stop();
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

test('只读运行时即使配置同步也不写 .gitignore 或执行 Git', async () => {
  const ctx = await makeRuntime({ readOnly: true, syncEnabled: true });
  try {
    await assert.rejects(fs.access(path.join(ctx.vaultDir, '.gitignore')));
    assert.equal(ctx.runtime.getSyncStatus().phase, 'idle', '专用复习同步能力保持可用');
    assert.deepEqual(await ctx.runtime.syncNow(), { ok: true, skipped: '同步已关闭' });
  } finally {
    await ctx.runtime.stop();
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

test('恢复后的首次运行不写 Git 忽略规则，也不自动执行双向 Blob 对账', async () => {
  let requests = 0;
  const blobServer = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ blobs: [], conditionalWrites: true }));
  });
  blobServer.listen(0, '127.0.0.1');
  await once(blobServer, 'listening');
  const address = blobServer.address();
  const ctx = await makeRuntime({
    blobServerUrl: `http://127.0.0.1:${address.port}`,
    blobServerToken: 'test-token'
  }, { initialBlobReconcile: false });

  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
    await assert.rejects(fs.access(path.join(ctx.vaultDir, '.gitignore')));

    const result = await ctx.runtime.reconcileNow();
    assert.equal(result.ok, true);
    assert.ok(requests > 0, '后续显式对账仍应可用');
  } finally {
    await ctx.runtime.stop({ finalSync: false });
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
    await closeServer(blobServer);
  }
});

test('退出只给进行中的大文件传输很短的收尾时间，之后中止而不是无限等待', async () => {
  const downloadStarted = deferred();
  const blobServer = http.createServer((request, response) => {
    if (request.url.startsWith('/blobs?')) {
      const prefix = new URL(request.url, 'http://x').searchParams.get('prefix');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        conditionalWrites: true,
        blobs: prefix === 'audio' ? [{ path: 'audio/big.m4a', size: 10, sha256: 'a'.repeat(64) }] : []
      }));
      return;
    }
    // 下载请求挂住不回：模拟慢链路上的一份大文件。
    downloadStarted.resolve();
  });
  blobServer.listen(0, '127.0.0.1');
  await once(blobServer, 'listening');
  const address = blobServer.address();
  const ctx = await makeRuntime({
    blobServerUrl: `http://127.0.0.1:${address.port}`,
    blobServerToken: 'test-token'
  }, { blobStopGraceMs: 50 });

  try {
    await downloadStarted.promise;
    const started = Date.now();
    await ctx.runtime.stop({ finalSync: false });
    assert.ok(Date.now() - started < 5_000, '退出不该被一次挂住的下载拖住');
    await assert.rejects(fs.access(path.join(ctx.vaultDir, 'audio', 'big.m4a')));
  } finally {
    await ctx.runtime.stop({ finalSync: false }).catch(() => {});
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
    blobServer.closeAllConnections();
    await closeServer(blobServer);
  }
});

test('关闭同步时手工同步返回明确跳过状态', async () => {
  const ctx = await makeRuntime();
  try {
    assert.deepEqual(await ctx.runtime.syncNow(), { ok: true, skipped: '同步已关闭' });
  } finally {
    await ctx.runtime.stop();
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

// 改设置引起的重启不该走退出前同步：一次 git 推送要几秒到几十秒，
// 把它放在「保存设置」这条路上，等于改个设备名也要等推送，
// 推送失败还会连累一份本来合法的新配置被回滚。
test('停止运行时可跳过退出前同步，真正退出时才提交', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-runtime-sync-'));
  const git = (...args) => execFileSync('git', ['-C', vaultDir, ...args], { encoding: 'utf8' });
  const commitCount = () => {
    try {
      return Number(git('rev-list', '--count', 'HEAD').trim());
    } catch {
      return 0;
    }
  };

  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');

    const settings = { vaultDir, dbPath: ':memory:', syncEnabled: true, internalToken: 'token' };
    const restarted = await startRuntime(loadConfig(settings), { logger: quietLogger });
    await restarted.stop({ finalSync: false });
    assert.equal(commitCount(), 0, '设置重启不该产生提交');

    const exiting = await startRuntime(loadConfig(settings), { logger: quietLogger });
    await exiting.stop();
    assert.equal(commitCount(), 1, '退出前应提交一次');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('关闭服务会在期限后强制断开活动请求', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('started');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const request = http.get({ host: '127.0.0.1', port });
  request.on('error', () => {});
  const [response] = await once(request, 'response');
  response.on('error', () => {});
  await once(response, 'data');

  const startedAt = Date.now();
  await closeServer(server, 50);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(server.listening, false);
  request.destroy();
});

// ——————————————————————————————————————————————————————————————
// 外部编辑与非阻塞启动
// ——————————————————————————————————————————————————————————————

/** 等到条件成立或超时。文件事件到重扫完成之间有去抖，不能靠固定 sleep。 */
async function waitFor(check, { timeoutMs = 6000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}

test('在应用外面新建、修改、删除笔记都会进索引', async () => {
  const { vaultDir, runtime } = await makeRuntime({}, {
    watcherOptions: {
      fallbackPollMs: 100,
      debounceMs: 20,
      watch: () => ({ on() {}, close() {} })
    }
  });
  try {
    await runtime.indexReady;
    const notesDir = path.join(vaultDir, 'notes', 'research');
    await fs.mkdir(notesDir, { recursive: true });
    const target = path.join(notesDir, '外部.md');

    // 新建：模拟在 Obsidian 里写了一篇
    await fs.writeFile(target, '---\ntitle: 外部\n---\n\n断点回归设计。\n');
    const added = await waitFor(async () =>
      runtime.db.getNote('research/外部.md') ? true : null);
    assert.ok(added, '外部新建的笔记应当自动进索引');

    // 修改
    await fs.appendFile(target, '\n工具变量估计。\n');
    const updated = await waitFor(async () => {
      const row = runtime.db.getNote('research/外部.md');
      return row && row.body_raw.includes('工具变量') ? true : null;
    });
    assert.ok(updated, '外部修改应当被重新索引');

    // 删除
    await fs.rm(target);
    const removed = await waitFor(async () =>
      runtime.db.getNote('research/外部.md') ? null : true);
    assert.ok(removed, '外部删除应当从索引里移除');
  } finally {
    await runtime.stop({ finalSync: false });
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('索引还没建完时服务已经能响应，并如实报告进度', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-runtime-cold-'));
  const notesDir = path.join(vaultDir, 'notes', 'research');
  await fs.mkdir(notesDir, { recursive: true });
  for (let i = 0; i < 40; i += 1) {
    await fs.writeFile(path.join(notesDir, `n${i}.md`), `---\ntitle: 主题${i}\n---\n\n正文${i}。\n`);
  }

  const config = loadConfig({
    vaultDir, dbPath: ':memory:', syncEnabled: false, internalToken: 'desktop-session-token'
  });
  const runtime = await startRuntime(config, { logger: quietLogger });

  try {
    // 关键约束：startRuntime 返回时服务已经在监听，不必等扫描完成。
    const status = runtime.getIndexStatus();
    assert.ok(['indexing', 'ready'].includes(status.phase));

    await runtime.indexReady;
    const done = runtime.getIndexStatus();
    assert.equal(done.phase, 'ready');
    assert.equal(done.notes, 40);
    assert.equal(done.total, 40);
  } finally {
    await runtime.stop({ finalSync: false });
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('PDF 初始化不阻塞 HTTP 监听', async () => {
  const initialization = deferred();
  let initializeCalls = 0;
  const service = fakePdfService({
    initialize() {
      initializeCalls += 1;
      return initialization.promise;
    },
    ready() {
      return initialization.promise;
    }
  });
  const ctx = await makeRuntime({}, { pdfOptions: { instance: service } });

  try {
    assert.equal(initializeCalls, 1);
    let initialized = false;
    ctx.runtime.pdfReady.then(() => { initialized = true; });

    const response = await fetch(ctx.runtime.origin, {
      headers: { 'x-workstation-internal-token': 'desktop-session-token' }
    });
    assert.equal(response.status, 200);
    assert.equal(initialized, false);

    initialization.resolve({ manifests: 3, ready: 2 });
    assert.deepEqual(await ctx.runtime.pdfReady, { manifests: 3, ready: 2 });
  } finally {
    initialization.resolve({ manifests: 0, ready: 0 });
    await ctx.runtime.stop({ finalSync: false });
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

test('PDF 状态路由等待初始化，其他页面仍可响应', async () => {
  const initialization = deferred();
  const readyEntered = deferred();
  let statusCalls = 0;
  const id = documentId('1', 'PDF00001');
  const service = fakePdfService({
    initialize: () => initialization.promise,
    ready() {
      readyEntered.resolve();
      return initialization.promise;
    },
    status(documentIdValue) {
      statusCalls += 1;
      return {
        documentId: documentIdValue,
        state: 'ready',
        progress: null,
        error: '',
        updatedAt: '2026-08-30T00:00:00.000Z',
        pageCount: 1
      };
    }
  });
  const ctx = await makeRuntime({}, { pdfOptions: { instance: service } });
  const headers = { 'x-workstation-internal-token': 'desktop-session-token' };
  let statusRequest;

  try {
    statusRequest = fetch(`${ctx.runtime.origin}/library/pdfs/${id}/status`, { headers });
    await readyEntered.promise;
    assert.equal(statusCalls, 0);

    const home = await fetch(ctx.runtime.origin, { headers });
    assert.equal(home.status, 200);

    initialization.resolve({ manifests: 1, ready: 1 });
    const response = await statusRequest;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'ready');
    assert.equal(statusCalls, 1);
  } finally {
    initialization.resolve({ manifests: 0, ready: 0 });
    await statusRequest?.catch(() => {});
    await ctx.runtime.stop({ finalSync: false });
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

test('运行时从 ready manifest 重建 PDF 索引', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-runtime-pdf-cache-'));
  const cached = await writePdfCache(vaultDir);
  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    syncEnabled: false,
    internalToken: 'desktop-session-token'
  });
  const runtime = await startRuntime(config, {
    logger: quietLogger,
    pdfOptions: { mineru: { configured: () => false } }
  });

  try {
    assert.deepEqual(await runtime.pdfReady, { manifests: 1, ready: 1 });
    const document = runtime.db.getPdfDocument(cached.manifest.documentId);
    assert.equal(document.title, '因果推断论文');
    assert.equal(runtime.db.listPdfChunks(cached.manifest.documentId).length, 1);
    const found = runtime.pdfSearch.search('工具变量');
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].pageNumber, 1);
  } finally {
    await runtime.stop({ finalSync: false });
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('PDF 初始化失败可观察但不阻止运行时响应', async () => {
  const warnings = [];
  const failure = new Error('synthetic PDF initialization failure');
  const service = fakePdfService({
    initialize: async () => { throw failure; },
    ready: async () => { throw failure; }
  });
  const ctx = await makeRuntime({}, {
    logger: { log() {}, error() {}, warn(message) { warnings.push(message); } },
    pdfOptions: { instance: service }
  });

  try {
    await assert.rejects(ctx.runtime.pdfReady, /synthetic PDF initialization failure/);
    assert.ok(warnings.some(message => message.includes('[pdf] 初始化失败')));
    const response = await fetch(ctx.runtime.origin, {
      headers: { 'x-workstation-internal-token': 'desktop-session-token' }
    });
    assert.equal(response.status, 200);
  } finally {
    await ctx.runtime.stop({ finalSync: false });
    await fs.rm(ctx.vaultDir, { recursive: true, force: true });
  }
});

test('运行时关闭会中止恢复中的 MinerU 等待并保留 submitted manifest', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-runtime-pdf-stop-'));
  const cached = await writePdfCache(vaultDir, {
    state: 'submitted',
    batchId: 'existing-batch',
    submissionConfirmed: true
  });
  const waiting = deferred();
  let aborted = false;
  const mineru = {
    configured: () => true,
    waitForResult(batchId, { signal }) {
      assert.equal(batchId, 'existing-batch');
      waiting.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => {
          aborted = true;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
  };
  const config = loadConfig({
    vaultDir,
    dbPath: ':memory:',
    syncEnabled: false,
    internalToken: 'desktop-session-token',
    mineruApiToken: 'test-token'
  });
  const runtime = await startRuntime(config, {
    logger: quietLogger,
    pdfOptions: { mineru }
  });
  const origin = runtime.origin;

  try {
    await waiting.promise;
    await runtime.stop({ finalSync: false });
    assert.equal(aborted, true);
    const manifest = JSON.parse(await fs.readFile(path.join(cached.directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.state, 'submitted');
    assert.equal(manifest.submissionConfirmed, true);
    await assert.rejects(fetch(origin), /fetch failed|ECONNREFUSED/);
  } finally {
    await runtime.stop({ finalSync: false }).catch(() => {});
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('索引状态接口需要令牌，并随扫描推进', async () => {
  const { vaultDir, runtime } = await makeRuntime();
  try {
    await runtime.indexReady;

    const forbidden = await fetch(`${runtime.origin}/api/index-status`);
    assert.equal(forbidden.status, 403, '没有令牌一律 403');

    const response = await fetch(`${runtime.origin}/api/index-status`, {
      headers: { 'x-workstation-internal-token': 'desktop-session-token' }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.phase, 'ready');
    assert.equal(typeof payload.notes, 'number');
  } finally {
    await runtime.stop({ finalSync: false });
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('停止之后文件改动不再触发扫描', async () => {
  const { vaultDir, runtime } = await makeRuntime();
  await runtime.indexReady;
  const notesDir = path.join(vaultDir, 'notes', 'research');
  await fs.mkdir(notesDir, { recursive: true });

  await runtime.stop({ finalSync: false });

  // 停掉之后再写文件：不该抛错，也不该有人去动已经关掉的库。
  await fs.writeFile(path.join(notesDir, '停止后.md'), '# 不该被索引');
  await new Promise(resolve => setTimeout(resolve, 500));

  await fs.rm(vaultDir, { recursive: true, force: true });
});
