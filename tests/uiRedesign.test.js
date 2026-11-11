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
const viewHelpers = require('../src/viewHelpers');

const FIXED_NOW = new Date(2026, 9, 25, 10, 0);

async function setup(t, { readOnly = false, windowChrome, platform } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ui-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, windowChrome });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db), now: () => FIXED_NOW, platform });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, indexer, notesDir };
}

test('阅读页把待办语法渲染成勾选框和日期标签，原文不变', () => {
  const html = renderMarkdown('- [ ] 写引言 <b> @2026-10-26\n- [x] 读论文\n- 普通条目 [ ] 不算', () => '', { today: '2026-10-25' });
  assert.match(html, /<li[^>]*class="task-item"[^>]*><span class="task-box" role="img" aria-label="待办"><\/span>写引言 &lt;b&gt; <time class="task-due" datetime="2026-10-26">10\/26<\/time>/);
  assert.match(html, /class="task-item is-done"[^>]*><span class="task-box is-done"[^>]*><\/span>读论文/);
  assert.doesNotMatch(html, /\[ \] 写引言|\[x\]/);
  assert.match(html, /<li[^>]*>普通条目 \[ \] 不算<\/li>/, '只有行首的 [ ] 才是待办');
});

test('从看板新建项目时预填状态字段骨架，普通笔记保持空白', async t => {
  const { app } = await setup(t);
  const project = await request(app).get('/new?path=experiments/new-project').expect(200);
  assert.match(project.text, /<title>新建研究项目/);
  assert.match(project.text, /status: planned/);
  assert.match(project.text, /name="path" value="experiments\/new-project\.md"/);
  const plain = await request(app).get('/new?path=research/idea').expect(200);
  assert.doesNotMatch(plain.text, /status: planned/);
});

test('侧栏角标显示逾期待办数；写操作之后立即刷新', async t => {
  const { app, indexer, notesDir } = await setup(t);
  await writeNote(notesDir, 'tasks.md', { body: '- [ ] 已经逾期 @2026-10-20\n- [ ] 今天 @2026-10-25\n- [ ] 以后 @2026-11-02' });
  await indexer.scan();
  const page = await request(app).get('/plan').expect(200);
  assert.match(page.text, /class="nav-badge is-warn" title="1 项逾期"/);

  await writeNote(notesDir, 'more.md', { body: '- [ ] 又一个逾期 @2026-10-01' });
  await indexer.scan();
  await request(app).post('/api/does-not-exist').set('Accept', 'application/json');
  const refreshed = await request(app).get('/plan').expect(200);
  assert.match(refreshed.text, /class="nav-badge is-warn" title="2 项逾期"/);
});

test('今日页只列今天要处理的事，待办勾选即可完成且保留原截止日', async t => {
  const { app, indexer, notesDir } = await setup(t);
  await writeNote(notesDir, 'tasks.md', { body: '- [ ] 整理表格 @2026-10-25' });
  await indexer.scan();
  const page = await request(app).get('/').expect(200);
  // 不再有「待办 / 逾期 / 今日复习」三格概览：逾期数在侧栏角标和待办列表里，复习在待办上面一行。
  assert.doesNotMatch(page.text, /desk-metrics/);
  assert.match(page.text, /<h2 id="task-title">今天需要处理<\/h2>/);
  assert.match(page.text, /data-task-form data-task-quick>/);
  assert.match(page.text, /<input type="hidden" name="due" value="2026-10-25">/);
  assert.match(page.text, /<time class="due-tag is-today" datetime="2026-10-25">今天<\/time>/);
});

test('只读模式不提供今日页的勾选表单', async t => {
  const { app, indexer, notesDir } = await setup(t);
  await writeNote(notesDir, 'tasks.md', { body: '- [ ] 只读里的待办 @2026-10-25' });
  await indexer.scan();
  const { app: readOnlyApp } = await setup(t, { readOnly: true });
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /data-task-quick/);
  const readOnlyPage = await request(readOnlyApp).get('/').expect(200);
  assert.doesNotMatch(readOnlyPage.text, /data-task-quick/);
});

