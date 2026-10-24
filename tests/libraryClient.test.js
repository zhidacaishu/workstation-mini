const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function element(tagName = 'div') {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tagName.toUpperCase(),
    dataset: {},
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    checked: false,
    open: false,
    isConnected: true,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    async dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) {
        await handler({ preventDefault() {}, target: this, ...event });
      }
    },
    setAttribute(name, value) { this[name] = String(value); },
    removeAttribute(name) { delete this[name]; },
    focus() { this.focusCalls = (this.focusCalls || 0) + 1; },
    remove() { this.isConnected = false; }
  };
}

async function loadClient(requestJson, { pdfState = 'unparsed' } = {}) {
  const documentListeners = new Map();
  const main = element('main');
  const dialog = element('dialog');
  const form = element('form');
  const source = element('blockquote');
  const comment = element('p');
  const status = element('p');
  const submit = element('button');
  const close = element('button');
  const cancel = element('button');
  const pdfDialog = element('dialog');
  const pdfSubmit = element('button');
  const pdfClose = element('button');
  const pdfCancel = element('button');
  const pdfStatus = element('p');
  const pdfFile = element('strong');
  const pdfTitle = element('p');
  const pdfRow = element('li');
  const pdfStateNode = element('span');
  const pdfProgress = element('span');
  const pdfMessage = element('p');
  const parsePdf = element('button');
  const documentId = '0123456789abcdef0123456789abcdef';
  pdfRow.dataset.documentId = documentId;
  pdfRow.dataset.pdfState = pdfState;
  parsePdf.textContent = '解析 PDF';
  pdfSubmit.textContent = '确认上传并解析';
  pdfClose.textContent = '关闭';
  pdfCancel.textContent = '取消';
  parsePdf.dataset.libraryId = '1';
  parsePdf.dataset.attachmentKey = 'PDF00001';
  parsePdf.dataset.documentId = documentId;
  parsePdf.dataset.fileName = 'paper.pdf';
  parsePdf.dataset.literatureTitle = '平台定价';
  const count = element('span');
  const item = element('li');
  item.dataset.noteHash = 'hash-1';
  const row = element('li');
  const process = element('button');
  process.dataset.annotationId = 'ABCD1234:10';
  process.dataset.notePath = 'lit/local.md';
  process.dataset.noteHash = 'hash-1';
  process.dataset.text = '识别策略';
  process.dataset.comment = '补制度背景';
  process.dataset.page = '12';

  const controls = {
    noteTitle: element('input'), noteBody: element('textarea'),
    cardDeck: element('input'), cardFront: element('textarea'), cardBack: element('textarea'),
    taskTitle: element('input')
  };
  const toggles = Object.fromEntries(['note', 'card', 'task'].map(name => {
    const toggle = element('input');
    toggle.dataset.outputToggle = name;
    return [name, toggle];
  }));
  const fields = {
    note: element(), card: element(), task: element()
  };
  fields.note.controls = [controls.noteTitle, controls.noteBody];
  fields.card.controls = [controls.cardDeck, controls.cardFront, controls.cardBack];
  fields.task.controls = [controls.taskTitle];
  for (const group of Object.values(fields)) {
    group.querySelectorAll = selector => selector === 'input, textarea, select' ? group.controls : [];
  }

  form.elements = controls;
  form.reset = () => { Object.values(toggles).forEach(toggle => { toggle.checked = false; }); };
  form.reportValidity = () => true;
  form.querySelector = selector => {
    const toggleMatch = selector.match(/^\[data-output-toggle="(.+)"\]$/);
    if (toggleMatch) return toggles[toggleMatch[1]];
    const fieldsMatch = selector.match(/^\[data-output-fields="(.+)"\]$/);
    if (fieldsMatch) return fields[fieldsMatch[1]];
    return {
      '[data-annotation-source]': source,
      '[data-annotation-comment]': comment,
      '[data-annotation-status]': status,
      '[data-dialog-submit]': submit,
      '[data-dialog-close]': close,
      '[data-dialog-cancel]': cancel
    }[selector] || null;
  };
  form.querySelectorAll = selector => {
    if (selector === '[data-output-toggle]') return Object.values(toggles);
    if (selector === '[data-output-toggle]:checked') return Object.values(toggles).filter(toggle => toggle.checked);
    return [];
  };

  dialog.querySelector = selector => selector === '[data-annotation-form]' ? form : null;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.open = false;
    dialog.dispatch('close');
  };

  pdfDialog.querySelector = selector => ({
    '[data-pdf-dialog-submit]': pdfSubmit,
    '[data-pdf-dialog-close]': pdfClose,
    '[data-pdf-dialog-cancel]': pdfCancel,
    '[data-pdf-dialog-status]': pdfStatus,
    '[data-pdf-dialog-file]': pdfFile,
    '[data-pdf-dialog-title-text]': pdfTitle
  }[selector] || null);
  pdfDialog.showModal = () => { pdfDialog.open = true; };
  pdfDialog.close = () => {
    if (!pdfDialog.open) return;
    pdfDialog.open = false;
    pdfDialog.dispatch('close');
  };
  pdfRow.querySelector = selector => ({
    '[data-pdf-status]': pdfStateNode,
    '[data-pdf-progress]': pdfProgress,
    '[data-pdf-message]': pdfMessage,
    '[data-parse-pdf]': parsePdf
  }[selector] || null);
  parsePdf.closest = selector => selector === '[data-parse-pdf]' ? parsePdf : null;

  row.closest = selector => selector === '[data-literature-item]' ? item : null;
  process.closest = selector => ({
    '[data-process-annotation]': process,
    '[data-annotation-row]': row
  }[selector] || null);
  row.remove = () => { row.isConnected = false; process.isConnected = false; };
  item.querySelectorAll = selector => {
    if (selector === '[data-annotation-row]') return row.isConnected ? [row] : [];
    if (selector === '[data-process-annotation]') return row.isConnected ? [process] : [];
    return [];
  };
  item.querySelector = selector => selector === '[data-pending-count]' ? count : null;

  const document = {
    querySelector(selector) {
      if (selector === '[data-annotation-dialog]') return dialog;
      if (selector === '[data-pdf-dialog]') return pdfDialog;
      if (selector === `[data-pdf-row][data-document-id="${documentId}"]`) return pdfRow;
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-pdf-row]' ? [pdfRow] : []; },
    getElementById(id) { return id === 'main-content' ? main : null; },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    }
  };
  const notifications = [];
  const timers = [];
  let reloadCalls = 0;
  const window = {
    workstationUI: {
      requestJson,
      notify(message, options = {}) { notifications.push({ message, options }); }
    },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    location: { href: '', reload() { reloadCalls += 1; } }
  };

  const script = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'library.js'), 'utf8');
  vm.runInNewContext(script, { document, window, encodeURIComponent });

  return {
    dialog, form, source, comment, status, submit, close, cancel,
    pdfDialog, pdfSubmit, pdfClose, pdfCancel, pdfStatus, pdfFile, pdfTitle,
    pdfRow, pdfStateNode, pdfProgress, pdfMessage, parsePdf, documentId,
    controls, toggles, fields, item, row, process, count, main, notifications, timers,
    get reloadCalls() { return reloadCalls; },
    async runNextTimer() {
      const callback = timers.shift();
      if (callback) await callback();
    },
    async click(target) {
      for (const handler of documentListeners.get('click') || []) {
        await handler({ target });
      }
    }
  };
}

