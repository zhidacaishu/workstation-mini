const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createElement(id = '') {
  return {
    id,
    dataset: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    children: [],
    listeners: new Map(),
    attributes: {},
    append(child) { this.children.push(child); },
    addEventListener(type, handler) { this.listeners.set(type, handler); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focused = true; },
    querySelectorAll() { return []; }
  };
}

async function loadReview(fetch, queue) {
  const elements = new Map([
    ['reviewer', createElement('reviewer')],
    ['review-front', createElement('review-front')],
    ['review-back', createElement('review-back')],
    ['review-reveal', createElement('review-reveal')],
    ['review-ratings', createElement('review-ratings')],
    ['review-remaining', createElement('review-remaining')],
    ['review-deck', createElement('review-deck')],
    ['review-done', createElement('review-done')],
    ['review-summary', createElement('review-summary')],
    ['review-done-title', createElement('review-done-title')],
    ['review-failures', createElement('review-failures')]
  ]);
  elements.get('reviewer').dataset.queue = encodeURIComponent(JSON.stringify(queue));
  elements.get('reviewer').append = child => {
    elements.get('reviewer').children.push(child);
    if (child.id) elements.set(child.id, child);
  };
  elements.get('review-done').hidden = true;

  const buttons = [1, 2, 3, 4].map(rating => {
    const button = createElement();
    button.dataset.rating = String(rating);
    return button;
  });
  elements.get('review-ratings').querySelectorAll = () => buttons;

  const document = {
    activeElement: null,
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return createElement(); },
    addEventListener(type, handler) { this.listeners = { ...(this.listeners || {}), [type]: handler }; },
    querySelector() { return null; }
  };
  const windowListeners = new Map();
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'public', 'review.js'), 'utf8');
  let uuid = 0;
  vm.runInNewContext(source, {
    document,
    window: { addEventListener(type, handler) { windowListeners.set(type, handler); } },
    fetch,
    JSON,
    decodeURIComponent,
    Date,
    Number,
    String,
    crypto: { randomUUID: () => `event-${++uuid}` },
    setTimeout: callback => { callback(); return 1; }
  });

  return {
    elements,
    document,
    beforeUnload(event) { windowListeners.get('beforeunload')?.(event); },
    reveal: () => elements.get('review-reveal').listeners.get('click')(),
    rate: rating => buttons[rating - 1].listeners.get('click')(),
    keydown(event) { document.listeners.keydown({ metaKey: false, ctrlKey: false, altKey: false, preventDefault() {}, ...event }); }
  };
}

const CARD = { id: 'deck/card', front: '正面', back: '背面', question: '', deck: '测试' };

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

test('focused button、select 和 audio 不被复习快捷键接管', async () => {
  for (const tag of ['BUTTON', 'SELECT', 'AUDIO']) {
    const ui = await loadReview(async () => ({ ok: true }), [CARD]);
    ui.document.activeElement = { tagName: tag };
    let prevented = false;
    ui.keydown({ key: ' ', preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(ui.elements.get('review-back').hidden, true);
  }
});

test('最后一次评分落盘前不结束也不同步', async () => {
  const answer = deferred();
  const calls = [];
  const ui = await loadReview((url) => {
    calls.push(url);
    if (url === '/review/answer') return answer.promise;
    return Promise.resolve({ ok: true, json: async () => ({ pushed: true }) });
  }, [CARD]);

  ui.reveal();
  ui.rate(3);
  await flush();

  assert.deepEqual(calls, ['/review/answer']);
  assert.equal(ui.elements.get('review-done').hidden, true);
  assert.match(ui.elements.get('review-front').textContent, /正在保存/);

  answer.resolve({ ok: true });
  await flush();
  await flush();

  assert.deepEqual(calls, ['/review/answer', '/review/sync']);
  assert.equal(ui.elements.get('reviewer').hidden, true);
  assert.equal(ui.elements.get('review-done').hidden, false);
  assert.equal(ui.elements.get('review-done').focused, true);
});

test('评分全部失败时完成页明确保留失败数和刷新指引', async () => {
  const calls = [];
  const ui = await loadReview(async url => {
    calls.push(url);
    return { ok: false, status: 409 };
  }, [CARD]);
  ui.reveal();
  await ui.rate(3);
  await flush();
  assert.equal(ui.elements.get('review-done').hidden, false);
  assert.match(ui.elements.get('review-done-title').textContent, /未保存/);
  assert.match(ui.elements.get('review-summary').textContent, /0 张/);
  assert.match(ui.elements.get('review-failures').textContent, /1.*评分.*未保存/);
  assert.match(ui.elements.get('review-failures').textContent, /刷新/);
  assert.equal(ui.elements.get('review-failures').hidden, false);
  assert.deepEqual(calls, ['/review/answer']);
});

test('乱序返回中成功评分不清除其他失败，混合结果只计入成功数', async () => {
  const first = deferred();
  const second = deferred();
  let attempts = 0;
  const ui = await loadReview(url => {
    if (url === '/review/answer') return ++attempts === 1 ? first.promise : second.promise;
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, skipped: '同步未配置' }) });
  }, [CARD, { ...CARD, id: 'deck/second' }]);
  ui.reveal(); ui.rate(3);
  ui.reveal(); ui.rate(2);
  second.resolve({ ok: false, status: 404 });
  await flush();
  assert.equal(ui.elements.get('review-done').hidden, true);
  first.resolve({ ok: true });
  await flush(); await flush();
  assert.match(ui.elements.get('review-summary').textContent, /1 张/);
  assert.match(ui.elements.get('review-failures').textContent, /1.*评分.*未保存/);
  assert.equal(ui.elements.get('review-failures').hidden, false);
  assert.match(ui.elements.get('review-done-title').textContent, /未保存/);
});

