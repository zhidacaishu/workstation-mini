const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'src/public/plan.js'), 'utf8');

function load({ href = 'http://localhost/plan', saved = null, blocked = false, serverDue = '', currentDue = serverDue } = {}) {
  const state = { redirected: '', saved: '', submitted: 0 };
  const date = { value: currentDue, defaultValue: serverDue, addEventListener: (name, callback) => { date[name] = callback; } };
  const checkbox = { addEventListener: (name, callback) => { checkbox[name] = callback; } };
  const classes = new Set();
  const form = {
    dataset: {},
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
    },
    querySelector: selector => selector === '.plan-task-reschedule' ? null : selector === '[name="due"]' ? date : checkbox,
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

test('计划页脚本不依赖浏览器存储：存储不可用时仍可编辑日期和完成待办', () => {
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
    assert.match(read(file), /prefers-reduced-motion/);
  }
  // 颜色与深浅主题集中在三个窗口共用的 tokens.css 里：主窗口在模板里引用，设置和恢复窗口在样式表里导入。
  assert.match(read('src/public/tokens.css'), /prefers-color-scheme:\s*dark/);
  assert.match(read('src/views/partials/head.ejs'), /href="\/static\/tokens\.css"/);
  for (const file of ['electron/settings/settings.css', 'electron/recovery/recovery.css']) {
    assert.match(read(file), /@import url\("\.\.\/\.\.\/src\/public\/tokens\.css"\)/);
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
  assert.match(message, /先保存备注/);
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

test('脚本初始化前已经输入的日期仍算未保存，显示保存入口并保护离开', () => {
  const ui = load({ serverDue: '2031-05-06', currentDue: '2032-06-07' });
  assert.equal(ui.classes.has('is-edited'), true);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  ui.beforeUnload(event);
  assert.equal(event.prevented, true);
  ui.date.value = '2031-05-06';
  ui.date.change();
  assert.equal(ui.classes.has('is-edited'), false);
  const restored = { prevented: false, preventDefault() { this.prevented = true; } };
  ui.beforeUnload(restored);
  assert.equal(restored.prevented, false);
});
