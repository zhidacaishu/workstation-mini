const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    contains(name) { return values.has(name); }
  };
}

function element() {
  const listeners = new Map();
  return {
    dataset: {},
    attributes: {},
    className: '',
    classList: classList(),
    textContent: '',
    value: '',
    disabled: false,
    hidden: false,
    children: [],
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      return Promise.all((listeners.get(type) || []).map(handler => handler(event)));
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  };
}

class FakeFormData {
  constructor(form) {
    this.values = form.fields.map(input => [input.name, input.value]);
  }
  [Symbol.iterator]() { return this.values[Symbol.iterator](); }
  entries() { return this.values[Symbol.iterator](); }
  get(name) { return this.values.find(([key]) => key === name)?.[1] ?? null; }
}

async function source() {
  return fs.readFile(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function loadEditor(fetch, { primaryModifier = 'control' } = {}) {
  let formDataCalls = 0;
  const expectedHashInput = { name: 'expectedHash', value: 'hash-1' };
  const isNewInput = { name: 'isNew', value: '0' };
  const pathInput = { name: 'path', value: 'notes/test.md' };
  const bodyInput = { name: 'body', value: '初始正文' };
  const status = element();
  const saveButton = element();
  const form = element();
  form.action = '/save';
  form.fields = [expectedHashInput, isNewInput, pathInput, bodyInput];
  form.requestSubmit = () => {
    form.requestSubmitCalls = (form.requestSubmitCalls || 0) + 1;
    form.dispatch('submit', { preventDefault() {} });
  };
  form.querySelector = selector => ({
    '[data-editor-status]': status,
    '[data-editor-save]': saveButton,
    '[name="expectedHash"]': expectedHashInput,
    '[name="isNew"]': isNewInput,
    '[name="path"]': pathInput
  }[selector] || null);

  const documentListeners = new Map();
  const body = element();
  body.dataset.primaryModifier = primaryModifier;
  const document = {
    body,
    activeElement: null,
    openDialog: false,
    querySelector(selector) {
      if (selector === '[data-editor-form]') return form;
      if (selector === 'dialog[open]') return this.openDialog ? {} : null;
      return null;
    },
    getElementById() { return null; },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    }
  };
  const windowListeners = new Map();
  const window = {
    location: { href: '' },
    history: { back() {} },
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    }
  };

  class CountingFormData extends FakeFormData {
    constructor(target) {
      super(target);
      formDataCalls += 1;
    }
  }

  vm.runInNewContext(await source(), {
    document, window, fetch, FormData: CountingFormData, URLSearchParams,
    Object, JSON, Error, String, Map, Set, Promise
  });

  return {
    form, expectedHashInput, isNewInput, pathInput, bodyInput, status, saveButton, window, document,
    formDataCalls() { return formDataCalls; },
    isInteractiveTarget(target) { return window.workstationUI.isInteractiveTarget(target); },
    keydown(event) {
      for (const handler of documentListeners.get('keydown') || []) handler(event);
    },
    beforeUnload(event) {
      for (const handler of windowListeners.get('beforeunload') || []) handler(event);
    }
  };
}

function unloadEvent() {
  return {
    prevented: false,
    returnValue: undefined,
    preventDefault() { this.prevented = true; }
  };
}

test('交互目标覆盖媒体元素及嵌套原生/ARIA 控件', async () => {
  const ui = await loadEditor(async () => { throw new Error('不应保存'); });
  const matchingTarget = expected => ({
    closest(selector) { return selector.split(',').includes(expected) ? this : null; }
  });

  assert.equal(ui.isInteractiveTarget(matchingTarget('audio')), true, 'AUDIO 自身是交互目标');
  assert.equal(ui.isInteractiveTarget(matchingTarget('video')), true, 'VIDEO 自身是交互目标');
  assert.equal(ui.isInteractiveTarget(matchingTarget('[role="button"]')), true, 'ARIA button 是交互目标');

  const buttonChild = matchingTarget('button');
  const textNode = { nodeType: 3, parentElement: buttonChild };
  assert.equal(ui.isInteractiveTarget(textNode), true, '嵌套 button child/text node 通过祖先识别');
  assert.equal(ui.isInteractiveTarget({ closest: () => null }), false);
});

