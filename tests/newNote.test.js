const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const request = require('supertest');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createIndexer } = require('../src/vault/indexer');
const { createSearch } = require('../src/search');
const { isNotePath } = require('../src/vault/paths');
const { parseFrontmatter } = require('../src/vault/note');

async function setup(t) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-new-note-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', syncEnabled: false });
  await fs.mkdir(config.notesDir, { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, { db, indexer, search: createSearch(db) });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config };
}

test('新建笔记默认进收件箱，路径按标题生成；指定路径和研究项目各有各的起点', async t => {
  const { app } = await setup(t);
  const blank = (await request(app).get('/new').expect(200)).text;
  assert.match(blank, /name="autoPath" value="1"/);
  assert.match(blank, /name="path" value=""[\s\S]*?placeholder="inbox\/标题\.md"[\s\S]*?data-auto-path data-folder="inbox"/);
  assert.match(blank, /data-note-title placeholder="标题"/);
  assert.match(blank, /src="\/static\/new-note\.js"/);

  const titled = (await request(app).get('/new?title=' + encodeURIComponent('注意力机制')).expect(200)).text;
  assert.match(titled, /<textarea name="body"[^>]*># 注意力机制\n\n<\/textarea>/);

  const project = (await request(app).get('/new?folder=experiments&title=' + encodeURIComponent('对比学习: 消融')).expect(200)).text;
  assert.match(project, /<title>新建研究项目/);
  assert.match(project, /title: &#34;对比学习: 消融&#34;\nstatus: planned/);
  assert.match(project, /data-folder="experiments"/);

  const fromLink = (await request(app).get('/new?path=Transformer').expect(200)).text;
  assert.match(fromLink, /name="path" value="Transformer\.md"/);
  assert.match(fromLink, /name="autoPath" value="0"/);
  assert.match(fromLink, /># Transformer\n\n<\/textarea>/);
});

test('自动生成的路径重名时依次换成「标题 2」，手填的路径重名照常报冲突', async t => {
  const { app, config } = await setup(t);
  const save = (body, autoPath) => request(app).post('/save').set('Accept', 'application/json').type('form')
    .send({ path: 'inbox/周会', body, isNew: '1', autoPath });
  assert.equal((await save('# 周会\n', '1').expect(200)).body.path, 'inbox/周会.md');
  const second = await save('# 周会\n\n第二次', '1').expect(200);
  assert.equal(second.body.path, 'inbox/周会 2.md');
  assert.equal(second.body.redirect, '/note/inbox/' + encodeURIComponent('周会 2') + '.md');
  assert.equal(await fs.readFile(path.join(config.notesDir, 'inbox', '周会 2.md'), 'utf8'), '# 周会\n\n第二次');
  await save('# 周会\n\n手填', '0').expect(409);
});

function fakeElement(props = {}) {
  const listeners = new Map();
  const attributes = new Map(Object.entries(props.attributes || {}));
  return {
    value: '', dataset: {}, ...props,
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatchEvent(event) { this.dispatched = (this.dispatched || 0) + 1; return true; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    focus() {},
    setSelectionRange() {},
    fire(type, event = {}) { return listeners.get(type)?.({ isTrusted: true, preventDefault() {}, ...event }); }
  };
}

async function loadNewNote(initialBody = '', folder = 'inbox') {
  const title = fakeElement();
  const body = fakeElement({ value: initialBody });
  const pathInput = fakeElement({ dataset: { folder }, attributes: { 'data-auto-path': '' } });
  const autoPath = fakeElement({ value: '1' });
  const form = {
    querySelector(selector) {
      return { '[data-note-title]': title, '[name="body"]': body, '[name="path"]': pathInput, '[name="autoPath"]': autoPath }[selector] || null;
    }
  };
  const window = {};
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'new-note.js'), 'utf8'), {
    document: { querySelector: selector => selector === '[data-editor-form]' ? form : null },
    window, Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  });
  return { title, body, pathInput, autoPath, api: window.workstationNewNote };
}

test('标题框和正文第一行的标题互相同步，路径跟着标题走，手改路径后不再跟', async () => {
  const ui = await loadNewNote();
  ui.title.value = '注意力机制';
  ui.title.fire('input');
  assert.equal(ui.body.value, '# 注意力机制\n\n');
  assert.equal(ui.pathInput.value, 'inbox/注意力机制.md');

  ui.body.value = '# 自注意力\n\n正文';
  ui.body.fire('input');
  assert.equal(ui.title.value, '自注意力');
  assert.equal(ui.pathInput.value, 'inbox/自注意力.md');

  ui.pathInput.value = 'research/attention.md';
  ui.pathInput.fire('input');
  assert.equal(ui.autoPath.value, '0');
  ui.title.value = '新标题';
  ui.title.fire('input');
  assert.equal(ui.pathInput.value, 'research/attention.md', '手改过的路径不再变');
  assert.equal(ui.body.value, '# 新标题\n\n正文');
});

test('研究项目的标题写进 frontmatter 的 title 字段；文件名去掉不能用的字符', async () => {
  const ui = await loadNewNote('---\ntitle: \nstatus: planned\n---\n\n', 'experiments');
  ui.title.value = 'ResNet: 消融 #2';
  ui.title.fire('input');
  assert.equal(ui.body.value, '---\ntitle: "ResNet: 消融 #2"\nstatus: planned\n---\n\n');
  assert.equal(ui.pathInput.value, 'experiments/ResNet 消融 2.md');
  assert.equal(ui.api.readTitle(ui.body.value), 'ResNet: 消融 #2');
  assert.equal(ui.api.fileNameFrom('a/b\\c?.  '), 'a b c');
  assert.equal(ui.api.fileNameFrom('CON'), 'CON_');
  assert.equal(ui.api.fileNameFrom('[[双链]] | 别名'), '双链 别名');
});

test('研究项目标题中的替换符按字面写入，其他字段与正文不变', async () => {
  const initial = '---\ntitle: 旧标题\nstatus: planned\n---\n\n原正文\n';
  for (const title of ['公式 $$ E=mc^2 $$', '匹配 $& 与 $1', "前缀 $` 后缀 $'", '引用: $$ 与 $&']) {
    const ui = await loadNewNote(initial, 'experiments');
    ui.title.value = title;
    ui.title.fire('input');
    const parsed = parseFrontmatter(ui.body.value);
    assert.equal(parsed.data.title, title);
    assert.equal(parsed.data.status, 'planned');
    assert.equal(parsed.content, '\n原正文\n');
    assert.equal(ui.api.readTitle(ui.body.value), title);
  }
});

test('带扩展名的 Windows 保留名称也会生成可保存的路径', async () => {
  const ui = await loadNewNote();
  for (const [title, expected] of [
    ['CON', 'CON_'], ['CON.txt', 'CON_.txt'], ['nul.foo.bar', 'nul_.foo.bar'],
    ['CoM1.log', 'CoM1_.log'], ['LPT9 .txt', 'LPT9_.txt'], ['CONtent.txt', 'CONtent.txt']
  ]) {
    ui.title.value = title;
    ui.title.fire('input');
    assert.equal(ui.pathInput.value, 'inbox/' + expected + '.md');
    assert.equal(isNotePath(ui.pathInput.value), true);
  }
});
