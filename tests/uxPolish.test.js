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
const { writeNote, deleteNote } = require('../src/vault/note');
const { listRecords } = require('../src/vault/history');

async function setupApp(t, { readOnly = false, isMac = false, syncEnabled = false } = {}) {
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-ux-polish-'));
  const config = loadConfig({ vaultDir, dbPath: ':memory:', readOnly, syncEnabled });
  await fs.mkdir(config.notesDir, { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'cards'), { recursive: true });
  const db = openDatabase(':memory:');
  const indexer = createIndexer({ db, vaultDir: config.notesDir });
  const app = createApp(config, {
    db,
    indexer,
    search: createSearch(db),
    now: () => new Date(2026, 9, 24, 9),
    platform: isMac ? 'darwin' : 'win32'
  });
  t.after(async () => {
    db.close();
    await fs.rm(vaultDir, { recursive: true, force: true });
  });
  return { app, config, db, indexer, vaultDir };
}

test('危险确认弹窗为破坏性按钮标记 is-danger，且默认焦点留在取消上', async () => {
  const appended = [];
  const makeNode = tag => {
    const classes = new Set();
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      children: [],
      attributes: {},
      classList: {
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...nodes) { this.children.push(...nodes); },
      addEventListener(type, fn) { listeners.set(type, fn); },
      showModal() { this.open = true; },
      close(val) { this.returnValue = val; listeners.get('close')?.(); },
      remove() {}
    };
  };
  const body = { append(node) { appended.push(node); } };
  const document = {
    body,
    activeElement: body,
    querySelector: () => null,
    createElement: makeNode
  };
  const window = {};
  const script = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'message-dialog.js'), 'utf8');
  vm.runInNewContext(script, { document, window, Promise, WeakMap, Number, String });

  const pending = window.workstationDialog.confirm('删除笔记？', '删除前会保存版本。', '删除笔记', { danger: true });
  const dialog = appended[0];
  const buttons = dialog.children[1].children;
  assert.equal(buttons[0].textContent, '取消');
  assert.equal(buttons[0].autofocus, true);
  assert.equal(buttons[0].classList.contains('is-primary'), false);
  assert.equal(buttons[0].classList.contains('is-danger'), false);
  assert.equal(buttons[1].textContent, '删除笔记');
  assert.equal(buttons[1].autofocus, false);
  assert.equal(buttons[1].classList.contains('is-danger'), true);
  assert.equal(buttons[1].classList.contains('is-primary'), false);
  dialog.close('0');
  assert.equal(await pending, false);
});

test('新建研究项目与恢复已删笔记的取消链接回到合理来源页', async t => {
  const ctx = await setupApp(t);
  const projectPage = (await request(ctx.app).get('/new?folder=experiments').expect(200)).text;
  assert.match(projectPage, /<a class="button quiet" href="\/board\/experiment">取消<\/a>/);

  const fromHealth = (await request(ctx.app).get('/new?path=Missing&returnTo=/health').expect(200)).text;
  assert.match(fromHealth, /<a class="button quiet" href="\/health">取消<\/a>/);

  const note = await writeNote(ctx.config.notesDir, 'inbox/temp.md', { body: '# 临时笔记\n' });
  await deleteNote(ctx.config.notesDir, note.path);
  const records = await listRecords(ctx.config.notesDir, note.path);
  const recoverPage = (await request(ctx.app).get('/recover/' + encodeURIComponent(records[0].id)).expect(200)).text;
  assert.match(recoverPage, new RegExp(`href="/history\\?id=${encodeURIComponent(records[0].id)}"`));
});