test('编辑器标记未保存状态，保存失败保留正文并继续阻止离开', async () => {
  const ui = await loadEditor(async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ message: '磁盘写入失败' })
  }));

  ui.bodyInput.value = '仍需保留的正文';
  await ui.form.dispatch('input');
  assert.equal(ui.status.textContent, '有未保存的更改');
  assert.match(ui.status.className, /is-dirty/);

  const before = unloadEvent();
  ui.beforeUnload(before);
  assert.equal(before.prevented, true);

  await ui.form.dispatch('submit', { preventDefault() {} });
  assert.equal(ui.bodyInput.value, '仍需保留的正文');
  assert.match(ui.status.textContent, /磁盘写入失败/);
  assert.equal(ui.saveButton.disabled, false);
  assert.equal(ui.window.location.href, '');

  const after = unloadEvent();
  ui.beforeUnload(after);
  assert.equal(after.prevented, true);
});

test('dirty 事件只序列化一次表单', async () => {
  const ui = await loadEditor(async () => { throw new Error('不应保存'); });
  const initialCalls = ui.formDataCalls();
  ui.bodyInput.value = '修改一次';
  await ui.form.dispatch('input');
  assert.equal(ui.formDataCalls() - initialCalls, 1);
  assert.equal(ui.status.textContent, '有未保存的更改');
});

test('编辑器保存成功后沿服务器 redirect 地址导航', async () => {
  let submitted;
  let submittedBody;
  const ui = await loadEditor(async (_url, options) => {
    submittedBody = options.body;
    submitted = Object.fromEntries(options.body);
    return {
      ok: true,
      status: 200,
      url: 'http://127.0.0.1/save',
      text: async () => JSON.stringify({ hash: 'hash-2', redirect: '/note/notes/test.md' })
    };
  });

  ui.bodyInput.value = '已修改';
  await ui.form.dispatch('input');
  await ui.form.dispatch('submit', { preventDefault() {} });

  assert.equal(submittedBody instanceof URLSearchParams, true);
  assert.deepEqual(submitted, {
    expectedHash: 'hash-1', isNew: '0', path: 'notes/test.md', body: '已修改'
  });
  assert.equal(ui.expectedHashInput.value, 'hash-2');
  assert.equal(ui.window.location.href, '/note/notes/test.md');
  assert.equal(ui.status.textContent, '已保存，正在打开笔记…');

  const leaving = unloadEvent();
  ui.beforeUnload(leaving);
  assert.equal(leaving.prevented, false);
});

test('保存快捷键要求精确单主修饰键且 modal 内不提交', async () => {
  const ui = await loadEditor(async () => { throw new Error('不应保存'); });
  const key = overrides => ({
    key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides
  });

  for (const event of [
    key({ shiftKey: true }),
    key({ altKey: true }),
    key({ metaKey: true }),
    key({ ctrlKey: false, metaKey: false })
  ]) {
    ui.keydown(event);
    assert.equal(event.prevented, false);
  }
  ui.document.openDialog = true;
  const modal = key({});
  ui.keydown(modal);
  assert.equal(modal.prevented, false);
  assert.equal(ui.form.requestSubmitCalls || 0, 0);

  ui.document.openDialog = false;
  const exact = key({});
  ui.keydown(exact);
  assert.equal(exact.prevented, true);
  assert.equal(ui.form.requestSubmitCalls, 1);
});

test('macOS 上保存快捷键只认 Cmd，Ctrl 留给系统的文本编辑绑定', async () => {
  // Ctrl+K 在 macOS 是「删到行尾」。保存用的是 S，但判定逻辑是同一个 ——
  // 认了 Ctrl 就等于整套 Ctrl 组合键都可能被页面抢走。
  const ui = await loadEditor(async () => { throw new Error('不应保存'); }, { primaryModifier: 'meta' });
  const key = overrides => ({
    key: 's', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides
  });

  const ctrl = key({ ctrlKey: true });
  ui.keydown(ctrl);
  assert.equal(ctrl.prevented, false);
  assert.equal(ui.form.requestSubmitCalls || 0, 0);

  const both = key({ ctrlKey: true, metaKey: true });
  ui.keydown(both);
  assert.equal(both.prevented, false);
  assert.equal(ui.form.requestSubmitCalls || 0, 0);

  const meta = key({ metaKey: true });
  ui.keydown(meta);
  assert.equal(meta.prevented, true);
  assert.equal(ui.form.requestSubmitCalls, 1);
});

