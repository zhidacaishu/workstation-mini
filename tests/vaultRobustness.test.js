const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { parseNote } = require('../src/vault/note');
const { parseWikilinks } = require('../src/vault/wikilink');
const { parseCardFile, appendCard, deleteCard, loadAllCards } = require('../src/cards');
const { readNote, writeNote } = require('../src/vault/note');
const history = require('../src/vault/history');
const { gitReport } = require('../src/health');
const { createReviewStore } = require('../src/review');

const JSON_ACCEPT = { Accept: 'application/json' };

function makeVault() {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-robust-'));
  for (const directory of ['notes/inbox', 'cards', 'reviews']) fs.mkdirSync(path.join(vaultDir, directory), { recursive: true });
  return { vaultDir, notesDir: path.join(vaultDir, 'notes'), cleanup: () => fs.rmSync(vaultDir, { recursive: true, force: true }) };
}

function makeApp(env) {
  const config = loadConfig({ vaultDir: env.vaultDir, dbPath: ':memory:', device: 'desktop' });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: env.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db), now: () => new Date(2026, 2, 17, 14, 30) });
  return { app, db, indexer };
}

// ---------- 属性区 ----------

test('属性区里循环引用的 YAML 锚点只算这一篇解析失败，不拖垮整轮索引', async () => {
  const env = makeVault();
  const db = openDatabase(':memory:');
  try {
    fs.writeFileSync(path.join(env.notesDir, 'inbox/a.md'), '# 正常笔记 A\n');
    fs.writeFileSync(path.join(env.notesDir, 'inbox/m.md'), '---\ntitle: 循环引用\nrefs: &r\n  - *r\n---\n正文\n');
    fs.writeFileSync(path.join(env.notesDir, 'inbox/z.md'), '# 正常笔记 Z\n');
    const indexer = createIndexer({ db, vaultDir: env.notesDir });

    const stats = await indexer.scan({ kind: 'initial' });

    assert.equal(stats.phase, 'degraded');
    assert.deepEqual(db.listPaths().sort(), ['inbox/a.md', 'inbox/z.md']);
    const status = indexer.getStatus();
    assert.equal(status.fatal, null);
    assert.deepEqual(status.failures.map(failure => failure.path), ['inbox/m.md']);
  } finally { db.close(); env.cleanup(); }
});

test('用别名堆出指数级结构的属性区按解析失败处理', () => {
  const layers = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let index = 1; index <= 8; index += 1) {
    layers.push(`a${index}: &a${index} [${Array(10).fill(`*a${index - 1}`).join(', ')}]`);
  }
  assert.throws(() => parseNote('inbox/bomb.md', `---\n${layers.join('\n')}\n---\n正文\n`), /过于庞大/);
});

test('开头的 --- 只是分隔线时，整篇都是正文', () => {
  const unclosed = parseNote('inbox/hr.md', '---\n\n只是想在开头画一条分隔线\n\n正文第二段\n');
  assert.deepEqual(unclosed.data, {});
  assert.match(unclosed.body, /只是想在开头画一条分隔线/);
  assert.match(unclosed.body, /正文第二段/);

  const prose = parseNote('inbox/hr.md', '---\n第一段\n\n---\n\n第二段\n- [ ] 待办\n');
  assert.deepEqual(prose.data, {});
  assert.match(prose.body, /第一段/);
  assert.match(prose.body, /第二段/);
  assert.ok(prose.raw.endsWith(prose.body), '正文仍然是原文的后缀，待办回写依赖这一点');

  const colon = parseNote('inbox/hr.md', '---\n\n注意: 这其实是正文\n');
  assert.deepEqual(colon.data, {});
  assert.match(colon.body, /这其实是正文/);
});