test('资料库健康页显示中文状态、可点击断链，以及页面标题与历史页差异说明一致', async t => {
  const ctx = await setupApp(t);
  const note = await writeNote(ctx.config.notesDir, 'research/a.md', { body: '# 笔记 A\n\n关联 [[未建笔记]]\n' });
  await writeNote(ctx.config.notesDir, note.path, { body: '# 笔记 A\n\n关联 [[未建笔记]]\n新增一行\n' });
  await ctx.indexer.scan();

  const health = (await request(ctx.app).get('/health').expect(200)).text;
  assert.match(health, /资料库目录 <strong>可用<\/strong>/);
  assert.match(health, /状态 <strong>就绪<\/strong>/);
  assert.match(health, /href="\/new\?path=%E6%9C%AA%E5%BB%BA%E7%AC%94%E8%AE%B0&amp;returnTo=\/health"/);

  const decks = (await request(ctx.app).get('/decks').expect(200)).text;
  assert.match(decks, /<title>复习 · 科研工作台<\/title>/);

  const records = await listRecords(ctx.config.notesDir, note.path);
  const history = (await request(ctx.app).get('/history?id=' + encodeURIComponent(records[0].id)).expect(200)).text;
  assert.match(history, /<title>历史与草稿 · 科研工作台<\/title>/);
  assert.match(history, /history-compare-legend/);
  assert.match(history, /这个旧版本原有/);

  // 与当前内容完全一致时，不再把「载入编辑器」标成主蓝色 CTA。
  await writeNote(ctx.config.notesDir, note.path, { body: '# 笔记 A\n\n关联 [[未建笔记]]\n' });
  const sameHistory = (await request(ctx.app).get('/history?id=' + encodeURIComponent(records[0].id)).expect(200)).text;
  assert.match(sameHistory, /和现在的内容完全一样/);
  assert.match(sameHistory, /<a class="button" href="\/recover\//);
});

test('上手指南只展示当前平台相关提示，并修正计划未安排分组文案', async t => {
  const macCtx = await setupApp(t, { isMac: true });
  const macGuide = (await request(macCtx.app).get('/guide').expect(200)).text;
  assert.doesNotMatch(macGuide, /Windows 关机或注销/);
  assert.doesNotMatch(macGuide, /Git Bash/);
  assert.doesNotMatch(macGuide, /计划 → 未安排/);
  assert.match(macGuide, /设置 → Git 同步/);
  assert.match(macGuide, /data-guide-settings="sync"/);

  const winCtx = await setupApp(t, { isMac: false });
  const winGuide = (await request(winCtx.app).get('/guide').expect(200)).text;
  assert.match(winGuide, /Windows 关机或注销/);
  assert.match(winGuide, /Git Bash/);
});

test('计划页未安排筛选默认不填今天日期，卡片暂停与待办接口返回实时状态字段', async t => {
  const ctx = await setupApp(t);
  const note = await writeNote(ctx.config.notesDir, 'inbox/tasks.md', {
    body: '# 待办\n\n- [ ] 逾期项 @2026-10-20\n- [ ] 没排期\n'
  });
  await fs.writeFile(path.join(ctx.vaultDir, 'cards', 'ml.md'), '---\ndeck: 机器学习\n---\n\n## 正则化\n\nL2\n');
  await ctx.indexer.scan();

  const undated = (await request(ctx.app).get('/plan?view=list&filter=undated').expect(200)).text;
  assert.match(undated, /class="plan-quick-date" type="date" name="due" value=""/);
  assert.match(undated, /plan-task-when is-unset[^>]*>设日期</);
  assert.match(undated, /data-task-revert/);

  const taskRes = await request(ctx.app).post('/tasks/update').set('Accept', 'application/json')
    .send({ path: note.path, line: 3, expectedHash: note.hash, done: true }).expect(200);
  assert.equal(taskRes.body.overdueCount, 0);

  const cardsHtml = (await request(ctx.app).get('/cards').expect(200)).text;
  const idMatch = cardsHtml.match(/name="id" value="([^"]+)"/);
  assert.ok(idMatch);
  const suspendRes = await request(ctx.app).post('/cards/suspend').set('Accept', 'application/json')
    .send({ id: idMatch[1], suspended: true }).expect(200);
  assert.equal(suspendRes.body.status?.label, '已暂停');
  assert.equal(suspendRes.body.status?.tone, 'is-suspended');
  const resumeRes = await request(ctx.app).post('/cards/suspend').set('Accept', 'application/json')
    .send({ id: idMatch[1], suspended: false }).expect(200);
  assert.equal(resumeRes.body.status?.label, '新卡');
});

