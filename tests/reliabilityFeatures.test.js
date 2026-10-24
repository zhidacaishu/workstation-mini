const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const request = require('supertest');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { createApp } = require('../src/app');
const { writeNote, readNote, deleteNote } = require('../src/vault/note');
const { listRecords, saveDraft } = require('../src/vault/history');
const { appendCard } = require('../src/cards');
const { createReviewService } = require('../src/reviewService');

async function setup(t, readOnly = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-features-'));
  const config = loadConfig({ vaultDir: root, dbPath: ':memory:', readOnly, syncEnabled: false });
  await fs.mkdir(config.notesDir);
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, config, db, indexer, app, notes: config.notesDir };
}

test('invalid save never overwrites; malformed existing file remains editable and can be repaired', async t => {
  const c = await setup(t);
  const original = await writeNote(c.notes, 'a.md', { raw: '# original' });
  const broken = '---\ntags: [broken\n---\ntext';
  const failed = await request(c.app).post('/save').send({ path: 'a.md', body: broken, expectedHash: original.hash, isNew: '0' });
  assert.equal(failed.status, 400);
  assert.equal((await readNote(c.notes, 'a.md')).raw, original.raw);
  assert.equal((await listRecords(c.notes)).length, 0);
  await fs.writeFile(path.join(c.notes, 'a.md'), broken);
  const edit = await request(c.app).get('/edit/a.md');
  assert.equal(edit.status, 200);
  assert.match(edit.text, /笔记格式有误/);
  const current = await readNote(c.notes, 'a.md', { tolerateInvalid: true });
  const repaired = await request(c.app).post('/save').send({ path: 'a.md', body: '# repaired', expectedHash: current.hash, isNew: '0' });
  assert.equal(repaired.status, 302);
  assert.equal((await listRecords(c.notes))[0].raw, broken);
});

test('local history survives deletion and database rebuild, is Git ignored, restores through guarded editor', async t => {
  const c = await setup(t);
  await writeNote(c.notes, 'a.md', { raw: '# first' });
  await writeNote(c.notes, 'a.md', { raw: '# second' });
  await deleteNote(c.notes, 'a.md');
  const records = await listRecords(c.notes);
  assert.equal(records.length, 2);
  const removed = records.find(r => r.reason === 'delete');
  assert.equal(removed.raw, '# second');
  await c.indexer.scan({ force: true });
  assert.equal(c.db.countNotes(), 0);
  execFileSync('git', ['init', '-q', c.root]);
  const ignored = execFileSync('git', ['-C', c.root, 'check-ignore', 'notes/.workstation-local/' + removed.id + '.json'], { encoding: 'utf8' });
  assert.match(ignored, /workstation-local/);
  const edit = await request(c.app).get('/recover/' + removed.id);
  assert.equal(edit.status, 200);
  assert.match(edit.text, /data-recovered="1"/);
  assert.match(edit.text, /name="isNew" value="1"/);
  assert.equal(await fs.access(path.join(c.notes, 'a.md')).then(() => true, () => false), false);
  const restored = await request(c.app).post('/save').send({ path: 'a.md', body: removed.raw, isNew: '1' });
  assert.equal(restored.status, 302);
  assert.equal((await readNote(c.notes, 'a.md')).raw, '# second');
  assert.equal((await request(c.app).get('/history')).status, 200);
});

test('draft sequence rejects stale writes and deletes; recovery never overwrites changed disk file', async t => {
  const c = await setup(t);
  const note = await writeNote(c.notes, 'a.md', { raw: '# saved' });
  const id = crypto.randomUUID();
  const body = { path: 'a.md', raw: '# draft', baseHash: note.hash, sequence: 2 };
  assert.equal((await request(c.app).post('/api/drafts/' + id).send(body)).status, 200);
  assert.equal((await request(c.app).post('/api/drafts/' + id).send({ ...body, sequence: 1, raw: 'stale' })).status, 409);
  assert.equal((await request(c.app).delete('/api/drafts/' + id).send({ sequence: 1 })).status, 409);
  assert.equal((await listRecords(c.notes))[0].raw, '# draft');
  const changed = await writeNote(c.notes, 'a.md', { raw: '# external' });
  const edit = await request(c.app).get('/recover/' + id);
  assert.match(edit.text, new RegExp(changed.hash));
  assert.equal((await readNote(c.notes, 'a.md')).raw, '# external');
  await writeNote(c.notes, 'a.md', { raw: '# external again' });
  assert.equal((await request(c.app).post('/save').send({ path: 'a.md', body: body.raw, expectedHash: changed.hash, isNew: '0' })).status, 409);
  assert.equal((await request(c.app).delete('/api/drafts/' + id).send({ sequence: 2 })).status, 200);
  assert.ok(!(await listRecords(c.notes)).some(r => r.id === id));
});