test('正常的属性区照旧解析', () => {
  const note = parseNote('inbox/n.md', '﻿---\ntitle: 带 BOM\ntags: [a, b]\n---\n正文\n');
  assert.equal(note.title, '带 BOM');
  assert.deepEqual(note.tags, ['a', 'b']);
  assert.equal(note.body, '正文\n');

  const empty = parseNote('inbox/n.md', '---\n---\n正文\n');
  assert.deepEqual(empty.data, {});
  assert.equal(empty.body, '正文\n');

  const atEnd = parseNote('inbox/n.md', '---\ntitle: 只有属性区\n---');
  assert.equal(atEnd.title, '只有属性区');
});

// ---------- 行内代码屏蔽 ----------

test('落单的反引号不跨段落配对，中间的双链照常识别', () => {
  const body = '快捷键是 ` 键。\n\n参见 [[inbox/target]]。\n\n后面还有个 ` 键。\n';
  assert.deepEqual(parseWikilinks(body).map(link => link.target), ['inbox/target']);

  const latex = '他说 ``这是引号\'\'。\r\n\r\n参见 [[甲]]。\r\n\r\n又说 ``另一句\'\'。\r\n';
  assert.deepEqual(parseWikilinks(latex).map(link => link.target), ['甲']);
});

test('同一段里的行内代码仍然屏蔽其中的双链，包括跨行的', () => {
  assert.deepEqual(parseWikilinks('用 `[[不是链接]]` 表示，[[是链接]]。').map(link => link.target), ['是链接']);
  assert.deepEqual(parseWikilinks('代码 `[[第一行\n第二行]]` 之后 [[真链接]]').map(link => link.target), ['真链接']);
  assert.deepEqual(parseWikilinks('``含 ` 的 [[代码]]`` 和 [[链接]]').map(link => link.target), ['链接']);
});

test('卡片背面有落单反引号时，挖空仍然识别', () => {
  const [card] = parseCardFile('cards/x.md', '## 题目\n命令是 ` 开头。\n\n答案是 {{挖空一}}，另见 ` 。\n');
  assert.equal(card.type, 'cloze');
});

// ---------- 索引 ----------

test('不合规文件名改名后，失败项随增量扫描消掉', { skip: process.platform === 'win32' }, async () => {
  const env = makeVault();
  const db = openDatabase(':memory:');
  try {
    const bad = 'inbox/BERT: Pre-training.md';
    fs.writeFileSync(path.join(env.notesDir, bad), '# BERT\n');
    const indexer = createIndexer({ db, vaultDir: env.notesDir });
    await indexer.scan({ kind: 'initial' });
    assert.deepEqual(indexer.getStatus().failures.map(failure => failure.path), [bad]);

    fs.renameSync(path.join(env.notesDir, bad), path.join(env.notesDir, 'inbox/BERT Pre-training.md'));
    await indexer.scan({ paths: [bad, 'inbox/BERT Pre-training.md'] });

    assert.equal(indexer.getStatus().phase, 'ready');
    assert.deepEqual(db.listPaths(), ['inbox/BERT Pre-training.md']);
  } finally { db.close(); env.cleanup(); }
});

test('不合规文件名还在磁盘上时，重试不会把失败项误删', { skip: process.platform === 'win32' }, async () => {
  const env = makeVault();
  const db = openDatabase(':memory:');
  try {
    const bad = 'inbox/为什么?.md';
    fs.writeFileSync(path.join(env.notesDir, bad), '# 问题\n');
    const indexer = createIndexer({ db, vaultDir: env.notesDir });
    await indexer.scan({ kind: 'initial' });

    const retried = await indexer.retry();

    assert.equal(retried.phase, 'degraded');
    assert.deepEqual(indexer.getStatus().failures.map(failure => failure.path), [bad]);
  } finally { db.close(); env.cleanup(); }
});

// ---------- 接口 ----------

test('卡组名以点号开头或叫 node_modules 时拒绝，不写出看不见的文件', async () => {
  const env = makeVault();
  const { app, db } = makeApp(env);
  try {
    for (const deckFile of ['.草稿', 'node_modules/x', '子目录/.隐藏']) {
      const response = await request(app).post('/cards/add').set(JSON_ACCEPT).send({ front: '正面', back: '背面', deckFile });
      assert.equal(response.status, 400, deckFile);
      assert.match(response.body.message, /卡组名/);
    }
    assert.deepEqual(fs.readdirSync(path.join(env.vaultDir, 'cards')), []);
  } finally { db.close(); env.cleanup(); }
});

