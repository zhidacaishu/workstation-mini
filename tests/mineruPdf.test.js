const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  API_BASE,
  MAX_PDF_BYTES,
  MAX_ZIP_BYTES,
  createMineruClient,
  safeMessage,
  wait
} = require('../src/integrations/mineru');
const {
  MAX_ENTRY_BYTES,
  candidate,
  readMineruArchive,
  safeEntryName
} = require('../src/pdf/archive');
const {
  MAX_CHUNK_LENGTH,
  htmlTableToMarkdown,
  parseContentList,
  splitLongText,
  stripMarkup
} = require('../src/pdf/content');
const {
  FALLBACK_QUERY_MAX_LENGTH,
  MAX_PER_DOCUMENT,
  createPdfSearch
} = require('../src/pdf/search');
const { openDatabase } = require('../src/db');
const { tokenizeToText } = require('../src/segment');

function jsonResponse(value, { status = 200 } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const source of entries) {
    const name = Buffer.isBuffer(source.name) ? source.name : Buffer.from(source.name, 'utf8');
    const body = Buffer.isBuffer(source.body) ? source.body : Buffer.from(source.body || '', 'utf8');
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(source.declaredSize ?? body.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(source.declaredSize ?? body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((source.externalAttributes ?? 0) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function withTempDir(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mineru-test-'));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writeZip(directory, entries) {
  const target = path.join(directory, 'result.zip');
  await fs.writeFile(target, zipBuffer(entries));
  return target;
}

const contentList = [
  { type: 'title', text: '识别策略', page_idx: 0 },
  { type: 'text', text: '工具变量用于处理内生性。', page_idx: 0 },
  { type: 'text', text: '第二页讨论稳健性检验。', page_idx: 1 }
];

test('MinerU v4 创建任务仅在 API 请求携带 Bearer Token', async () => {
  const calls = [];
  const client = createMineruClient({
    token: 'secret-test-token',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (options.method === 'POST') {
        return jsonResponse({
          code: 0,
          data: {
            batch_id: 'batch_1',
            file_urls: ['https://uploads.example.test/signed.pdf?signature=hidden']
          }
        });
      }
      return new Response('', { status: 200 });
    }
  });

  const task = await client.createTask({ fileName: 'paper.pdf', dataId: 'doc-1' });
  assert.deepEqual(task, {
    batchId: 'batch_1',
    uploadUrl: 'https://uploads.example.test/signed.pdf?signature=hidden'
  });
  assert.equal(calls[0].url, `${API_BASE}/file-urls/batch`);
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-test-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    files: [{ name: 'paper.pdf', data_id: 'doc-1' }],
    model_version: 'vlm'
  });

  await withTempDir(async directory => {
    const pdf = path.join(directory, 'paper.pdf');
    await fs.writeFile(pdf, '%PDF-test');
    await client.uploadFile({
      uploadUrl: task.uploadUrl,
      filePath: pdf,
      size: 9
    });
  });
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.deepEqual(calls[1].options.headers, { 'content-length': '9' });
});

test('MinerU 客户端拒绝非 HTTPS 地址、越界大小和无效 batch ID', async () => {
  const insecureCreate = createMineruClient({
    token: 'token',
    fetchImpl: async () => jsonResponse({
      code: 0,
      data: { batch_id: 'batch', file_urls: ['http://uploads.example.test/file'] }
    })
  });
  await assert.rejects(
    insecureCreate.createTask({ fileName: 'paper.pdf', dataId: 'doc' }),
    /上传地址不是 HTTPS/
  );

  const client = createMineruClient({ token: 'token', fetchImpl: async () => new Response() });
  await assert.rejects(
    client.uploadFile({ uploadUrl: 'https://example.test', filePath: 'missing', size: MAX_PDF_BYTES + 1 }),
    /200 MB/
  );
  await assert.rejects(client.result('../batch'), /batch ID 无效/);
  await assert.rejects(
    client.downloadResult({ zipUrl: 'http://example.test/result.zip', targetPath: 'unused' }),
    /不是 HTTPS/
  );
});

test('MinerU 状态轮询传播进度、接受未知进行态并处理终态失败', async () => {
  const states = [
    { state: 'queued_remote', extract_progress: { extracted_pages: 1, total_pages: 3 } },
    { state: 'running', extract_progress: { extracted_pages: 2, total_pages: 3 } },
    { state: 'done', extract_progress: { extracted_pages: 3, total_pages: 3 }, full_zip_url: 'https://results.example.test/result.zip' }
  ];
  const progress = [];
  let sleeps = 0;
  const client = createMineruClient({
    token: 'token',
    pollIntervalMs: 1,
    sleep: async () => { sleeps += 1; },
    fetchImpl: async () => jsonResponse({
      code: 0,
      data: { extract_result: [states.shift()] }
    })
  });
  const result = await client.waitForResult('batch_1', {
    onProgress: status => progress.push(status)
  });
  assert.deepEqual(progress.map(entry => entry.state), ['queued_remote', 'running', 'done']);
  assert.deepEqual(progress[0].progress, { extractedPages: 1, totalPages: 3 });
  assert.equal(sleeps, 2);
  assert.equal(result.zipUrl, 'https://results.example.test/result.zip');

  const failed = createMineruClient({
    token: 'token',
    fetchImpl: async () => jsonResponse({
      code: 0,
      data: {
        extract_result: [{
          state: 'failed',
          err_msg: 'failed at https://signed.example.test/file Bearer leaked /Users/person/private.pdf'
        }]
      }
    })
  });
  await assert.rejects(failed.result('batch_2'), error => {
    assert.doesNotMatch(error.message, /signed\.example|leaked|\/Users\/person/);
    assert.match(error.message, /\[地址\]/);
    assert.match(error.message, /\[路径\]/);
    return true;
  });
});

// 这条测试守的正是「不会无限轮询」。node:test 的 { timeout } 在这里靠不住：
// 它只是把测试判失败，并不会终止那个还在自旋的 Promise，进程照样不退出，CI
// 还是挂死。所以让 stub 自己设一个硬上限 —— 真退化了会抛错，测试立刻变红。
const MAX_TEST_POLLS = 5_000;

test('MinerU 轮询有等待上限并逐步退避，不会永远占住解析队列', async () => {
  const intervals = [];
  let clock = 0;
  const client = createMineruClient({
    token: 'token',
    pollIntervalMs: 1_000,
    maxPollIntervalMs: 4_000,
    pollDeadlineMs: 60_000,
    sleep: async milliseconds => {
      intervals.push(milliseconds);
      clock += milliseconds;
      if (intervals.length > MAX_TEST_POLLS) {
        throw new Error(`轮询已经跑了 ${intervals.length} 轮还没有上限，等待时限失效了`);
      }
    },
    fetchImpl: async () => jsonResponse({
      code: 0,
      data: { extract_result: [{ state: 'running' }] }
    })
  });

  // Date.now 不动的话到不了 deadline，这里让它跟着 sleep 走。
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + clock;
  try {
    await assert.rejects(client.waitForResult('batch'), /超过等待上限/);
  } finally {
    Date.now = realNow;
  }

  assert.ok(intervals.length > 1, '应当轮询多轮后才放弃');
  assert.equal(intervals[0], 1_000);
  assert.ok(
    intervals[1] > intervals[0],
    `退避没有生效：${intervals.slice(0, 3).join(', ')}`
  );
  assert.equal(Math.max(...intervals), 4_000, '退避不应超过上限');
});

test('空文件的报错说的是空文件，不是体积超限', async () => {
  const client = createMineruClient({ token: 'token', fetchImpl: async () => new Response() });
  await assert.rejects(
    client.uploadFile({ uploadUrl: 'https://example.test', filePath: 'missing', size: 0 }),
    /空文件/
  );
});

test('MinerU API 错误不泄漏远端消息中的地址、凭据和本机路径', async () => {
  const client = createMineruClient({
    token: 'top-secret',
    fetchImpl: async () => jsonResponse({
      code: 400,
      msg: 'Bearer top-secret https://signed.example.test/a /private/tmp/source.pdf'
    })
  });
  await assert.rejects(client.createTask({ fileName: 'paper.pdf', dataId: 'doc' }), error => {
    assert.equal(error.message, 'Bearer [已隐藏] [地址] [路径]');
    return true;
  });
  assert.equal(
    safeMessage('open C:\\Users\\person\\paper.pdf or /Volumes/Vault/a.pdf'),
    'open [路径] or [路径]'
  );
});

test('MinerU 下载限制声明大小并在流式越界或中止时清理半文件', async () => {
  await withTempDir(async directory => {
    const declaredTarget = path.join(directory, 'declared.zip');
    const declared = createMineruClient({
      token: 'token',
      fetchImpl: async () => new Response('x', {
        headers: { 'content-length': String(MAX_ZIP_BYTES + 1) }
      })
    });
    await assert.rejects(
      declared.downloadResult({ zipUrl: 'https://results.example.test/a.zip', targetPath: declaredTarget }),
      /压缩包过大/
    );
    await assert.rejects(fs.access(declaredTarget));

    const originalLimit = MAX_ZIP_BYTES;
    const oversizedBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(originalLimit));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      }
    });
    const streamedTarget = path.join(directory, 'streamed.zip');
    const streamed = createMineruClient({
      token: 'token',
      fetchImpl: async () => new Response(oversizedBody)
    });
    await assert.rejects(
      streamed.downloadResult({ zipUrl: 'https://results.example.test/b.zip', targetPath: streamedTarget }),
      /压缩包过大/
    );
    await assert.rejects(fs.access(streamedTarget));

    const controller = new AbortController();
    const abortBody = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('partial'));
      },
      cancel() {}
    });
    const abortedTarget = path.join(directory, 'aborted.zip');
    const aborted = createMineruClient({
      token: 'token',
      fetchImpl: async () => new Response(abortBody)
    });
    const operation = aborted.downloadResult({
      zipUrl: 'https://results.example.test/c.zip',
      targetPath: abortedTarget,
      signal: controller.signal
    });
    controller.abort();
    await assert.rejects(operation, error => error.name === 'AbortError');
    await assert.rejects(fs.access(abortedTarget));
  });
});

