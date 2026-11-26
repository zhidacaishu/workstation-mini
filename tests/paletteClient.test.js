const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function createElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    id: '',
    dataset: {},
    children: [],
    className: '',
    textContent: '',
    value: '',
    attributes: {},
    isConnected: true,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    scrollIntoView() {}
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function loadPalette({ readOnly = false, primaryModifier = 'control', fetch = async () => ({ json: async () => ({ results: [] }) }) } = {}) {
  const dialog = createElement();
  const input = createElement();
  const list = createElement();
  const status = createElement();
  const form = createElement();
  const trigger = createElement();
  const main = createElement();
  const body = createElement();
  const documentListeners = new Map();
  const timers = new Map();
  const notifications = [];
  let nextTimer = 1;

  body.dataset.primaryModifier = primaryModifier;
  dialog.dataset.readonly = readOnly ? '1' : '0';
  dialog.open = false;
  dialog.showModalCalls = 0;
  dialog.showModal = () => { dialog.open = true; dialog.showModalCalls += 1; };
  dialog.close = () => { dialog.open = false; dialog.dispatch('close'); };
  dialog.querySelector = selector => ({
    '.palette-input': input,
    '.palette-list': list,
    '.palette-status': status
  }[selector] || null);
  form.submitCalls = 0;
  form.submit = () => { form.submitCalls += 1; };

  const document = {
    body,
    activeElement: trigger,
    getElementById(id) { return ({ palette: dialog, 'palette-post': form, 'main-content': main })[id] || null; },
    querySelectorAll(selector) { return selector === '[data-palette-open]' ? [trigger] : []; },
    createElement() { return createElement(); },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    }
  };
  input.focus = () => { document.activeElement = input; };
  trigger.focusCalls = 0;
  trigger.focus = () => { document.activeElement = trigger; trigger.focusCalls += 1; };
  main.focusCalls = 0;
  main.focus = () => { document.activeElement = main; main.focusCalls += 1; };
  const location = { href: '', reloadCalls: 0, reload() { this.reloadCalls += 1; } };
  const requestJson = async (url, options) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (response.ok === false) throw new Error(payload.message || `请求失败（${response.status}）`);
    return payload;
  };
  class AbortController {
    constructor() {
      const listeners = [];
      this.signal = {
        aborted: false,
        addEventListener(type, handler) { if (type === 'abort') listeners.push(handler); }
      };
      this.abort = () => {
        this.signal.aborted = true;
        listeners.forEach(handler => handler());
      };
    }
  }
  const window = {
    location,
    workstationUI: {
      requestJson,
      notify(text, options = {}) { notifications.push({ text, options }); }
    }
  };
  const setTimeout = callback => {
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  };
  const clearTimeout = id => timers.delete(id);

  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'palette.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, fetch, setTimeout, clearTimeout, AbortController,
    encodeURIComponent, Object, Math, String
  });

  return {
    document, body, main, dialog, input, list, status, form, trigger, location, notifications,
    keydown(event) {
      for (const handler of documentListeners.get('keydown') || []) handler(event);
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(callback => callback());
    },
    labels() {
      return list.children.map(item => item.children.find(child => child.className === 'palette-label')?.textContent);
    },
    item(label) {
      return list.children.find(item => item.children.some(child => child.className === 'palette-label' && child.textContent === label));
    }
  };
}

function shortcut(modifier) {
  let prevented = false;
  return {
    event: { key: 'k', ctrlKey: modifier === 'ctrl', metaKey: modifier === 'meta', preventDefault() { prevented = true; } },
    prevented: () => prevented
  };
}

