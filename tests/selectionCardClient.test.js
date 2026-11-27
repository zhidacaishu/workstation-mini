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

function createClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); }
  };
}

function createElement(document, tagName = 'div') {
  const listeners = new Map();
  const node = {
    tagName: tagName.toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    children: [],
    attributes: {},
    classList: createClassList(),
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    isConnected: false,
    offsetHeight: 32,
    offsetWidth: 90,
    addEventListener(type, handler, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ handler, once: Boolean(options.once) });
    },
    async dispatch(type, event = {}) {
      const entries = [...(listeners.get(type) || [])];
      for (const entry of entries) {
        await entry.handler({ preventDefault() {}, target: node, ...event });
        if (entry.once) listeners.set(type, (listeners.get(type) || []).filter(item => item !== entry));
      }
    },
    append(...children) {
      this.children.push(...children);
      children.forEach(child => { child.isConnected = true; child.parentNode = this; });
    },
    remove() {
      this.isConnected = false;
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    },
    contains(target) {
      if (target === this) return true;
      return this.children.some(child => child.contains?.(target));
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { document.activeElement = this; this.focusCalls = (this.focusCalls || 0) + 1; },
    select() { this.selectCalls = (this.selectCalls || 0) + 1; }
  };
  return node;
}

function createDialog(document) {
  const dialog = createElement(document, 'dialog');
  const form = createElement(document, 'form');
  const front = createElement(document, 'input');
  const back = createElement(document, 'textarea');
  const deck = createElement(document, 'input');
  const save = createElement(document, 'button');
  const cancel = createElement(document, 'button');
  const status = createElement(document, 'p');
  front.name = 'front';
  back.name = 'back';
  deck.name = 'deckFile';
  deck.value = 'inbox';
  status.className = 'selection-status';
  status.hidden = true;
  form.querySelector = selector => ({
    '[name=front]': front,
    '[name=back]': back,
    '[name=deckFile]': deck,
    '[data-save]': save,
    '[data-cancel]': cancel,
    '.selection-status': status
  }[selector] || null);
  form.querySelectorAll = () => [front, back, deck, save, cancel];
  dialog.querySelector = selector => selector === '[data-card-form]' ? form : null;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.open = false;
    dialog.dispatch('close');
  };
  dialog.parts = { form, front, back, deck, save, cancel, status };
  return dialog;
}

async function loadSelectionCard(requestJson) {
  const documentListeners = new Map();
  const body = createElement(null, 'body');
  const document = {
    body,
    activeElement: null,
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    createElement(tagName) {
      return tagName === 'dialog' ? createDialog(document) : createElement(document, tagName);
    },
    querySelector(selector) { return selector === '.prose' ? prose : null; },
    getElementById(id) { return id === 'main-content' ? main : null; },
    getSelection() { return selection; }
  };
  body.dataset.notePath = 'reading/paper.md';
  body.append = (...children) => {
    body.children.push(...children);
    children.forEach(child => { child.isConnected = true; child.parentNode = body; });
  };

  const prose = createElement(document, 'article');
  const textNode = { nodeType: 3, parentElement: prose };
  prose.contains = target => target === textNode || target === prose;
  const main = createElement(document, 'main');
  const original = createElement(document, 'button');
  original.isConnected = true;
  document.activeElement = original;
  let selectedText = '工具变量';
  const rect = { top: 100, bottom: 120, left: 40, right: 120, width: 80, height: 20 };
  const selection = {
    isCollapsed: false,
    anchorNode: textNode,
    focusNode: textNode,
    toString() { return selectedText; },
    getRangeAt() {
      return { commonAncestorContainer: textNode, getBoundingClientRect: () => rect };
    }
  };

  const notifications = [];
  const windowListeners = new Map();
  const window = {
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: el => el?.style || { scrollPaddingTop: '56px', scrollPaddingBottom: '58px' },
    workstationUI: {
      requestJson,
      notify(message, options = {}) { notifications.push({ message, options }); }
    }
  };

  const script = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'selection-card.js'), 'utf8');
  vm.runInNewContext(script, { document, window, JSON, String, Math });

  return {
    document, body, prose, main, original, selection, notifications, rect,
    windowEvent(type) { windowListeners.get(type)(); },
    setText(value) { selectedText = value; },
    async selectionChange() {
      for (const handler of documentListeners.get('selectionchange') || []) await handler();
    },
    bubble() { return body.children.find(child => child.className === 'selection-card'); },
    dialog() { return body.children.find(child => child.className === 'selection-form'); }
  };
}