test('界面字体随应用本地提供，不依赖在线字体服务', async t => {
  const { app } = await setup(t);
  const home = await request(app).get('/').expect(200);
  assert.doesNotMatch(home.text, /fonts\.googleapis|fonts\.gstatic/);
  for (const name of ['geist', 'geist-mono', 'noto-sans-sc']) {
    assert.match(home.text, new RegExp(`href="/static/fonts/${name}/wght.css"`));
    const css = await request(app).get(`/static/fonts/${name}/wght.css`).expect(200);
    assert.match(css.text, /@font-face/);
  }
  const woff = await request(app).get('/static/fonts/geist/files/geist-latin-wght-normal.woff2').expect(200);
  assert.ok(woff.body.length > 1000);
});

test('日期辅助函数兼容 YAML 解析出的 Date 与字符串', () => {
  assert.equal(viewHelpers.shortDate(new Date('2026-10-30T00:00:00Z'), '2026-10-25'), '10/30');
  assert.equal(viewHelpers.shortDate('2027-01-02', '2026-10-25'), '2027/1/2');
  assert.equal(viewHelpers.dueRelative('2026-10-25', '2026-10-25'), '今天');
  assert.equal(viewHelpers.dueRelative('2026-10-30', '2026-10-25'), '5 天后');
  assert.equal(viewHelpers.dueRelative('2026-10-23', '2026-10-25'), '逾期 2 天');
  assert.equal(viewHelpers.fieldText({ lr: '3e-4', bs: 64 }), 'lr 3e-4 · bs 64');
  assert.equal(viewHelpers.fieldText([1, 2]), '1, 2');
  assert.equal(
    viewHelpers.plainSnippet('主线见 [[research/rag|分块笔记]]。 - [ ] 整理表格 @2026-10-25 ## 设置 **重点** `bge-m3`'),
    '主线见 分块笔记。 整理表格 @2026-10-25 设置 重点 bge-m3'
  );
});

test('Windows 与 macOS 的笔记分区显示一致，实际路径保留 inbox', async t => {
  for (const platform of ['win32', 'darwin']) {
    const { app, indexer, notesDir } = await setup(t, { platform });
    await writeNote(notesDir, 'inbox/sample.md', { body: '# 分区测试\n\n正文\n' });
    await indexer.scan();
    const note = (await request(app).get('/note/inbox/sample.md').expect(200)).text;
    assert.match(note, /class="note-section" href="\/search\?section=inbox">收件箱<\/a>/);
    assert.match(note, /href="\/edit\/inbox\/sample\.md"/);
    const library = (await request(app).get('/search?section=inbox').expect(200)).text;
    assert.match(library, /value="inbox" selected>收件箱<\/option>/);
    assert.match(library, /href="\/note\/inbox\/sample\.md"/);
  }
});

test('没写别名的双链显示目标笔记标题，别名保持原样，小节链接带上小节名', async t => {
  const { app, indexer, notesDir } = await setup(t);
  await writeNote(notesDir, 'research/rag.md', { data: { title: '分块与召回' }, body: '正文\n\n## 结果\n' });
  await writeNote(notesDir, 'index.md', { body: '见 [[research/rag]]、[[research/rag|别名]]、[[research/rag#结果]] 和 [[未写的笔记]]。' });
  await indexer.scan();
  const page = await request(app).get('/note/index.md').expect(200);
  assert.match(page.text, /<a href="\/note\/research\/rag\.md" class="wikilink">分块与召回<\/a>/);
  assert.match(page.text, /class="wikilink">别名<\/a>/);
  assert.match(page.text, /class="wikilink">分块与召回 › 结果<\/a>/);
  assert.match(page.text, /class="wikilink wikilink-missing">未写的笔记<\/a>/);
});

