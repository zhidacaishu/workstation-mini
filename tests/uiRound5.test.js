// 第五轮（界面与体验）新增功能的回归测试：快速添加待办、撤销评分、编辑器的预览/补全/贴图、
// 代码高亮、挖空就地显示、阅读行宽、健康页的两处提示、历史逐行对比。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { writeNote } = require('../src/vault/note');
const { saveVersion, listRecords } = require('../src/vault/history');
const { renderMarkdown } = require('../src/markdown');
const { parseCloze, markClozeAnswers, renderClozeAnswer } = require('../src/cards');
const ui = require('../src/viewHelpers');
const { compareText, diffLines } = require('../src/lineDiff');
const { sniffImage } = require('../src/routes/editorRoutes');
const { validateConflictChoices } = require('../electron/settings-validation');

const FIXED_NOW = new Date(2026, 10, 13, 9, 30, 5);
const TODAY = '2026-11-13';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

async function setup({ readOnly = false, syncEnabled = false, notes = {}, cards = {} } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ui5-'));
  const notesDir = path.join(vaultDir, 'notes');
  for (const dir of ['notes', 'cards', 'reviews']) await fs.mkdir(path.join(vaultDir, dir), { recursive: true });
  for (const [name, body] of Object.entries(notes)) await writeNote(notesDir, name, { raw: body });
  for (const [name, content] of Object.entries(cards)) await fs.writeFile(path.join(vaultDir, 'cards', name), content, 'utf8');
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, syncEnabled, device: 'desk' });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  await indexer.scan();
  const app = createApp(config, { db, indexer, search: createSearch(db), now: () => FIXED_NOW });
  return {
    app, db, indexer, config, vaultDir, notesDir,
    read: name => fsSync.readFileSync(path.join(notesDir, name), 'utf8'),
    reviewLines: () => fsSync.readdirSync(path.join(vaultDir, 'reviews'))
      .flatMap(file => fsSync.readFileSync(path.join(vaultDir, 'reviews', file), 'utf8').split('\n').filter(Boolean).map(JSON.parse)),
    async cleanup() { db.close(); await fs.rm(vaultDir, { recursive: true, force: true }); }
  };
}

// ── 小工具 ────────────────────────────────────────────────────────────────

test('dueLabel：逾期、今天、明后天、本周内的星期、更远的短日期', () => {
  assert.equal(ui.dueLabel('2026-11-10', TODAY), '逾期 3 天');
  assert.equal(ui.dueLabel(TODAY, TODAY), '今天');
  assert.equal(ui.dueLabel('2026-11-14', TODAY), '明天');
  assert.equal(ui.dueLabel('2026-11-15', TODAY), '后天');
  assert.match(ui.dueLabel('2026-11-18', TODAY), /^(周|星期)三$/);
  assert.match(ui.dueLabel('2026-12-25', TODAY), /12.*25/);
  assert.equal(ui.dueLabel('', TODAY), '');
  assert.equal(ui.dueLabel('不是日期', TODAY), '');
});

test('inlineTitle 把标题里的行内公式排出来，尖括号照样转义', () => {
  const html = ui.inlineTitle('证明 $\\rho<1$ 时稳定 <script>');
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /\$\\rho/);
  assert.doesNotMatch(html, /<script>/);
});