test('MinerU wait 可被 AbortSignal 立即终止', async () => {
  const controller = new AbortController();
  const operation = wait(60_000, controller.signal);
  controller.abort();
  await assert.rejects(operation, error => error.name === 'AbortError');
});

test('ZIP 路径和候选选择只接受规范的 MinerU 结果名', () => {
  assert.equal(safeEntryName('batch/full.md'), 'batch/full.md');
  for (const unsafe of ['../full.md', '/full.md', 'C:\\full.md', 'a/./full.md', 'a/../full.md', 'x\0y']) {
    assert.equal(safeEntryName(unsafe), '');
  }
  assert.deepEqual(candidate('batch/full.md'), { type: 'markdown', priority: 2 });
  assert.deepEqual(candidate('batch/paper_content_list.json'), { type: 'contentList', priority: 1 });
  assert.equal(candidate('batch/image.png'), null);
});

test('ZIP 读取带目录的结果且跳过未使用文件', async () => {
  await withTempDir(async directory => {
    const archive = await writeZip(directory, [
      { name: 'batch/images/page.png', body: 'not retained' },
      { name: 'batch/full.md', body: '# 论文\n\n工具变量。' },
      { name: 'batch/content_list.json', body: JSON.stringify(contentList) }
    ]);
    const result = await readMineruArchive(archive);
    assert.equal(result.markdown, '# 论文\n\n工具变量。');
    assert.deepEqual(result.contentList, contentList);
    assert.equal(result.contentListText, JSON.stringify(contentList));
  });
});