test('task updates preserve frontmatter, CRLF, unrelated lines; stale edits and code blocks rejected', async t => {
  const c = await setup(t);
  const raw = '---\r\n# keep comment\r\ntitle: Tasks\r\n---\r\n- [ ] One @2026-10-05\r\n* [X] Two\r\n~~~\r\n- [ ] example\r\n~~~\r\n';
  const note = await writeNote(c.notes, 'a.md', { raw });
  await c.indexer.scan();
  const task = c.db.listTasks()[0];
  const payload = { path: 'a.md', line: task.line, expectedHash: note.hash, done: true, due: '2026-10-07' };
  const response = await request(c.app).post('/tasks/update').set('accept', 'application/json').send(payload);
  assert.equal(response.status, 200);
  assert.equal((await readNote(c.notes, 'a.md')).raw, raw.replace('- [ ] One @2026-10-05', '- [x] One @2026-10-07'));
  assert.equal(c.db.listTasks().length, 0);
  assert.equal((await listRecords(c.notes))[0].raw, raw);
  assert.equal((await request(c.app).post('/tasks/update').send(payload)).status, 409);
  assert.equal((await request(c.app).post('/tasks/update').send({ ...payload, expectedHash: response.body.hash, due: '2026-02-30' })).status, 400);
  assert.equal((await request(c.app).post('/tasks/update').send({ ...payload, expectedHash: response.body.hash, line: 4 })).status, 409);
  const cleared = await request(c.app).post('/tasks/update').set('accept', 'application/json').send({ ...payload, expectedHash: response.body.hash, done: false, due: '' });
  assert.equal(cleared.status, 200);
  assert.equal(c.db.listTasks()[0].due, null);
  assert.match((await request(c.app).get('/tasks')).text, /data-task-form/);
  assert.match((await request(c.app).get('/')).text, /data-task-form/);
});

test('read-only blocks task changes, draft writes and restore but permits history previews', async t => {
  const c = await setup(t, true);
  const id = crypto.randomUUID();
  await saveDraft(c.notes, id, { path: 'a.md', raw: 'draft', sequence: 1 });
  assert.equal((await request(c.app).get('/history')).status, 200);
  assert.equal((await request(c.app).get('/recover/' + id)).status, 403);
  assert.equal((await request(c.app).post('/api/drafts/' + id).send({ path: 'a.md', raw: 'new', sequence: 2 })).status, 403);
  assert.equal((await request(c.app).post('/tasks/update').send({})).status, 403);
});

test('special deck names, uppercase extension and one malformed deck leave healthy cards usable', async t => {
  const c = await setup(t);
  await appendCard(c.root, { deckFile: '[draft', front: 'Question', back: 'Answer' });
  await fs.writeFile(path.join(c.root, 'cards', 'UPPER.MD'), '## Upper\nAnswer');
  await fs.writeFile(path.join(c.root, 'cards', 'bad.md'), '---\ndeck: [broken\n---\n## Bad');
  const service = createReviewService({ vaultDir: c.root, device: 'test' });
  assert.equal((await service.allCards()).length, 2);
  assert.equal((await service.stats()).failures.length, 1);
  await fs.writeFile(path.join(c.root, 'cards', 'UPPER.MD'), '## Newer\nAnswer');
  assert.ok((await service.allCards()).some(card => card.front === 'Newer'));
  for (const page of ['/', '/decks', '/calendar']) assert.equal((await request(c.app).get(page)).status, 200);
});

test('cross-file card IDs isolated; unambiguous old events migrate; ambiguous old events never duplicate', async t => {
  const c = await setup(t);
  await appendCard(c.root, { deckFile: 'english', front: 'grammar/tense' });
  const service = createReviewService({ vaultDir: c.root, device: 'test' });
  await fs.mkdir(path.join(c.root, 'reviews'));
  await fs.writeFile(path.join(c.root, 'reviews', 'legacy.jsonl'), JSON.stringify({ card_id: 'english/grammar/tense', ts: '2026-10-01T00:00:00Z', rating: 3 }) + '\n');
  assert.equal((await service.withStates())[0].state.reps, 1);
  await appendCard(c.root, { deckFile: 'english/grammar', front: 'tense' });
  const cards = await service.allCards();
  assert.notEqual(cards[0].id, cards[1].id);
  assert.deepEqual((await service.withStates()).map(c => c.state.reps), [0, 0]);
  await service.answer(cards[0].id, 3, 10, 'one-answer');
  assert.deepEqual((await service.withStates()).map(c => c.state.reps), [1, 0]);
});

test('card symlink and history symlink cannot modify outside files', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation requires Windows privilege');
  const c = await setup(t);
  const outside = path.join(c.root, 'outside.md');
  await fs.writeFile(outside, '# outside');
  await fs.mkdir(path.join(c.root, 'cards'));
  await fs.symlink(outside, path.join(c.root, 'cards', 'linked.md'));
  await assert.rejects(appendCard(c.root, { deckFile: 'linked', front: 'No' }));
  assert.equal(await fs.readFile(outside, 'utf8'), '# outside');
  await fs.symlink(c.root, path.join(c.notes, '.workstation-local'));
  await assert.rejects(saveDraft(c.notes, crypto.randomUUID(), { path: 'a.md', raw: 'no', sequence: 1 }));
});

test('task scheduling never edits a date inside a multiline code span', async t => {
  const c = await setup(t);
  const raw = '- [ ] Check ' + String.fromCharCode(96) + 'example @2026-10-05\ncontinued' + String.fromCharCode(96) + '\n';
  const note = await writeNote(c.notes, 'code.md', { raw });
  await c.indexer.scan();
  assert.equal(c.db.listTasks()[0].due, null);
  const result = await request(c.app).post('/tasks/update').send({
    path: 'code.md', line: 1, expectedHash: note.hash, due: '2026-10-08'
  });
  assert.equal(result.status, 302);
  const updated = await readNote(c.notes, 'code.md');
  assert.ok(updated.raw.includes('example @2026-10-05\ncontinued'));
  assert.equal(c.db.listTasks()[0].due, '2026-10-08');
});
