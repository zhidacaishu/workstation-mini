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

async function setup(t, { readOnly = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-library-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false, readOnly });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });

  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config, indexer };
}

async function addNote(config, notePath, note, modifiedAt) {
  await writeNote(config.notesDir, notePath, note);
  if (modifiedAt) {
    const timestamp = new Date(modifiedAt);
    await fs.utimes(path.join(config.notesDir, notePath), timestamp, timestamp);
  }
}

function assertBefore(text, first, second) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.ok(firstIndex >= 0, `expected ${first} in page`);
  assert.ok(secondIndex >= 0, `expected ${second} in page`);
  assert.ok(firstIndex < secondIndex, `expected ${first} before ${second}`);
}

test('空查询浏览最近文档，按 mtime 倒序再按路径排序', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/z-last.md', { data: { title: '较早文档' }, body: '旧正文' }, '2026-01-01T00:00:00Z');
  await addNote(config, 'reading/b-tied.md', { data: { title: '同时间 B' }, body: 'B 正文' }, '2026-02-01T00:00:00Z');
  await addNote(config, 'reading/a-tied.md', { data: { title: '同时间 A' }, body: 'A 正文' }, '2026-02-01T00:00:00Z');
  await indexer.scan();

  const response = await request(app).get('/search').expect(200);
  assert.match(response.text, /<title>笔记资料库/);
  assert.match(response.text, /reading\/a-tied\.md/);
  assert.match(response.text, /reading\/b-tied\.md/);
  assert.match(response.text, /reading\/z-last\.md/);
  assertBefore(response.text, 'reading/a-tied.md', 'reading/b-tied.md');
  assertBefore(response.text, 'reading/b-tied.md', 'reading/z-last.md');
});

test('无 query 时可单独按分区或标签浏览', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/kept.md', { data: { title: '阅读保留', tags: ['重点'] }, body: '阅读正文' });
  await addNote(config, 'diary/other.md', { data: { title: '日记条目', tags: ['日记'] }, body: '日记正文' });
  await indexer.scan();

  const section = await request(app).get('/search?section=reading').expect(200);
  assert.match(section.text, /阅读保留/);
  assert.doesNotMatch(section.text, /日记条目/);

  const tag = await request(app).get('/search?tag=' + encodeURIComponent('日记')).expect(200);
  assert.match(tag.text, /日记条目/);
  assert.doesNotMatch(tag.text, /阅读保留/);
});

test('无 query 的 section 和 tag 取交集', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/match.md', { data: { title: '阅读重点', tags: ['重点'] }, body: '交集结果' });
  await addNote(config, 'reading/wrong-tag.md', { data: { title: '阅读普通', tags: ['普通'] }, body: '不应出现' });
  await addNote(config, 'diary/wrong-section.md', { data: { title: '日记重点', tags: ['重点'] }, body: '不应出现' });
  await indexer.scan();

  const response = await request(app)
    .get('/search?section=reading&tag=' + encodeURIComponent('重点'))
    .expect(200);
  assert.match(response.text, /阅读重点/);
  assert.match(response.text, /reading\/match\.md/);
  assert.doesNotMatch(response.text, /阅读普通/);
  assert.doesNotMatch(response.text, /日记重点/);
});

test('有 query 时仍使用全文搜索结果', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'reading/hit.md', { data: { title: '命中文档' }, body: '独特检索词出现在正文。' });
  await addNote(config, 'reading/miss.md', { data: { title: '未命中文档' }, body: '完全不同的内容。' });
  await indexer.scan();

  const response = await request(app).get('/search?q=' + encodeURIComponent('独特检索词')).expect(200);
  assert.match(response.text, /<title>搜索：独特检索词/);
  assert.match(response.text, /命中文档/);
  assert.doesNotMatch(response.text, /未命中文档/);
});