test('界面导览自动弹出在卡片编辑页和恢复页保持静默', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'guide.js'), 'utf8');
  for (const route of ['/cards/edit', '/recover/abc123', '/edit/a.md', '/new', '/review']) {
    let opened = false;
    const dialog = {
      open: false,
      querySelector: () => ({ addEventListener() {}, classList: { toggle() {}, remove() {} }, style: {} }),
      querySelectorAll: () => [],
      addEventListener() {},
      showModal() { opened = true; }
    };
    const document = {
      body: { dataset: { pagePath: route } },
      getElementById: id => id === 'onboarding' ? dialog : null,
      querySelector: () => null,
      querySelectorAll: selector => selector === 'template[data-guide-step]' ? [{ dataset: {}, content: { cloneNode: () => ({}) } }] : [],
      addEventListener() {}
    };
    const window = {
      workstationDesktop: { getGuide: async () => ({ status: 'active', step: 0 }), saveGuide: async s => s, openSettings: async () => {} },
      addEventListener() {}
    };
    vm.runInNewContext(source, {
      document, window, location: { pathname: route }, Element: class {}, Promise
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened, false, `${route} 不应自动弹出界面导览`);
  }
});

test('设置页在关闭自动同步时隐藏间隔与立即同步，并支持放弃更改与平台快捷键保存', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'settings', 'settings.js'), 'utf8');
  const fields = new Map();
  const makeEl = (extra = {}) => {
    const listeners = new Map();
    const classes = new Set();
    return {
      value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {},
      classList: { toggle(n, f) { if (f) classes.add(n); else classes.delete(n); }, contains: n => classes.has(n) },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      async dispatch(t, e = {}) { for (const fn of listeners.get(t) || []) await fn({ preventDefault() {}, ...e }); },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], ...extra
    };
  };
  for (const name of ['vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes', 'launchAtLogin', 'theme']) {
    fields.set(name, makeEl({ name, type: ['readOnly', 'syncEnabled', 'launchAtLogin'].includes(name) ? 'checkbox' : 'text' }));
  }
  const form = makeEl({
    elements: { namedItem: n => fields.get(n) || null },
    reportValidity: () => true,
    querySelectorAll: () => [...fields.values(), save, discard, reload, syncBtn, abortBtn]
  });
  const save = makeEl();
  const discard = makeEl({ hidden: true });
  const reload = makeEl({ hidden: true });
  const runtime = makeEl();
  const syncBtn = makeEl();
  const syncIntervalField = makeEl();
  const systemHideNote = makeEl();
  const syncStatus = makeEl();
  const syncStatusTitle = makeEl();
  const syncStatusDetail = makeEl();
  const abortBtn = makeEl({ hidden: true });
  const message = makeEl();
  const ids = {
    'settings-form': form, message, save, 'discard-changes': discard, 'reload-settings': reload,
    'runtime-status': runtime, 'sync-now': syncBtn, 'sync-interval-field': syncIntervalField,
    'system-hide-note': systemHideNote, 'sync-status': syncStatus, 'sync-status-title': syncStatusTitle,
    'sync-status-detail': syncStatusDetail, 'abort-git-operation': abortBtn,
    'open-vault': makeEl(), 'open-config': makeEl(), 'open-recovery': makeEl()
  };
  const winListeners = new Map();
  let saveCalls = 0;
  const data = {
    revision: 1, runtimeRunning: true,
    settings: { vaultDir: '/v', device: 'mac', readOnly: false, syncEnabled: false, syncIntervalMinutes: 15, launchAtLogin: false, theme: 'system' },
    syncStatus: { phase: 'disabled', operation: '', recovery: null, lastResult: null },
    capabilities: { launchAtLogin: false, isMac: true }
  };
  const window = {
    innerHeight: 800,
    location: { hash: '' },
    addEventListener(t, fn) { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); },
    workstationSettings: {
      get: async () => data,
      save: async update => { saveCalls += 1; return { ...data, revision: 2, settings: update.settings }; },
      onChanged: () => () => {},
      onSyncStatusChanged: () => () => {},
      onNavigateSection: () => () => {}
    }
  };
  const document = {
    body: { dataset: {} },
    documentElement: { classList: { contains: () => true } },
    getElementById: id => ids[id] || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  vm.runInNewContext(source, { document, window, Map, Set, Number, String, JSON, Object, Boolean, Math });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(syncIntervalField.hidden, true, '同步关闭时隐藏同步间隔');
  assert.equal(syncBtn.hidden, true, '同步关闭时隐藏立即同步');
  assert.equal(discard.hidden, true, '未修改时隐藏放弃更改');
  assert.match(systemHideNote.textContent, /菜单栏或程序坞/);

  // 勾选自动同步后：间隔出现、状态明确说明尚未保存、放弃更改按钮出现
  fields.get('syncEnabled').checked = true;
  await form.dispatch('change', { target: fields.get('syncEnabled') });
  assert.equal(syncIntervalField.hidden, false);
  assert.equal(syncStatusTitle.textContent, '自动同步尚未保存');
  assert.equal(discard.hidden, false);

  // 点击放弃更改：还原所有字段并再次隐藏同步间隔
  await discard.dispatch('click');
  assert.equal(fields.get('syncEnabled').checked, false);
  assert.equal(syncIntervalField.hidden, true);
  assert.equal(discard.hidden, true);
  assert.equal(syncStatusTitle.textContent, '自动同步已关闭');

  // macOS 上 Cmd+S 保存，Ctrl+S 不拦截
  fields.get('device').value = 'mac-2';
  await form.dispatch('input');
  for (const fn of winListeners.get('keydown') || []) fn({ key: 's', ctrlKey: true, metaKey: false, preventDefault() {} });
  assert.equal(saveCalls, 0);
  for (const fn of winListeners.get('keydown') || []) fn({ key: 's', ctrlKey: false, metaKey: true, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saveCalls, 1);
});