test('加工 dialog 填充可信默认值并发送组合输出 payload', async () => {
  const pending = deferred();
  const calls = [];
  const ui = await loadClient((url, options) => {
    calls.push({ url, options });
    return pending.promise;
  });
  await ui.click(ui.process);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.source.textContent, '识别策略');
  assert.equal(ui.comment.textContent, '补制度背景');
  assert.equal(ui.controls.noteTitle.value, '补制度背景');
  assert.equal(ui.controls.cardFront.value, '识别策略');
  assert.equal(ui.controls.taskTitle.value, '补制度背景');

  for (const toggle of Object.values(ui.toggles)) {
    toggle.checked = true;
    await toggle.dispatch('change');
  }
  ui.controls.cardDeck.value = 'research';
  const first = ui.form.dispatch('submit');
  const second = ui.form.dispatch('submit');
  assert.equal(calls.length, 1);
  assert.equal(ui.submit.disabled, true);
  assert.equal(calls[0].url, '/library/annotations/process');
  assert.equal(calls[0].options.json.notePath, 'lit/local.md');
  assert.equal(calls[0].options.json.annotationId, 'ABCD1234:10');
  assert.equal(calls[0].options.json.expectedHash, 'hash-1');
  assert.equal(calls[0].options.json.outputs.note.title, '补制度背景');
  assert.equal(calls[0].options.json.outputs.card.deckFile, 'research');
  assert.equal(calls[0].options.json.outputs.task.title, '补制度背景');

  pending.resolve({ ok: true, outputs: ['note', 'card', 'task'], hash: 'hash-2' });
  await first;
  await second;
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.row.isConnected, false);
  assert.equal(ui.count.textContent, '0 条待加工');
  assert.equal(ui.item.dataset.noteHash, 'hash-2');
  assert.equal(ui.main.focusCalls, 1);
});

