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
const { appendCard, updateCard, deleteCard } = require('../src/cards');
const { readNote } = require('../src/vault/note');

async function setup(t, { readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-cards-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false, readOnly, device: 'test' });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db), now: () => new Date('2026-10-28T10:00:00Z') });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, vaultDir, review: app.locals?.review };
}

const read = (vaultDir, file) => fs.readFile(path.join(vaultDir, 'cards', file), 'utf8');
const queueOf = async app => JSON.parse(decodeURIComponent((await request(app).get('/review').expect(200)).text.match(/data-queue="([^"]+)"/)[1]));

test('编辑正面后复习记录接得上：卡片 id 固定在元数据行里', async t => {
  const { app, vaultDir } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'ml', front: '注意力复杂度', back: 'O(n^2)' });
  await appendCard(vaultDir, { deckFile: 'ml', front: '另一张', back: '不动' });
  const card = (await queueOf(app)).find(item => item.id === 'ml/注意力复杂度');
  await request(app).post('/review/answer').send({ cardId: card.id, rating: 3, eventId: 'e1' }).expect(200);

  const file = await readNote(vaultDir, 'cards/ml.md');
  const before = await read(vaultDir, 'ml.md');
  await request(app).post('/cards/update').type('form').send({
    id: card.id, expectedHash: file.hash, front: '自注意力的时间复杂度', back: '$O(n^2 d)$', returnTo: '/cards?deck=ml'
  }).expect(302).expect('location', '/cards?deck=ml');

  const after = await read(vaultDir, 'ml.md');
  assert.match(after, /## 自注意力的时间复杂度\n<!-- workstation:card:v1 \{"id":"ml\/注意力复杂度","legacy":"ml\/注意力复杂度"\} -->\n\n\$O\(n\^2 d\)\$\n/);
  assert.equal(after.slice(after.indexOf('## 另一张')), before.slice(before.indexOf('## 另一张')), '别的卡一个字节都不动');
  const list = (await request(app).get('/cards?deck=ml').expect(200)).text;
  assert.match(list, /自注意力的时间复杂度/);
  assert.match(list, /下次 /, '已复习过的状态保留，而不是变回新卡');
  assert.doesNotMatch(list, /workstation:card/, '元数据行不显示');
});

test('暂停的卡不进复习队列，恢复后回来；复习中途可以一键暂停', async t => {
  const { app, vaultDir } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'ml', front: '甲', back: '1' });
  await appendCard(vaultDir, { deckFile: 'ml', front: '乙', back: '2' });
  const first = (await queueOf(app)).find(item => item.id === 'ml/甲');
  const suspended = await request(app).post('/cards/suspend').set('Accept', 'application/json').send({ id: first.id, suspended: true }).expect(200);
  assert.equal(suspended.body.suspended, true);
  assert.deepEqual((await queueOf(app)).map(card => card.id), ['ml/乙']);
  const decks = (await request(app).get('/decks').expect(200)).text;
  assert.match(decks, /已暂停 1/);
  assert.match((await request(app).get('/cards?deck=ml').expect(200)).text, /已暂停/);
  await request(app).post('/cards/suspend').type('form').send({ id: first.id, suspended: '0', returnTo: '/cards?deck=ml' }).expect(302);
  assert.equal((await queueOf(app)).length, 2);
});

test('挪到别的卡组文件：新文件里出现、旧文件里消失，身份不变', async t => {
  const { app, vaultDir } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'inbox', front: '梯度消失', back: '用残差连接缓解' });
  const [card] = await queueOf(app);
  const file = await readNote(vaultDir, 'cards/inbox.md');
  const moved = await request(app).post('/cards/update').set('Accept', 'application/json').send({
    id: card.id, expectedHash: file.hash, front: '梯度消失', back: '用残差连接缓解', deckFile: 'deep-learning'
  }).expect(200);
  assert.equal(moved.body.id, 'inbox/梯度消失');
  assert.doesNotMatch(await read(vaultDir, 'inbox.md'), /梯度消失/);
  assert.match(await read(vaultDir, 'deep-learning.md'), /^---\ndeck: deep-learning\ntype: concept\n---\n[\s\S]*## 梯度消失\n<!-- workstation:card:v1 \{"id":"inbox\/梯度消失"/);
  assert.deepEqual((await queueOf(app)).map(item => [item.id, item.deck]), [['inbox/梯度消失', 'deep-learning']]);
});

