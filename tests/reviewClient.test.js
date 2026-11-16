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
    ['review-failures', createElement('review-failures')],
    ['review-relearn', createElement('review-relearn')],
    ['review-edit', createElement('review-edit')],
    ['review-suspend', createElement('review-suspend')]
  ]);
  elements.get('reviewer').dataset.queue = encodeURIComponent(JSON.stringify(queue));
  elements.get('reviewer').append = child => {
    elements.get('reviewer').children.push(child);
    if (child.id) elements.set(child.id, child);
  };
  elements.get('review-done').hidden = true;

  const buttons = [1, 2, 3, 4].map(rating => {
    const button = createElement();
    button.tagName = 'BUTTON';
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
  for (const element of [...elements.values(), ...buttons]) {
    element.focus = () => { element.focused = true; document.activeElement = element; };
  }
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
    buttons,
    document,
    beforeUnload(event) { windowListeners.get('beforeunload')?.(event); },
    reveal: () => elements.get('review-reveal').listeners.get('click')(),
    suspend: () => elements.get('review-suspend').listeners.get('click')(),
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

test('显示答案按钮持有焦点时，隐藏后交还焦点并允许数字键评分', async () => {
  const answer = deferred();
  const payloads = [];
  const ui = await loadReview((url, options) => {
    if (url === '/review/answer') {
      payloads.push(JSON.parse(options.body));
      return answer.promise;
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, skipped: '同步未配置' }) });
  }, [CARD]);
  const reveal = ui.elements.get('review-reveal');
  reveal.tagName = 'BUTTON';
  reveal.focus();
  ui.reveal();
  assert.equal(reveal.hidden, true);
  assert.equal(ui.document.activeElement, ui.elements.get('reviewer'));
  ui.keydown({ key: '3' });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].rating, 3);
  assert.equal(ui.elements.get('reviewer').attributes['aria-busy'], 'true');
  answer.resolve({ ok: true });
  await flush();
  assert.equal(ui.elements.get('review-done').hidden, false);
});

test('鼠标评分后即使隐藏按钮仍持有焦点，下一张也能用空格翻面并按数字评分', async () => {
  const answer = deferred();
  const payloads = [];
  const ui = await loadReview((url, options) => {
    if (url === '/review/answer') {
      payloads.push(JSON.parse(options.body));
      return answer.promise;
    }
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }, [CARD, { ...CARD, id: 'deck/next', front: '下一张' }]);
  ui.reveal();
  ui.buttons[2].focus();
  ui.rate(3);
  assert.equal(ui.elements.get('review-front').innerHTML, '下一张');
  ui.keydown({ key: ' ' });
  assert.equal(ui.elements.get('review-back').hidden, false, '下一张答案应能通过空格显示');
  ui.keydown({ key: '2' });
  assert.deepEqual(payloads.map(({ cardId, rating }) => [cardId, rating]), [[CARD.id, 3], ['deck/next', 2]]);
  answer.resolve({ ok: true });
  await flush();
  assert.equal(ui.elements.get('review-done').hidden, false);
});

test('鼠标提交最后一次评分仍在保存时，Z 可以立即排队撤销', async () => {
  const answer = deferred();
  const calls = [];
  const ui = await loadReview(url => {
    calls.push(url);
    if (url === '/review/answer') return answer.promise;
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  }, [CARD]);
  ui.reveal();
  ui.buttons[2].focus();
  ui.rate(3);
  ui.keydown({ key: 'z' });
  answer.resolve({ ok: true });
  await flush();
  assert.ok(calls.includes('/review/undo'), '等待评分保存后应提交撤销');
  assert.equal(ui.elements.get('review-front').innerHTML, CARD.front);
  assert.equal(ui.elements.get('reviewer').hidden, false);
});

test('暂停当前卡后交回翻面焦点，但异步等待中移到其他控件的焦点不被抢回', async () => {
  for (const moveFocus of [false, true]) {
    const suspended = deferred();
    const ui = await loadReview(() => suspended.promise, [CARD, { ...CARD, id: 'deck/next', front: '下一张' }]);
    const button = ui.elements.get('review-suspend');
    button.tagName = 'BUTTON';
    button.focus();
    const pending = ui.suspend();
    const input = { tagName: 'INPUT' };
    if (moveFocus) ui.document.activeElement = input;
    suspended.resolve({ ok: true, json: async () => ({ ok: true }) });
    await pending;
    assert.equal(ui.elements.get('review-front').innerHTML, '下一张');
    if (moveFocus) assert.equal(ui.document.activeElement, input);
    else {
      ui.keydown({ key: ' ' });
      assert.equal(ui.elements.get('review-back').hidden, false, '暂停后下一张仍可用空格显示答案');
    }
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

test('选「忘了」的卡在这一轮末尾再出现一次，并标出「本轮重学」', async () => {
  const answers = [];
  const ui = await loadReview(async (url, options) => {
    if (url === '/review/answer') answers.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, skipped: '同步未启用' }) };
  }, [CARD, { ...CARD, id: 'deck/other', front: '另一张' }]);
  assert.equal(ui.elements.get('review-relearn').hidden, true);
  assert.match(ui.elements.get('review-edit').href, /^\/cards\/edit\?id=deck%2Fcard&returnTo=/);
  ui.reveal();
  await ui.rate(1);
  assert.equal(ui.elements.get('review-remaining').textContent, '2', '重学的卡排到最后，剩余数不减');
  assert.equal(ui.elements.get('review-front').innerHTML, '另一张');
  ui.reveal();
  await ui.rate(3);
  assert.equal(ui.elements.get('review-front').innerHTML, '正面');
  assert.equal(ui.elements.get('review-relearn').hidden, false);
  ui.reveal();
  await ui.rate(3);
  await flush();
  assert.deepEqual(answers.map(answer => [answer.cardId, answer.rating]), [['deck/card', 1], ['deck/other', 3], ['deck/card', 3]]);
  assert.equal(ui.elements.get('review-done').hidden, false);
  assert.match(ui.elements.get('review-summary').textContent, /^复习了 2 张，其中 1 张本轮重学过。/);
});

