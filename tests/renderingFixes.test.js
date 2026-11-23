// 编辑与渲染、HTTP 几处边角问题的回归测试：原文首行换行、公式渲染异常、
// 双链里的括号和竖线、附件超限提示、历史页只差换行符。
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
const { renderMarkdown, replaceWikilinks, escapeMarkdownText } = require('../src/markdown');
const { saveVersion, listRecords } = require('../src/vault/history');

async function setup() {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-render-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false });
  await fs.mkdir(path.join(config.notesDir, 'inbox'), { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  return {
    app, config, notesDir: config.notesDir,
    async cleanup() {
      db.close();
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  };
}

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&#34;': '"', '&#39;': "'", '&quot;': '"' };
/** 按 HTML 解析规则取出 <textarea>/<pre> 的文字：开标签后紧跟的一个换行会被丢掉。 */
function parsedText(html, tag, attribute = '') {
  const match = new RegExp(`<${tag}[^>]*${attribute}[^>]*>([\\s\\S]*?)</${tag}>`).exec(html);
  assert.ok(match, `页面里应有 <${tag}>`);
  const text = match[1].startsWith('\n') ? match[1].slice(1) : match[1];
  return text.replace(/&(?:lt|gt|amp|quot|#34|#39);/g, entity => ENTITIES[entity]);
}

// ---------- 原文首行换行 ----------

test('正文以空行开头的笔记：编辑框里的原文不少第一行', async () => {
  const ctx = await setup();
  try {
    const raw = '\n\n正文从第三行开始 <b>\n';
    await fs.writeFile(path.join(ctx.notesDir, 'inbox/a.md'), raw);
    const page = await request(ctx.app).get('/edit/inbox/a.md').expect(200);
    assert.equal(parsedText(page.text, 'textarea', 'name="body"'), raw);
  } finally { await ctx.cleanup(); }
});

test('历史页全文：以换行开头的版本原样显示', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.notesDir, 'inbox/a.md'), '# 现在\n');
    const raw = '\n以前的版本\n';
    await saveVersion(ctx.notesDir, 'inbox/a.md', raw, 'save');
    const [record] = await listRecords(ctx.notesDir, 'inbox/a.md');
    const page = await request(ctx.app).get('/history').query({ id: record.id, view: 'full' }).expect(200);
    assert.equal(parsedText(page.text, 'pre', 'class="history-preview"'), raw);
  } finally { await ctx.cleanup(); }
});

// ---------- 公式 ----------

test('嵌套过深的公式退回源码显示，整页不报错', () => {
  const source = '\\frac{'.repeat(3000) + 'x' + '}{y}'.repeat(3000);
  const html = renderMarkdown(`前文\n\n$$\n${source}\n$$\n\n行内 $${'{'.repeat(5000)}x${'}'.repeat(5000)}$ 后文\n`, () => '');
  assert.match(html, /前文/);
  assert.match(html, /后文/);
  assert.match(html, /class="math-error"/);
});

// ---------- 双链里的括号和竖线 ----------