test('ZIP 拒绝穿越、符号链接、重复结果与缺失文件', async () => {
  await withTempDir(async directory => {
    const cases = [
      {
        entries: [
          { name: '../full.md', body: 'bad' },
          { name: 'content_list.json', body: '[]' }
        ],
        message: /不安全路径|invalid relative path/
      },
      {
        entries: [
          { name: 'full.md', body: 'bad', externalAttributes: 0xa000 << 16 },
          { name: 'content_list.json', body: '[]' }
        ],
        message: /符号链接/
      },
      {
        entries: [
          { name: 'a/full.md', body: 'one' },
          { name: 'b/full.md', body: 'two' },
          { name: 'content_list.json', body: '[]' }
        ],
        message: /重复的 Markdown/
      },
      {
        entries: [{ name: 'full.md', body: 'only markdown' }],
        message: /缺少 Markdown 或 content_list/
      }
    ];
    for (const [index, fixture] of cases.entries()) {
      const target = path.join(directory, `case-${index}.zip`);
      await fs.writeFile(target, zipBuffer(fixture.entries));
      await assert.rejects(readMineruArchive(target), fixture.message);
    }
  });
});

test('ZIP 拒绝超大声明、无效 UTF-8、空 Markdown 和无效 JSON', async () => {
  await withTempDir(async directory => {
    const cases = [
      {
        entries: [
          { name: 'full.md', body: 'body', declaredSize: MAX_ENTRY_BYTES + 1 },
          { name: 'content_list.json', body: '[]' }
        ],
        message: /条目解压后过大|size mismatch/
      },
      {
        entries: [
          { name: 'full.md', body: Buffer.from([0xc3, 0x28]) },
          { name: 'content_list.json', body: '[]' }
        ],
        message: /有效 UTF-8/
      },
      {
        entries: [
          { name: 'full.md', body: '  \n' },
          { name: 'content_list.json', body: '[]' }
        ],
        message: /Markdown 为空/
      },
      {
        entries: [
          { name: 'full.md', body: 'body' },
          { name: 'content_list.json', body: '{bad' }
        ],
        message: /无法解析/
      }
    ];
    for (const [index, fixture] of cases.entries()) {
      const target = path.join(directory, `invalid-${index}.zip`);
      await fs.writeFile(target, zipBuffer(fixture.entries));
      await assert.rejects(readMineruArchive(target), fixture.message);
    }
  });
});

