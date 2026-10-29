// 代码检查后修复的一批问题的回归测试：每条都对应一个曾经复现过的现象。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { writeNote } = require('../src/vault/note');
const { renderMarkdown } = require('../src/markdown');
const { VAULT_GITIGNORE } = require('../src/sync');

const FIXED_NOW = new Date(2026, 9, 28, 10, 0);

async function setup(t, { readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-maintenance-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false, readOnly });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db), now: () => FIXED_NOW });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config, db, indexer, vaultDir };
}

test('今日页「今天需要处理」只列逾期和今天到期的待办，没有时给出接下来几条', async t => {
  const { app, config, indexer } = await setup(t);
  await writeNote(config.notesDir, 'plan.md', {
    body: '- [ ] 下周的事 @2026-11-04\n- [ ] 没有日期的事\n- [ ] 下下周 @2026-11-11\n'
  });
  await indexer.scan();
  let page = (await request(app).get('/').expect(200)).text;
  let panel = page.slice(page.indexOf('今天需要处理'));
  assert.match(panel, /今天没有到期的待办/);
  assert.match(panel, /接下来/);
  assert.match(panel, /下周的事/);
  assert.doesNotMatch(panel, /没有日期的事/, '未排期的待办不冒充今天的事');

  await writeNote(config.notesDir, 'today.md', { body: '- [ ] 逾期的事 @2026-10-20\n- [ ] 今天的事 @2026-10-28\n' });
  await indexer.scan();
  page = (await request(app).get('/').expect(200)).text;
  panel = page.slice(page.indexOf('今天需要处理'));
  assert.match(panel, /逾期的事/);
  assert.match(panel, /今天的事/);
  assert.doesNotMatch(panel, /下周的事|接下来/);
});

test('阅读页的待办日期跨年时带年份，逾期和今天到期写明状态', () => {
  const html = renderMarkdown('- [ ] 去年 @2025-12-01\n- [ ] 今天 @2026-10-28\n- [x] 已完成 @2026-10-01\n- [ ] 明年 @2027-01-15\n', () => '', { today: '2026-10-28' });
  assert.match(html, /<time class="task-due is-overdue" datetime="2025-12-01">逾期 2025\/12\/1<\/time>/);
  assert.match(html, /<time class="task-due is-today" datetime="2026-10-28">今天<\/time>/);
  assert.match(html, /<time class="task-due" datetime="2026-10-01">10\/1<\/time>/, '已完成的不标逾期');
  assert.match(html, /<time class="task-due" datetime="2027-01-15">2027\/1\/15<\/time>/);
});

test('新资料库的 .gitignore 不再提到已移除的功能', () => {
  assert.doesNotMatch(VAULT_GITIGNORE, /MinerU|mineru/);
  assert.match(VAULT_GITIGNORE, /^workstation\.db$/m);
});

const { listRecords, getRecord, saveVersion, saveDraft, pruneVersions, noteKey, KEEP_RECENT } = require('../src/vault/history');

test('版本历史按笔记分目录：列出时不读全文，只看这一篇的目录', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveVersion(root, 'a.md', '# A1', 'save');
  await saveVersion(root, 'b/c.md', '# C1', 'save');
  await saveVersion(root, 'a.md', '# A2', 'delete');
  const onlyA = await listRecords(root, 'a.md');
  assert.deepEqual(onlyA.map(record => [record.path, record.reason, 'raw' in record]), [['a.md', 'delete', false], ['a.md', 'save', false]]);
  assert.equal((await getRecord(root, onlyA[0].id)).raw, '# A2');
  assert.equal((await listRecords(root)).length, 3);
  // 坏掉的一条不影响其它记录。
  const directory = path.join(root, '.workstation-local', 'versions', noteKey('a.md'));
  await fs.writeFile(path.join(directory, 'junk.json'), '{bad');
  assert.equal((await listRecords(root, 'a.md')).length, 2);
});