test('保存路径的上级是一个文件时返回 400 和原因，不是 500', async () => {
  const env = makeVault();
  const { app, db } = makeApp(env);
  try {
    fs.writeFileSync(path.join(env.notesDir, 'inbox/target.md'), '# 目标\n');
    const response = await request(app).post('/save').set(JSON_ACCEPT)
      .send({ path: 'inbox/target.md/子.md', body: 'x', isNew: '1' });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /非目录祖先/);
  } finally { db.close(); env.cleanup(); }
});

// ---------- 本机历史 ----------

test('删卡前的卡组版本：60 天内全留，更早的每天只留最早一份', async () => {
  const env = makeVault();
  try {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const day = 86_400_000;
    const stamp = ms => new Date(ms).toISOString().replace(/[-:.]/g, '');
    const key = history.noteKey('cards/english.md');
    const directory = path.join(env.vaultDir, history.DIRECTORY, 'versions', key);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'path.json'), JSON.stringify({ path: 'cards/english.md' }));
    const write = (ms, reason, tag) => {
      const name = `${stamp(ms)}-${reason}-00000000-0000-4000-8000-${String(tag).padStart(12, '0')}.json`;
      fs.writeFileSync(path.join(directory, name), '{}');
      return name;
    };
    const recent = [write(now - 2 * day, 'card', 1), write(now - 2 * day + 1000, 'card', 2)];
    const oldDayFirst = write(now - 90 * day, 'card', 3);
    const oldDayLater = [write(now - 90 * day + 1000, 'card', 4), write(now - 90 * day + 2000, 'card', 5)];
    const deleted = write(now - 400 * day, 'delete', 6);

    await history.pruneVersions(env.vaultDir, key, now);

    const left = new Set(fs.readdirSync(directory));
    for (const name of [...recent, oldDayFirst, deleted]) assert.ok(left.has(name), `应保留 ${name}`);
    for (const name of oldDayLater) assert.ok(!left.has(name), `应清理 ${name}`);
  } finally { env.cleanup(); }
});

test('冲突未采用和中止前的副本不随普通保存清理', async () => {
  const env = makeVault();
  try {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const day = 86_400_000;
    const stamp = ms => new Date(ms).toISOString().replace(/[-:.]/g, '');
    const key = history.noteKey('inbox/a.md');
    const directory = path.join(env.notesDir, history.DIRECTORY, 'versions', key);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'path.json'), JSON.stringify({ path: 'inbox/a.md' }));
    const write = (ms, reason, tag) => {
      const name = `${stamp(ms)}-${reason}-00000000-0000-4000-8000-${String(tag).padStart(12, '0')}.json`;
      fs.writeFileSync(path.join(directory, name), '{}');
      return name;
    };
    // 同一天先有冲突和中止的副本，之后又保存了很多次；另有一对超过 60 天的。
    const kept = [
      write(now - 3600_000, 'conflict', 1), write(now - 3500_000, 'abort', 2),
      write(now - 400 * day, 'conflict', 3), write(now - 400 * day, 'abort', 4)
    ];
    for (let index = 0; index < history.KEEP_RECENT + 5; index += 1) write(now - 3000_000 + index * 1000, 'save', 100 + index);

    await history.pruneVersions(env.notesDir, key, now);

    const left = new Set(fs.readdirSync(directory));
    for (const name of kept) assert.ok(left.has(name), `应保留 ${name}`);
    assert.equal([...left].filter(name => name.includes('-save-')).length, history.KEEP_RECENT, '同一天的普通保存只留最近的 20 份');
  } finally { env.cleanup(); }
});