test('未选择输出时发送 mark-only，失败保留 dialog 与输入', async () => {
  const error = new Error('磁盘繁忙');
  error.payload = { completedOutputs: ['note'] };
  const calls = [];
  const ui = await loadClient(async (url, options) => {
    calls.push({ url, options });
    throw error;
  });
  await ui.click(ui.process);
  ui.controls.noteBody.value = '不能丢失';
  await ui.form.dispatch('submit');

  assert.deepEqual(Object.keys(calls[0].options.json.outputs), []);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.controls.noteBody.value, '不能丢失');
  assert.equal(ui.submit.disabled, false);
  assert.match(ui.status.textContent, /永久笔记/);
  assert.match(ui.status.textContent, /重试时复用/);
  assert.match(ui.status.textContent, /磁盘繁忙/);
});

test('保存期间取消、Escape 和遮罩都不能关闭，提交按钮显示 busy 文案', async () => {
  const pending = deferred();
  const ui = await loadClient(() => pending.promise);
  await ui.click(ui.process);
  const saving = ui.form.dispatch('submit');

  assert.equal(ui.submit.textContent, '正在保存…');
  assert.equal(ui.submit['aria-busy'], 'true');
  await ui.cancel.dispatch('click');
  await ui.dialog.dispatch('click', { target: ui.dialog });
  let prevented = false;
  await ui.dialog.dispatch('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(ui.dialog.open, true);

  pending.resolve({ outputs: [], hash: 'hash-2' });
  await saving;
  assert.equal(ui.dialog.open, false);
});

test('409 明确要求刷新，取消后恢复原按钮焦点', async () => {
  const error = new Error('文献笔记已被其它编辑修改');
  error.status = 409;
  const ui = await loadClient(async () => { throw error; });
  await ui.click(ui.process);
  await ui.form.dispatch('submit');
  assert.match(ui.status.textContent, /刷新页面后重试/);
  await ui.cancel.dispatch('click');
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.process.focusCalls, 1);
});