test('双链名里有括号时，生成的链接不被截断', () => {
  const resolve = target => (target === '1) 准备' ? 'inbox/1) 准备.md' : '');
  const html = renderMarkdown('见 [[1) 准备]] 和 [[foo (x]]。\n', resolve);
  assert.match(html, /<a href="\/note\/inbox\/1%29%20%E5%87%86%E5%A4%87\.md"[^>]*>1\) 准备<\/a>/);
  assert.match(html, /<a href="\/new\?path=foo%20%28x"[^>]*>foo \(x<\/a>/);
  assert.doesNotMatch(html, /\[\[|\]\(/);
});

test('标题里有竖线的双链放进表格，不会把单元格拆开', () => {
  const resolve = target => (target === 'a' ? 'a.md' : '');
  resolve.titleOf = () => 'A | B';
  const html = renderMarkdown('| 链接 | 备注 |\n| --- | --- |\n| [[a]] | 说明 |\n', resolve);
  const cells = [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(match => match[1]);
  assert.equal(cells.length, 2);
  assert.match(cells[0], /<a href="\/note\/a\.md"[^>]*>A \| B<\/a>/);
  assert.equal(cells[1], '说明');
  assert.equal(escapeMarkdownText('a|b'), 'a\\|b');
});

test('表格里 Obsidian 写法的 [[目标\\|别名]] 指向目标本身', () => {
  const resolve = target => (target === 'a' ? 'a.md' : target === 'a#小节' ? 'a.md' : '');
  const html = renderMarkdown('| 链接 |\n| --- |\n| [[a\\|别名]] |\n', resolve);
  assert.match(html, /<td><a href="\/note\/a\.md"[^>]*>别名<\/a><\/td>/);
  assert.match(replaceWikilinks('[[a#小节\\|别名]]', resolve), /^\[别名\]\(\/note\/a\.md#/);
});

// ---------- 附件超限 ----------

test('粘贴的图片超过 15 MB 时提示图片太大，不提示拆分笔记', async () => {
  const ctx = await setup();
  try {
    const png = Buffer.alloc(16 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const response = await request(ctx.app).post('/api/attachments')
      .set('Content-Type', 'image/png').set('Accept', 'application/json').send(png).expect(413);
    assert.match(response.body.message, /15 ?MB/);
    assert.doesNotMatch(response.body.message, /笔记/);

    const note = await request(ctx.app).post('/save').set('Accept', 'application/json')
      .send({ path: 'inbox/big.md', body: 'x'.repeat(11 * 1024 * 1024) });
    assert.equal(note.status, 413);
    assert.match(note.body.message, /10MB/);
  } finally { await ctx.cleanup(); }
});

// ---------- 历史页只差换行符 ----------

test('历史版本和现在只差换行符时，不说「完全一样」', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.notesDir, 'inbox/a.md'), '# 甲\n\n正文\n');
    await saveVersion(ctx.notesDir, 'inbox/a.md', '# 甲\r\n\r\n正文\r\n', 'save');
    await saveVersion(ctx.notesDir, 'inbox/a.md', '# 甲\n\n正文\n', 'save');
    const records = await listRecords(ctx.notesDir, 'inbox/a.md');
    const crlf = records.find(record => record.kind === 'version');
    const pages = await Promise.all(records.filter(record => record.kind === 'version')
      .map(record => request(ctx.app).get('/history').query({ id: record.id }).expect(200)));
    assert.ok(crlf);
    const texts = pages.map(page => page.text);
    assert.equal(texts.filter(text => /和现在的内容完全一样/.test(text)).length, 1, '只有真正相同的那份说完全一样');
    assert.equal(texts.filter(text => /只差换行符/.test(text)).length, 1);
  } finally { await ctx.cleanup(); }
});

// ---------- 范围外补齐的同类问题 ----------

test('反链索引也认表格里的 [[目标\\|别名]]，目标不带反斜杠', () => {
  const { parseWikilinks } = require('../src/vault/wikilink');
  assert.deepEqual(parseWikilinks('| [[a\\|别名]] | [[b#小节\\|别名]] |').map(link => [link.target, link.heading, link.display]),
    [['a', '', '别名'], ['b', '小节', '别名']]);
});

test('历史列表里带时区的时间标题按原文显示', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.notesDir, 'inbox/t.md'), '# 现在\n');
    await saveVersion(ctx.notesDir, 'inbox/t.md', '---\ntitle: 2026-08-06T09:00:00+08:00\n---\n正文\n', 'save');
    const page = await request(ctx.app).get('/history').expect(200);
    assert.match(page.text, /2026-08-06T09:00:00\+08:00/);
    assert.doesNotMatch(page.text, /2026-08-06 01:00/);
  } finally { await ctx.cleanup(); }
});

test('月历备注以空行开头时，编辑框里不少第一行', async () => {
  const ctx = await setup();
  try {
    await fs.mkdir(path.join(ctx.notesDir, 'calendar'), { recursive: true });
    await fs.writeFile(path.join(ctx.notesDir, 'calendar/2026-03-17.md'), '\n\n第三行的备注\n');
    const page = await request(ctx.app).get('/plan').query({ view: 'calendar', date: '2026-03-17' }).expect(200);
    assert.match(parsedText(page.text, 'textarea', 'id="calendar-note"'), /^\n\n第三行的备注/);
  } finally { await ctx.cleanup(); }
});