test('划词建卡使用单一原生 dialog，取消后清理并恢复焦点', async () => {
  const ui = await loadSelectionCard(async () => ({}));
  await ui.selectionChange();
  assert.ok(ui.bubble());

  await ui.bubble().children[0].dispatch('click');
  const dialog = ui.dialog();
  assert.ok(dialog);
  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.open, true);
  assert.equal(dialog.parts.front.value, '工具变量');
  assert.equal(dialog.parts.front.focusCalls, 1);
  assert.equal(dialog.parts.front.selectCalls, 1);

  await dialog.parts.cancel.dispatch('click');
  assert.equal(ui.dialog(), undefined);
  assert.equal(ui.original.focusCalls, 1);

  ui.setText('第二张');
  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  const secondDialog = ui.dialog();
  assert.equal(ui.body.children.filter(child => child.className === 'selection-form').length, 1);

  ui.original.isConnected = false;
  secondDialog.close();
  assert.equal(ui.dialog(), undefined);
  assert.equal(ui.main.focusCalls, 1);
});

test('原焦点是 body 时关闭 dialog 回到主内容', async () => {
  const ui = await loadSelectionCard(async () => ({}));
  ui.document.activeElement = ui.body;
  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  ui.dialog().close();
  assert.equal(ui.main.focusCalls, 1);
  assert.equal(ui.body.focusCalls, undefined);
});

test('划词建卡保持 payload，保存期间防重复提交，成功后关闭并通知', async () => {
  const pending = deferred();
  const calls = [];
  const ui = await loadSelectionCard((url, options) => {
    calls.push({ url, options });
    return pending.promise;
  });
  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  const dialog = ui.dialog();
  dialog.parts.back.value = '两阶段最小二乘';
  dialog.parts.deck.value = 'econometrics';

  const first = dialog.parts.form.dispatch('submit');
  const second = dialog.parts.form.dispatch('submit');
  assert.equal(calls.length, 1);
  for (const name of ['front', 'back', 'deck', 'save', 'cancel']) {
    assert.equal(dialog.parts[name].disabled, true, `${name} 保存中必须锁定`);
  }
  assert.equal(calls[0].url, '/cards/add');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.fallbackMessage, '保存失败');
  assert.equal(calls[0].options.json.front, '工具变量');
  assert.equal(calls[0].options.json.back, '两阶段最小二乘');
  assert.equal(calls[0].options.json.deckFile, 'econometrics');
  assert.equal(calls[0].options.json.source, 'reading/paper.md');

  pending.resolve({ path: 'cards/econometrics.md' });
  await first;
  await second;
  assert.equal(ui.dialog(), undefined);
  assert.deepEqual(ui.notifications, [{ message: '已存到 cards/econometrics.md', options: {} }]);
});

test('保存期间拒绝取消、Escape、遮罩关闭和新 selection', async () => {
  const request = deferred();
  const ui = await loadSelectionCard(() => request.promise);

  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  const dialog = ui.dialog();
  const saving = dialog.parts.form.dispatch('submit');

  await dialog.parts.cancel.dispatch('click');
  assert.equal(ui.dialog(), dialog);
  await dialog.dispatch('click', { target: dialog });
  assert.equal(ui.dialog(), dialog);
  let escapePrevented = false;
  await dialog.dispatch('cancel', { preventDefault() { escapePrevented = true; } });
  assert.equal(escapePrevented, true);

  ui.setText('新选区');
  await ui.selectionChange();
  assert.equal(ui.bubble(), undefined);
  assert.equal(ui.dialog(), dialog);

  request.resolve({ path: 'cards/first.md' });
  await saving;
  assert.equal(ui.dialog(), undefined);
});