test('恢复向导动态提示缺少的步骤，并支持返回欢迎页与回车检查远端', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'recovery', 'recovery.js'), 'utf8');
  const makeEl = (id = '') => {
    const listeners = new Map();
    const classes = new Set();
    return {
      id, value: '', hidden: false, disabled: false, textContent: '', dataset: {}, style: {},
      classList: { toggle(n, f) { if (f) classes.add(n); else classes.delete(n); } },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      async dispatch(t, e = {}) { for (const fn of listeners.get(t) || []) await fn({ preventDefault() {}, target: this, ...e }); },
      click() { return this.dispatch('click'); },
      setAttribute() {}, removeAttribute() {}, toggleAttribute() {},
      querySelector: () => makeEl(), querySelectorAll: () => []
    };
  };
  const ids = [
    'recovery-form', 'first-run', 'source-panel', 'destination-panel', 'status-panel',
    'phase-label', 'title', 'outcome', 'remote', 'remote-result', 'local-source-path',
    'destination-parent', 'directory-name', 'status-title', 'status-message',
    'current-path', 'progress', 'start', 'back-to-welcome', 'cancel', 'retry', 'activate',
    'discard-staging', 'open-current-vault', 'dismiss-residue', 'action-note', 'warnings',
    'index-failures', 'fatal-error', 'git-source', 'local-source', 'inspect-remote',
    'choose-local-source', 'choose-destination', 'create-vault', 'open-existing-vault', 'begin-restore'
  ];
  const map = new Map(ids.map(id => [id, makeEl(id)]));
  map.get('directory-name').value = 'workstation-vault-restored';
  const form = map.get('recovery-form');
  form.elements = { sourceKind: { value: 'git' } };
  form.querySelectorAll = () => [map.get('remote'), map.get('directory-name'), map.get('start'), map.get('back-to-welcome')];

  let inspected = 0;
  let returned = 0;
  const window = {
    workstationRecovery: {
      getState: async () => ({ phase: 'idle', mode: 'restore', canReturnToWelcome: true }),
      inspectRemote: async () => { inspected += 1; return { message: 'ok', state: { phase: 'idle', mode: 'restore', canReturnToWelcome: true } }; },
      returnToWelcome: async () => { returned += 1; return { phase: 'idle', mode: 'first-run', canReturnToWelcome: false }; },
      onStateChanged: () => () => {}
    }
  };
  const document = {
    title: '',
    body: { dataset: {} },
    getElementById: id => map.get(id) || null,
    querySelectorAll: () => []
  };
  vm.runInNewContext(source, { document, window, Number, String, Math, Object, Boolean });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(map.get('back-to-welcome').hidden, false);
  assert.match(map.get('action-note').textContent, /填写 Git 远端地址/);

  map.get('remote').value = 'https://example.com/vault.git';
  await form.dispatch('input', { target: map.get('remote') });
  assert.match(map.get('action-note').textContent, /检查远端/);

  await map.get('remote').dispatch('keydown', { key: 'Enter' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspected, 1);
  assert.match(map.get('action-note').textContent, /上级目录/);

  await map.get('back-to-welcome').dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, 1);
  assert.equal(document.body.dataset.view, 'welcome');
});