test('PDF 只在确认后发送身份 payload，取消会恢复按钮焦点', async () => {
  const calls = [];
  const ui = await loadClient(async (url, options) => {
    calls.push({ url, options });
    return { documentId: ui.documentId, state: 'running', progress: null, error: '' };
  });

  await ui.click(ui.parsePdf);
  assert.equal(ui.pdfDialog.open, true);
  assert.equal(ui.pdfFile.textContent, 'paper.pdf');
  assert.equal(ui.pdfTitle.textContent, '平台定价');
  assert.equal(calls.length, 0, '打开确认 dialog 不能发请求');
  await ui.pdfCancel.dispatch('click');
  assert.equal(ui.pdfDialog.open, false);
  assert.equal(ui.parsePdf.focusCalls, 1);

  await ui.click(ui.parsePdf);
  await ui.pdfSubmit.dispatch('click');
  assert.equal(calls[0].url, '/library/pdfs/parse');
  assert.equal(calls[0].options.json.libraryId, '1');
  assert.equal(calls[0].options.json.attachmentKey, 'PDF00001');
  assert.deepEqual(Object.keys(calls[0].options.json).sort(), ['attachmentKey', 'libraryId']);
  assert.equal(ui.pdfDialog.open, false);
  assert.equal(ui.parsePdf.disabled, true);
  assert.equal(ui.parsePdf.textContent, '解析中…');
});

test('PDF 排队期间重复确认只提交一次并锁住关闭操作', async () => {
  const pending = deferred();
  const calls = [];
  const ui = await loadClient((url, options) => {
    calls.push({ url, options });
    return pending.promise;
  });
  await ui.click(ui.parsePdf);
  const first = ui.pdfSubmit.dispatch('click');
  const second = ui.pdfSubmit.dispatch('click');
  assert.equal(calls.length, 1);
  assert.equal(ui.pdfSubmit.disabled, true);
  assert.equal(ui.pdfSubmit.textContent, '正在排队…');
  assert.equal(ui.pdfClose.disabled, true);
  await ui.pdfCancel.dispatch('click');
  assert.equal(ui.pdfDialog.open, true);

  pending.resolve({ documentId: ui.documentId, state: 'running', progress: null, error: '' });
  await first;
  await second;
  assert.equal(ui.pdfDialog.open, false);
});

test('PDF 轮询从进行态到 ready 后通知并刷新', async () => {
  const statuses = [
    { documentId: '0123456789abcdef0123456789abcdef', state: 'running', progress: { extractedPages: 1, totalPages: 2 }, error: '' },
    { documentId: '0123456789abcdef0123456789abcdef', state: 'ready', progress: null, error: '', pageCount: 2 }
  ];
  const calls = [];
  const ui = await loadClient(async (url, options) => {
    calls.push({ url, options });
    if (url === '/library/pdfs/parse') return statuses[0];
    return statuses.shift();
  });
  await ui.click(ui.parsePdf);
  await ui.pdfSubmit.dispatch('click');
  assert.equal(ui.pdfStateNode.textContent, 'MinerU 解析中');
  assert.equal(ui.pdfProgress.textContent, '1 / 2 页');
  assert.equal(ui.timers.length, 1);

  await ui.runNextTimer();
  assert.equal(ui.reloadCalls, 1);
  assert.ok(ui.notifications.some(entry => entry.message === 'PDF 解析和索引已完成。'));
  assert.equal(calls.filter(call => call.url.includes('/status')).length, 2);
});

test('刷新页面时活动 PDF 自动恢复轮询', async () => {
  const calls = [];
  const ui = await loadClient(async url => {
    calls.push(url);
    return { documentId: '0123456789abcdef0123456789abcdef', state: 'ready', progress: null, error: '', pageCount: 2 };
  }, { pdfState: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [`/library/pdfs/${ui.documentId}/status`]);
  assert.equal(ui.reloadCalls, 1);
});

test('PDF 状态暂时读取失败只显示行内错误，不会重新提交', async () => {
  const calls = [];
  const ui = await loadClient(async url => {
    calls.push(url);
    throw new Error('本机服务繁忙');
  }, { pdfState: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(ui.pdfMessage.textContent, /暂时无法读取解析状态/);
  assert.match(ui.pdfMessage.textContent, /本机服务繁忙/);
  assert.equal(calls.some(url => url === '/library/pdfs/parse'), false);
  assert.equal(ui.reloadCalls, 0);
});