test('卡组快照和删除副本不占「最近 20 份」的名额；按本地日期每天留一份', async () => {
  const env = makeVault();
  const timezone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const day = 86_400_000;
    const stamp = ms => new Date(ms).toISOString().replace(/[-:.]/g, '');
    const key = history.noteKey('cards/deck.md');
    const directory = path.join(env.vaultDir, history.DIRECTORY, 'versions', key);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'path.json'), JSON.stringify({ path: 'cards/deck.md' }));
    let tag = 0;
    const write = (ms, reason) => {
      tag += 1;
      const name = `${stamp(ms)}-${reason}-00000000-0000-4000-8000-${String(tag).padStart(12, '0')}.json`;
      fs.writeFileSync(path.join(directory, name), '{}');
      return name;
    };
    // 5 份普通保存之后，同一天又删了 20 张卡、留下 20 份快照。
    const saves = Array.from({ length: 5 }, (_, index) => write(now - 7200_000 + index * 1000, 'save'));
    for (let index = 0; index < 20; index += 1) write(now - 3600_000 + index * 1000, 'card');
    // 另有 20 份更新的保存把上面的挤出「最近 20」之外之前，先看本地日期分组：
    // 北京时间 10 月 2 日 01:00 和 10 月 1 日 23:00 在 UTC 是同一天。
    const lateNight = write(Date.parse('2026-10-01T15:00:00.000Z'), 'save');
    const earlyMorning = write(Date.parse('2026-10-01T17:00:00.000Z'), 'save');
    for (let index = 0; index < history.KEEP_RECENT; index += 1) write(now - 600_000 + index * 1000, 'save');

    await history.pruneVersions(env.vaultDir, key, now);
    const left = new Set(fs.readdirSync(directory));
    assert.ok(left.has(lateNight) && left.has(earlyMorning), '本地日期不同的两天各留一份');
    assert.equal(saves.filter(name => left.has(name)).length, 0, '今天已有最近 20 份，更早的同日保存不再多留');
    assert.equal([...left].filter(name => name.includes('-card-')).length, 20, '60 天内的卡组快照全留');

    // 卡组快照不挤占普通保存的名额。
    for (const name of fs.readdirSync(directory)) if (name.includes('-save-')) fs.rmSync(path.join(directory, name));
    const kept = Array.from({ length: 5 }, (_, index) => write(now - 7200_000 + index * 1000, 'save'));
    for (let index = 0; index < 20; index += 1) write(now - 1800_000 + index * 1000, 'delete');
    await history.pruneVersions(env.vaultDir, key, now);
    const after = new Set(fs.readdirSync(directory));
    for (const name of kept) assert.ok(after.has(name), `应保留 ${name}`);
  } finally {
    if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
    env.cleanup();
  }
});