test('content_list 支持包装结构、正文类型、忽略块与可靠页码', () => {
  const wrapped = {
    content_list: [
      { type: 'header', text: '每页页眉', page_idx: 0 },
      { type: 'title', text: '方法', page_idx: 0 },
      { type: 'text', text: '第一段', page_idx: 0 },
      { type: 'list', list_items: ['条件一', '条件二'], page_idx: 0 },
      { type: 'equation', latex: 'x = zβ', page_idx: 0 },
      { type: 'table', table_caption: '结果表', table_body: '<table><tr><td>0.42</td></tr></table>', page_idx: 1 },
      { type: 'figure', figure_caption: ['识别图'], footnote: '置信区间', page_idx: 1 },
      { type: 'page_number', text: '2', page_idx: 1 }
    ]
  };
  const result = parseContentList(wrapped);
  assert.equal(result.pageCount, 2);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.chunks[0].pageIndex, 0);
  assert.equal(result.chunks[0].heading, '方法');
  assert.match(result.chunks[0].body, /条件一/);
  assert.match(result.chunks[0].markdown, /\$\$/);
  assert.equal(result.chunks[1].pageIndex, 1);
  assert.match(result.chunks[1].body, /结果表/);
  assert.match(result.chunks[1].body, /识别图/);
  assert.doesNotMatch(result.chunks[1].body, /每页页眉|page_number/);
  assert.equal(stripMarkup('[结果](https://example.test) **显著**'), '结果 显著');
});

