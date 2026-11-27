// 写作区 [[ 补全：弹出后用键盘挪动光标，补全要跟着失效或重算，
// 回车、Tab 不能把 [[ 到新光标之间的文字整段替换掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SCRIPT = fs.readFileSync(path.join(__dirname, '../src/public/editor.js'), 'utf8');

function element(tag = 'div') {
  const listeners = {};
  const node = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, attributes: {}, children: [], hidden: false,
    offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 20, textContent: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    dispatchEvent(event) { for (const handler of listeners[event.type] || []) handler(event); return !event.defaultPrevented; },
    append(...nodes) { this.children.push(...nodes); },
    remove() {},
    closest() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 20, width: 100, height: 20 }),
    listeners
  };
  return node;
}

function setup(results) {
  const area = element('textarea');
  Object.assign(area, {
    value: '', selectionStart: 0, selectionEnd: 0, scrollLeft: 0, scrollTop: 0,
    dataset: {},
    focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    }
  });
  const body = element('body');
  const document = {
    body,
    querySelectorAll: selector => (selector === 'textarea[data-md-editor]' ? [area] : []),
    querySelector: () => null,
    createElement: element,
    addEventListener() {},
    execCommand: () => false
  };
  class Event {
    constructor(type, init = {}) { Object.assign(this, { type, defaultPrevented: false }, init); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
  }
  const window = Object.assign(element(), { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }) });
  const context = {
    window, document, Event, getComputedStyle: () => ({}),
    fetch: async () => ({ ok: true, json: async () => ({ results }) }),
    setTimeout, clearTimeout, URLSearchParams, encodeURIComponent
  };
  vm.runInNewContext(SCRIPT, context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const popup = () => body.children.find(node => node.id === 'link-suggest');

  async function type(text) {
    area.value = area.value.slice(0, area.selectionStart) + text + area.value.slice(area.selectionEnd);
    area.selectionStart = area.selectionEnd += text.length;
    area.dispatchEvent(new Event('input'));
    await tick(); await tick();
  }
  function key(name, move) {
    const down = new Event('keydown', { key: name });
    area.dispatchEvent(down);
    if (!down.defaultPrevented && move) move();
    area.dispatchEvent(new Event('keyup', { key: name }));
    return down;
  }
  return { area, type, key, tick, popup, window };
}

const RESULTS = [
  { target: '排队论', title: '排队论读书笔记', path: 'inbox/排队论.md' },
  { target: '排序算法', title: '排序算法', path: 'inbox/排序算法.md' }
];

test('滚动时补全框跟随输入行，光标离开可见范围后回车照常换行', async () => {
  const c = setup(RESULTS);
  let top = 240;
  c.area.getBoundingClientRect = () => ({ left: 8, top, bottom: top + 80 });
  await c.type('参考 [[排');
  const firstTop = parseFloat(c.popup().style.top);
  const option = c.popup().children[0];
  top -= 100;
  c.window.dispatchEvent({ type: 'scroll', target: c.area });
  assert.equal(parseFloat(c.popup().style.top), firstTop - 100);
  assert.equal(c.popup().children[0], option);
  top = -40;
  c.window.dispatchEvent({ type: 'scroll', target: c.area });
  assert.equal(c.popup().hidden, true);
  assert.equal(c.area.getAttribute('aria-activedescendant'), null);
  assert.equal(c.key('Enter').defaultPrevented, false);
});

test('补全列表在输入行上方缩短时，顶边和键盘选中的末项都可见', async () => {
  const c = setup(RESULTS);
  c.window.innerHeight = 400;
  let top = 320;
  c.area.getBoundingClientRect = () => ({ left: 8, top, bottom: top + 80 });
  await c.type('参考 [[排');
  const list = c.popup();
  Object.assign(list, { offsetHeight: 310, clientHeight: 224, scrollTop: 0 });
  Object.assign(list.children[1], { offsetTop: 260, offsetHeight: 36 });
  top = 240;
  c.window.dispatchEvent({ type: 'scroll', target: c.area });
  assert.equal(list.dataset.placement, 'above');
  assert.equal(list.style.top, '8px');
  assert.equal(list.style.maxHeight, '226px');
  c.key('ArrowDown');
  assert.equal(list.scrollTop + list.clientHeight, 296);
  assert.equal(c.key('Enter').defaultPrevented, true);
  assert.equal(c.area.value, '参考 [[排序算法]]');
});

test('补全弹出后按 End 移到后面的文字之后，回车不替换文字', async () => {
  const c = setup(RESULTS);
  // 在一行中间写双链：光标后面还有别的字。
  c.area.value = 'abc [[ xyz';
  c.area.setSelectionRange(6, 6);
  await c.type('排');
  assert.equal(c.popup()?.hidden, false, '补全框应弹出');

  c.key('End', () => c.area.setSelectionRange(c.area.value.length, c.area.value.length));
  const enter = c.key('Enter');
  assert.equal(enter.defaultPrevented, false, '回车照常换行');
  assert.equal(c.area.value, 'abc [[排 xyz');
  assert.equal(c.popup().hidden, true);
});

test('补全弹出后按 Home 移到 [[ 前面，回车不在别处插入链接', async () => {
  const c = setup(RESULTS);
  await c.type('abc [[排');
  assert.equal(c.popup()?.hidden, false);

  c.key('Home', () => c.area.setSelectionRange(0, 0));
  c.key('Enter');
  assert.equal(c.area.value, 'abc [[排');
  assert.equal(c.popup().hidden, true);
});

test('上下键选补全项不会被松键重算打断，回车写入选中的那一项', async () => {
  const c = setup(RESULTS);
  await c.type('见 [[排');
  c.key('ArrowDown');
  await c.tick();
  const enter = c.key('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(c.area.value, '见 [[排序算法]]');
});
