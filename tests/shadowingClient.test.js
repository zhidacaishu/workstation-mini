const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function element(tagName = 'div') {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tagName.toUpperCase(),
    dataset: {},
    children: [],
    checked: false,
    value: '',
    classList: {
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler({ target: this, preventDefault() {}, ...event });
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() { this.scrollCalls = (this.scrollCalls || 0) + 1; }
  };
}

async function loadShadowing(cues = [
  { index: 0, start: 0, end: 5, text: 'one' },
  { index: 1, start: 10, end: 15, text: 'two' }
]) {
  const cueButtons = cues.map(() => element('button'));
  const items = cues.map((cue, index) => {
    const item = element('li');
    item.querySelector = selector => selector === '[data-play-cue]' ? cueButtons[index] : null;
    return item;
  });
  const list = element('ol');
  list.dataset.cues = encodeURIComponent(JSON.stringify(cues));
  list.querySelectorAll = selector => selector === 'li' ? items : [];
  const player = element('audio');
  player.currentTime = 0;
  player.paused = true;
  player.playCalls = 0;
  player.pauseCalls = 0;
  player.play = () => { player.paused = false; player.playCalls += 1; return Promise.resolve(); };
  player.pause = () => { player.paused = true; player.pauseCalls += 1; };
  const loop = element('input');
  loop.checked = true;
  const rate = element('select');
  const hide = element('input');
  const documentListeners = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      return ({ cues: list, player, loop, rate, hide, transcribe: null })[id] || null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    querySelector() { return null; }
  };
  const window = {
    workstationUI: { requestJson: async () => ({}), notify() {} },
    matchMedia: () => ({ matches: true })
  };
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'shadowing.js'), 'utf8');
  vm.runInNewContext(source, { document, window, JSON, decodeURIComponent, Number, Math });
  return {
    document, player, loop, items, cueButtons,
    keydown(event) {
      for (const handler of documentListeners.get('keydown') || []) handler({
        metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, ...event
      });
    }
  };
}

test('cue 使用原生按钮播放对应句', async () => {
  const ui = await loadShadowing();
  assert.equal(ui.cueButtons[1].tagName, 'BUTTON');
  ui.cueButtons[1].dispatch('click');
  assert.equal(ui.player.currentTime, 10);
  assert.equal(ui.player.playCalls, 1);
  assert.equal(ui.items[1].classList.contains('is-active'), true);
});

test('快捷键不覆盖 focused button 或 audio 的原生操作', async () => {
  const ui = await loadShadowing();
  for (const tag of ['button', 'audio']) {
    ui.document.activeElement = element(tag);
    ui.keydown({ key: ' ' });
  }
  assert.equal(ui.player.playCalls, 0);
});

test('拖动 seek 后按当前时间重算 cue 且不回跳', async () => {
  const ui = await loadShadowing();
  ui.player.currentTime = 11;
  ui.player.dispatch('seeking');
  ui.player.dispatch('timeupdate');
  assert.equal(ui.player.currentTime, 11);
  ui.player.dispatch('seeked');
  assert.equal(ui.items[1].classList.contains('is-active'), true);
  ui.player.dispatch('timeupdate');
  assert.equal(ui.player.currentTime, 11);
});

test('连续 cue 自然到达句尾时循环当前句或推进到下一句开头', async () => {
  const cues = [
    { index: 0, start: 0, end: 5, text: 'one' },
    { index: 1, start: 5, end: 9, text: 'two' }
  ];
  const looped = await loadShadowing(cues);
  looped.player.currentTime = 5;
  looped.player.dispatch('timeupdate');
  assert.equal(looped.player.currentTime, 0);
  assert.equal(looped.items[0].classList.contains('is-active'), true);

  const advanced = await loadShadowing(cues);
  advanced.loop.checked = false;
  advanced.player.currentTime = 5;
  advanced.player.dispatch('timeupdate');
  assert.equal(advanced.player.currentTime, 5);
  assert.equal(advanced.items[1].classList.contains('is-active'), true);
  assert.equal(advanced.player.playCalls, 1);
});

test('有 gap 的 cue 不会在 gap 中绕过当前句的 loop 或 advance', async () => {
  const looped = await loadShadowing();
  looped.player.currentTime = 7;
  looped.player.dispatch('timeupdate');
  assert.equal(looped.player.currentTime, 0);
  assert.equal(looped.items[1].classList.contains('is-active'), false);

  const advanced = await loadShadowing();
  advanced.loop.checked = false;
  advanced.player.currentTime = 7;
  advanced.player.dispatch('timeupdate');
  assert.equal(advanced.player.currentTime, 10);
  assert.equal(advanced.items[1].classList.contains('is-active'), true);
  assert.equal(advanced.player.playCalls, 1);
});