test('划词建卡空正面不发请求并把焦点留在输入框', async () => {
  let calls = 0;
  const ui = await loadSelectionCard(async () => { calls += 1; return {}; });
  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  const dialog = ui.dialog();
  dialog.parts.front.value = '   ';

  await dialog.parts.form.dispatch('submit');
  assert.equal(calls, 0);
  assert.equal(dialog.parts.status.textContent, '正面不能为空。');
  assert.equal(dialog.parts.status.classList.contains('is-error'), true);
  assert.equal(dialog.parts.front.focusCalls, 2);
});

test('划词建卡失败时保留 dialog 和输入并恢复保存按钮', async () => {
  const ui = await loadSelectionCard(async () => { throw new Error('磁盘繁忙'); });
  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  const dialog = ui.dialog();
  dialog.parts.back.value = '不能丢失';

  await dialog.parts.form.dispatch('submit');
  assert.equal(ui.dialog(), dialog);
  assert.equal(dialog.parts.front.value, '工具变量');
  assert.equal(dialog.parts.back.value, '不能丢失');
  for (const name of ['front', 'back', 'deck', 'save', 'cancel']) {
    assert.equal(dialog.parts[name].disabled, false, `${name} 失败后必须解锁`);
  }
  assert.equal(dialog.parts.status.hidden, false);
  assert.match(dialog.parts.status.textContent, /磁盘繁忙/);
  assert.equal(dialog.parts.status.classList.contains('is-error'), true);
});

test('多行选区保留在背面，要求填写具体问题', async () => {
  const ui = await loadSelectionCard(async () => { throw new Error('未填写正面时不应保存'); });
  ui.setText('第一段\n第二段');
  await ui.selectionChange();
  await ui.bubble().children[0].dispatch('click');
  const { form, front, back, status } = ui.dialog().parts;
  assert.equal(front.value || '', '');
  assert.equal(back.value, '第一段\n第二段');
  await form.dispatch('submit');
  assert.equal(status.textContent, '正面不能为空。');
});

test('笔记重新排版后建卡按钮紧邻原选区，打开表单后滚动不会重建按钮', async () => {
  const ui = await loadSelectionCard();
  await ui.selectionChange();
  const bubble = ui.bubble();
  Object.assign(ui.rect, { top: 260, bottom: 280 });
  ui.windowEvent('resize');
  assert.equal(parseFloat(bubble.style.top) + bubble.offsetHeight, 252);
  Object.assign(ui.rect, { top: -40, bottom: -20 });
  ui.windowEvent('scroll');
  assert.equal(bubble.hidden, true);
  Object.assign(ui.rect, { top: -70, bottom: 1845 });
  ui.windowEvent('scroll');
  const visibleTop = parseFloat(bubble.style.top);
  assert.ok(!bubble.hidden && visibleTop >= 56 && visibleTop + bubble.offsetHeight <= 742);
  Object.assign(ui.rect, { top: 110, bottom: 130 });
  ui.windowEvent('scroll');
  assert.equal(bubble.hidden, false);
  await bubble.children[0].dispatch('click');
  assert.ok(ui.dialog()?.open);
  ui.windowEvent('resize');
  assert.equal(ui.bubble(), undefined);
});

test('选中的代码滚出代码块后隐藏建卡按钮，滚回时重新定位', async () => {
  const ui = await loadSelectionCard();
  ui.selection.anchorNode.parentElement = {
    parentElement: ui.prose, style: { overflowX: 'auto', overflowY: 'auto' },
    getBoundingClientRect: () => ({ left: 30, right: 320, top: 90, bottom: 150 })
  };
  await ui.selectionChange();
  const bubble = ui.bubble();
  Object.assign(ui.rect, { left: 340, right: 380 });
  ui.windowEvent('scroll');
  assert.equal(bubble.hidden, true);
  Object.assign(ui.rect, { left: 160, right: 200 });
  ui.windowEvent('scroll');
  assert.equal(bubble.hidden, false);
  assert.equal(parseFloat(bubble.style.left), 160);
});
