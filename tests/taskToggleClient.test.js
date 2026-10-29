const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'src/public/task-actions.js'), 'utf8');

function classList(initial = []) {
  const set = new Set(initial);
  return { set, add: (...names) => names.forEach(n => set.add(n)), remove: (...names) => names.forEach(n => set.delete(n)),
    toggle: (name, on) => (on ? set.add(name) : set.delete(name)), contains: name => set.has(name) };
}

function load(respond) {
  const listeners = { change: [], submit: [] };
  const requests = [];
  const notices = [];
  const tag = { textContent: '逾期 10/1', classList: classList(['task-due', 'is-overdue']), getAttribute: () => '2026-10-01' };
  const item = { classList: classList(['task-item']), querySelector: selector => selector === 'time.task-due' ? tag : null };
  const hashInput = { value: 'v1' };
  const prose = { dataset: { noteHash: 'v1' }, querySelectorAll: () => [box] };
  const attrs = { 'aria-label': '标记为完成：交初稿' };
  const box = {
    checked: true, disabled: false, dataset: { taskLine: '3' }, classList: classList(['task-box', 'task-toggle']),
    matches: selector => selector === '.prose input.task-toggle',
    closest: selector => selector === '.prose' ? prose : selector === 'li.task-item' ? item : null,
    getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: name => { delete attrs[name]; }
  };
  vm.runInNewContext(script, {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-28T09:00:00'])); } },
    document: {
      body: { dataset: { notePath: 'research/plan.md' } },
      addEventListener: (type, handler) => listeners[type]?.push(handler),
      querySelectorAll: selector => selector === 'input[name="expectedHash"]' ? [hashInput] : []
    },
    window: { workstationUI: {
      requestJson: async (url, options) => { requests.push({ url, ...options }); return respond(); },
      notify: (message, options) => notices.push({ message, ...options })
    } }
  });
  return {
    box, item, tag, prose, hashInput, attrs, requests, notices,
    change: () => Promise.all(listeners.change.map(handler => handler({ target: box })))
  };
}

test('阅读页勾选待办：带行号和版本号提交，成功后换新版本号、划掉并去掉逾期标记', async () => {
  const ui = load(() => ({ ok: true, hash: 'v2' }));
  await ui.change();
  assert.deepEqual({ ...ui.requests[0].json }, { path: 'research/plan.md', line: 3, expectedHash: 'v1', done: true });
  assert.equal(ui.prose.dataset.noteHash, 'v2');
  assert.equal(ui.hashInput.value, 'v2');
  assert.equal(ui.item.classList.contains('is-done'), true);
  assert.equal(ui.tag.classList.contains('is-overdue'), false);
  assert.equal(ui.tag.textContent, '10/1');
  assert.equal(ui.attrs['aria-label'], '标记为未完成：交初稿');
  assert.equal(ui.box.disabled, false, '正在操作的勾选框不禁用，键盘焦点留在它上面');
  assert.equal(ui.attrs['aria-disabled'], undefined);
});

test('笔记已在别处改过时恢复勾选状态并提示刷新', async () => {
  const ui = load(() => { const error = new Error('conflict'); error.status = 409; throw error; });
  await ui.change();
  assert.equal(ui.box.checked, false);
  assert.equal(ui.prose.dataset.noteHash, 'v1');
  assert.match(ui.notices[0].message, /刷新页面/);
  assert.equal(ui.item.classList.contains('is-done'), false);
});