test('今日只突出一个研究项目，项目截止日显示在项目卡上而不混进待办', async t => {
  const { app, config, indexer } = await setup(t);
  const date = new Date();
  const localDate = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
  const today = localDate(date);
  date.setDate(date.getDate() + 10);
  for (let i = 0; i < 4; i += 1) {
    await addNote(config, `experiments/project-${i}.md`, {
      data: { title: `研究项目 ${i}`, status: 'running', next: '下一次实验', ...(i === 0 ? { deadline: localDate(date) } : {}) },
      body: '项目内容'
    });
  }
  await addNote(config, 'tasks.md', { body: Array.from({ length: 9 }, (_, i) => `- [ ] 待办 ${i} @${today}`).join('\n') });
  await indexer.scan();
  const response = await request(app).get('/').expect(200);
  assert.equal((response.text.match(/class="research-entry/g) || []).length, 1);
  assert.doesNotMatch(response.text, /class="statrow"/);
  const featured = response.text.match(/<article class="research-entry is-featured">([\s\S]*?)<\/article>/)[1];
  assert.match(featured, /研究项目 0/);
  assert.match(featured, /截止 /);
  const tasks = response.text.match(/<ul class="desk-tasks">([\s\S]*?)<\/ul>/)[1];
  assert.equal((tasks.match(/class="desk-task"/g) || []).length, 5, '首页最多列五条待办');
  assert.doesNotMatch(tasks, /研究项目 0/);
});

test('笔记标签直接筛选资料库，不再附加同名全文搜索', async t => {
  const { app, config, indexer } = await setup(t);
  await addNote(config, 'research/tags.md', { data: { title: '标签示例', tags: ['评测'] }, body: '正文没有标签关键词' });
  await indexer.scan();
  const response = await request(app).get('/note/research/tags.md').expect(200);
  assert.match(response.text, /href="\/search\?tag=%E8%AF%84%E6%B5%8B"/);
  assert.doesNotMatch(response.text, /tag=[^"]*&q=/);
});

test('空资料库和只读模式均可打开资料库页面', async t => {
  const empty = await setup(t);
  const emptyPage = await request(empty.app).get('/search').expect(200);
  assert.match(emptyPage.text, /还没有笔记/);

  const readOnly = await setup(t, { readOnly: true });
  await addNote(readOnly.config, 'archive/readonly.md', { data: { title: '只读文档' }, body: '仍可浏览' });
  await readOnly.indexer.scan();
  const readOnlyPage = await request(readOnly.app).get('/search').expect(200);
  assert.match(readOnlyPage.text, /只读文档/);
  assert.match(readOnlyPage.text, /archive\/readonly\.md/);
});

test('笔记本地图片和媒体可读取，只读模式同样有效', async t => {
  for (const readOnly of [false, true]) {
    const { app, config } = await setup(t, { readOnly });
    await fs.mkdir(path.join(config.vaultDir, 'attachments', '图片'), { recursive: true });
    await fs.mkdir(path.join(config.vaultDir, 'audio'), { recursive: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    await fs.writeFile(path.join(config.vaultDir, 'attachments', '图片', '示例.svg'), svg);
    await fs.writeFile(path.join(config.vaultDir, 'audio', 'clip.mp3'), Buffer.from([1, 2, 3, 4]));
    const image = await request(app).get('/attachments/' + encodeURIComponent('图片') + '/' + encodeURIComponent('示例.svg')).expect(200);
    assert.match(image.headers['content-type'], /image\/svg\+xml/);
    assert.match(image.headers['content-security-policy'], /sandbox/);
    assert.equal(Buffer.from(image.body).toString(), svg);
    await request(app).head('/attachments/' + encodeURIComponent('图片') + '/' + encodeURIComponent('示例.svg')).expect(200);
    const audio = await request(app).get('/media/clip.mp3').set('Range', 'bytes=1-2').expect(206);
    assert.deepEqual(audio.body, Buffer.from([2, 3]));
  }
});

test('媒体读取拒绝非媒体、目录、缺失文件和符号链接逃逸', async t => {
  const { app, config } = await setup(t);
  await fs.mkdir(path.join(config.vaultDir, 'attachments', 'directory.svg'), { recursive: true });
  await fs.writeFile(path.join(config.vaultDir, 'attachments', 'secret.md'), 'private');
  for (const url of ['/attachments/secret.md', '/attachments/directory.svg', '/attachments/missing.png', '/media/missing.mp3', '/attachments/%2e%2e%2fnotes%2fsecret.png']) {
    await request(app).get(url).expect(404);
  }
  if (process.platform !== 'win32') {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-resource-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, 'secret.svg'), '<svg/>');
    await fs.symlink(path.join(outside, 'secret.svg'), path.join(config.vaultDir, 'attachments', 'linked.svg'));
    await fs.symlink(outside, path.join(config.vaultDir, 'attachments', 'linked-dir'));
    await request(app).get('/attachments/linked.svg').expect(404);
    await request(app).get('/attachments/linked-dir/secret.svg').expect(404);
  }
});

test('KaTeX 样式及引用字体均由本地服务提供', async t => {
  const { app } = await setup(t);
  const css = await request(app).get('/static/katex/katex.min.css').expect(200);
  assert.match(css.headers['content-type'], /text\/css/);
  const urls = [...new Set([...css.text.matchAll(/url\(([^)]+)\)/g)].map(match => match[1].replace(/['"]/g, '')))];
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith('fonts/'));
    await request(app).get('/static/katex/' + url).expect(200);
  }
});