test('plainSnippet 不把嵌入图片、双链路径和日期标记的源码露出来', () => {
  const text = ui.plainSnippet('见 [[projects/尾延迟/基线复现|基线]] 和 [[inbox/排队论]] ![[图.png]] 周五交 @2026-11-20');
  assert.doesNotMatch(text, /\[\[|\]\]|!\[|@2026/);
  assert.match(text, /基线/);
  assert.match(text, /排队论/);
  assert.doesNotMatch(text, /inbox\//);
});

test('代码块按标注的语言高亮；没标语言或不认识的语言原样输出，不猜', () => {
  const python = renderMarkdown('```python\ndef f(x):\n    return "a" + 1  # 注释\n```\n');
  assert.match(python, /class="hljs-keyword">def</);
  assert.match(python, /class="hljs-string"/);
  assert.match(python, /class="hljs-comment"/);
  const plain = renderMarkdown('```\ndef f(x): <b>\n```\n');
  assert.doesNotMatch(plain, /hljs-/);
  assert.match(plain, /&lt;b&gt;/);
  const unknown = renderMarkdown('```brainfuck\n+++ <i>\n```\n');
  assert.doesNotMatch(unknown, /hljs-keyword/);
  assert.match(unknown, /&lt;i&gt;/);
  assert.doesNotMatch(renderMarkdown('```html\n<script>alert(1)</script>\n```\n'), /<script>/);
});

test('挖空：正面留空，背面在原位标出答案，答案里的尖括号不变成标签', () => {
  const cloze = parseCloze('排队稳定的条件是 {{ρ < 1}}，否则 {{队长发散}}。');
  assert.deepEqual(cloze.answers, ['ρ < 1', '队长发散']);
  assert.doesNotMatch(cloze.masked, /ρ/);
  const html = markClozeAnswers(renderMarkdown(cloze.marked));
  assert.equal((html.match(/<mark class="cloze-answer">/g) || []).length, 2);
  assert.match(html, /<mark class="cloze-answer">ρ &lt; 1<\/mark>/);
  assert.doesNotMatch(html, /[]/);
  // 没有挖空的卡片原样返回。
  assert.equal(markClozeAnswers('<p>普通</p>'), '<p>普通</p>');
});

test('挖空高亮只在不改变排版时才加：整块公式、列表、跨段落的答案照常渲染，不高亮', () => {
  const render = text => renderMarkdown(text);
  const marks = html => (html.match(/<mark class="cloze-answer">/g) || []).length;
  const inline = renderClozeAnswer('负载 {{ $\\rho<1$ }} 时 {{**稳定**}}', render);
  assert.equal(marks(inline), 2);
  assert.match(inline, /<mark class="cloze-answer"><span class="math-source"/);
  assert.match(inline, /<mark class="cloze-answer"><strong>稳定<\/strong><\/mark>/);

  // 夹上标记以后这些会变样（公式成了源码、<mark> 横跨列表项），所以退回不高亮的填充结果。
  for (const [text, expected] of [
    ['{{$$x^2$$}}', /class="math-source math-display"/],
    ['{{- 甲\n- 乙}}', /<ul>\s*<li[^>]*>甲<\/li>\s*<li[^>]*>乙<\/li>\s*<\/ul>/],
    ['前 {{一段\n\n另一段}} 后', /<p[^>]*>前 一段<\/p>\s*<p[^>]*>另一段 后<\/p>/],
    ['![图 {{x}}](a.png)', /<img[^>]*alt="图 x"/]
  ]) {
    const html = renderClozeAnswer(text, render);
    assert.equal(marks(html), 0, text);
    assert.match(html, expected, text);
    assert.equal(html, render(parseCloze(text).filled), text);
    assert.doesNotMatch(html, /[\uE000\uE001]/, text);
  }
  assert.equal(renderClozeAnswer('没有挖空', render), render('没有挖空'));
});

test('sniffImage 只认四种位图的文件头', () => {
  assert.equal(sniffImage(PNG), 'png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'gif');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), '');
  assert.equal(sniffImage(Buffer.from('%PDF-1.7')), '');
  assert.equal(sniffImage(Buffer.alloc(0)), '');
});

test('逐行对比：只动了一行的大文件很快，差太多就放弃，末尾换行不算一行', () => {
  assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc').map(op => op.type), ['same', 'del', 'add', 'same']);
  assert.equal(compareText('a\nb\n', 'a\nb').changed, false);
  assert.deepEqual(diffLines('', 'x'), [{ type: 'add', text: 'x' }]);
  assert.deepEqual(diffLines('x', ''), [{ type: 'del', text: 'x' }]);

  const big = Array.from({ length: 20000 }, (_, index) => `第 ${index} 行`);
  const edited = [...big]; edited[9000] = '改过'; edited.push('末尾加的');
  const result = compareText(big.join('\n'), edited.join('\n'));
  assert.deepEqual([result.added, result.removed, result.tooLarge], [2, 1, false]);
  // 改动前后各留 3 行，其余折起来。
  assert.deepEqual(result.hunks.map(hunk => hunk.type), ['skip', 'lines', 'skip', 'lines']);
  assert.equal(result.hunks[0].count, 8997);
  const changed = result.hunks[1].rows.find(row => row.type === 'del');
  assert.deepEqual([changed.fromLine, changed.toLine, changed.text], [9001, null, '第 9000 行']);

  const other = Array.from({ length: 20000 }, (_, index) => `完全不同 ${index}`);
  assert.equal(compareText(big.join('\n'), other.join('\n')).tooLarge, true);
});

test('冲突选择的校验：只收三种取值和仓库内的相对路径', () => {
  assert.deepEqual(validateConflictChoices({ 'notes/a.md': 'remote', 'cards/b.md': 'local', 'notes/c d.md': 'current' }),
    { 'notes/a.md': 'remote', 'cards/b.md': 'local', 'notes/c d.md': 'current' });
  for (const bad of [null, [], 'x', { 'notes/a.md': 'both' }, { '../x.md': 'remote' }, { '/etc/passwd': 'local' }, { 'a/../../b.md': 'local' }, { '': 'local' }, { 'a\0b': 'local' }]) {
    assert.throws(() => validateConflictChoices(bad), /冲突|选择/);
  }
});

// ── 快速添加待办 ───────────────────────────────────────────────────────────

test('POST /plan/tasks：写进今天的月历备注，带截止日期，回到来的那一页', async () => {
  const ctx = await setup();
  try {
    const first = await request(ctx.app).post('/plan/tasks').type('form')
      .send({ text: '  给导师发\n本周进展  ', due: '2026-11-20', returnTo: '/plan?view=list' }).expect(302);
    assert.equal(first.headers.location, '/plan?view=list&added=1');
    assert.match(ctx.read(`calendar/${TODAY}.md`), /^- \[ \] 给导师发 本周进展 @2026-11-20$/m);

    // 已有列表时直接续一项；文字里手写了日期就不再追加第二个。
    const second = await request(ctx.app).post('/plan/tasks').type('form')
      .send({ text: '订会议室 @2026-11-15', due: TODAY, returnTo: '/' }).expect(302);
    assert.equal(second.headers.location, '/?added=1');
    assert.match(ctx.read(`calendar/${TODAY}.md`), /- \[ \] 给导师发 本周进展 @2026-11-20\n- \[ \] 订会议室 @2026-11-15\n$/);

    const page = await request(ctx.app).get('/plan?view=list').expect(200);
    assert.match(page.text, /给导师发 本周进展/);
    assert.match(page.text, /class="plan-quick-add"/);
    const home = await request(ctx.app).get('/').expect(200);
    assert.match(home.text, /data-quick-add/);
  } finally { await ctx.cleanup(); }
});

test('POST /plan/tasks：接在普通段落后面空一行；保留原来的换行风格；JSON 调用返回路径', async () => {
  const ctx = await setup({ notes: { [`calendar/${TODAY}.md`]: '---\r\ntitle: 备注\r\n---\r\n今天开组会。\r\n' } });
  try {
    const response = await request(ctx.app).post('/plan/tasks').set('Accept', 'application/json').send({ text: '整理纪要' }).expect(200);
    assert.deepEqual(response.body, { ok: true, path: `calendar/${TODAY}.md` });
    assert.equal(ctx.read(`calendar/${TODAY}.md`), '---\r\ntitle: 备注\r\n---\r\n今天开组会。\r\n\r\n- [ ] 整理纪要\r\n');
  } finally { await ctx.cleanup(); }
});

test('POST /plan/tasks：空内容、太长、坏日期、只读都拒绝；不认识的返回地址回计划页', async () => {
  const ctx = await setup();
  const readOnly = await setup({ readOnly: true });
  try {
    await request(ctx.app).post('/plan/tasks').type('form').send({ text: '   ' }).expect(400);
    await request(ctx.app).post('/plan/tasks').type('form').send({ text: 'x'.repeat(501) }).expect(400);
    await request(ctx.app).post('/plan/tasks').type('form').send({ text: '事', due: '2026-13-40' }).expect(400);
    assert.equal(fsSync.existsSync(path.join(ctx.notesDir, 'calendar')), false);
    const stray = await request(ctx.app).post('/plan/tasks').type('form').send({ text: '事', returnTo: 'https://example.invalid/' }).expect(302);
    assert.equal(stray.headers.location, '/plan?view=list&added=1');
    await request(readOnly.app).post('/plan/tasks').type('form').send({ text: '事' }).expect(403);
    const page = await request(readOnly.app).get('/plan?view=list').expect(200);
    assert.doesNotMatch(page.text, /plan-quick-add/);
  } finally { await ctx.cleanup(); await readOnly.cleanup(); }
});

// ── 撤销评分 ───────────────────────────────────────────────────────────────

const DECK = ['---', 'deck: 排队论', '---', '', '## M/M/1 的平均队长', '$L = \\frac{\\rho}{1-\\rho}$', '', '## 稳定条件', '{{ρ < 1}}', ''].join('\n');

test('POST /review/undo：只能撤销最后一次评分，撤销后那张卡回到队列', async () => {
  const ctx = await setup({ cards: { '排队论.md': DECK } });
  try {
    const page = await request(ctx.app).get('/review').expect(200);
    const queue = JSON.parse(decodeURIComponent(page.text.match(/data-queue="([^"]*)"/)[1]));
    assert.equal(queue.length, 2);
    assert.match(page.text, /id="review-undo"/);
    // 挖空卡的背面在原位标出答案。
    assert.match(JSON.stringify(queue), /cloze-answer/);

    await request(ctx.app).post('/review/answer').send({ cardId: queue[0].id, rating: 3, elapsedMs: 1000, eventId: 'e-1' }).expect(200);
    await request(ctx.app).post('/review/answer').send({ cardId: queue[1].id, rating: 1, elapsedMs: 1000, eventId: 'e-2' }).expect(200);
    assert.equal(ctx.reviewLines().length, 2);

    const stale = await request(ctx.app).post('/review/undo').send({ eventId: 'e-1' }).expect(409);
    assert.match(stale.body.error || stale.text, /只能撤销最后一次评分/);
    await request(ctx.app).post('/review/undo').send({}).expect(400);
    assert.equal(ctx.reviewLines().length, 2);

    const undone = await request(ctx.app).post('/review/undo').send({ eventId: 'e-2' }).expect(200);
    assert.deepEqual(undone.body, { ok: true, eventId: 'e-2' });
    assert.deepEqual(ctx.reviewLines().filter(line => line.type !== 'undo').map(line => line.event_id), ['e-1', 'e-2']);
    assert.equal(ctx.reviewLines().at(-1).undo_event_id, 'e-2');
    // 同一条撤销可重试，不重复追加撤销事件。
    await request(ctx.app).post('/review/undo').send({ eventId: 'e-2' }).expect(200);
    assert.equal(ctx.reviewLines().filter(line => line.type === 'undo').length, 1);

    const again = await request(ctx.app).get('/review').expect(200);
    const left = JSON.parse(decodeURIComponent(again.text.match(/data-queue="([^"]*)"/)[1]));
    assert.deepEqual(left.map(card => card.id), [queue[1].id]);
    // 撤销记录与评分同文件追加，原日志不删除。
    assert.deepEqual(fsSync.readdirSync(path.join(ctx.vaultDir, 'reviews')), ['2026-11-desk.jsonl']);
    await request(ctx.app).post('/review/undo').send({ eventId: 'e-1' }).expect(200);
    assert.deepEqual(ctx.reviewLines().filter(line => line.type === 'undo').map(line => line.undo_event_id), ['e-2', 'e-1']);
    const resetPage = await request(ctx.app).get('/review').expect(200);
    assert.equal(JSON.parse(decodeURIComponent(resetPage.text.match(/data-queue="([^"]*)"/)[1])).length, 2);
  } finally { await ctx.cleanup(); }
});

// ── 编辑器接口 ─────────────────────────────────────────────────────────────

test('POST /api/preview：和阅读页同一套渲染；属性区没写完时只报原因；卡片预览标出挖空', async () => {
  const ctx = await setup({ notes: { 'inbox/排队论.md': '# 排队论\n' } });
  try {
    const note = await request(ctx.app).post('/api/preview')
      .send({ kind: 'note', path: 'inbox/草稿.md', raw: '---\ntitle: 草稿\n---\n# 标题\n\n$a^2$ 见 [[排队论]]\n\n- [ ] 待办\n\n```python\nprint(1)\n```\n' }).expect(200);
    assert.match(note.body.html, /<h1[^>]*>标题<\/h1>/);
    assert.match(note.body.html, /class="katex"/);
    assert.match(note.body.html, /href="\/note\/inbox\/[^"]*"/);
    assert.match(note.body.html, /hljs-/);
    assert.doesNotMatch(note.body.html, /title: 草稿/);
    // 预览里的待办不能勾。
    assert.doesNotMatch(note.body.html, /data-task-toggle|action="\/tasks/);

    const broken = await request(ctx.app).post('/api/preview').send({ kind: 'note', raw: '---\ntitle: [没写完\n---\n正文\n' }).expect(200);
    assert.equal(broken.body.html, '');
    assert.match(broken.body.error, /属性区/);

    const card = await request(ctx.app).post('/api/preview').send({ kind: 'card', front: '**条件** $x<1$', raw: '条件是 {{ρ < 1}}' }).expect(200);
    assert.match(card.body.html, /<mark class="cloze-answer">ρ &lt; 1<\/mark>/);

    assert.match(card.body.frontHtml, /<strong>条件<\/strong>/);
    assert.match(card.body.frontHtml, /class="katex"/);
    const unsafe = await request(ctx.app).post('/api/preview').send({ kind: 'note', path: '../../etc/x.md', raw: '<script>alert(1)</script>\n\n正文' }).expect(200);
    assert.doesNotMatch(unsafe.body.html, /<script>/);
  } finally { await ctx.cleanup(); }
});

test('GET /api/link-suggest：文件名唯一时只给文件名，重名给完整路径，月历备注排后面', async () => {
  const ctx = await setup({ notes: {
    'inbox/排队论读书笔记.md': '# 排队论读书笔记\n',
    'projects/a/基线.md': '# 甲的基线\n',
    'projects/b/基线.md': '# 乙的基线\n',
    'calendar/2026-11-01.md': '# 排队论讨论\n'
  } });
  try {
    const hit = (await request(ctx.app).get('/api/link-suggest').query({ q: '排队' }).expect(200)).body.results;
    assert.deepEqual(hit.map(item => item.target), ['排队论读书笔记', '2026-11-01']);
    assert.equal(hit[0].title, '排队论读书笔记');
    assert.equal(hit[0].path, 'inbox/排队论读书笔记.md');

    const duplicate = (await request(ctx.app).get('/api/link-suggest').query({ q: '基线' }).expect(200)).body.results;
    assert.deepEqual(duplicate.map(item => item.target).sort(), ['projects/a/基线', 'projects/b/基线']);

    assert.equal((await request(ctx.app).get('/api/link-suggest').query({ q: '没有这篇' }).expect(200)).body.results.length, 0);
    assert.equal((await request(ctx.app).get('/api/link-suggest').expect(200)).body.results.length, 4);
    // 多个词都要命中。
    assert.equal((await request(ctx.app).get('/api/link-suggest').query({ q: '排队 笔记' }).expect(200)).body.results.length, 1);
  } finally { await ctx.cleanup(); }
});

test('POST /api/attachments：图片存进 attachments/，同一秒再贴不覆盖；不是图片、空内容、只读都拒绝', async () => {
  const ctx = await setup();
  const readOnly = await setup({ readOnly: true });
  try {
    const first = await request(ctx.app).post('/api/attachments').set('Content-Type', 'image/png').send(PNG).expect(200);
    assert.deepEqual(first.body, { ok: true, name: '20261113-093005.png', path: 'attachments/20261113-093005.png', markdown: '![[20261113-093005.png]]', bytes: PNG.length });
    const second = await request(ctx.app).post('/api/attachments').set('Content-Type', 'application/octet-stream').send(PNG).expect(200);
    assert.equal(second.body.name, '20261113-093005-2.png');
    const dir = path.join(ctx.vaultDir, 'attachments');
    assert.deepEqual(fsSync.readdirSync(dir).sort(), ['20261113-093005-2.png', '20261113-093005.png']);
    assert.deepEqual(fsSync.readFileSync(path.join(dir, first.body.name)), PNG);

    // 请求头说是图片也没用，看的是内容。
    await request(ctx.app).post('/api/attachments').set('Content-Type', 'image/png').send(Buffer.from('<svg><script/></svg>')).expect(415);
    await request(ctx.app).post('/api/attachments').set('Content-Type', 'image/png').send(Buffer.alloc(0)).expect(400);
    await request(ctx.app).post('/api/attachments').set('Content-Type', 'image/png').send(Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)])).expect(413);
    assert.equal(fsSync.readdirSync(dir).length, 2);

    await request(readOnly.app).post('/api/attachments').set('Content-Type', 'image/png').send(PNG).expect(403);
    assert.equal(fsSync.existsSync(path.join(readOnly.vaultDir, 'attachments')), false);
  } finally { await ctx.cleanup(); await readOnly.cleanup(); }
});

test('编辑页带上分栏预览、补全和贴图的开关；只读时不加载编辑器脚本', async () => {
  const ctx = await setup({ notes: { 'inbox/a.md': '# 甲\n' } });
  const readOnly = await setup({ readOnly: true, notes: { 'inbox/a.md': '# 甲\n' } });
  try {
    const page = await request(ctx.app).get('/edit/inbox/a.md').expect(200);
    assert.match(page.text, /<textarea[^>]*data-md-editor[^>]*data-upload="1"[^>]*data-preview="#editor-preview"/);
    assert.match(page.text, /id="editor-preview"/);
    assert.match(page.text, /data-preview-toggle/);
    assert.match(page.text, /src="\/static\/editor\.js"/);
    const note = await request(readOnly.app).get('/note/inbox/a.md').expect(200);
    assert.doesNotMatch(note.text, /\/static\/editor\.js/);
  } finally { await ctx.cleanup(); await readOnly.cleanup(); }
});

// ── 阅读行宽 ───────────────────────────────────────────────────────────────

test('旧版行宽 cookie 不限制笔记正文，菜单不再提供行宽操作', async () => {
  const ctx = await setup({ notes: { 'inbox/a.md': '# 甲\n\n正文\n' } });
  try {
    const page = await request(ctx.app).get('/note/inbox/a.md').set('Cookie', 'reading_width=comfort').expect(200);
    assert.doesNotMatch(page.text, /is-comfort|舒适行宽|正文铺满窗口|prefs\/reading-width/);
  } finally { await ctx.cleanup(); }
});

// ── 健康页 ─────────────────────────────────────────────────────────────────

test('健康页：没开同步时资料库不是 Git 仓库不算问题；开了同步才提醒', async () => {
  const off = await setup({ syncEnabled: false, notes: { 'inbox/a.md': '# 甲\n' } });
  const on = await setup({ syncEnabled: true, notes: { 'inbox/a.md': '# 甲\n' } });
  try {
    const report = (await request(off.app).get('/api/health').expect(200)).body;
    assert.equal(report.sync.enabled, false);
    assert.equal(report.git.isRepository, false);
    assert.equal(report.git.error, undefined, '「不是仓库」是明确的答案，不是探测失败');
    const page = await request(off.app).get('/health').expect(200);
    assert.match(page.text, /一切正常/);
    assert.match(page.text, /Git <strong>未启用/);
    assert.match(page.text, /不影响本机使用/);
    assert.doesNotMatch(page.text, /状态未知/);

    const warned = await request(on.app).get('/health').expect(200);
    assert.match(warned.text, /1 项需要留意/);
    assert.match(warned.text, /Git <strong>不是仓库/);
    assert.match(warned.text, /还不是 Git 仓库/);
  } finally { await off.cleanup(); await on.cleanup(); }
});

test('健康页：断链逐条列出来源笔记和写的目标，不带正文', async () => {
  const ctx = await setup({ notes: {
    'inbox/来源.md': '# 来源笔记\n\n机密正文 [[不存在的笔记]] 和 [[另一篇|别名]]，还有 [[存在]]。\n',
    'inbox/存在.md': '# 存在\n'
  } });
  try {
    const report = (await request(ctx.app).get('/api/health').expect(200)).body;
    assert.equal(report.links.brokenCount, 2);
    assert.deepEqual(report.links.broken, [
      { path: 'inbox/来源.md', target: '不存在的笔记', title: '来源笔记' },
      { path: 'inbox/来源.md', target: '另一篇', title: '来源笔记' }
    ]);
    assert.equal(report.links.brokenTruncated, false);
    assert.doesNotMatch(JSON.stringify(report), /机密正文/);

    const page = await request(ctx.app).get('/health').expect(200);
    assert.match(page.text, /id="broken-links"/);
    assert.match(page.text, /href="#broken-links"/);
    assert.match(page.text, /<a href="\/note\/inbox\/[^"]+"[^>]*>来源笔记<\/a>/);
    assert.match(page.text, /\[\[不存在的笔记\]\]/);

    const clean = await setup({ notes: { 'inbox/a.md': '# 甲\n' } });
    try { assert.doesNotMatch((await request(clean.app).get('/health').expect(200)).text, /id="broken-links"/); }
    finally { await clean.cleanup(); }
  } finally { await ctx.cleanup(); }
});

// ── 历史逐行对比 ───────────────────────────────────────────────────────────

test('历史页：默认显示和现在相比改了哪些行，可以切回全文', async () => {
  const ctx = await setup({ notes: { 'inbox/a.md': '# 甲\n\n第一行\n第二行（新）\n第三行\n新加的\n' } });
  try {
    await saveVersion(ctx.notesDir, 'inbox/a.md', '# 甲\n\n第一行\n第二行（旧）<b>\n第三行\n', 'save');
    const [record] = await listRecords(ctx.notesDir, 'inbox/a.md');

    const diff = await request(ctx.app).get('/history').query({ id: record.id }).expect(200);
    assert.match(diff.text, /class="history-preview history-diff"/);
    assert.match(diff.text, /从这个版本到现在/);
    assert.match(diff.text, /＋2 行/);
    assert.match(diff.text, /－1 行/);
    assert.match(diff.text, /<div class="diff-row is-del">.*第二行（旧）&lt;b&gt;<\/span><\/div>/);
    assert.match(diff.text, /<div class="diff-row is-add">.*第二行（新）<\/span><\/div>/);
    assert.match(diff.text, /<div class="diff-row is-add">.*新加的<\/span><\/div>/);
    assert.doesNotMatch(diff.text, /<b>\n/);
    assert.match(diff.text, /aria-current="page"[^>]*>改动</);

    const full = await request(ctx.app).get('/history').query({ id: record.id, view: 'full' }).expect(200);
    assert.match(full.text, /<pre class="history-preview"># 甲\n\n第一行\n第二行（旧）&lt;b&gt;\n第三行\n<\/pre>/);
    assert.match(full.text, /aria-current="page"[^>]*>全文</);
  } finally { await ctx.cleanup(); }
});

test('历史页：内容一样、文件已删除、解决冲突留下的版本各有说明', async () => {
  const ctx = await setup({ notes: { 'inbox/a.md': '# 甲\n\n正文\n' } });
  try {
    await saveVersion(ctx.notesDir, 'inbox/a.md', '# 甲\n\n正文\n', 'save');
    await saveVersion(ctx.notesDir, 'inbox/gone.md', '# 已删\n\n旧内容\n', 'delete');
    await saveVersion(ctx.notesDir, 'inbox/a.md', '# 甲\n\n另一台设备的正文\n', 'conflict');

    const records = await listRecords(ctx.notesDir);
    const same = records.find(record => record.path === 'inbox/a.md' && record.reason === 'save');
    const gone = records.find(record => record.path === 'inbox/gone.md');
    const conflict = records.find(record => record.reason === 'conflict');
    assert.ok(same && gone && conflict);

    const samePage = await request(ctx.app).get('/history').query({ id: same.id }).expect(200);
    assert.match(samePage.text, /和现在的内容完全一样/);
    assert.match(samePage.text, /<pre class="history-preview">/);

    const gonePage = await request(ctx.app).get('/history').query({ id: gone.id }).expect(200);
    assert.match(gonePage.text, /这个文件现在不存在/);
    assert.match(gonePage.text, /<pre class="history-preview"># 已删/);

    const conflictPage = await request(ctx.app).get('/history').query({ id: conflict.id }).expect(200);
    assert.match(conflictPage.text, /解决同步冲突时没采用的那一边/);
    assert.match(conflictPage.text, /class="history-kind is-kept">冲突未采用</);
    assert.match(conflictPage.text, /history-diff/);
  } finally { await ctx.cleanup(); }
});

test('历史对比纯新增或纯删除超过行数上限时同样退回全文', () => {
  const many = Array.from({ length: 2001 }, (_, index) => 'line ' + index).join('\n');
  assert.equal(compareText('', many).tooLarge, true);
  assert.equal(compareText(many, '').tooLarge, true);
});