test('清理旧版本失败时，笔记照常保存', async () => {
  const env = makeVault();
  const fsp = require('node:fs/promises');
  const originalRm = fsp.rm;
  const originalWarn = console.warn;
  const warnings = [];
  try {
    fs.writeFileSync(path.join(env.notesDir, 'inbox/a.md'), 'v0\n');
    for (let index = 1; index <= history.KEEP_RECENT + 1; index += 1) {
      await writeNote(env.notesDir, 'inbox/a.md', { raw: `v${index}\n` });
    }
    // 模拟 Windows 上旧版本被杀毒软件占着，删不掉。
    fsp.rm = async (target, options) => {
      const name = path.basename(String(target));
      if (String(target).includes(`${history.DIRECTORY}${path.sep}versions`) && /-save-.*\.json$/.test(name)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return originalRm(target, options);
    };
    console.warn = message => warnings.push(String(message));

    await writeNote(env.notesDir, 'inbox/a.md', { raw: '新内容\n' });

    assert.equal(fs.readFileSync(path.join(env.notesDir, 'inbox/a.md'), 'utf8'), '新内容\n');
    assert.ok(warnings.some(message => message.includes('清理旧版本失败')));
  } finally {
    fsp.rm = originalRm;
    console.warn = originalWarn;
    env.cleanup();
  }
});

test('版本和草稿先 fsync 临时文件再改名，崩溃留下的旧临时文件随清理删掉', async t => {
  const env = makeVault();
  try {
    const fsp = require('node:fs/promises');
    const open = fsp.open;
    const synced = [];
    t.mock.method(fsp, 'open', async (target, ...rest) => {
      const handle = await open.call(fsp, target, ...rest);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { synced.push(path.basename(String(target))); return sync(); };
      return handle;
    });
    fs.writeFileSync(path.join(env.notesDir, 'inbox/a.md'), 'v0\n');
    await writeNote(env.notesDir, 'inbox/a.md', { raw: 'v1\n' });
    await history.saveDraft(env.notesDir, '00000000-0000-4000-8000-000000000001', { path: 'inbox/a.md', raw: '草稿', sequence: 1 });
    assert.ok(synced.some(name => /-save-.*\.json\.tmp-/.test(name)), '版本文件写完要 fsync');
    assert.ok(synced.some(name => /^00000000-0000-4000-8000-000000000001\.json\.tmp-/.test(name)), '草稿写完要 fsync');
    t.mock.restoreAll();

    const key = history.noteKey('inbox/a.md');
    const versions = path.join(env.notesDir, history.DIRECTORY, 'versions', key);
    const drafts = path.join(env.notesDir, history.DIRECTORY, 'drafts');
    const stale = [
      path.join(versions, '20260101T000000000Z-save-00000000-0000-4000-8000-000000000009.json.tmp-00000000-0000-4000-8000-00000000000a'),
      path.join(drafts, '00000000-0000-4000-8000-000000000002.json.tmp-00000000-0000-4000-8000-00000000000b')
    ];
    const fresh = path.join(versions, 'path.json.tmp-00000000-0000-4000-8000-00000000000c');
    for (const file of [...stale, fresh]) fs.writeFileSync(file, '{');
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const file of stale) fs.utimesSync(file, old, old);

    await history.pruneVersions(env.notesDir, key);
    await history.pruneDrafts(env.notesDir);
    for (const file of stale) assert.equal(fs.existsSync(file), false, `应清理 ${path.basename(file)}`);
    assert.equal(fs.existsSync(fresh), true, '刚写到一半的临时文件不能删');
  } finally { env.cleanup(); }
});

test('删除卡片时，卡组的旧版本记成 card 并能在历史里找到', async () => {
  const env = makeVault();
  try {
    await appendCard(env.vaultDir, { deckFile: 'english', front: '甲', back: '一' });
    await appendCard(env.vaultDir, { deckFile: 'english', front: '乙', back: '二' });
    const [first] = await loadAllCards(env.vaultDir);
    const { hash } = await readNote(env.vaultDir, first.path);

    await deleteCard(env.vaultDir, { id: first.id, expectedHash: hash });

    const records = await history.listRecords(env.vaultDir, first.path);
    const record = records.find(item => item.reason === 'card');
    assert.ok(record, '应有一条删卡前的版本');
    assert.match((await history.getRecord(env.vaultDir, record.id)).raw, /## 甲/);
  } finally { env.cleanup(); }
});

test('超过 30 天没动过的草稿被清理，新的保留', async () => {
  const env = makeVault();
  try {
    const fresh = '11111111-1111-4111-8111-111111111111';
    const stale = '22222222-2222-4222-8222-222222222222';
    for (const id of [fresh, stale]) {
      await history.saveDraft(env.notesDir, id, { path: 'inbox/n.md', raw: '草稿', sequence: 1 });
    }
    const draftFile = id => path.join(env.notesDir, history.DIRECTORY, 'drafts', `${id}.json`);
    const old = new Date(Date.now() - 45 * 86_400_000);
    fs.utimesSync(draftFile(stale), old, old);

    const removed = await history.pruneDrafts(env.notesDir);

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(draftFile(stale)), false);
    assert.equal(fs.existsSync(draftFile(fresh)), true);
  } finally { env.cleanup(); }
});