test('复习角标只计到期卡，新卡不点亮角标', async t => {
  const { app, notesDir } = await setup(t);
  const vaultDir = path.dirname(notesDir);
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'cards', 'words.md'), '---\ndeck: 生词\n---\n\n## heterogeneity\n\n异质性\n');
  const page = await request(app).get('/decks').expect(200);
  assert.match(page.text, /新卡 1 张/);
  assert.doesNotMatch(page.text, /class="nav-badge"/);
});

test('侧栏搜索按钮唤起命令面板，快捷键按平台标注', async t => {
  const { app } = await setup(t);
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /class="palette-trigger workspace-search" data-palette-open[^>]*aria-keyshortcuts="(?:Meta|Control)\+K"/);
  assert.doesNotMatch(page.text, /workspace-toolbar|class="topsearch"/);
});

test('macOS 隐藏标题栏时页面给红绿灯让位，其他情况保持原样', async t => {
  const inset = await setup(t, { windowChrome: 'inset' });
  const insetPage = await request(inset.app).get('/').expect(200);
  assert.match(insetPage.text, /<html lang="zh-CN" class="chrome-inset">/);

  const native = await setup(t);
  const nativePage = await request(native.app).get('/').expect(200);
  assert.match(nativePage.text, /<html lang="zh-CN">/);
  // 品牌标记换成了应用图标的简化写法，不再是一个「研」字。
  assert.match(nativePage.text, /<svg class="workspace-mark"[^>]*aria-hidden="true">/);
  assert.doesNotMatch(nativePage.text, /workspace-mark"[^>]*>研</);

  // 不认识的取值一律按系统标题栏处理。
  assert.equal(loadConfig({ windowChrome: 'frameless' }).windowChrome, 'native');
});


test('搜索数字时保留摘要公式，且只高亮正文数字', () => {
  const html = viewHelpers.excerptHtml('公式 $x^2$ 与 $y$，结果为 0 和 1', '0');
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /结果为 <mark>0<\/mark> 和 1/);
  assert.doesNotMatch(html, /\u0000/);
});

test('摘要高亮不会匹配 HTML 实体内部，并安全转义匹配文本', () => {
  assert.equal(viewHelpers.excerptHtml('A < B & C lt', 'lt'), 'A &lt; B &amp; C <mark>lt</mark>');
  assert.equal(viewHelpers.excerptHtml('A < B', '<'), 'A <mark>&lt;</mark> B');
  assert.equal(viewHelpers.excerptHtml('<img src=x onerror=alert(1)>', '<img'), '<mark>&lt;img</mark> src=x onerror=alert(1)&gt;');
  assert.equal(viewHelpers.excerptHtml('A.b a.b', 'a.b'), '<mark>A.b</mark> <mark>a.b</mark>');
});

test('摘要只去掉完整重复标题，保留正文及较长标题的相同前缀', () => {
  const { buildSnippet } = require('../src/search');
  assert.equal(buildSnippet('研究方法很多', '研究', '研究'), '研究方法很多');
  assert.equal(buildSnippet('# 研究\n\n研究方法很多', '研究', '研究'), '研究方法很多');
  assert.equal(buildSnippet('# 研究方法\n\n正文', '研究', '研究'), '# 研究方法 正文');
  assert.equal(buildSnippet('# 研究 ###\r\n正文', '正文', '研究'), '正文');
});

test('搜索页去重真实标题，但保留以笔记名开头的正文', async t => {
  const { app, indexer, notesDir } = await setup(t);
  await writeNote(notesDir, 'research/prefix.md', { body: '---\ntitle: 研究\n---\n\n# 研究\n\n研究方法很多，公式 $x^2$ 的结果为 0。' });
  await indexer.scan();
  const result = await request(app).get('/search?q=' + encodeURIComponent('研究')).expect(200);
  assert.match(result.text, /class="library-excerpt"><mark>研究<\/mark>方法很多/);
  const numeric = await request(app).get('/search?q=0').expect(200);
  assert.match(numeric.text, /class="katex"/);
  assert.match(numeric.text, /<mark>0<\/mark>/);
  assert.doesNotMatch(numeric.text, /\u0000/);
});