test('主修饰键按平台区分，另一个修饰键既不开面板也不吞事件', async () => {
  // macOS 的 Ctrl+K 是系统级的「删到行尾」。面板要是也认 Ctrl，用户在编辑器里
  // 想删到行尾就会弹出一个模态面板，而 preventDefault 又把原生行为吃掉了。
  // 反过来 Windows/Linux 上 Meta 是系统键，同样不该被页面接管。
  for (const [primaryModifier, wanted, unwanted] of [['control', 'ctrl', 'meta'], ['meta', 'meta', 'ctrl']]) {
    const ui = await loadPalette({ primaryModifier });

    const wrong = shortcut(unwanted);
    ui.keydown(wrong.event);
    await flush();
    assert.equal(ui.dialog.open, false, `${primaryModifier}：${unwanted} 不该打开面板`);
    // 没有 preventDefault 才能把按键交回给平台自己的文本编辑绑定。
    assert.equal(wrong.prevented(), false, `${primaryModifier}：${unwanted} 不该被吞掉`);

    const right = shortcut(wanted);
    ui.keydown(right.event);
    await flush();
    assert.equal(ui.dialog.open, true, `${primaryModifier}：${wanted} 应该打开面板`);
    assert.equal(right.prevented(), true);
  }
});

test('主修饰键 +K 和顶部按钮打开面板，已打开时不重复请求', async () => {
  for (const [primaryModifier, modifier] of [['control', 'ctrl'], ['meta', 'meta']]) {
    let calls = 0;
    const ui = await loadPalette({
      primaryModifier,
      fetch: async () => { calls += 1; return { json: async () => ({ results: [] }) }; }
    });
    ui.input.value = '旧查询';
    const key = shortcut(modifier);
    ui.keydown(key.event);
    await flush();

    assert.equal(key.prevented(), true);
    assert.equal(ui.dialog.open, true);
    assert.equal(ui.dialog.showModalCalls, 1);
    assert.equal(ui.input.value, '');
    assert.equal(ui.input.attributes['aria-expanded'], 'true');
    assert.equal(ui.input.attributes['aria-activedescendant'], 'palette-option-0');
    assert.equal(calls, 1);

    ui.keydown(shortcut(modifier).event);
    assert.equal(calls, 1);
  }

  const ui = await loadPalette();
  ui.trigger.dispatch('click');
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.input.attributes['aria-expanded'], 'true');
  ui.dialog.close();
  assert.equal(ui.input.attributes['aria-expanded'], 'false');
  assert.equal(ui.input.attributes['aria-activedescendant'], undefined);
  assert.equal(ui.trigger.focusCalls, 1);

  ui.document.activeElement = ui.body;
  ui.trigger.dispatch('click');
  ui.dialog.close();
  assert.equal(ui.main.focusCalls, 1);
});

test('匹配命令排在最多六篇笔记之前，fallback 命令排在之后', async () => {
  const results = Array.from({ length: 8 }, (_, index) => ({
    path: `research/日记 ${index + 1}.md`,
    title: index === 0 ? '' : `日记研究 ${index + 1}`,
    section: 'research'
  }));
  const ui = await loadPalette({ fetch: async url => {
    assert.equal(url, '/api/search?q=%E6%97%A5%E8%AE%B0');
    return { json: async () => ({ results }) };
  } });
  ui.dialog.showModal();
  ui.input.value = '日记';
  ui.input.dispatch('input');
  ui.runTimers();
  await flush();

  assert.deepEqual(ui.labels(), [
    'research/日记 1.md', '日记研究 2', '日记研究 3', '日记研究 4', '日记研究 5', '日记研究 6',
    '新建笔记', '全文搜索「日记」'
  ]);
  assert.equal(ui.list.children[0].className, 'palette-item active');
  assert.equal(ui.list.children[0].attributes.role, 'option');
  assert.equal(ui.list.children[0].attributes['aria-selected'], 'true');
  // 笔记行只放文档图标，不再写「笔记」两个字；命令行照旧是文字标签。
  const iconOf = option => option.children.find(child => String(child.className).startsWith('palette-icon'));
  assert.equal(iconOf(ui.list.children[0]).className, 'palette-icon is-note');
  assert.equal(iconOf(ui.list.children[0]).textContent, '');
  assert.equal(iconOf(ui.list.children.at(-1)).className, 'palette-icon');
  assert.equal(iconOf(ui.list.children.at(-1)).textContent, '搜索');
});