test('删除卡片和版本冲突：外部改过的卡组文件拒绝覆盖', async t => {
  const { app, vaultDir } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'ml', front: '甲', back: '1' });
  await appendCard(vaultDir, { deckFile: 'ml', front: '乙', back: '2' });
  const stale = (await readNote(vaultDir, 'cards/ml.md')).hash;
  await fs.appendFile(path.join(vaultDir, 'cards', 'ml.md'), '\n## 丙\n\n外部加的\n');
  await request(app).post('/cards/delete').type('form').send({ id: 'ml/甲', expectedHash: stale }).expect(409);
  await assert.rejects(updateCard(vaultDir, { id: 'ml/甲', expectedHash: stale, front: '改' }), { status: 409 });
  const fresh = (await readNote(vaultDir, 'cards/ml.md')).hash;
  await deleteCard(vaultDir, { id: 'ml/甲', expectedHash: fresh });
  const after = await read(vaultDir, 'ml.md');
  assert.doesNotMatch(after, /## 甲/);
  assert.match(after, /## 乙\n\n2\n/);
  assert.match(after, /## 丙\n\n外部加的\n$/);
  await assert.rejects(updateCard(vaultDir, { id: 'ml/甲', suspended: true }), { status: 404 });
});

test('编辑页和写接口在只读模式下不可用；回跳地址只认应用内页面', async t => {
  const readOnly = await setup(t, { readOnly: true });
  await appendCard(readOnly.vaultDir, { deckFile: 'ml', front: '甲', back: '1' });
  await request(readOnly.app).get('/cards/edit?id=' + encodeURIComponent('ml/甲')).expect(403);
  await request(readOnly.app).post('/cards/suspend').send({ id: 'ml/甲', suspended: true }).expect(403);
  const list = (await request(readOnly.app).get('/cards').expect(200)).text;
  assert.doesNotMatch(list, /\/cards\/edit|\/cards\/suspend/);

  const writable = await setup(t);
  await appendCard(writable.vaultDir, { deckFile: 'ml', front: '甲', back: '1' });
  const page = (await request(writable.app).get('/cards/edit?id=' + encodeURIComponent('ml/甲') + '&returnTo=https://evil.example').expect(200)).text;
  assert.match(page, /name="returnTo" value="\/cards\?deck=ml"/);
  const review = (await request(writable.app).get('/review').expect(200)).text;
  assert.match(review, /id="review-edit"/);
  assert.match(review, /id="review-suspend"/);
});

test('卡片列表的预览把公式排出来，文字照常转义', () => {
  const { cardPreview } = require('../src/viewHelpers');
  const html = cardPreview('梯度 $\\hat y - y$ 与 <b> & [[链接|别名]]');
  assert.match(html, /^梯度 <span class="katex">/);
  assert.match(html, /<span class="mbin">−<\/span>/, '公式里的减号不被当成列表符号去掉');
  assert.match(html, /<\/span> 与 &lt;b&gt; &amp; 别名$/);
  assert.equal(cardPreview('只有 $ 一个美元符号'), '只有 $ 一个美元符号');
  assert.equal(cardPreview(''), '');
});

const { createReviewService } = require('../src/reviewService');
const { loadAllCards, splitCards, resolveDeckPath } = require('../src/cards');

async function vaultWithReviews(t) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-card-ids-'));
  t.after(() => fs.rm(vaultDir, { recursive: true, force: true }));
  const service = createReviewService({ vaultDir, device: 'test' });
  const review = async (id, times) => { for (let i = 0; i < times; i += 1) await service.answer(id, 3, 1000); };
  const counts = async () => Object.fromEntries((await service.withStates()).map(card => [`${card.path}:${card.front}:${card.back.split('\n')[0]}`, card.state.reviewCount]));
  const hash = async file => (await readNote(vaultDir, `cards/${file}`)).hash;
  return { vaultDir, review, counts, hash };
}

test('挪走后在原卡组新建同正面的卡：老卡的复习记录不会被新卡抢走', async t => {
  const { vaultDir, review, counts, hash } = await vaultWithReviews(t);
  await appendCard(vaultDir, { deckFile: 'inbox', front: '注意力机制', back: '老卡' });
  await review('inbox/注意力机制', 5);
  await updateCard(vaultDir, { id: 'inbox/注意力机制', deckFile: 'zoo', expectedHash: await hash('inbox.md') });
  await appendCard(vaultDir, { deckFile: 'inbox', front: '注意力机制', back: '新卡' });
  const result = await counts();
  assert.equal(result['cards/zoo.md:注意力机制:老卡'], 5);
  assert.equal(result['cards/inbox.md:注意力机制:新卡'], 0);
});

