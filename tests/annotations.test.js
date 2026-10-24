const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  mergeAnnotations,
  parseManagedAnnotations,
  processAnnotation,
  renderLiteratureNote,
  stripMachineDirectives,
  syncLiteratureNote
} = require('../src/annotations');
const { loadAllCards } = require('../src/cards');
const { openDatabase } = require('../src/db');
const { extractTasks } = require('../src/tasks');
const { createIndexer } = require('../src/vault/indexer');
const { readNote, writeNote } = require('../src/vault/note');
const { enqueueNote } = require('../src/vault/note-queue');

function annotation(itemID, text, overrides = {}) {
  return { itemID, text, comment: '', page: '', color: '', sortIndex: String(itemID).padStart(4, '0'), ...overrides };
}

async function setup() {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-annotations-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  return { vaultDir, notesDir, cleanup: () => fs.rm(vaultDir, { recursive: true, force: true }) };
}

test('managed 文献笔记保存稳定身份，机器指令不进入展示文本', () => {
  const raw = renderLiteratureNote({
    item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
    annotations: [annotation(10, '识别策略', { comment: '补制度背景', page: '12' })]
  });
  const records = parseManagedAnnotations(raw);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'ABCD1234:10');
  assert.equal(records[0].status, 'pending');
  assert.doesNotMatch(stripMachineDirectives(raw), /workstation:annotation/);
  assert.match(stripMachineDirectives(raw), /> 识别策略/);
});

test('旧标注区保守迁移，未匹配内容和我的想法原样保留', () => {
  const body = `# 平台定价\n\n## 标注（2 条）\n\n> 识别策略  （p.12）\n\n补制度背景\n\n> 已从 Zotero 删除的旧高亮\n\n旧批注\n\n## 我的想法\n\n这里是我手写的长段落。\n`;
  const result = mergeAnnotations(body, 'ABCD1234', [
    annotation(10, '识别策略', { comment: '补制度背景', page: '12' }),
    annotation(11, '新增高亮')
  ]);

  assert.equal(result.migrated, true);
  assert.equal(result.pending, 2);
  assert.match(result.body, /ABCD1234:10/);
  assert.match(result.body, /ABCD1234:11/);
  assert.match(result.body, /迁移时未匹配的旧标注内容/);
  assert.match(result.body, /已从 Zotero 删除的旧高亮/);
  assert.match(result.body, /这里是我手写的长段落/);

  const second = mergeAnnotations(result.body, 'ABCD1234', [annotation(10, '识别策略', { page: '12' }), annotation(11, '新增高亮')]);
  assert.match(second.body, /已从 Zotero 删除的旧高亮/);
  assert.equal((second.body.match(/ABCD1234:10/g) || []).length, 1);
});

test('增量同步保留 processed 状态、用户章节和 Zotero 暂时缺失的标注', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    const raw = renderLiteratureNote({
      item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
      annotations: [annotation(10, '旧文本'), annotation(11, '会暂时消失')]
    }).replace('## 我的想法\n', '## 我的想法\n\n用户内容。\n');
    await writeNote(ctx.notesDir, notePath, { raw });
    const before = await readNote(ctx.notesDir, notePath);

    const result = await syncLiteratureNote({
      notesDir: ctx.notesDir,
      notePath,
      itemKey: 'ABCD1234',
      annotations: [annotation(10, 'Zotero 更新后的文本'), annotation(12, '新增标注')],
      expectedHash: before.hash
    });
    assert.equal(result.added, 1);
    assert.equal(result.pending, 3);
    assert.match(result.body, /用户内容/);
    assert.match(result.body, /会暂时消失/);
    assert.match(result.body, /Zotero 更新后的文本/);
  } finally {
    await ctx.cleanup();
  }
});