// ---------- 健康页与复习日志 ----------

test('资料库放在别的 Git 仓库子目录里时，健康页不把父仓库当成它的仓库', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-parent-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', parent]);
    fs.writeFileSync(path.join(parent, '论文草稿.tex'), 'x');
    const vaultDir = path.join(parent, 'vault');
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true });

    const report = await gitReport(vaultDir);

    assert.equal(report.isRepository, false);
    assert.deepEqual(report.changedPaths, []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('复习日志目录里的符号链接仍然不读', { skip: process.platform === 'win32' }, async () => {
  const env = makeVault();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-outside-'));
  try {
    const store = createReviewStore({ vaultDir: env.vaultDir, device: 'b' });
    await store.record('deck/card', 3, 1000, 'e1');
    fs.writeFileSync(path.join(outside, 'x.jsonl'), '{"card_id":"deck/evil","ts":"2026-11-12T00:00:00.000Z","rating":3}\n');
    fs.symlinkSync(path.join(outside, 'x.jsonl'), path.join(env.vaultDir, 'reviews/2026-11-evil.jsonl'));

    const events = await createReviewStore({ vaultDir: env.vaultDir, device: 'b' }).readEvents();

    assert.deepEqual(events.map(event => event.cardId), ['deck/card']);
  } finally { env.cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

// ---------- 待办 ----------

test('取消排期会去掉这一行里所有的日期标记', async () => {
  const env = makeVault();
  try {
    const { updateTask } = require('../src/taskActions');
    const file = path.join(env.notesDir, 'inbox/t.md');
    fs.writeFileSync(file, '- [ ] 甲 @2026-03-01 改到 @2026-04-01\n- [ ] 乙 `@2026-01-01` @2026-05-05\n');
    let hash = (await readNote(env.notesDir, 'inbox/t.md')).hash;
    hash = (await updateTask(env.notesDir, { path: 'inbox/t.md', line: 1, expectedHash: hash, due: '' })).hash;
    await updateTask(env.notesDir, { path: 'inbox/t.md', line: 2, expectedHash: hash, due: '' });

    const [first, second] = fs.readFileSync(file, 'utf8').split('\n');
    assert.doesNotMatch(first, /@\d{4}/);
    assert.equal(second, '- [ ] 乙 `@2026-01-01` ', '行内代码里的日期不是标记，不动');
  } finally { env.cleanup(); }
});

test('历史版本落盘失败时保存接口保留旧笔记，恢复存储后可用同一版本重试', async t => {
  const env = makeVault();
  const { app, db } = makeApp(env);
  t.after(() => { db.close(); env.cleanup(); });
  const file = 'inbox/a.md';
  const previous = await writeNote(env.notesDir, file, { raw: '旧稿' });
  const fsp = require('node:fs/promises');
  const open = fsp.open;
  const save = () => request(app).post('/save').set(JSON_ACCEPT)
    .type('form').send({ path: file, expectedHash: previous.hash, body: '新稿' });
  for (const code of ['EIO', 'ENOENT']) {
    const mock = t.mock.method(fsp, 'open', async (target, ...rest) => {
      const handle = await open.call(fsp, target, ...rest);
      if (/-save-.*\.json\.tmp-/.test(target)) {
        handle.sync = async () => { throw Object.assign(new Error('模拟落盘错误'), { code }); };
      }
      return handle;
    });
    const response = await save().expect(500);
    assert.match(response.body.message, /历史未能保存.*重试/);
    assert.equal((await readNote(env.notesDir, file)).raw, '旧稿');
    assert.equal((await history.listRecords(env.notesDir, file)).length, 0);
    mock.mock.restore();
  }
  await save().expect(200);
  assert.equal((await readNote(env.notesDir, file)).raw, '新稿');
  const [version] = await history.listRecords(env.notesDir, file);
  assert.equal((await history.getRecord(env.notesDir, version.id)).raw, '旧稿');
});