test('每篇笔记的旧版本会被清理：最近的全部保留，更早的每天留一份，过期的删除', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveVersion(root, 'busy.md', '# 删掉之前', 'delete');
  for (let i = 0; i < KEEP_RECENT + 10; i += 1) await saveVersion(root, 'busy.md', `# v${i}`, 'save');
  const kept = await listRecords(root, 'busy.md');
  assert.equal(kept.length, KEEP_RECENT + 2, '同一天里更早的版本只留最新的一份，删除记录另外保留');
  assert.equal((await getRecord(root, kept[0].id)).raw, `# v${KEEP_RECENT + 9}`);
  await pruneVersions(root, noteKey('busy.md'), Date.now() + 100 * 86_400_000);
  const left = await listRecords(root, 'busy.md');
  assert.equal(left.length, KEEP_RECENT + 1, '超过保留天数的只剩最近的那些');
  assert.equal(left.filter(record => record.reason === 'delete').length, 1, '在同一路径重新建的笔记保存再多次，也挤不掉删除前的那份');
});

test('旧版平铺的记录自动迁移，旧链接里的 uuid 仍能打开', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = path.join(root, '.workstation-local');
  await fs.mkdir(local, { recursive: true });
  const versionId = '11111111-1111-4111-8111-111111111111';
  const draftId = '22222222-2222-4222-8222-222222222222';
  await fs.writeFile(path.join(local, versionId + '.json'), JSON.stringify({ id: versionId, kind: 'version', path: 'old.md', raw: '# old', reason: 'delete', at: '2026-09-01T08:00:00.000Z' }));
  await fs.writeFile(path.join(local, draftId + '.json'), JSON.stringify({ id: draftId, kind: 'draft', path: 'old.md', raw: '# draft', baseHash: '', sequence: 3, at: '2026-09-02T08:00:00.000Z' }));
  await fs.writeFile(path.join(local, '33333333-3333-4333-8333-333333333333.json'), '{damaged');
  const records = await listRecords(root, 'old.md');
  assert.deepEqual(records.map(record => record.kind), ['draft', 'version']);
  assert.equal((await getRecord(root, versionId)).raw, '# old', '迁移前的链接仍然有效');
  assert.equal((await getRecord(root, draftId)).sequence, 3);
  const remaining = await fs.readdir(local);
  assert.ok(!remaining.includes(versionId + '.json') && !remaining.includes(draftId + '.json'), '迁移后删除旧文件');
  assert.ok(remaining.includes('33333333-3333-4333-8333-333333333333.json'), '读不出的旧文件原样保留');
  await assert.rejects(saveDraft(root, draftId, { path: 'old.md', raw: 'stale', sequence: 2 }), { status: 409 });
});

const { appendCard } = require('../src/cards');
const { createReviewService } = require('../src/reviewService');

test('复习状态缓存：翻页复用重放结果，本机评分和别的设备拉下来的记录都会生效', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await appendCard(root, { deckFile: 'd', front: '甲', back: '1' });
  await appendCard(root, { deckFile: 'd', front: '乙', back: '2' });
  const service = createReviewService({ vaultDir: root, device: 'here', now: () => new Date('2026-10-28T10:00:00Z') });
  const [first, second] = await service.allCards();
  const states = async () => Object.fromEntries((await service.withStates()).map(card => [card.front, card.state.reps]));
  assert.deepEqual(await states(), { 甲: 0, 乙: 0 });

  await service.answer(first.id, 3, 1000, 'local-1');
  assert.deepEqual(await states(), { 甲: 1, 乙: 0 }, '本机评分立即反映');
  await assert.rejects(service.answer(first.id, 1, 1000, 'local-1'), { status: 409 }, '同一事件 ID 换了评分仍被拒绝');

  // 模拟 git 拉下另一台设备的日志。
  await fs.writeFile(path.join(root, 'reviews', '2026-10-there.jsonl'),
    JSON.stringify({ event_id: 'remote-1', card_id: second.id, card_id_version: 2, ts: '2026-10-27T09:00:00Z', rating: 3, elapsed_ms: 500 }) + '\n');
  assert.deepEqual(await states(), { 甲: 1, 乙: 1 }, '新文件被读入');
  const duplicate = await service.answer(second.id, 3, 500, 'remote-1');
  assert.equal(duplicate.duplicate, true, '别的设备的事件 ID 也参与去重');
});

