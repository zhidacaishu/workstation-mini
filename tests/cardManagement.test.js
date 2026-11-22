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
  const now = () => new Date('2026-10-28T10:00:00Z');
  const review = createReviewService({ vaultDir, device: config.device, now });
  const app = createApp(config, { db, indexer, search: createSearch(db), now, review });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, vaultDir, review };
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
  const restore = expectedHash => request(app).post('/history/restore-deck').type('form').send({ id: decodeURIComponent(id), expectedHash });
  const token = html => html.match(/name="expectedHash" value="([^"]+)"/)[1];
  await restore('').expect(409);
  await appendCard(vaultDir, { deckFile: 'ml', front: '预览后新增', back: '保留' });
  await restore(token(preview)).expect(409);
  assert.match(await read(vaultDir, 'ml.md'), /预览后新增/);
  const latest = (await request(app).get('/history?id=' + id)).text;
  await restore(token(latest)).expect(302);
  assert.match(await read(vaultDir, 'ml.md'), /## 要删的卡/);
  await fs.unlink(path.join(vaultDir, 'cards/ml.md'));
  await restore(token(latest)).expect(409);
  const missing = token((await request(app).get('/history?id=' + id)).text);
  assert.equal(missing, 'missing');
  await appendCard(vaultDir, { deckFile: 'ml', front: '同名卡组', back: '保留' });
  await restore(missing).expect(409);
  assert.match(await read(vaultDir, 'ml.md'), /同名卡组/);
  await fs.unlink(path.join(vaultDir, 'cards/ml.md'));
  await restore(missing).expect(302);
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

test('目标卡组的代码围栏未闭合时，拒绝追加和移动并保留两份原文', async t => {
  const { vaultDir } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'source', front: '题目', back: '源答案' });
  const source = await readNote(vaultDir, 'cards/source.md');
  const target = '## 摘录\n\n~~~python\nprint(1)\n';
  await fs.writeFile(path.join(vaultDir, 'cards', 'target.md'), target);
  await assert.rejects(appendCard(vaultDir, { deckFile: 'target', front: '新增' }), { status: 409 });
  await assert.rejects(updateCard(vaultDir, {
    id: 'source/题目', expectedHash: source.hash, deckFile: 'target'
  }), { status: 409 });
  assert.equal(await read(vaultDir, 'source.md'), source.raw);
  assert.equal(await read(vaultDir, 'target.md'), target);
});

test('长正面卡片挪入新建和已有卡组后仍使用原始复习身份', async t => {
  const { app, vaultDir } = await setup(t);
  const front = '长'.repeat(520);
  await appendCard(vaultDir, { deckFile: 'long', front });
  await appendCard(vaultDir, { deckFile: 'used', front: '已有卡' });
  for (const [from, to] of [['long', 'new'], ['new', 'used']]) {
    const id = 'long/' + front;
    const { hash } = await readNote(vaultDir, 'cards/' + from + '.md');
    await updateCard(vaultDir, { id, expectedHash: hash, deckFile: to });
    assert.equal((await queueOf(app)).filter(card => card.id === id).length, 1);
    assert.equal((await read(vaultDir, from + '.md')).includes(front), false);
  }
});

