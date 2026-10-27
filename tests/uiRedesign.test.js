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

async function setup(t, { readOnly = false, windowChrome } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ui-'));
  const notesDir = path.join(vaultDir, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, windowChrome });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db), now: () => FIXED_NOW });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, indexer, notesDir };
}

test('阅读页把待办语法渲染成勾选框和日期标签，原文不变', () => {
  const html = renderMarkdown('- [ ] 写引言 <b> @2026-10-26\n- [x] 读论文\n- 普通条目 [ ] 不算');
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

test('今日页给出概览指标，待办勾选即可完成且保留原截止日', async t => {
  const { app, indexer, notesDir } = await setup(t);
  await writeNote(notesDir, 'tasks.md', { body: '- [ ] 整理表格 @2026-10-25' });
  await indexer.scan();
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /<nav class="desk-metrics" aria-label="今日概览">/);
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
