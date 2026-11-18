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

test('health is read-only and reports rebuildable source state without note bodies', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-health-'));
  const db = openDatabase(':memory:');
  try {
    await fs.mkdir(path.join(vaultDir, 'notes'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'reviews'), { recursive: true });
    await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
    await writeNote(path.join(vaultDir, 'notes'), 'a.md', { body: 'private body [[missing]]' });
    await fs.writeFile(path.join(vaultDir, 'reviews', '2026-10-device.jsonl'), '{bad-json}\n{"event_id":"e1","card_id":"gone","ts":"2026-10-01T00:00:00Z","rating":3}\n{"event_id":"e1","card_id":"gone","ts":"2026-10-01T00:00:00Z","rating":3}\n');
    const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false });
    const indexer = createIndexer({ db, vaultDir: config.notesDir });
    await indexer.scan();
    const app = createApp(config, { db, indexer, search: createSearch(db) });
    const before = await fs.readFile(path.join(vaultDir, 'notes', 'a.md'), 'utf8');
    const response = await request(app).get('/api/health').expect(200);
    assert.equal(response.body.vault.noteFiles, 1);
    assert.equal(response.body.vault.indexedNotes, 1);
    assert.equal(response.body.vault.indexRebuildable, true);
    assert.equal(response.body.links.brokenCount, 1);
    assert.equal(response.body.reviews.malformedLines, 1);
    assert.equal(response.body.reviews.duplicateEventIds, 1);
    assert.equal(response.body.reviews.orphanedCards, 1);
    assert.equal(JSON.stringify(response.body).includes('private body'), false);
    await request(app).get('/health').expect(200);
    assert.equal(await fs.readFile(path.join(vaultDir, 'notes', 'a.md'), 'utf8'), before);
  } finally {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('Git health preserves modified, renamed and Unicode paths without refreshing the index', async () => {
  const { execFileSync } = require('node:child_process');
  const { gitReport } = require('../src/health');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-health-git-'));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  try {
    git(['init', '-q']);
    await fs.writeFile(path.join(root, 'a.md'), 'initial');
    await fs.writeFile(path.join(root, 'old.md'), 'rename');
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    await fs.writeFile(path.join(root, 'a.md'), 'modified');
    git(['mv', 'old.md', '新名字.md']);
    const before = await fs.readFile(path.join(root, '.git', 'index'));
    const report = await gitReport(root);
    assert.equal(report.dirty, true);
    assert.deepEqual(report.changedPaths.sort(), ['a.md', '新名字.md']);
    assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('health remains available when SQLite statistics fail, without reporting false zeroes', async () => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-health-corrupt-'));
  const db = openDatabase(':memory:');
  try {
    const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly: true });
    await fs.mkdir(config.notesDir);
    await fs.writeFile(path.join(config.notesDir, 'a.md'), '# retained source');
    const fail = () => { throw Object.assign(new Error('private database details'), { code: 'SQLITE_CORRUPT' }); };
    const fatal = { code: 'database-corrupt', reason: '索引数据库已损坏，重启应用后会自动重建', retryable: false };
    const app = createApp(config, {
      db: { ...db, countNotes: fail, raw: { prepare: fail } },
      search: createSearch(db), indexer: { getStatus: () => ({ phase: 'error', fatal }) }
    });
    const response = await request(app).get('/api/health').expect(200);
    assert.equal(response.body.vault.noteFiles, 1);
    assert.equal(response.body.vault.indexedNotes, null);
    assert.equal(response.body.vault.indexLag, null);
    assert.equal(response.body.links.brokenCount, null);
    assert.equal(response.body.index.statErrors.length, 2);
    assert.deepEqual(response.body.index.fatal, fatal);
    assert.equal(response.body.reviews.files, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /private database details/);
    const page = await request(app).get('/health').expect(200);
    assert.match(page.text, /索引数据库已损坏/);
    assert.match(page.text, /未知/);
    assert.equal(await fs.readFile(path.join(config.notesDir, 'a.md'), 'utf8'), '# retained source');
  } finally { db.close(); await fs.rm(vaultDir, { recursive: true, force: true }); }
});

test('health prioritizes Git and sync recovery over a clean worktree', async () => {
  const { execFileSync } = require('node:child_process');
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-health-recovery-'));
  const db = openDatabase(':memory:');
  try {
    execFileSync('git', ['-C', vaultDir, 'init', '-q']);
    const config = loadConfig({ vaultDir, dbPath: ':memory:' });
    const indexer = createIndexer({ db, vaultDir: config.notesDir });
    const app = createApp(config, { db, indexer, search: createSearch(db) });
    await fs.writeFile(path.join(vaultDir, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n');
    const report = (await request(app).get('/api/health').expect(200)).body;
    assert.equal(report.git.dirty, false);
    assert.deepEqual(report.git.recoveryRequired.markers, ['MERGE_HEAD']);
    const page = await request(app).get('/health').expect(200);
    assert.match(page.text, /Git <strong>需要恢复/);
    assert.match(page.text, /MERGE_HEAD/);
    assert.doesNotMatch(page.text, /Git <strong>干净/);
    await fs.rm(path.join(vaultDir, '.git', 'MERGE_HEAD'));
    const syncApp = createApp(config, { db, indexer, search: createSearch(db),
      sync: { getStatus: () => ({ recovery: { kind: 'rebase', unmergedCount: 1 } }) } });
    const syncPage = await request(syncApp).get('/health').expect(200);
    assert.match(syncPage.text, /Git <strong>需要恢复/);
    assert.match(syncPage.text, /rebase/);
    assert.doesNotMatch(syncPage.text, /Git <strong>干净/);
  } finally { db.close(); await fs.rm(vaultDir, { recursive: true, force: true }); }
});

test('健康页统计普通历史与卡组版本，并指出无法读取的卡组', async t => {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-health-cards-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false });
  const db = openDatabase(':memory:');
  t.after(async () => { db.close(); await fs.rm(vaultDir, { recursive: true, force: true }); });
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  await fs.mkdir(config.notesDir);
  await writeNote(config.notesDir, 'a.md', { body: '初稿' });
  await writeNote(config.notesDir, 'a.md', { body: '定稿' });
  await writeNote(vaultDir, 'cards/a.md', { body: '## 提问' });
  await writeNote(vaultDir, 'cards/a.md', { body: '## 新提问' });
  await fs.writeFile(path.join(vaultDir, 'cards/bad.md'), '---\ndeck: [bad\n---\n');
  await indexer.scan();
  const report = (await request(app).get('/api/health').expect(200)).body;
  assert.equal(report.drafts.historyCount, 2);
  assert.deepEqual(report.reviews.deckFailures, ['cards/bad.md']);
  const html = (await request(app).get('/health').expect(200)).text;
  assert.match(html, /本地历史与草稿 <strong>2<\/strong>/);
  assert.match(html, /cards\/bad\.md/);
  assert.doesNotMatch(html, /一切正常/);
  // cards/ 不是目录时所有平台都会返回枚举错误，和子目录不可读走同一条错误路径。
  await fs.rename(path.join(vaultDir, 'cards'), path.join(vaultDir, '原卡组'));
  await fs.writeFile(path.join(vaultDir, 'cards'), '目录不可用');
  const failed = (await request(app).get('/api/health').expect(200)).body.reviews;
  assert.equal(failed.deckScanFailed, true);
  assert.equal(failed.orphanedCards, null);
  const warning = (await request(app).get('/health').expect(200)).text;
  assert.match(warning, /卡组扫描未完成/);
  assert.doesNotMatch(warning, /一切正常|查看卡组历史/);
});
