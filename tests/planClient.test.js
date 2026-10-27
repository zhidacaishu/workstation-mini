const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'src/public/plan.js'), 'utf8');

function load({ href = 'http://localhost/plan', saved = null, blocked = false } = {}) {
  const state = { redirected: '', saved: '', submitted: 0 };
  const date = { value: '', addEventListener: (name, callback) => { date[name] = callback; } };
  const checkbox = { addEventListener: (name, callback) => { checkbox[name] = callback; } };
  const classes = new Set();
  const form = {
    dataset: {},
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    },
    querySelector: selector => selector === '[name="due"]' ? date : checkbox,
    requestSubmit: () => { state.submitted += 1; }
  };
  const windowListeners = new Map();
  const url = new URL(href);
  const view = url.searchParams.get('view') || 'list';
  vm.runInNewContext(script, {
    URL,
    window: {
      location: { href, replace: next => { state.redirected = next; } },
      addEventListener: (name, handler) => windowListeners.set(name, handler)
    },
    localStorage: {
      getItem() { if (blocked) throw new Error('storage unavailable'); return saved; },
      setItem(key, value) { if (blocked) throw new Error('storage unavailable'); state.saved = value; }
    },
    document: {
      querySelector: () => ({ dataset: { planView: view } }),
      querySelectorAll: () => [form]
    }
  });
  return { state, date, checkbox, classes,
    beforeUnload(event) { windowListeners.get('beforeunload')?.(event); }
  };
}

test('计划入口记住上次月历视图，显式列表链接仍优先', () => {
  const remembered = load({ saved: 'calendar' });
  assert.equal(remembered.state.redirected, 'http://localhost/plan?view=calendar');
  const explicit = load({ href: 'http://localhost/plan?view=list&filter=undated', saved: 'calendar' });
  assert.equal(explicit.state.redirected, '');
  assert.equal(explicit.state.saved, 'list');
  assert.equal(load({ href: 'http://localhost/plan?filter=undated', saved: 'calendar' }).state.redirected, '');
});

test('浏览器存储不可用时仍可编辑日期和完成待办', () => {
  const ui = load({ blocked: true });
  assert.equal(ui.classes.has('is-enhanced'), true);
  ui.date.value = '2026-10-30';
  ui.date.input();
  assert.equal(ui.classes.has('is-edited'), true);
  ui.date.value = '';
  ui.date.input();
  assert.equal(ui.classes.has('is-edited'), false);
  ui.checkbox.change();
  assert.equal(ui.state.submitted, 1);
});

test('桌面界面不再包含移动导航或手机布局断点', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  assert.doesNotMatch(read('src/views/partials/head.ejs'), /navigation-dialog|compact-nav-trigger|data-navigation-open/);
  assert.doesNotMatch(read('src/public/app.js'), /navigation-dialog|data-navigation-open|matchMedia/);
  assert.doesNotMatch(script, /matchMedia|scrollIntoView/);
  for (const file of ['src/public/styles.css', 'electron/settings/settings.css', 'electron/recovery/recovery.css']) {
    assert.doesNotMatch(read(file), /@media\s*\(max-width:\s*(?:760|560|520)px\)|calendar-mobile-count|compact-nav-trigger/);
    assert.match(read(file), /prefers-color-scheme/);
    assert.match(read(file), /prefers-reduced-motion/);
  }
});

test('当天备注未保存时不更新待办，避免刷新丢失输入', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/public/task-actions.js'), 'utf8');
  let submit;
  let requested = false;
  let reloaded = false;
  let message = '';
  const done = { checked: true, defaultChecked: false };
  vm.runInNewContext(source, {
    document: { addEventListener: (name, callback) => { submit = callback; } },
    window: {
      workstationCalendar: { hasUnsavedChanges: () => true },
      workstationUI: { requestJson: () => { requested = true; }, notify: text => { message = text; } },
      location: { reload: () => { reloaded = true; } }
    }
  });
  await submit({
    preventDefault() {},
    target: { matches: () => true, dataset: {}, querySelector: () => done }
  });
  assert.equal(requested, false);
  assert.equal(reloaded, false);
  assert.equal(done.checked, false);
  assert.match(message, /先保存当天备注/);
});

test('计划日期未保存时离开有保护，还原后解除', () => {
  const ui = load();
  const attempt = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    ui.beforeUnload(event);
    return event.prevented;
  };
  assert.equal(attempt(), false);
  ui.date.value = '2031-05-06';
  assert.equal(attempt(), true);
  ui.date.value = '';
  assert.equal(attempt(), false);
});