test('同步被安全检查阻止时明确说明记录仍在本地', async () => {
  const ui = await loadReview((url) => {
    if (url === '/review/answer') return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: false, committed: false, pushed: false, changed: false, blocked: 'non-review-commits' })
    });
  }, [CARD]);
  ui.reveal();
  ui.rate(3);
  await flush();
  await flush();
  assert.match(ui.elements.get('review-summary').textContent, /安全检查被阻止/);
  assert.match(ui.elements.get('review-summary').textContent, /仍保留在本地/);
});

test('当前设备复习日志已暂存时提示用户处理 Git index', async () => {
  const ui = await loadReview((url) => {
    if (url === '/review/answer') return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: false, blocked: 'staged-current-review' })
    });
  }, [CARD]);
  ui.reveal();
  ui.rate(3);
  await flush();
  await flush();
  assert.match(ui.elements.get('review-summary').textContent, /提交或取消暂存/);
  assert.match(ui.elements.get('review-summary').textContent, /仍保留在本地/);
});

test('评分响应中断后自动重试完全相同的事件载荷', async () => {
  let attempts = 0;
  const calls = [];
  const ui = await loadReview((url, options) => {
    calls.push({ url, body: options?.body || '' });
    if (url === '/review/answer') {
      attempts += 1;
      return Promise.resolve({ ok: attempts > 1, status: attempts > 1 ? 200 : 503 });
    }
    return Promise.resolve({ ok: true, json: async () => ({ pushed: true }) });
  }, [CARD]);

  ui.reveal();
  ui.rate(3);
  await flush();
  await flush();
  await flush();

  assert.deepEqual(calls.map(call => call.url), ['/review/answer', '/review/answer', '/review/sync']);
  assert.equal(calls[0].body, calls[1].body, '重试必须复用 eventId、评分与耗时');
  assert.equal(JSON.parse(calls[0].body).eventId, 'event-1');
  assert.equal(ui.elements.get('review-done').hidden, false);
  assert.equal(ui.elements.get('review-summary').textContent.startsWith('复习了 1 张。'), true);
});

test('评分保存和重试期间离开页面有保护，保存完成后允许离开', async () => {
  const answer = deferred();
  const ui = await loadReview(url => url === '/review/answer'
    ? answer.promise
    : Promise.resolve({ ok: true, json: async () => ({ ok: true, skipped: '同步未配置' }) }), [CARD]);
  const attempt = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    ui.beforeUnload(event);
    return event;
  };
  assert.equal(attempt().prevented, false);
  ui.reveal();
  const rating = ui.rate(3);
  const pending = attempt();
  assert.equal(pending.prevented, true, '评分未确认时离开会丢失重试机会');
  assert.equal(pending.returnValue, '');
  answer.resolve({ ok: true });
  await rating;
  assert.equal(attempt().prevented, false);
});