test('改过正面的卡上方又出现同旧正面的卡：固定的 id 优先', async t => {
  const { vaultDir, review, counts, hash } = await vaultWithReviews(t);
  await appendCard(vaultDir, { deckFile: 'd', front: 'A', back: '老卡' });
  await review('d/A', 4);
  await updateCard(vaultDir, { id: 'd/A', front: 'A（改过）', expectedHash: await hash('d.md') });
  const file = path.join(vaultDir, 'cards', 'd.md');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('## A（改过）', '## A\n\n新卡\n\n## A（改过）'));
  const result = await counts();
  assert.equal(result['cards/d.md:A（改过）:老卡'], 4);
  assert.equal(result['cards/d.md:A:新卡'], 0);
});

test('两张同正面的卡删掉第一张：第二张的 id 被固定，复习记录不串', async t => {
  const { vaultDir, review, counts, hash } = await vaultWithReviews(t);
  await appendCard(vaultDir, { deckFile: 'd', front: 'X', back: '第一张' });
  await appendCard(vaultDir, { deckFile: 'd', front: 'X', back: '第二张' });
  await review('d/X', 6);
  await review('d/X-2', 1);
  await deleteCard(vaultDir, { id: 'd/X', expectedHash: await hash('d.md') });
  assert.deepEqual(await counts(), { 'cards/d.md:X:第二张': 1 });
  assert.match(await read(vaultDir, 'd.md'), /## X\n<!-- workstation:card:v1 \{"id":"d\/X-2","legacy":"d\/X-2"\} -->/);
});

test('两个方向相反的挪卡组同时进行不会死锁', async t => {
  const { vaultDir, hash } = await vaultWithReviews(t);
  await appendCard(vaultDir, { deckFile: 'a', front: '甲', back: '1' });
  await appendCard(vaultDir, { deckFile: 'b', front: '乙', back: '2' });
  const [hashA, hashB] = [await hash('a.md'), await hash('b.md')];
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('死锁')), 5000));
  const results = await Promise.race([Promise.allSettled([
    updateCard(vaultDir, { id: 'a/甲', deckFile: 'b', expectedHash: hashA }),
    updateCard(vaultDir, { id: 'b/乙', deckFile: 'a', expectedHash: hashB })
  ]), timeout]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length >= 1, true);
  await appendCard(vaultDir, { deckFile: 'a', front: '丙', back: '3' });
  const fronts = (await loadAllCards(vaultDir)).map(card => card.front).sort();
  assert.deepEqual(fronts, ['丙', '乙', '甲']);
});

test('CRLF 换行的卡组照常识别；改动保持原来的换行风格', async t => {
  const { vaultDir, hash } = await vaultWithReviews(t);
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'cards', 'w.md'), '---\r\ndeck: w\r\n---\r\n\r\n## 甲\r\n\r\n答案一\r\n\r\n## 乙\r\n\r\n答案二\r\n');
  assert.deepEqual((await loadAllCards(vaultDir)).map(card => [card.id, card.back]), [['w/甲', '答案一'], ['w/乙', '答案二']]);
  await updateCard(vaultDir, { id: 'w/甲', suspended: true });
  await updateCard(vaultDir, { id: 'w/乙', back: '新答案\n第二行', expectedHash: await hash('w.md') });
  await appendCard(vaultDir, { deckFile: 'w', front: '丙', back: '三' });
  const raw = await read(vaultDir, 'w.md');
  assert.equal(raw.replace(/\r\n/g, '').includes('\n'), false, '不出现单独的 LF');
  assert.deepEqual((await loadAllCards(vaultDir)).map(card => [card.front, card.back, card.suspended]), [['甲', '答案一', true], ['乙', '新答案\n第二行', false], ['丙', '三', false]]);
});