test('阅读页的待办可以直接勾选：行号与索引一致，机器指令行和 frontmatter 不打乱行号', async t => {
  const { app, config, indexer, db } = await setup(t);
  const raw = '---\ntitle: 文献笔记\n---\n<!-- workstation:annotations:v1 begin -->\n\n\n<!-- workstation:annotations:v1 end -->\n- [ ] 精读第三节 @2026-10-30\n- [x] 下载论文\n\n```\n- [ ] 代码块里的不算\n```\n';
  await writeNote(config.notesDir, 'reading/paper.md', { raw });
  await indexer.scan();
  const page = (await request(app).get('/note/reading/paper.md').expect(200)).text;
  const lines = [...page.matchAll(/data-task-line="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(lines, db.listTasks({ includeDone: true }).map(task => task.line), '勾选框的行号就是索引里的待办行号');
  assert.equal(lines.length, 2);
  const hash = page.match(/class="prose" data-note-hash="([a-f0-9]+)"/)[1];

  const response = await request(app).post('/tasks/update').set('Accept', 'application/json')
    .send({ path: 'reading/paper.md', line: lines[0], expectedHash: hash, done: true }).expect(200);
  const { readNote } = require('../src/vault/note');
  const after = await readNote(config.notesDir, 'reading/paper.md');
  assert.equal(after.raw, raw.replace('- [ ] 精读第三节', '- [x] 精读第三节'), '只改了那一行');
  assert.equal(response.body.hash, after.hash);
  await request(app).post('/tasks/update').send({ path: 'reading/paper.md', line: lines[1], expectedHash: hash, done: false }).expect(409);
});

test('只读模式下阅读页的待办只显示、不能勾选', async t => {
  const { app, config, indexer } = await setup(t, { readOnly: true });
  await writeNote(config.notesDir, 'a.md', { raw: '- [ ] 只读待办\n' });
  await indexer.scan();
  const page = (await request(app).get('/note/a.md').expect(200)).text;
  assert.doesNotMatch(page, /task-toggle/);
  assert.match(page, /<span class="task-box" role="img" aria-label="待办"><\/span>/);
});

test('阅读页不再把和页头相同的开头 H1 排两遍，其他标题照常显示', () => {
  const { renderMarkdown } = require('../src/markdown');
  assert.doesNotMatch(renderMarkdown('# 注意力机制\n\n正文', () => '', { title: '注意力机制' }), /<h1/);
  assert.match(renderMarkdown('# 注意力机制\n\n正文', () => '', { title: '别的标题' }), /<h1/);
  assert.match(renderMarkdown('导语\n\n# 注意力机制', () => '', { title: '注意力机制' }), /<h1/);
  assert.match(renderMarkdown('# 读 [[Transformer]]', () => '', { title: '读 Transformer' }), /<h1/);
  assert.match(renderMarkdown('# 注意力机制\n\n正文'), /<h1/, '没传标题时（例如历史预览）不动');
});

test('侧栏逾期角标每次现查，外部改动后不会和今日页对不上', async () => {
  const { createNavCounts } = require('../src/viewHelpers');
  let tasks = [{ due: '2026-10-01' }];
  const nav = createNavCounts({ config: {}, db: { listTasks: () => tasks }, now: () => new Date('2026-10-28T09:00:00') });
  assert.equal((await nav.get()).overdue, 1);
  tasks = [{ due: '2026-10-01' }, { due: '2026-10-02' }, { due: '2026-12-01' }];
  assert.equal((await nav.get()).overdue, 2);
});