test('复习中途暂停当前这张：从本轮队列里拿掉，后面的重学也一起拿掉', async () => {
  const calls = [];
  const ui = await loadReview(async (url, options) => {
    calls.push([url, options?.body]);
    return { ok: true, json: async () => ({ ok: true, suspended: true }) };
  }, [CARD, { ...CARD, id: 'deck/other', front: '另一张' }]);
  ui.reveal();
  await ui.rate(1);
  ui.reveal();
  await ui.rate(3);
  assert.equal(ui.elements.get('review-front').innerHTML, '正面', '轮到重学的那张');
  await ui.suspend();
  assert.deepEqual(calls.find(([url]) => url === '/cards/suspend'), ['/cards/suspend', JSON.stringify({ id: 'deck/card', suspended: true })]);
  await flush();
  assert.equal(ui.elements.get('review-done').hidden, false, '拿掉之后这一轮就结束了');
});

test('服务端持续出错时不会无限重试：几次之后如实报告原因', async () => {
  let attempts = 0;
  const ui = await loadReview(async url => {
    if (url !== '/review/answer') return { ok: true, json: async () => ({ ok: true }) };
    attempts += 1;
    return { ok: false, status: 500, json: async () => ({ message: '磁盘已满' }) };
  }, [CARD], { fastTimers: true });
  ui.reveal();
  await ui.rate(3);
  for (let i = 0; i < 20 && ui.elements.get('review-done').hidden; i += 1) await flush();
  assert.equal(attempts, 5);
  assert.match(ui.elements.get('review-failures').textContent, /磁盘已满/);
});

test('撤销请求尚未完成时不能给下一张评分或暂停，完成后回到原卡', async () => {
  const undo = deferred();
  const calls = [];
  const ui = await loadReview(async (url, options) => {
    calls.push({ url, payload: options?.body });
    if (url === '/review/undo') return undo.promise;
    return { ok: true, json: async () => ({ ok: true }) };
  }, [CARD, { ...CARD, id: 'second', front: '第二张' }]);
  ui.reveal();
  await ui.rate(3);
  ui.keydown({ key: 'z' });
  await flush();
  ui.reveal();
  await ui.rate(3);
  await ui.suspend();
  assert.deepEqual(calls.map(call => call.url), ['/review/answer', '/review/undo']);
  undo.resolve({ ok: true, json: async () => ({ ok: true }) });
  await flush();
  assert.equal(ui.elements.get('review-front').innerHTML, CARD.front);
  assert.equal(ui.elements.get('review-remaining').textContent, '2');
});

test('首次评分仍在保存时快速重学，撤销第二次不丢掉首次成功评分的卡片统计', async () => {
  const first = deferred();
  let answers = 0;
  const ui = await loadReview(async url => {
    if (url === '/review/answer') {
      answers += 1;
      if (answers === 1) return first.promise;
      if (answers === 3) return { ok: false, status: 400, json: async () => ({ message: '评分失败' }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }, [CARD]);
  ui.reveal();
  const initial = ui.rate(1);
  ui.reveal();
  await ui.rate(3);
  first.resolve({ ok: true });
  await initial;
  ui.keydown({ key: 'z' });
  await flush();
  ui.reveal();
  await ui.rate(3);
  assert.match(ui.elements.get('review-summary').textContent, /复习了 1 张，其中 1 张本轮重学过/);
});

test('撤销响应连接中断时保留事件 ID，可重试后回到原卡', async () => {
  const ids = [];
  const ui = await loadReview(async (url, options) => {
    if (url === '/review/undo') {
      ids.push(JSON.parse(options.body).eventId);
      if (ids.length === 1) throw new Error('连接中断');
    }
    return { ok: true, json: async () => ({ ok: true }) };
  }, [CARD]);
  ui.reveal();
  await ui.rate(3);
  ui.keydown({ key: 'z' });
  await flush();
  ui.keydown({ key: 'z' });
  await flush();
  assert.deepEqual(ids, ['event-1', 'event-1']);
  assert.equal(ui.elements.get('review-front').innerHTML, CARD.front);
  assert.equal(ui.elements.get('review-remaining').textContent, '1');
});