test('content_list 分块稳定且绝不跨页', () => {
  const entries = [
    { type: 'heading', text: '标题', page_idx: 0 },
    { type: 'text', text: 'a'.repeat(30), page_idx: 0 },
    { type: 'text', text: 'b'.repeat(30), page_idx: 0 },
    { type: 'text', text: 'c'.repeat(10), page_idx: 1 }
  ];
  const first = parseContentList(entries, { maxChunkLength: 40 });
  const second = parseContentList(entries, { maxChunkLength: 40 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.chunks.map(chunk => chunk.pageIndex), [0, 0, 1]);
  assert.deepEqual(first.chunks.map(chunk => chunk.chunkIndex), [0, 1, 2]);
  assert.ok(MAX_CHUNK_LENGTH >= 1_000);
});

test('content_list 拒绝无页码、未知根结构和空正文', () => {
  assert.throws(
    () => parseContentList([{ type: 'text', text: '正文' }]),
    /缺少可靠的 page_idx/
  );
  assert.throws(() => parseContentList({ nope: [] }), /结构无法识别/);
  assert.throws(
    () => parseContentList([{ type: 'header', text: '页眉', page_idx: 0 }]),
    /没有可索引的 PDF 正文/
  );
});

function pdfRecord({ body = '计量经济学中的工具变量方法。', hash = 'a'.repeat(64) } = {}) {
  return {
    documentId: '0123456789abcdef0123456789abcdef',
    libraryId: '1',
    attachmentKey: 'ATTACH1',
    parentKey: 'PARENT1',
    title: '因果推断论文',
    fileName: 'paper.pdf',
    sourceSha256: hash,
    cachePath: '.workstation/mineru/1/ATTACH1',
    pageCount: 2,
    indexedAt: '2026-08-30T00:00:00.000Z',
    titleTokens: tokenizeToText('因果推断论文'),
    chunks: [
      {
        chunkIndex: 0,
        pageIndex: 0,
        heading: '方法',
        body,
        markdown: body,
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
  };
}

test('MinerU 的 HTML 表格翻成 GFM 管道表，而不是转义后的标签源码', () => {
  const result = parseContentList([{
    type: 'table',
    table_caption: '回归结果',
    table_body: '<table><thead><tr><th>变量</th><th>系数</th></tr></thead>'
      + '<tbody><tr><td>x</td><td>0.42</td></tr></tbody></table>',
    page_idx: 0
  }]);
  const { markdown, body } = result.chunks[0];
  assert.match(markdown, /^\| 变量 \| 系数 \|$/m);
  assert.match(markdown, /^\| --- \| --- \|$/m);
  assert.match(markdown, /^\| x \| 0\.42 \|$/m);
  assert.doesNotMatch(markdown, /<table|<td|<tr/i);
  // 索引用的正文仍然是纯文本，不带管道和标签。
  assert.match(body, /回归结果/);
  assert.match(body, /0\.42/);
  assert.doesNotMatch(body, /<|\|/);

  // colspan 补空位，单元格里的竖线要转义，实体要解码。
  assert.match(
    htmlTableToMarkdown('<table><tr><td colspan="2">合计</td></tr><tr><td>a|b</td><td>&amp;</td></tr></table>'),
    /\| 合计 \|  \|\n\| --- \| --- \|\n\| a\\\|b \| & \|/
  );
  // 不是 HTML 就别乱动：有些 MinerU 版本直接给管道表。
  assert.equal(htmlTableToMarkdown('| a | b |'), '');
});

test('超长正文块被切开，结构化块保持完整', () => {
  const sentence = '这是一句用来撑长度的中文。';
  const long = parseContentList(
    [{ type: 'text', text: sentence.repeat(60), page_idx: 0 }],
    { maxChunkLength: 200 }
  );
  assert.ok(long.chunks.length > 1, '超长文本块必须被切成多块');
  for (const chunk of long.chunks) {
    assert.ok(chunk.body.length <= 200, `切完仍超限：${chunk.body.length}`);
    assert.equal(chunk.pageIndex, 0);
  }
  // 切点落在句末，不会把句子劈成两半。
  assert.ok(long.chunks[0].body.endsWith('。'));
  assert.equal(long.chunks.map(chunk => chunk.body).join(''), sentence.repeat(60));

  // 表格是结构化的，宁可超长也不能从中间切断。
  const table = parseContentList(
    [{ type: 'table', table_body: `<table><tr><td>${'x'.repeat(900)}</td></tr></table>`, page_idx: 0 }],
    { maxChunkLength: 200 }
  );
  assert.equal(table.chunks.length, 1);
  assert.match(table.chunks[0].markdown, /^\| x{900} \|$/m);

  assert.deepEqual(splitLongText('短的', 100), ['短的']);
});

test('个别块缺页码只跳过它自己，过半才判定格式变了', () => {
  const partial = parseContentList([
    { type: 'text', text: '第一页正文', page_idx: 0 },
    { type: 'text', text: '页码丢了的块' },
    { type: 'text', text: '第二页正文', page_idx: 1 }
  ]);
  assert.equal(partial.skippedBlocks, 1);
  assert.deepEqual(partial.chunks.map(chunk => chunk.pageIndex), [0, 1]);
  assert.equal(partial.pageCount, 2);

  assert.throws(
    () => parseContentList([
      { type: 'text', text: '坏一' },
      { type: 'text', text: '坏二' },
      { type: 'text', text: '好', page_idx: 0 }
    ]),
    /过半正文块缺少可靠的 page_idx/
  );

  // 边界：一半一半也算格式变了。半篇论文被静默丢掉比直接失败更糟。
  assert.throws(
    () => parseContentList([
      { type: 'text', text: '好一', page_idx: 0 },
      { type: 'text', text: '好二', page_idx: 1 },
      { type: 'text', text: '坏一' },
      { type: 'text', text: '坏二' }
    ]),
    /过半正文块缺少可靠的 page_idx/
  );
});

test('畸形表格不会把事件循环卡住，也不会切开代理对', () => {
  // 标签不闭合的超长串：配对式正则在这里是平方复杂度，一份文献就能让
  // initialize() 停摆好几秒。
  const malformed = `<table><tr>${'<td>x'.repeat(49_000)}</tr></table>`;
  const started = process.hrtime.bigint();
  const converted = htmlTableToMarkdown(malformed);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < 1_000, `畸形表格耗时 ${elapsed.toFixed(0)}ms，说明退化成了平方复杂度`);
  assert.ok(converted.length > 0, '不闭合的单元格也该拿到内容，而不是白烧一遍');

  assert.equal(htmlTableToMarkdown(`<table><tr>${'<tr>'.repeat(20_000)}</table>`), '');

  // emoji 和部分生僻字是两个 code unit，从中间切开会得到非法 UTF-16。
  const parts = splitLongText('🙂'.repeat(30), 11);
  const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(parts.every(part => !lonely.test(part)), '切分产生了孤立的代理项');
  assert.equal(parts.join(''), '🙂'.repeat(30));
});

test('PDF 派生索引事务替换文档、chunks 和 FTS', () => {
  const db = openDatabase(':memory:');
  try {
    db.replacePdfDocument(pdfRecord());
    assert.equal(db.listPdfDocuments().length, 1);
    assert.deepEqual(db.listPdfChunks('0123456789abcdef0123456789abcdef').map(row => row.pageIndex), [0, 1]);

    db.replacePdfDocument(pdfRecord({ body: '替换后的断点回归正文。', hash: 'b'.repeat(64) }));
    assert.equal(db.listPdfDocuments().length, 1);
    assert.equal(db.listPdfChunks('0123456789abcdef0123456789abcdef').length, 2);
    assert.match(db.listPdfChunks('0123456789abcdef0123456789abcdef')[0].body, /断点回归/);
    assert.equal(db.raw.prepare('SELECT count(*) AS count FROM pdf_chunks_fts').get().count, 2);

    db.removePdfDocument('0123456789abcdef0123456789abcdef');
    assert.equal(db.listPdfDocuments().length, 0);
    assert.equal(db.raw.prepare('SELECT count(*) AS count FROM pdf_chunks').get().count, 0);
    assert.equal(db.raw.prepare('SELECT count(*) AS count FROM pdf_chunks_fts').get().count, 0);
  } finally {
    db.close();
  }
});

test('PDF 搜索返回中文 FTS、原文片段、页码和子串兜底', () => {
  const db = openDatabase(':memory:');
  try {
    db.replacePdfDocument(pdfRecord());
    const search = createPdfSearch(db);
    const fts = search.search('工具变量');
    assert.equal(fts.results.length, 1);
    assert.equal(fts.results[0].via, 'fts');
    assert.equal(fts.results[0].pageNumber, 1);
    assert.match(fts.results[0].snippet, /工具变量/);
    assert.doesNotMatch(fts.results[0].snippet, /工 具/);

    const withoutFallback = search.search('量经', { includeFallback: false });
    assert.equal(withoutFallback.results.length, 0);
    assert.equal(withoutFallback.usedFallback, false);

    const fallback = search.search('量经');
    assert.equal(fallback.results.length, 1);
    assert.equal(fallback.results[0].via, 'like');
    assert.equal(fallback.usedFallback, true);
    assert.deepEqual(search.search('  '), { query: '', results: [], usedFallback: false });
  } finally {
    db.close();
  }
});

function multiChunkRecord({ documentId, title, bodies }) {
  return {
    documentId,
    libraryId: '1',
    attachmentKey: `K${documentId.slice(0, 6)}`,
    parentKey: 'PARENT1',
    title,
    fileName: `${documentId}.pdf`,
    sourceSha256: 'b'.repeat(64),
    cachePath: `.workstation/mineru/1/${documentId}`,
    pageCount: bodies.length,
    indexedAt: '2026-08-30T00:00:00.000Z',
    titleTokens: tokenizeToText(title),
    chunks: bodies.map((body, index) => ({
      chunkIndex: index,
      pageIndex: index,
      heading: '',
      body,
      markdown: body,
      headingTokens: '',
      bodyTokens: tokenizeToText(body)
    }))
  };
}

test('RAG 召回按文献限量，不让一篇长文吃掉全部名额', () => {
  const db = openDatabase(':memory:');
  try {
    // title 在 FTS 里每个 chunk 都重复一份：问句带上标题词时这篇会整体上浮。
    // 40 块的长文：它足以包揽 bm25 排行前几十名。配额如果只是「多取几条再在
    // JS 里筛」，其它文献根本进不了候选窗口，最后返回的条数反而更少。
    db.replacePdfDocument(multiChunkRecord({
      documentId: '1'.repeat(32),
      title: '平台治理政策评估',
      bodies: Array.from({ length: 40 }, (unused, index) => `平台治理的第 ${index} 节讨论。`)
    }));
    db.replacePdfDocument(multiChunkRecord({
      documentId: '2'.repeat(32),
      title: '另一篇平台研究',
      bodies: ['平台治理在另一篇论文里的处理方式。', '平台治理的补充讨论。']
    }));
    db.replacePdfDocument(multiChunkRecord({
      documentId: '3'.repeat(32),
      title: '第三篇平台论文',
      bodies: ['平台治理的第三种视角。', '平台治理的实证结果。']
    }));
    const search = createPdfSearch(db);

    const retrieved = search.retrieve('平台治理政策评估', { limit: 6, includeFallback: false });
    const perDocument = new Map();
    for (const row of retrieved.results) {
      perDocument.set(row.documentId, (perDocument.get(row.documentId) || 0) + 1);
    }
    for (const [id, count] of perDocument) {
      assert.ok(count <= MAX_PER_DOCUMENT, `${id} 贡献了 ${count} 块，超过上限`);
    }
    // 关键断言：名额必须被真正填满，而不是被长文挤空。
    assert.equal(retrieved.results.length, 6, '配额腾出来的名额应当由其它文献补上');
    assert.equal(perDocument.size, 3, '三篇文献都该出现在召回里');

    // 显式的全文搜索不受配额影响：用户自己敲的词，命中什么都该看得见。
    const searched = search.search('平台治理政策评估', { limit: 20, includeFallback: false });
    assert.ok(
      searched.results.filter(row => row.documentId === '1'.repeat(32)).length > MAX_PER_DOCUMENT,
      '专用搜索不应该限制单篇条数'
    );
  } finally {
    db.close();
  }
});

test('RAG 召回用相对分数下限挡掉蹭词的弱命中', () => {
  const db = openDatabase(':memory:');
  try {
    db.replacePdfDocument(multiChunkRecord({
      documentId: '3'.repeat(32),
      title: '无关标题',
      bodies: [
        '双重差分依赖平行趋势假设，平行趋势检验是双重差分的核心。',
        '本节讨论问卷的抽样与回收，只是顺带提了一次趋势。'
      ]
    }));
    const search = createPdfSearch(db);

    const strong = search.retrieve('双重差分的平行趋势怎么检验', {
      limit: 6,
      includeFallback: false
    });
    assert.equal(strong.results.length, 1, '蹭到「趋势」的弱命中应当被挡在外面');
    assert.equal(strong.results[0].chunkIndex, 0);

    // 关掉下限就会把弱命中放进来 —— 说明差别确实来自这条规则。
    const unfiltered = search.retrieve('双重差分的平行趋势怎么检验', {
      limit: 6,
      includeFallback: false,
      relevanceRatio: 0
    });
    assert.equal(unfiltered.results.length, 2);
  } finally {
    db.close();
  }
});

test('整句问句不再做全表子串兜底，短词查询仍然兜底', () => {
  const db = openDatabase(':memory:');
  try {
    db.replacePdfDocument(pdfRecord({ body: '第三章计量经济学的工具变量方法。' }));
    const search = createPdfSearch(db);

    // 「量经」跨了分词边界，FTS 命中不了，只能靠子串。
    const short = search.retrieve('量经', { limit: 6 });
    assert.ok(short.usedFallback, '短词查询应当继续走子串兜底');
    assert.equal(short.results[0].via, 'like');
    assert.ok('量经'.length <= FALLBACK_QUERY_MAX_LENGTH);

    const sentence = '请问这本教材的第三章讲的是什么方法';
    assert.ok(sentence.length > FALLBACK_QUERY_MAX_LENGTH);
    assert.equal(search.retrieve(sentence, { limit: 6 }).usedFallback, false);
    // 显式关掉时，短词查询也不兜底。
    assert.equal(
      search.retrieve('量经', { limit: 6, includeFallback: false }).usedFallback,
      false
    );
    // 门控只是默认值，不是硬禁止：显式打开时长查询照样会走兜底。
    // 用一个长单词的中段做查询 —— 分词切不出这个 token，只有子串能命中。
    db.replacePdfDocument(pdfRecord({ body: 'supercalifragilisticexpialidocious 是个长词。' }));
    const buried = 'califragilisticexpiali';
    assert.ok(buried.length > FALLBACK_QUERY_MAX_LENGTH);
    assert.equal(search.retrieve(buried, { limit: 6 }).usedFallback, false, '默认应当按长度关掉');
    const forced = search.retrieve(buried, { limit: 6, includeFallback: true });
    assert.equal(forced.usedFallback, true, '显式打开时仍然兜底');
    assert.equal(forced.results[0].via, 'like');
  } finally {
    db.close();
  }
});

test('PDF RAG 使用宽松 BM25，但专用搜索继续严格匹配', () => {
  const db = openDatabase(':memory:');
  try {
    db.replacePdfDocument(pdfRecord());
    const search = createPdfSearch(db);
    const question = '请问工具变量如何处理内生性';

    assert.equal(search.search(question, { includeFallback: false }).results.length, 0);
    const retrieved = search.retrieve(question, { includeFallback: false });
    assert.equal(retrieved.results.length, 2);
    assert.deepEqual(retrieved.results.map(result => result.via), ['fts', 'fts']);
    assert.equal(retrieved.results[0].chunkIndex, 0);

    for (const unsafe of ['A AND B', 'NOT', 'OR', 'foo*', '(bar)', 'said "hi"']) {
      assert.doesNotThrow(() => search.retrieve(unsafe, { includeFallback: false }));
    }
  } finally {
    db.close();
  }
});