test('多日期待办清空后撤销按原文精确还原，外部修改后撤销返回 409 且保留外部内容', async t => {
  const ctx = await setupApp(t);
  const original = '# 论文\n\n- [ ] 补齐消融实验 @2026-10-01 并在 @2026-10-05 前汇总\n';
  const note = await writeNote(ctx.config.notesDir, 'research/multi.md', { raw: original });
  await ctx.indexer.scan();

  const cleared = await request(ctx.app).post('/tasks/update').set('Accept', 'application/json')
    .send({ path: note.path, line: 3, expectedHash: note.hash, done: false, due: '' }).expect(200);
  assert.ok(cleared.body.undoToken);
  const afterClear = await fs.readFile(path.join(ctx.config.notesDir, note.path), 'utf8');
  assert.doesNotMatch(afterClear, /@2026-10-/);

  await request(ctx.app).post('/tasks/undo').set('Accept', 'application/json')
    .send({ undoToken: cleared.body.undoToken, expectedHash: cleared.body.hash }).expect(200);
  assert.equal(await fs.readFile(path.join(ctx.config.notesDir, note.path), 'utf8'), original);

  // 二次使用同一个 undoToken 被拒绝
  await request(ctx.app).post('/tasks/undo').set('Accept', 'application/json')
    .send({ undoToken: cleared.body.undoToken }).expect(409);

  // 外部改过笔记后，撤销必须返回 409 且不覆盖外部内容
  const current = await request(ctx.app).post('/tasks/update').set('Accept', 'application/json')
    .send({ path: note.path, line: 3, expectedHash: (await writeNote(ctx.config.notesDir, note.path, { raw: original })).hash, done: true }).expect(200);
  const external = '# 论文\n\n外部刚写的重要补充\n';
  await writeNote(ctx.config.notesDir, note.path, { raw: external });
  await request(ctx.app).post('/tasks/undo').set('Accept', 'application/json')
    .send({ undoToken: current.body.undoToken, expectedHash: current.body.hash }).expect(409);
  assert.equal(await fs.readFile(path.join(ctx.config.notesDir, note.path), 'utf8'), external);
});