test('卡组名按已有文件不区分大小写匹配；暂停只改元数据行', async t => {
  const { vaultDir } = await vaultWithReviews(t);
  await appendCard(vaultDir, { deckFile: 'english', front: 'robust', back: '稳健的' });
  assert.equal(await resolveDeckPath(vaultDir, 'English'), 'cards/english.md');
  assert.equal((await appendCard(vaultDir, { deckFile: 'ENGLISH', front: 'sparse', back: '稀疏的' })).path, 'cards/english.md');
  await fs.writeFile(path.join(vaultDir, 'cards', 'c.md'), '## C# #\n\n    indented code\n    line 2\n');
  const before = (await loadAllCards(vaultDir)).find(card => card.path === 'cards/c.md').id;
  await updateCard(vaultDir, { id: before, suspended: true });
  assert.equal(await read(vaultDir, 'c.md'), '## C# #\n<!-- workstation:card:v1 {"suspended":true} -->\n\n    indented code\n    line 2\n');
  assert.equal((await loadAllCards(vaultDir)).find(card => card.path === 'cards/c.md').id, before);
  assert.equal(splitCards('## Q\n\n    code\n').at(0).back, '    code', '背面开头的缩进保留');
});

test('删卡前的卡组版本记为「删除」，在历史页能看到并恢复', async t => {
  const { app, vaultDir } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'ml', front: '要删的卡', back: '内容' });
  const hash = (await readNote(vaultDir, 'cards/ml.md')).hash;
  await deleteCard(vaultDir, { id: 'ml/要删的卡', expectedHash: hash });
  const page = (await request(app).get('/history').expect(200)).text;
  assert.match(page, /cards\/ml\.md/);
  assert.match(page, /卡组/);
  const id = page.match(/href="\/history\?id=(deck%3A[^"&]+)/)[1];
  const preview = (await request(app).get('/history?id=' + id).expect(200)).text;
  assert.match(preview, /要删的卡/);
  await request(app).post('/history/restore-deck').type('form').send({ id: decodeURIComponent(id) }).expect(302);
  assert.match(await read(vaultDir, 'ml.md'), /## 要删的卡/);
});

test('三个固定 ID 副本及显式后缀全局唯一，按 ID 编辑正确卡片', async t => {
  const { vaultDir, review, counts, hash } = await vaultWithReviews(t);
  await fs.mkdir(path.join(vaultDir, 'cards'));
  for (const [file, id] of [['a', 'shared'], ['b', 'shared'], ['c', 'shared'], ['d', 'shared-2']]) {
    await fs.writeFile(path.join(vaultDir, 'cards', file + '.md'), '## '+file+'\n<!-- workstation:card:v1 '+JSON.stringify({ id })+' -->\nanswer\n');
  }
  const cards = await loadAllCards(vaultDir);
  assert.equal(new Set(cards.map(card => card.id)).size, 4);
  for (const [index, card] of cards.entries()) await review(card.id, index + 1);
  assert.deepEqual(Object.values(await counts()), [1, 2, 3, 4]);
  const target = cards.find(card => card.front === 'c');
  await updateCard(vaultDir, { id: target.id, back: 'updated', expectedHash: await hash('c.md') });
  assert.match(await read(vaultDir, 'c.md'), /updated/);
  assert.doesNotMatch(await read(vaultDir, 'b.md'), /updated/);
  const moved = await updateCard(vaultDir, { id: target.id, deckFile: 'z', expectedHash: await hash('c.md') });
  assert.equal(moved.id, target.id);
  const after = await loadAllCards(vaultDir);
  assert.equal(after.find(card => card.path === 'cards/z.md').id, target.id);
  assert.deepEqual(Object.values(await counts()).sort(), [1, 2, 3, 4]);
});

test('大量同名卡删除和移动后剩余身份保持不变', async t => {
  const { vaultDir, hash } = await vaultWithReviews(t);
  for (let i = 0; i < 10; i++) await appendCard(vaultDir, { deckFile: 'same', front: 'Q', back: String(i) });
  const original = await loadAllCards(vaultDir);
  await deleteCard(vaultDir, { id: original[0].id, expectedHash: await hash('same.md') });
  assert.deepEqual((await loadAllCards(vaultDir)).map(c => c.id), original.slice(1).map(c => c.id));
  await updateCard(vaultDir, { id: original[1].id, deckFile: 'target', expectedHash: await hash('same.md') });
  assert.deepEqual((await loadAllCards(vaultDir)).map(c => c.id).sort(), original.slice(1).map(c => c.id).sort());
});