test('保存请求期间继续输入时不导航，并保留后续内容为未保存状态', async () => {
  const response = deferred();
  let submitted;
  const ui = await loadEditor(async (_url, options) => {
    submitted = Object.fromEntries(options.body);
    return response.promise;
  });

  ui.bodyInput.value = '提交版本';
  await ui.form.dispatch('input');
  const saving = ui.form.dispatch('submit', { preventDefault() {} });
  await flush();

  ui.bodyInput.value = '提交后继续输入';
  await ui.form.dispatch('input');
  const pending = unloadEvent();
  ui.beforeUnload(pending);
  assert.equal(pending.prevented, true);

  response.resolve({
    ok: true,
    status: 200,
    url: 'http://127.0.0.1/save',
    text: async () => JSON.stringify({ hash: 'hash-2', redirect: '/note/notes/test.md' })
  });
  await saving;

  assert.equal(submitted.body, '提交版本');
  assert.equal(submitted.expectedHash, 'hash-1');
  assert.equal(ui.expectedHashInput.value, 'hash-2');
  assert.equal(ui.bodyInput.value, '提交后继续输入');
  assert.equal(ui.window.location.href, '');
  assert.match(ui.status.textContent, /还有未保存的更改/);
});

async function loadIndexWatcher(fetch) {
  const banner = element();
  const message = element();
  const failures = element();
  const summary = element();
  const retry = element();
  banner.hidden = true;
  failures.hidden = true;
  summary.hidden = true;
  retry.hidden = true;
  const timers = [];
  const ids = {
    'index-banner': banner,
    'index-banner-message': message,
    'index-banner-failures': failures,
    'index-banner-summary': summary,
    'index-banner-retry': retry
  };
  const document = {
    activeElement: null,
    querySelector() { return null; },
    getElementById(id) { return ids[id] || null; },
    createElement() { return element(); },
    addEventListener() {}
  };
  const window = { history: { back() {} }, location: { href: '' }, addEventListener() {} };
  const setTimeout = (callback, delay) => {
    const timer = { callback, delay, active: true };
    timers.push(timer);
    return timer;
  };
  const clearTimeout = timer => { if (timer) timer.active = false; };

  vm.runInNewContext(await source(), {
    document, window, fetch, FormData: FakeFormData, URLSearchParams,
    Object, JSON, Error, String, Map, Set, Promise, setTimeout, clearTimeout
  });

  return {
    banner, message, failures, summary, retry,
    timerCount() { return timers.filter(timer => timer.active).length; },
    nextDelay() { return timers.find(timer => timer.active)?.delay; },
    runNextTimer() {
      const timer = timers.find(candidate => candidate.active);
      if (!timer) return;
      timer.active = false;
      timer.callback();
    }
  };
}

test('后台对账和单篇增量扫描不弹索引横幅，首次建索引照常提示', async () => {
  const responses = [
    { phase: 'indexing', scanKind: 'background', done: 10, total: 3000, notes: 3000 },
    { phase: 'indexing', scanKind: 'incremental', done: 0, total: 1, notes: 3000 },
    { phase: 'ready', scanKind: 'background', done: 3000, total: 3000, notes: 3000 },
    { phase: 'indexing', scanKind: 'initial', done: 10, total: 3000, notes: 0 }
  ];
  const ui = await loadIndexWatcher(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responses.shift())
  }));
  await flush();
  assert.equal(ui.banner.hidden, true, '后台对账不显示');
  ui.runNextTimer();
  await flush();
  assert.equal(ui.banner.hidden, true, '单篇增量不显示');
  ui.runNextTimer();
  await flush();
  assert.equal(ui.banner.hidden, true, '对账结束后也不出现「索引已恢复」');
  ui.runNextTimer();
  await flush();
  assert.equal(ui.banner.hidden, false);
  assert.match(ui.message.textContent, /正在建立索引 10\/3000/);
});

test('索引轮询仅在请求完成后安排下一次，不产生重叠请求', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const ui = await loadIndexWatcher(() => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  });

  assert.equal(calls, 1);
  assert.equal(ui.timerCount(), 0, '请求未完成时不安排轮询');
  first.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ phase: 'indexing', done: 1, total: 2 })
  });
  await flush();
  assert.equal(ui.timerCount(), 1);

  ui.runNextTimer();
  assert.equal(calls, 2);
  assert.equal(ui.timerCount(), 0, '下一请求 pending 时没有可触发的重叠 timer');
  second.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ phase: 'indexing', done: 2, total: 3 })
  });
  await flush();
  assert.equal(ui.timerCount(), 1, '请求完成后才安排下一次');
});