test('卡片暂停携带 expectedHash 时拦住跨窗口 409，并随 deckCanReview 返回且不被派生统计失败拖垮', async t => {
  const ctx = await setupApp(t);
  const deckPath = path.join(ctx.vaultDir, 'cards', 'ml.md');
  await fs.writeFile(deckPath, '---\ndeck: 机器学习\n---\n\n## 正则化\n\nL2\n');
  const cardsHtml = (await request(ctx.app).get('/cards?deck=' + encodeURIComponent('机器学习')).expect(200)).text;
  const idMatch = cardsHtml.match(/name="id" value="([^"]+)"/);
  assert.ok(idMatch);

  const suspended = await request(ctx.app).post('/cards/suspend').set('Accept', 'application/json')
    .send({ id: idMatch[1], suspended: true }).expect(200);
  assert.equal(suspended.body.deckCanReview, false);

  // 外部改过卡组后，带旧 hash 的撤销必须返回 409
  await fs.appendFile(deckPath, '\n## 新增卡片\n\n内容\n');
  await request(ctx.app).post('/cards/suspend').set('Accept', 'application/json')
    .send({ id: idMatch[1], suspended: false, expectedHash: suspended.body.hash }).expect(409);
});

test('服务端确认的 ws_flash 只在写入成功后下发一次，且对无效日期按服务端真实解析结果提示', async t => {
  const ctx = await setupApp(t);
  const agent = request.agent(ctx.app);

  // 非法日期 @2099-02-30 会被解析器忽略并在今日页按今天追加，不应谎称已排到 2099-02-30
  const invalidDue = await agent.post('/plan/tasks').type('form')
    .send({ text: '检查 @2099-02-30', due: 'today', returnTo: '/' }).expect(302);
  assert.equal(invalidDue.headers.location, '/?added=1');
  const homeAfterInvalid = (await agent.get('/?added=1').expect(200)).text;
  assert.match(homeAfterInvalid, /data-server-flash="[^"]*已添加待办/);
  assert.doesNotMatch(homeAfterInvalid, /已添加到计划（2099-02-30）/);
  // 二次访问已清空，不再重复弹出
  assert.doesNotMatch((await agent.get('/').expect(200)).text, /data-server-flash=/);

  // 合法未来日期明确提示去向
  await agent.post('/plan/tasks').type('form')
    .send({ text: '准备报告 @2099-05-01', due: 'today', returnTo: '/' }).expect(302);
  const homeAfterFuture = (await agent.get('/?added=1').expect(200)).text;
  assert.match(homeAfterFuture, /已添加到计划（2099-05-01）/);

  // 删除失败（409）绝不下发成功提示
  const note = await writeNote(ctx.config.notesDir, 'inbox/keep.md', { body: '# 保留\n' });
  const failedDelete = await agent.post('/delete').type('form')
    .send({ path: note.path, expectedHash: 'wrong-hash' }).expect(409);
  assert.equal(failedDelete.headers['set-cookie'], undefined);
});