test('加工三类输出幂等，任务机器身份不进入可见标题', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    await writeNote(ctx.notesDir, notePath, {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [annotation(10, '识别策略', { comment: '补制度背景' })]
      })
    });
    let note = await readNote(ctx.notesDir, notePath);
    const payload = {
      vaultDir: ctx.vaultDir,
      notesDir: ctx.notesDir,
      notePath,
      annotationId: 'ABCD1234:10',
      expectedHash: note.hash,
      outputs: {
        note: { title: '工具变量制度背景', body: '需要补充制度背景。' },
        card: { deckFile: 'research', front: '识别策略依赖什么？', back: '外生性。' },
        task: { title: '补充制度背景' }
      }
    };
    const first = await processAnnotation(payload);
    assert.deepEqual(first.outputs, ['note', 'card', 'task']);
    assert.deepEqual(first.writes, {
      notes: ['research/zotero-ABCD1234-10.md', notePath],
      vault: ['cards/research.md']
    });

    note = await readNote(ctx.notesDir, notePath);
    assert.equal(parseManagedAnnotations(note.body)[0].status, 'processed');
    const tasks = extractTasks(stripMachineDirectives(note.body));
    assert.equal(tasks.length, 1);
    assert.doesNotMatch(tasks[0].title, /workstation/);
    assert.match(tasks[0].title, /补充制度背景/);

    const cards = await loadAllCards(ctx.vaultDir);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].back.includes('workstation:'), false);

    const retried = await processAnnotation({ ...payload, expectedHash: note.hash });
    assert.deepEqual(retried.writes, { notes: [], vault: [] });
    assert.equal((await loadAllCards(ctx.vaultDir)).length, 1);
    assert.equal(extractTasks(stripMachineDirectives((await readNote(ctx.notesDir, notePath)).body)).length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('删除 SQLite 后能从 Markdown 重建待处理标注', async () => {
  const ctx = await setup();
  try {
    await writeNote(ctx.notesDir, 'lit/ABCD1234.md', {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [annotation(10, '识别策略')]
      })
    });
    const db = openDatabase(':memory:');
    const indexer = createIndexer({ db, vaultDir: ctx.notesDir });
    await indexer.scan();
    assert.equal(db.listPendingAnnotations().length, 1);
    await indexer.rebuild();
    assert.equal(db.listPendingAnnotations()[0].id, 'ABCD1234:10');
    db.close();
  } finally {
    await ctx.cleanup();
  }
});

test('managed marker 外的手写内容保留，marker 内未知内容拒绝覆盖', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    const raw = renderLiteratureNote({
      item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
      annotations: [annotation(10, '识别策略')]
    }).replace('<!-- workstation:annotations:v1 begin -->', 'marker 前手写说明。\n\n<!-- workstation:annotations:v1 begin -->')
      .replace('<!-- workstation:annotations:v1 end -->', '<!-- workstation:annotations:v1 end -->\n\nmarker 后手写说明。');
    await writeNote(ctx.notesDir, notePath, { raw });
    let note = await readNote(ctx.notesDir, notePath);
    await syncLiteratureNote({
      notesDir: ctx.notesDir,
      notePath,
      itemKey: 'ABCD1234',
      annotations: [annotation(10, '更新文本'), annotation(11, '新增标注')],
      expectedHash: note.hash
    });
    note = await readNote(ctx.notesDir, notePath);
    assert.match(note.body, /marker 前手写说明/);
    assert.match(note.body, /marker 后手写说明/);

    await writeNote(ctx.notesDir, notePath, {
      raw: note.raw.replace('<!-- workstation:annotations:v1 begin -->', '<!-- workstation:annotations:v1 begin -->\n这里是 marker 内手写内容。')
    });
    note = await readNote(ctx.notesDir, notePath);
    await assert.rejects(syncLiteratureNote({
      notesDir: ctx.notesDir,
      notePath,
      itemKey: 'ABCD1234',
      annotations: [annotation(12, '不能覆盖')],
      expectedHash: note.hash
    }), error => error.status === 409 && /手写/.test(error.message));
    assert.match((await readNote(ctx.notesDir, notePath)).body, /marker 内手写内容/);
  } finally {
    await ctx.cleanup();
  }
});