test('索引就绪后低频检查，并显示后来出现的文件失败', async () => {
  const statuses = [
    { phase: 'ready', notes: 3, failures: [], failureTotal: 0 },
    {
      phase: 'degraded', notes: 2, failureTotal: 2, failuresTruncated: false,
      failures: [
        { path: 'research/bad.md', code: 'read-failed', reason: '文件读取失败（EIO）' },
        { path: 'research/坏 属性.md', code: 'invalid-frontmatter', reason: '属性区（frontmatter）格式有误，点路径打开后修复' }
      ]
    }
  ];
  const ui = await loadIndexWatcher(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(statuses.shift())
  }));

  await flush();
  assert.equal(ui.banner.hidden, true);
  assert.equal(ui.nextDelay(), 15000);

  ui.runNextTimer();
  await flush();
  assert.equal(ui.banner.hidden, false);
  assert.match(ui.message.textContent, /有 2 篇笔记未能更新/);
  assert.equal(ui.failures.hidden, false);
  assert.equal(ui.failures.children[0].children[0].textContent, 'research/bad.md');
  const link = ui.failures.children[1].children[0];
  assert.equal(link.href, '/note/research/%E5%9D%8F%20%E5%B1%9E%E6%80%A7.md', '属性区写坏的笔记给出打开入口');
  assert.equal(link.children[0].textContent, 'research/坏 属性.md');
  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.nextDelay(), 9000);
});

test('索引重试使用语义 POST，并在成功后显示恢复状态', async () => {
  let statusCalls = 0;
  const requests = [];
  const ui = await loadIndexWatcher(async (url, options = {}) => {
    requests.push([url, options]);
    const payload = url === '/api/index-retry'
      ? { phase: 'ready', failureTotal: 0 }
      : statusCalls++ === 0
        ? {
            phase: 'degraded', notes: 1, failureTotal: 1, failuresTruncated: false,
            failures: [{ path: 'bad.md', reason: '笔记内容无法解析' }]
          }
        : { phase: 'ready', notes: 2, failureTotal: 0, failures: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  });

  await flush();
  assert.equal(ui.retry.hidden, false);
  await ui.retry.dispatch('click');
  await flush();

  const retryRequest = requests.find(([url]) => url === '/api/index-retry');
  assert.equal(retryRequest[1].method, 'POST');
  assert.match(ui.message.textContent, /索引已恢复，共 2 篇笔记/);
  assert.equal(ui.retry.hidden, true);
  assert.equal(ui.nextDelay(), 15000);
});

test('Retry 后忽略旧 generation 的在途 degraded 响应', async () => {
  const stale = deferred();
  let statusCalls = 0;
  const ui = await loadIndexWatcher(async url => {
    if (url === '/api/index-retry') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ phase: 'indexing' }) };
    }
    statusCalls += 1;
    if (statusCalls === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          phase: 'degraded', notes: 1, failureTotal: 1,
          failures: [{ path: 'old.md', reason: '旧失败' }]
        })
      };
    }
    if (statusCalls === 2) return stale.promise;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ phase: 'ready', notes: 2, failureTotal: 0, failures: [] })
    };
  });

  await flush();
  ui.runNextTimer();
  assert.equal(statusCalls, 2);
  await ui.retry.dispatch('click');
  await flush();
  assert.match(ui.message.textContent, /索引已恢复，共 2 篇笔记/);
  assert.equal(ui.retry.hidden, true);
  assert.equal(ui.timerCount(), 1);

  stale.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      phase: 'degraded', notes: 1, failureTotal: 1,
      failures: [{ path: 'stale.md', reason: '迟到失败' }]
    })
  });
  await flush();

  assert.match(ui.message.textContent, /索引已恢复，共 2 篇笔记/);
  assert.equal(ui.retry.hidden, true);
  assert.equal(ui.timerCount(), 1);
});