test('健康页区分同名待消歧双链与缺失笔记，不为同名双链建议新建第三篇', async t => {
  const ctx = await setupApp(t);
  await writeNote(ctx.config.notesDir, 'a/论文.md', { body: '# 论文 A\n' });
  await writeNote(ctx.config.notesDir, 'b/论文.md', { body: '# 论文 B\n' });
  await writeNote(ctx.config.notesDir, 'inbox/index.md', { body: '# 索引\n\n[[论文]] 与 [[真的缺失]]\n' });
  await ctx.indexer.scan();

  const health = (await request(ctx.app).get('/health').expect(200)).text;
  assert.match(health, /同名多篇，需写明路径/);
  assert.doesNotMatch(health, /href="\/new\?path=%E8%AE%BA%E6%96%87/);
  assert.match(health, /href="\/new\?path=%E7%9C%9F%E7%9A%84%E7%BC%BA%E5%A4%B1&amp;returnTo=\/health"/);
});

test('设置页先把同步间隔改成无效值再关闭自动同步，仍可正常保存其他设置', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'settings', 'settings.js'), 'utf8');
  const fields = new Map();
  const makeEl = (extra = {}) => {
    const listeners = new Map();
    const classes = new Set();
    return {
      value: '', checked: false, hidden: false, disabled: false, textContent: '', dataset: {},
      classList: { toggle(n, f) { if (f) classes.add(n); else classes.delete(n); }, contains: n => classes.has(n) },
      addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
      async dispatch(t, e = {}) { for (const fn of listeners.get(t) || []) await fn({ preventDefault() {}, ...e }); },
      setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [], ...extra
    };
  };
  for (const name of ['vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes', 'launchAtLogin', 'theme']) {
    fields.set(name, makeEl({ name, type: ['readOnly', 'syncEnabled', 'launchAtLogin'].includes(name) ? 'checkbox' : 'text' }));
  }
  const save = makeEl();
  const form = makeEl({
    elements: { namedItem: n => fields.get(n) || null },
    // 真实校验逻辑：启用且无效的间隔会阻止保存
    reportValidity: () => fields.get('syncIntervalMinutes').disabled || Number(fields.get('syncIntervalMinutes').value) >= 1,
    querySelectorAll: () => [...fields.values(), save]
  });
  const ids = {
    'settings-form': form, message: makeEl(), save, 'discard-changes': makeEl({ hidden: true }),
    'reload-settings': makeEl({ hidden: true }), 'runtime-status': makeEl(), 'sync-now': makeEl(),
    'sync-interval-field': makeEl(), 'system-hide-note': makeEl(), 'sync-status': makeEl(),
    'sync-status-title': makeEl(), 'sync-status-detail': makeEl(), 'abort-git-operation': makeEl({ hidden: true }),
    'open-vault': makeEl(), 'open-config': makeEl(), 'open-recovery': makeEl()
  };
  const savedPayloads = [];
  const data = {
    revision: 1, runtimeRunning: true,
    settings: { vaultDir: '/v', device: 'mac', readOnly: false, syncEnabled: true, syncIntervalMinutes: 20, launchAtLogin: false, theme: 'system' },
    syncStatus: { phase: 'idle', operation: '', recovery: null, lastResult: null },
    capabilities: { launchAtLogin: false, isMac: true }
  };
  const window = {
    innerHeight: 800,
    location: { hash: '' },
    addEventListener() {},
    workstationSettings: {
      get: async () => data,
      save: async update => { savedPayloads.push(update); return { ...data, revision: 2, settings: update.settings, syncStatus: { phase: 'disabled' } }; },
      onChanged: () => () => {},
      onSyncStatusChanged: () => () => {},
      onNavigateSection: () => () => {}
    }
  };
  const document = {
    body: { dataset: {} },
    documentElement: { classList: { contains: () => true } },
    getElementById: id => ids[id] || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  vm.runInNewContext(source, { document, window, Map, Set, Number, String, JSON, Object, Boolean, Math });
  await new Promise(resolve => setImmediate(resolve));

  // 用户先把间隔改成非法 0，再决定干脆关闭自动同步
  fields.get('syncIntervalMinutes').value = '0';
  fields.get('syncEnabled').checked = false;
  await form.dispatch('change', { target: fields.get('syncEnabled') });
  assert.equal(fields.get('syncIntervalMinutes').disabled, true, '隐藏间隔字段必须退出表单校验');
  assert.equal(form.reportValidity(), true);

  await form.dispatch('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savedPayloads.length, 1);
  assert.equal(savedPayloads[0].settings.syncEnabled, false);
  assert.equal(savedPayloads[0].settings.syncIntervalMinutes, 20, '回退为上次有效间隔，顺利通过主进程校验');
});
