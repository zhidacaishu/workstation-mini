const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function loadAttachments({ requestJson, ids = ['id-1', 'id-2'], execCommand } = {}) {
  const listeners = new Map();
  const textarea = {
    value: '', selectionStart: 0, selectionEnd: 0, inputEvents: 0, focusCalls: 0,
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatchEvent(event) { if (event.type === 'input') this.inputEvents += 1; },
    focus() { this.focusCalls += 1; },
    closest() { return form; },
    dispatch(type, event) { listeners.get(type)?.(event); }
  };
  const formListeners = new Map();
  const form = {
    addEventListener(type, handler) { formListeners.set(type, handler); },
    classList: { add() {}, remove() {} },
    dispatch(type, event) { formListeners.get(type)?.(event); }
  };
  const notifications = [];
  const commands = [];
  const pendingWork = new Set();
  let nextId = 0;
  const document = {
    querySelector(selector) { return selector === '[data-editor-form] textarea[name="body"]' ? textarea : null; },
    execCommand(command, _ui, text) {
      commands.push({ command, text, start: textarea.selectionStart, end: textarea.selectionEnd });
      if (execCommand) return execCommand({ textarea, command, text });
      const { selectionStart: start, selectionEnd: end } = textarea;
      textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      return true;
    }
  };
  const window = {
    crypto: { randomUUID: () => ids[nextId++] },
    workstationUI: {
      requestJson,
      notify(text, options = {}) { notifications.push({ text, options }); },
      beginEditorWork() {
        const token = {};
        pendingWork.add(token);
        let finished = false;
        return () => {
          if (finished) return;
          finished = true;
          pendingWork.delete(token);
        };
      }
    }
  };
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'attachments.js'), 'utf8');
  vm.runInNewContext(source, { window, document, Event: class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } }, String, Date, Math, encodeURIComponent });
  return {
    textarea,
    notifications,
    commands,
    pendingCount() { return pendingWork.size; },
    paste(files) {
      let prevented = false;
      textarea.dispatch('paste', { clipboardData: { files }, preventDefault() { prevented = true; } });
      return prevented;
    },
    drop(files) {
      let prevented = false;
      form.dispatch('drop', { dataTransfer: { files }, preventDefault() { prevented = true; } });
      return prevented;
    }
  };
}

const image = name => ({ name, type: 'image/png' });

test('完整 UUID 占位符隔离同名上传和用户已有的可见文本', async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const ui = await loadAttachments({ requestJson: () => [first.promise, second.promise][call++] });
  const old = '![上传中 same.png…]()';
  ui.textarea.value = `${old}\n`;
  ui.textarea.selectionStart = ui.textarea.selectionEnd = ui.textarea.value.length;
  ui.paste([image('same.png')]);
  ui.paste([image('same.png')]);
  await flush();
  assert.match(ui.textarea.value, /workstation-attachment-upload:id-1/);
  assert.match(ui.textarea.value, /workstation-attachment-upload:id-2/, '并发同名上传各自使用 UUID 标识');
  assert.equal(ui.pendingCount(), 2, '多次 paste 批次各自登记 pending work');

  first.resolve({ url: '/one.png' });
  await flush();
  assert.equal(ui.pendingCount(), 1, '完成一个批次不会误报全部 idle');
  assert.ok(ui.textarea.value.startsWith(`${old}\n`));
  assert.match(ui.textarea.value, /!\[same\.png\]\(\/one\.png\)/);
  assert.match(ui.textarea.value, /workstation-attachment-upload:id-2/, '下一同名文件也有独立 UUID 标识');
  second.resolve({ url: '/two.png' });
  await flush();
  assert.equal(ui.pendingCount(), 0);
  assert.match(ui.textarea.value, /!\[same\.png\]\(\/two\.png\)/);
  assert.equal(ui.notifications.filter(note => note.text === '已插入 1 个附件。').length, 2);
});

test('单次 paste 的多个文件串行上传时 pending 不在文件间归零', async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const ui = await loadAttachments({ requestJson: () => [first.promise, second.promise][call++] });
  ui.paste([image('one.png'), image('two.png')]);
  await flush();
  assert.equal(ui.pendingCount(), 1, '整个 paste 批次只登记一个连续 pending token');
  assert.equal(call, 1, '第二个文件尚未开始');

  first.resolve({ url: '/one.png' });
  await flush();
  assert.equal(call, 2, '第一个完成后开始第二个文件');
  assert.equal(ui.pendingCount(), 1, '串行文件交界处不归零');

  second.resolve({ url: '/two.png' });
  await flush();
  assert.equal(ui.pendingCount(), 0);
});

test('paste 与 drop 并发批次都计入 pending work', async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const ui = await loadAttachments({ requestJson: () => [first.promise, second.promise][call++] });
  assert.equal(ui.paste([image('paste.png')]), true);
  assert.equal(ui.drop([image('drop.png')]), true);
  await flush();
  assert.equal(ui.pendingCount(), 2);

  first.resolve({ url: '/paste.png' });
  second.resolve({ url: '/drop.png' });
  await flush();
  assert.equal(ui.pendingCount(), 0);
});