test('部分失败保留 pending，重试复用已创建输出且不重复', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    await writeNote(ctx.notesDir, notePath, {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [annotation(10, '识别策略')]
      })
    });
    await fs.writeFile(path.join(ctx.vaultDir, 'cards'), '阻止建立 cards 目录', 'utf8');
    let note = await readNote(ctx.notesDir, notePath);
    const payload = {
      vaultDir: ctx.vaultDir,
      notesDir: ctx.notesDir,
      notePath,
      annotationId: 'ABCD1234:10',
      expectedHash: note.hash,
      outputs: {
        note: { title: '制度背景', body: '永久内容。' },
        card: { deckFile: 'research', front: '识别策略？', back: '外生性。' }
      }
    };
    await assert.rejects(processAnnotation(payload), error => {
      assert.deepEqual(error.completedOutputs, ['note']);
      assert.deepEqual(error.writes, {
        notes: ['research/zotero-ABCD1234-10.md'],
        vault: []
      });
      return true;
    });
    assert.equal(parseManagedAnnotations((await readNote(ctx.notesDir, notePath)).body)[0].status, 'pending');

    await fs.rm(path.join(ctx.vaultDir, 'cards'));
    note = await readNote(ctx.notesDir, notePath);
    await processAnnotation({ ...payload, expectedHash: note.hash });
    assert.equal((await loadAllCards(ctx.vaultDir)).length, 1);
    assert.equal(parseManagedAnnotations((await readNote(ctx.notesDir, notePath)).body)[0].status, 'processed');
  } finally {
    await ctx.cleanup();
  }
});

test('expected hash 冲突拒绝覆盖用户并发编辑', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    await writeNote(ctx.notesDir, notePath, {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [annotation(10, '识别策略')]
      })
    });
    const old = await readNote(ctx.notesDir, notePath);
    await writeNote(ctx.notesDir, notePath, { raw: `${old.raw}\n用户抢先编辑。\n` });
    await assert.rejects(syncLiteratureNote({
      notesDir: ctx.notesDir,
      notePath,
      itemKey: 'ABCD1234',
      annotations: [annotation(11, '新增')],
      expectedHash: old.hash
    }), error => error.status === 409);
    assert.match((await readNote(ctx.notesDir, notePath)).raw, /用户抢先编辑/);
  } finally {
    await ctx.cleanup();
  }
});

test('标注同步在队列内重读，排在编辑器保存后会返回 409', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    await writeNote(ctx.notesDir, notePath, {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [annotation(10, '识别策略')]
      })
    });
    const old = await readNote(ctx.notesDir, notePath);
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const editorSave = enqueueNote(ctx.notesDir, notePath, async () => {
      entered();
      await gate;
      await writeNote(ctx.notesDir, notePath, { raw: `${old.raw}\n编辑器保存的新正文。\n` });
    });
    await started;

    const sync = syncLiteratureNote({
      notesDir: ctx.notesDir,
      notePath,
      itemKey: 'ABCD1234',
      annotations: [annotation(11, '不应写入')],
      expectedHash: old.hash
    });
    release();
    await editorSave;
    await assert.rejects(sync, error => error.status === 409);
    const current = await readNote(ctx.notesDir, notePath);
    assert.match(current.raw, /编辑器保存的新正文/);
    assert.doesNotMatch(current.raw, /不应写入/);
  } finally {
    await ctx.cleanup();
  }
});

test('永久笔记创建与普通笔记写入共享目标路径队列', async () => {
  const ctx = await setup();
  try {
    const notePath = 'lit/ABCD1234.md';
    const permanentPath = 'research/zotero-ABCD1234-10.md';
    await writeNote(ctx.notesDir, notePath, {
      raw: renderLiteratureNote({
        item: { key: 'ABCD1234', title: '平台定价', creators: [], tags: [] },
        annotations: [annotation(10, '识别策略')]
      })
    });
    const source = await readNote(ctx.notesDir, notePath);
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const ordinaryWrite = enqueueNote(ctx.notesDir, permanentPath, async () => {
      entered();
      await gate;
      await writeNote(ctx.notesDir, permanentPath, {
        data: { title: '用户笔记' },
        body: '# 用户先创建的内容'
      });
    });
    await started;

    let settled = false;
    const processing = processAnnotation({
      vaultDir: ctx.vaultDir,
      notesDir: ctx.notesDir,
      notePath,
      annotationId: 'ABCD1234:10',
      expectedHash: source.hash,
      outputs: { note: { title: '制度背景', body: '自动生成内容。' } }
    }).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, '永久笔记创建必须等待同一路径上的普通写入');

    release();
    await ordinaryWrite;
    await assert.rejects(processing, error => error.status === 409);
    const permanent = await readNote(ctx.notesDir, permanentPath);
    assert.equal(permanent.data.title, '用户笔记');
    assert.match(permanent.body, /用户先创建的内容/);
    assert.equal(parseManagedAnnotations((await readNote(ctx.notesDir, notePath)).body)[0].status, 'pending');
  } finally {
    await ctx.cleanup();
  }
});
