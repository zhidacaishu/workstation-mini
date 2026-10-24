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
