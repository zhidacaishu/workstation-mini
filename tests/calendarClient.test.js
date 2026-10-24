const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function element(textContent = '') {
  return {
    textContent, children: [], dataset: {}, attributes: {}, hidden: false,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    querySelectorAll() { return []; }
  };
}

async function loadCalendar(requestJson) {
  const listeners = {};
  const fields = Object.fromEntries(Object.entries({ date: '2026-09-10', from: '', to: '', what: '写引言', expectedHash: 'old' })
    .map(([key, value]) => [`[name=${key}]`, { value }]));
  const button = element('排进这天');
  const form = {
    querySelector(selector) { return selector === 'button' ? button : fields[selector]; },
    addEventListener(type, listener) { listeners[type] = listener; }
  };
  const items = element();
  const number = element('10');
  const cell = element();
  cell.dataset = { date: '2026-09-10', weekday: '周四', planCount: '0', entryCount: '2', reviewDue: '3' };
  cell.querySelector = selector => ({ '.calday-items': items, '.calday-num': number,
    '.calday-diary': number.children.find(child => child.className === 'calday-diary') }[selector] || null);
  const total = element('4');
  const list = element();
  const empty = element();
  const slot = element();
  slot.querySelector = () => ({});
  const nodes = {
    '[data-plan-form]': form, '[data-plan-list]': list, '[data-plan-empty]': empty,
    '[data-plan-total]': total, '[data-diary-slot]': slot
  };
  const document = {
    getElementById() { return element(); }, addEventListener() {},
    querySelector(selector) {
      if (selector.startsWith('.calday[')) return selector.endsWith(' .calday-items') ? items : cell;
      return nodes[selector] || null;
    },
    createElement: () => element(), createTextNode: text => ({ textContent: text })
  };
  const notices = [];
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'src/public/calendar.js'), 'utf8'), {
    document, window: { workstationUI: { requestJson, notify: message => notices.push(message) } }
  });
  return { fields, button, cell, items, number, total, list, empty, notices, submit: () => listeners.submit({ preventDefault() {} }) };
}

const result = {
  date: '2026-09-10', path: 'diary/2026-09-10.md', hash: 'new', block: '写引言',
  plan: [{ from: '', to: '', what: '写引言' }]
};

test('排期更新网格统计、辅助描述和日记标记，相同结果不重复累计', async () => {
  const ui = await loadCalendar(async () => result);
  await ui.submit();
  assert.equal(ui.total.textContent, '5');
  assert.equal(ui.cell.dataset.planCount, '1');
  assert.equal(ui.cell.attributes['aria-label'], '2026-09-10 周四，2 项截止，1 个时间块，3 张待复习');
  assert.equal(ui.number.children.length, 1);
  assert.equal(ui.number.children[0].className, 'calday-diary');
  await ui.submit();
  assert.equal(ui.total.textContent, '5');
  assert.equal(ui.number.children.length, 1);
  assert.equal(ui.fields['[name=expectedHash]'].value, 'new');
});

test('保存中不重复提交，失败不改变统计且保留输入', async () => {
  let reject;
  let calls = 0;
  const ui = await loadCalendar(() => { calls += 1; return new Promise((resolve, no) => { reject = no; }); });
  const first = ui.submit();
  const second = ui.submit();
  const count = calls;
  reject(Object.assign(new Error('冲突'), { status: 409 }));
  if (count > 1) { assert.equal(count, 1, '必须阻止重复请求'); return; }
  await Promise.all([first, second]);
  assert.equal(ui.total.textContent, '4');
  assert.equal(ui.fields['[name=what]'].value, '写引言');
  assert.equal(ui.button.disabled, false);
  assert.match(ui.notices[0], /刷新/);
});