test('较早的搜索响应不会覆盖较新的结果', async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const ui = await loadPalette({ fetch: url => url.includes('old') ? oldRequest.promise : newRequest.promise });
  ui.dialog.showModal();

  ui.input.value = 'old';
  ui.input.dispatch('input');
  ui.runTimers();
  ui.input.value = 'new';
  ui.input.dispatch('input');
  ui.runTimers();

  newRequest.resolve({ json: async () => ({ results: [{ path: 'new.md', title: '新结果' }] }) });
  await flush();
  assert.ok(ui.labels().includes('新结果'));

  oldRequest.resolve({ json: async () => ({ results: [{ path: 'old.md', title: '旧结果' }] }) });
  await flush();
  assert.ok(ui.labels().includes('新结果'));
  assert.ok(!ui.labels().includes('旧结果'));
});

test('输入立即中止旧搜索；旧列表留到新结果到达，回车会等新结果', async () => {
  let firstSignal;
  const ui = await loadPalette({ fetch: (url, options = {}) => {
    if (url.includes('old')) {
      firstSignal = options.signal;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }));
    }
    return Promise.resolve({ json: async () => ({ results: [] }) });
  } });
  ui.dialog.showModal();
  ui.input.value = 'old';
  ui.input.dispatch('input');
  ui.runTimers();
  await flush();

  const before = ui.labels();
  ui.input.value = 'new';
  ui.input.dispatch('input');
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(ui.labels(), before, '列表不清空，不跳动');
});

test('IME 合成期间不搜索或执行 Enter，compositionend 后只搜索一次', async () => {
  let calls = 0;
  const ui = await loadPalette({ fetch: async () => {
    calls += 1;
    return { json: async () => ({ results: [] }) };
  } });
  ui.dialog.showModal();
  ui.input.dispatch('compositionstart');
  ui.input.value = '日';
  ui.input.dispatch('input', { isComposing: true });
  ui.input.dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault() { throw new Error('不应执行'); } });
  ui.runTimers();
  assert.equal(calls, 0);
  ui.input.dispatch('compositionend');
  ui.runTimers();
  await flush();
  assert.equal(calls, 1);
});