async function loadBoard(fetch) {
  const sourceCount = element();
  const targetCount = element();
  sourceCount.textContent = '1';
  targetCount.textContent = '0';
  const sourceItems = element();
  const targetItems = element();
  const sourceColumn = element();
  const targetColumn = element();
  sourceColumn.dataset.status = 'running';
  targetColumn.dataset.status = 'done';
  sourceColumn.querySelector = selector => ({
    '[data-board-items]': sourceItems,
    '[data-column-count]': sourceCount
  }[selector] || null);
  targetColumn.querySelector = selector => ({
    '[data-board-items]': targetItems,
    '[data-column-count]': targetCount
  }[selector] || null);

  const board = element();
  board.querySelectorAll = selector => selector === '[data-board-column]' ? [sourceColumn, targetColumn] : [];
  const card = element();
  card.dataset.status = 'running';
  card.parentColumn = sourceColumn;
  card.querySelector = () => null;
  card.closest = selector => selector === '[data-board-column]' ? card.parentColumn : null;
  sourceItems.cards = [card];
  targetItems.cards = [];
  sourceItems.querySelectorAll = selector => selector === '[data-board-card]' ? sourceItems.cards : [];
  targetItems.querySelectorAll = selector => selector === '[data-board-card]' ? targetItems.cards : [];
  targetItems.append = moved => {
    sourceItems.cards = sourceItems.cards.filter(item => item !== moved);
    if (!targetItems.cards.includes(moved)) targetItems.cards.push(moved);
    moved.parentColumn = targetColumn;
  };

  const select = element();
  select.name = 'status';
  select.value = 'done';
  select.selectedOptions = [{ textContent: '完成' }];
  const workflow = { name: 'workflow', value: 'experiment' };
  const notePath = { name: 'path', value: 'experiments/test.md' };
  const form = element();
  form.action = '/board/status';
  form.fields = [workflow, notePath, select];
  form.matches = selector => selector === '.statusform';
  form.closest = selector => ({
    '[data-board-card]': card,
    '[data-board]': board
  }[selector] || null);
  select.form = form;
  select.closest = selector => ({
    '[data-auto-submit]': select,
    '[data-board]': board
  }[selector] || null);

  const documentListeners = new Map();
  const document = {
    activeElement: null,
    querySelector() { return null; },
    getElementById() { return null; },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    }
  };
  const window = { history: { back() {} }, location: { href: '' }, addEventListener() {} };

  vm.runInNewContext(await source(), {
    document, window, fetch, FormData: FakeFormData, URLSearchParams,
    Object, JSON, Error, String
  });

  return {
    card, select, sourceItems, targetItems, sourceCount, targetCount,
    change() {
      for (const handler of documentListeners.get('change') || []) handler({ target: select });
    }
  };
}

test('看板状态成功后移动原卡片并更新两列计数', async () => {
  let request;
  const ui = await loadBoard(async (_url, options) => {
    request = options;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, path: 'experiments/test.md', status: 'done' })
    };
  });

  ui.change();
  await flush();
  await flush();

  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), {
    workflow: 'experiment',
    path: 'experiments/test.md',
    status: 'done'
  });
  assert.equal(ui.card.dataset.status, 'done');
  assert.deepEqual(ui.sourceItems.cards, []);
  assert.deepEqual(ui.targetItems.cards, [ui.card]);
  assert.equal(ui.sourceCount.textContent, '0');
  assert.equal(ui.targetCount.textContent, '1');
  assert.equal(ui.select.disabled, false);
  assert.equal(ui.select.focusCalls, 1);
});

test('看板状态请求失败时恢复选项并保留原卡片', async () => {
  const ui = await loadBoard(async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ message: '状态冲突' })
  }));

  ui.change();
  await flush();
  await flush();

  assert.equal(ui.select.value, 'running');
  assert.equal(ui.card.dataset.status, 'running');
  assert.deepEqual(ui.sourceItems.cards, [ui.card]);
  assert.deepEqual(ui.targetItems.cards, []);
  assert.equal(ui.sourceCount.textContent, '1');
  assert.equal(ui.targetCount.textContent, '0');
  assert.equal(ui.select.disabled, false);
  assert.equal(ui.select.focusCalls, 1);
});

test('409 时草稿未确认保存则不刷新，保留编辑内容与离开保护', async () => {
  const c = await loadEditor(async () => ({ ok: false, status: 409, json: async () => ({ message: '版本冲突' }) }));
  c.bodyInput.value = '唯一的未保存内容';
  c.window.workstationDrafts = { flush: async () => false };
  c.window.confirm = () => { throw new Error('不能承诺草稿已保存'); };
  c.window.location.reload = () => { throw new Error('不能刷新'); };
  await c.form.dispatch('submit', { preventDefault() {} });
  assert.match(c.status.textContent, /草稿未确认保存/);
  const event = unloadEvent(); c.beforeUnload(event);
  assert.equal(event.prevented, true);
  assert.equal(c.bodyInput.value, '唯一的未保存内容');
});