test('上传失败会清除内部 marker 并结束 pending work', async () => {
  const pending = deferred();
  const ui = await loadAttachments({ requestJson: () => pending.promise });
  ui.paste([image('broken.png')]);
  await flush();
  assert.equal(ui.pendingCount(), 1);
  assert.match(ui.textarea.value, /workstation-attachment-upload/);

  pending.reject(new Error('上传失败'));
  await flush();
  assert.equal(ui.pendingCount(), 0);
  assert.doesNotMatch(ui.textarea.value, /workstation-attachment-upload/);
  assert.doesNotMatch(ui.textarea.value, /上传中/);
});

test('被删除或编辑的占位符不会在成功或失败时改动别处', async () => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred();
    const ui = await loadAttachments({ requestJson: () => pending.promise });
    ui.paste([image('a.png')]);
    await flush();
    ui.textarea.value = '用户保留的 ![上传中 a.png…]() 文本';
    ui.textarea.selectionStart = ui.textarea.selectionEnd = ui.textarea.value.length;
    const inputs = ui.textarea.inputEvents;
    if (outcome === 'success') pending.resolve({ url: '/a.png' });
    else pending.reject(new Error('网络中断'));
    await flush();
    assert.equal(ui.textarea.value, '用户保留的 ![上传中 a.png…]() 文本');
    assert.equal(ui.textarea.inputEvents, inputs, `${outcome} 不应派发 input`);
    assert.match(ui.notifications[0].text, /占位内容已被修改或删除/);
  }
});

test('替换优先走 execCommand，回退会切片并按位置恢复选择区', async () => {
  const pending = deferred();
  const ui = await loadAttachments({
    requestJson: () => pending.promise,
    execCommand({ textarea, text }) {
      if (text.includes('workstation-attachment-upload')) return false;
      if (text === '![a.png](/a.png)') return false;
      const { selectionStart: start, selectionEnd: end } = textarea;
      textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      return true;
    }
  });
  ui.textarea.value = 'before ';
  ui.textarea.selectionStart = ui.textarea.selectionEnd = 7;
  ui.paste([image('a.png')]);
  await flush();
  const markerStart = ui.textarea.value.indexOf('![上传中');
  ui.textarea.value = `${ui.textarea.value} after`;
  ui.textarea.selectionStart = ui.textarea.selectionEnd = ui.textarea.value.length;
  pending.resolve({ url: '/a.png' });
  await flush();
  assert.equal(ui.textarea.value, 'before ![a.png](/a.png) after');
  assert.equal(ui.textarea.selectionStart, ui.textarea.value.length, '替换后的用户光标仍在正文末尾');
  assert.equal(ui.commands.filter(entry => entry.text === '![a.png](/a.png)').length, 1);
  assert.ok(markerStart >= 0);
});

test('execCommand 成功时保留选择区相对位置，空命令结果不派发 input', async () => {
  const pending = deferred();
  let replacementAttempt = false;
  const ui = await loadAttachments({
    requestJson: () => pending.promise,
    execCommand({ textarea, text }) {
      const { selectionStart: start, selectionEnd: end } = textarea;
      if (text === '![a.png](/a.png)' && replacementAttempt) return true;
      if (text === '![a.png](/a.png)') replacementAttempt = true;
      textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      return true;
    }
  });
  ui.textarea.value = 'x';
  ui.textarea.selectionStart = ui.textarea.selectionEnd = 1;
  ui.paste([image('a.png')]);
  await flush();
  ui.textarea.selectionStart = ui.textarea.selectionEnd = 0;
  pending.resolve({ url: '/a.png' });
  await flush();
  assert.equal(ui.textarea.selectionStart, 0, '替换区之前的光标不应移动');

  const inside = deferred();
  const insideUi = await loadAttachments({ requestJson: () => inside.promise });
  insideUi.paste([image('a.png')]);
  await flush();
  insideUi.textarea.selectionStart = 3;
  insideUi.textarea.selectionEnd = 8;
  inside.resolve({ url: '/a.png' });
  await flush();
  assert.equal(insideUi.textarea.selectionStart, '![a.png](/a.png)'.length, '替换区内的选择收敛到链接末尾');
  assert.equal(insideUi.textarea.selectionEnd, '![a.png](/a.png)'.length);

  const noOp = deferred();
  const noOpUi = await loadAttachments({ requestJson: () => noOp.promise, execCommand: ({ textarea, text }) => {
    const { selectionStart: start, selectionEnd: end } = textarea;
    if (text === '![a.png](/a.png)') return true;
    textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    return true;
  } });
  noOpUi.paste([image('a.png')]);
  await flush();
  const inputs = noOpUi.textarea.inputEvents;
  noOp.resolve({ url: '/a.png' });
  await flush();
  assert.equal(noOpUi.textarea.inputEvents, inputs, '无实际替换时不应派发 input');
});