test('有其他 modal 时拒绝打开，且只接受 exact Ctrl/Cmd+K', async () => {
  const ui = await loadPalette();
  const other = createElement();
  ui.document.querySelectorAll = selector => selector === 'dialog[open]' ? [other] : [];
  let prevented = false;
  ui.keydown({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(ui.dialog.open, false);

  ui.document.querySelectorAll = () => [];
  ui.keydown({ key: 'k', ctrlKey: true, metaKey: true, altKey: false, shiftKey: false, preventDefault() {} });
  ui.keydown({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, preventDefault() {} });
  assert.equal(ui.dialog.open, false);
});

test('只读模式隐藏写命令但保留搜索和笔记导航', async () => {
  const ui = await loadPalette({
    readOnly: true,
    fetch: async () => ({ json: async () => ({ results: [{ path: 'safe.md', title: '可读笔记' }] }) })
  });
  ui.keydown(shortcut('ctrl').event);
  await flush();

  assert.deepEqual(ui.labels(), ['可读笔记', '计划', '重新扫描索引']);
  for (const label of ['今天的日记', '新建笔记']) assert.ok(!ui.labels().includes(label));

  ui.input.value = '安全';
  ui.input.dispatch('input');
  ui.runTimers();
  await flush();
  assert.ok(ui.labels().includes('全文搜索「安全」'));
});

test('鼠标悬停只更新 active 状态，不替换待点击节点', async () => {
  const ui = await loadPalette();
  ui.keydown(shortcut('ctrl').event);
  await flush();

  const target = ui.list.children[1];
  target.dispatch('mouseenter');
  assert.equal(ui.list.children[1], target);
  assert.equal(target.className, 'palette-item active');
  target.dispatch('click');
  assert.equal(ui.location.href, '/plan');
});

test('键盘导航循环更新 active 状态并执行当前项', async () => {
  const ui = await loadPalette();
  ui.keydown(shortcut('ctrl').event);
  await flush();

  const preventDefault = () => {};
  ui.input.dispatch('keydown', { key: 'ArrowUp', preventDefault });
  assert.equal(ui.list.children.at(-1).className, 'palette-item active');
  assert.equal(ui.list.children.at(-1).attributes['aria-selected'], 'true');

  ui.input.dispatch('keydown', { key: 'ArrowDown', preventDefault });
  assert.equal(ui.list.children[0].className, 'palette-item active');
  ui.input.dispatch('keydown', { key: 'Enter', preventDefault });

  assert.equal(ui.dialog.open, false);
  assert.equal(ui.location.href, '/new');
  assert.equal(ui.form.submitCalls, 0);
});

test('命令和笔记使用正确 URL，重新扫描索引通过 POST 后刷新', async () => {
  const calls = [];
  const ui = await loadPalette({ fetch: async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/reindex') return { ok: true, json: async () => ({ added: 9, updated: 2, phase: 'ready', failureTotal: 0 }) };
    return { json: async () => ({ results: [{ path: '研究 主题/中文&英文.md', title: '特殊笔记' }] }) };
  } });

  ui.dialog.showModal();
  ui.input.value = '研究 主题/中文&英文';
  ui.input.dispatch('input');
  ui.runTimers();
  await flush();

  ui.item('特殊笔记').dispatch('click');
  assert.equal(ui.location.href, '/note/%E7%A0%94%E7%A9%B6%20%E4%B8%BB%E9%A2%98/%E4%B8%AD%E6%96%87%26%E8%8B%B1%E6%96%87.md');

  ui.dialog.open = true;
  ui.item('新建笔记').dispatch('click');
  assert.equal(ui.location.href, '/new?path=%E7%A0%94%E7%A9%B6%20%E4%B8%BB%E9%A2%98%2F%E4%B8%AD%E6%96%87%26%E8%8B%B1%E6%96%87');

  ui.dialog.open = true;
  ui.item('全文搜索「研究 主题/中文&英文」').dispatch('click');
  assert.equal(ui.location.href, '/search?q=%E7%A0%94%E7%A9%B6%20%E4%B8%BB%E9%A2%98%2F%E4%B8%AD%E6%96%87%26%E8%8B%B1%E6%96%87');

  const reindexUi = await loadPalette({ fetch: async (url, options) => {
    calls.push([url, options]);
    return url === '/api/reindex'
      ? { ok: true, json: async () => ({ added: 9, updated: 2, phase: 'ready', failureTotal: 0 }) }
      : { json: async () => ({ results: [] }) };
  } });
  reindexUi.keydown(shortcut('ctrl').event);
  await flush();
  reindexUi.item('重新扫描索引').dispatch('click');
  await flush();

  assert.equal(calls.at(-1)[0], '/api/reindex');
  assert.equal(calls.at(-1)[1].method, 'POST');
  assert.deepEqual(reindexUi.notifications, [{ text: '索引扫描完成：新增 9 / 更新 2', options: {} }]);
  assert.equal(reindexUi.location.reloadCalls, 0);
  reindexUi.runTimers();
  assert.equal(reindexUi.location.reloadCalls, 1);
});

test('重新扫描索引失败时提示错误且不刷新', async () => {
  for (const failure of [
    async () => ({ ok: false, status: 500 }),
    async () => { throw new Error('网络中断'); }
  ]) {
    const ui = await loadPalette({ fetch: async url => (
      url === '/api/reindex'
        ? failure()
        : { json: async () => ({ results: [] }) }
    ) });
    ui.keydown(shortcut('ctrl').event);
    await flush();
    ui.item('重新扫描索引').dispatch('click');
    await flush();

    assert.match(ui.notifications[0].text, /^重新扫描索引失败：/);
    assert.equal(ui.notifications[0].options.type, 'error');
    assert.equal(ui.location.reloadCalls, 0);
  }
});

test('搜索切换时点击旧笔记不会误打开，当前结果可直接点击', async () => {
  const pending = deferred();
  const ui = await loadPalette({
    fetch: async url => ({ json: async () => url.endsWith('q=') ? { results: [{ path: 'old.md' }] } : await pending.promise })
  });
  ui.keydown(shortcut('ctrl').event);
  await flush();
  ui.input.value = '文献';
  ui.input.dispatch('input');
  ui.list.children[0].dispatch('click');
  assert.equal(ui.dialog.open, true);
  ui.runTimers();
  ui.list.children[0].dispatch('click');
  assert.equal(ui.dialog.open, true);
  pending.resolve({ results: [{ path: 'new.md' }] });
  await flush();
  ui.list.children[0].dispatch('click');
  assert.equal(ui.location.href, '/note/new.md');
});