test('三反引号行内代码、背面中的元数据注释以及带空格尾井号标题编辑均保持安全', async t => {
  const { splitCards, parseCardFile } = require('../src/cards');
  const { vaultDir } = await setup(t);

  await appendCard(vaultDir, { deckFile: 'edge', front: '行内三反引号', back: '```foo``` 是行内代码' });
  await appendCard(vaultDir, { deckFile: 'edge', front: '第二张卡', back: '不被吞并' });
  const edgeRaw = await read(vaultDir, 'edge.md');
  assert.doesNotMatch(edgeRaw, /\n```\n/, '不应给行内三反引号补闭合围栏');
  assert.deepEqual(splitCards(edgeRaw).map(c => c.front), ['行内三反引号', '第二张卡']);

  const forgedRaw = '## 无元数据卡\n\n背面正文\n<!-- workstation:card:v1 {"id":"hijack","suspended":true} -->\n\n## 后一张\n答案\n';
  const forged = parseCardFile('cards/forged.md', forgedRaw);
  assert.equal(forged[0].id, 'forged/无元数据卡');
  assert.equal(forged[0].suspended, false);
  assert.match(forged[0].back, /workstation:card:v1/);

  await fs.writeFile(path.join(vaultDir, 'cards', 'sharp.md'), '## C# #\n\n旧答案\n');
  const beforeHash = (await readNote(vaultDir, 'cards/sharp.md')).hash;
  await updateCard(vaultDir, { id: 'sharp/C#', back: '新答案', expectedHash: beforeHash });
  const sharpAfter = await read(vaultDir, 'sharp.md');
  assert.equal(sharpAfter, '## C# #\n\n新答案\n');

  const first = '---\r\ndeck: crlf\r\n---\r\n\r\n## Q1\r\n\r\nA1\r\n\r\n\r\n第二段  \r\n';
  await fs.writeFile(path.join(vaultDir, 'cards', 'crlf-end.md'), first + '\r\n## Q2\r\n\r\nA2\r\n');
  const h1 = (await readNote(vaultDir, 'cards/crlf-end.md')).hash;
  const u1 = await updateCard(vaultDir, { id: 'crlf-end/Q2', back: 'A2-new', expectedHash: h1 });
  assert.equal((await read(vaultDir, 'crlf-end.md')).includes('\r\r\n'), false, 'CRLF 更新末张卡不应出现 \\r\\r\\n');
  await deleteCard(vaultDir, { id: 'crlf-end/Q2', expectedHash: u1.hash });
  const crlfAfterDelete = await read(vaultDir, 'crlf-end.md');
  assert.equal(crlfAfterDelete, first);
  assert.equal(crlfAfterDelete.includes('\r\r\n'), false, 'CRLF 删除末张卡不应出现 \\r\\r\\n');
  assert.equal(crlfAfterDelete.replace(/\r\n/g, '').includes('\n'), false);
});

test('标题下有空行的旧卡保留评分和暂停状态，新卡背面的元数据示例可往返编辑', async t => {
  const { vaultDir, app } = await setup(t);
  const { parseCardFile } = require('../src/cards');
  await appendCard(vaultDir, { deckFile: 'old', front: '原题', back: '答案' });
  const id = 'old/原题';
  await request(app).post('/review/answer').send({ cardId: id, rating: 3, eventId: 'before-format' }).expect(200);
  const meta = '<!-- workstation:card:v1 {"id":"old/原题","suspended":true} -->';
  const file = path.join(vaultDir, 'cards', 'old.md');
  await fs.writeFile(file, ['## 新标题', ' \t', '', meta, '', '答案', ''].join('\r\n'));
  assert.equal(parseCardFile('cards/old.md', await read(vaultDir, 'old.md'))[0].suspended, true);
  await updateCard(vaultDir, { id, suspended: false });
  const live = await request(app).post('/api/review-round').send({ ids: [id] }).expect(200);
  assert.equal(live.body.cards[0].reviewCount, 1);

  const literal = { deckFile: 'example', front: '注释示例', back: meta };
  await appendCard(vaultDir, literal);
  const exampleId = 'example/注释示例';
  await updateCard(vaultDir, { id: exampleId, suspended: true });
  const { hash } = await updateCard(vaultDir, { id: exampleId, suspended: false });
  await updateCard(vaultDir, { id: exampleId, expectedHash: hash, back: meta + '\n第二行' });
  const [example] = parseCardFile('cards/example.md', await read(vaultDir, 'example.md'));
  assert.equal(example.id, exampleId);
  assert.equal(example.suspended, false);
  assert.equal(example.back, meta + '\n第二行');
});

test('缩进与围栏内的元数据示例在卡组文件和复习题面中保留', async t => {
  const { app, vaultDir } = await setup(t);
  const marker = '<!-- workstation:card:v1 {"id":"other","suspended":true} -->';
  const examples = ['    ' + marker, '\t' + marker, '  \t' + marker, '~~~\n' + marker + '\n~~~'];
  for (const [index, back] of examples.entries()) {
    await request(app).post('/cards/add').send({ front: 'Q' + index, back, deckFile: 'code' }).expect(200);
  }
  const { parseCardFile } = require('../src/cards');
  const parsed = parseCardFile('cards/code.md', await read(vaultDir, 'code.md'));
  assert.deepEqual(parsed.map(card => card.back), examples);
  const queue = await queueOf(app);
  assert.deepEqual(queue.map(card => card.id), examples.map((_, index) => 'code/Q' + index));
  for (const card of queue) {
    assert.match(card.back, /<pre\b[^>]*><code\b/);
    assert.match(card.back, /workstation:card:v1/);
  }
});

test('新增带后缀的题面、删除跨卡组原卡或重建同名卡都不会转移评分', async t => {
  const { vaultDir, hash, review, counts } = await vaultWithReviews(t);
  const add = (deckFile, front, back) => appendCard(vaultDir, { deckFile, front, back, checkDuplicate: true });
  await fs.mkdir(path.join(vaultDir, 'cards'));
  await fs.writeFile(path.join(vaultDir, 'cards', 'd.md'), '## A\n\none\n\n## A\n\ntwo\n');
  await review('d/A-2', 2);
  await add('d', 'A-2', 'three');
  assert.deepEqual(await counts(), { 'cards/d.md:A:one': 0, 'cards/d.md:A:two': 2, 'cards/d.md:A-2:three': 0 });

  await add('a', 'Q', 'original');
  await review('a/Q', 3);
  await updateCard(vaultDir, { id: 'a/Q', expectedHash: await hash('a.md'), deckFile: 'z' });
  // 模拟旧版本已经存在的、尚未把后缀写入元数据的卡。
  await fs.writeFile(path.join(vaultDir, 'cards', 'a.md'), '## Q\n\nsecond\n');
  await review('a/Q-2', 1);
  await deleteCard(vaultDir, { id: 'a/Q', expectedHash: await hash('z.md') });
  assert.equal((await counts())['cards/a.md:Q:second'], 1);
  assert.equal((await loadAllCards(vaultDir)).find(card => card.back === 'second').id, 'a/Q-2');
  await add('a', 'Q', 'third');
  assert.equal((await counts())['cards/a.md:Q:third'], 0);
});

test('编辑页使用卡片正文所在快照的哈希，旧页面提交会报告冲突', async t => {
  const { vaultDir, app, review } = await setup(t);
  await appendCard(vaultDir, { deckFile: 'deck', front: 'Q', back: 'old' });
  const snapshot = await review.allCards();
  const before = await readNote(vaultDir, 'cards/deck.md');
  t.mock.method(review, 'allCards', async () => snapshot);
  await fs.writeFile(path.join(vaultDir, 'cards', 'deck.md'), before.raw.replace('old', 'new'));
  const page = await request(app).get('/cards/edit').query({ id: 'deck/Q' }).expect(200);
  const expectedHash = page.text.match(/name="expectedHash" value="([^"]+)"/)[1];
  assert.equal(expectedHash, before.hash);
  await request(app).post('/cards/update').send({ id: 'deck/Q', expectedHash, front: 'changed', back: 'old' }).expect(409);
  assert.match(await read(vaultDir, 'deck.md'), /new/);
});

test('整组恢复时已移走的活卡保留身份与评分', async t => {
  const { vaultDir, app, review } = await setup(t);
  const hash = async file => (await readNote(vaultDir, 'cards/' + file + '.md')).hash;
  await appendCard(vaultDir, { deckFile: 'z', front: 'Q', back: 'first' });
  await updateCard(vaultDir, { id: 'z/Q', deckFile: 'a', expectedHash: await hash('z') });
  await updateCard(vaultDir, { id: 'z/Q', deckFile: 'y', back: 'changed', expectedHash: await hash('a') });
  await review.answer('z/Q', 3, 1000);
  await appendCard(vaultDir, { deckFile: 'z', front: 'Q', back: 'retired' });
  await review.answer('z/Q-2', 3, 1000);
  await deleteCard(vaultDir, { id: 'z/Q-2', expectedHash: await hash('z') });
  const { listRecords } = require('../src/vault/history');
  const [snapshot] = await listRecords(vaultDir, 'cards/a.md');
  await request(app).post('/history/restore-deck').type('form')
    .send({ id: 'deck:' + snapshot.id, expectedHash: await hash('a') }).expect(302);
  const cards = await review.withStates();
  assert.equal(cards.find(card => card.back === 'changed').id, 'z/Q');
  assert.equal(cards.find(card => card.back === 'changed').state.reviewCount, 1);
  assert.equal(cards.find(card => card.back === 'first').state.reviewCount, 0);
});
