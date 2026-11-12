const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createWatcher, isEditorNoise } = require('../src/vault/watcher');

const quiet = { log() {}, warn() {}, error() {} };

/** 假的 fs.watch：把回调抓出来，测试自己决定什么时候发事件。 */
function fakeWatch() {
  const state = { listener: null, closed: false, handlers: new Map(), dir: '' };
  const watch = (dir, options, listener) => {
    state.dir = dir;
    state.options = options;
    state.listener = listener;
    return {
      on(event, handler) { state.handlers.set(event, handler); },
      close() { state.closed = true; }
    };
  };
  return { state, watch };
}

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

test('编辑器中间产物不触发重扫', () => {
  // 这些如果被当成「不认识的路径」，每保存一次就会白扫一次全量。
  for (const name of [
    'note.md.tmp-1234-abcd',      // 本应用自己的原子写
    '.goutputstream-xyz',          // GTK 编辑器
    'note.md~',                    // 备份文件
    '4913',                        // vim 的探测文件
    '.note.md.swp',
    'sub/.hidden.md',
    // 草稿和版本历史：编辑时约每秒写一次，不该触发全量重扫。
    '.workstation-local/drafts/0b8f4a52-8b1b-4c55-9d8e-3f0e4d1a2b3c.json',
    '.workstation-local/versions/abc/note.json',
    'node_modules/pkg/readme.md'
  ]) {
    assert.equal(isEditorNoise(name), true, `${name} 应被当作编辑器噪声`);
  }

  for (const name of ['note.md', 'research/甲.md', '子目录']) {
    assert.equal(isEditorNoise(name), false, `${name} 不该被当作噪声`);
  }
});

test('多个事件合并成一批，.md 走增量路径', async () => {
  const { state, watch } = fakeWatch();
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault',
    watch,
    debounceMs: 20,
    logger: quiet,
    onChange: batch => { batches.push(batch); }
  });
  assert.deepEqual(watcher.start(), { ok: true, degraded: false });
  assert.deepEqual(state.options, { recursive: true }, '必须是递归监听');

  state.listener('change', 'research/甲.md');
  state.listener('change', 'research/甲.md');
  state.listener('rename', 'research/乙.md');
  state.listener('change', 'note.md.tmp-9-9');

  await tick();
  assert.equal(batches.length, 1, '去抖窗口内的事件应合并成一批');
  assert.equal(batches[0].full, false);
  assert.deepEqual([...batches[0].paths].sort(), ['research/甲.md', 'research/乙.md'].sort());

  watcher.close();
});

test('目录改名和没有文件名的事件退化成全量重扫', async () => {
  const { state, watch } = fakeWatch();
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault', watch, debounceMs: 20, logger: quiet,
    onChange: batch => { batches.push(batch); }
  });
  watcher.start();

  // 目录改名影响它下面所有笔记的路径，猜不出范围
  state.listener('rename', 'research/旧目录');
  await tick();
  assert.equal(batches[0].full, true);

  batches.length = 0;
  state.listener('change', null);
  await tick();
  assert.equal(batches[0].full, true, '拿不到文件名时只能全量重扫');

  watcher.close();
});

test('反斜杠路径归一成正斜杠', async () => {
  const { state, watch } = fakeWatch();
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault', watch, debounceMs: 20, logger: quiet,
    onChange: batch => { batches.push(batch); }
  });
  watcher.start();

  // Windows 的递归监听给的是 `research\甲.md`
  state.listener('change', `research${path.sep}甲.md`);
  await tick();
  assert.deepEqual(batches[0].paths, ['research/甲.md']);

  watcher.close();
});

test('重扫失败不会让监听器失效', async () => {
  const { state, watch } = fakeWatch();
  let calls = 0;
  const watcher = createWatcher({
    dir: '/vault', watch, debounceMs: 20, logger: quiet,
    onChange: () => {
      calls += 1;
      // 一次扫描出错不该等于「从此不再感知外部编辑」
      return Promise.reject(new Error('扫描炸了'));
    }
  });
  watcher.start();

  state.listener('change', 'a.md');
  await tick();
  state.listener('change', 'b.md');
  await tick();

  assert.equal(calls, 2, '第一次失败后仍要继续响应事件');
  watcher.close();
});

test('监听正常时也周期对账，兜住漏报事件', async () => {
  const { watch } = fakeWatch();
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault', watch, debounceMs: 5, fallbackPollMs: 30, logger: quiet,
    onChange: batch => { batches.push(batch); }
  });
  watcher.start();

  await tick(90);
  assert.ok(batches.length >= 1);
  assert.equal(batches[0].full, true);
  assert.deepEqual(batches[0].paths, []);

  watcher.close();
});

test('监听建不起来时退化成轮询，而不是让应用起不来', async () => {
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault',
    watch: () => { const error = new Error('不支持'); error.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'; throw error; },
    debounceMs: 5,
    fallbackPollMs: 30,
    logger: quiet,
    onChange: batch => { batches.push(batch); }
  });

  const result = watcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.equal(watcher.isDegraded(), true);

  await tick(90);
  assert.ok(batches.length >= 1, '退化后应靠轮询继续发现改动');
  assert.equal(batches[0].full, true, '轮询只能做全量重扫');

  watcher.close();
});

test('监听中途失效也退化成轮询', async () => {
  const { state, watch } = fakeWatch();
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault', watch, debounceMs: 5, fallbackPollMs: 30, logger: quiet,
    onChange: batch => { batches.push(batch); }
  });
  watcher.start();
  assert.equal(watcher.isDegraded(), false);

  // 网络盘掉线、目录被删
  state.handlers.get('error')(new Error('EPERM'));
  assert.equal(watcher.isDegraded(), true);

  await tick(90);
  assert.ok(batches.length >= 1);
  watcher.close();
});

test('close 之后不再回调', async () => {
  const { state, watch } = fakeWatch();
  const batches = [];
  const watcher = createWatcher({
    dir: '/vault', watch, debounceMs: 20, logger: quiet,
    onChange: batch => { batches.push(batch); }
  });
  watcher.start();

  state.listener('change', 'a.md');
  watcher.close();
  await tick();

  assert.equal(batches.length, 0, '关掉之后排队中的事件不该再触发扫描');
  assert.equal(state.closed, true, '底层监听句柄要真的关掉');
});

test('真实文件系统上能监听到外部写入', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-watch-'));
  const batches = [];
  let resolveChange, timeout;
  const changed = new Promise(resolve => { resolveChange = resolve; });
  const watcher = createWatcher({
    dir, debounceMs: 50, logger: quiet,
    onChange: batch => {
      batches.push(batch);
      if (batch.full || batch.paths.includes('research/外部.md')) resolveChange(true);
    }
  });

  const started = watcher.start();
  if (!started.ok) {
    t.skip('当前环境不支持递归监听');
    watcher.close();
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }

  try {
    await fs.mkdir(path.join(dir, 'research'), { recursive: true });
    await fs.writeFile(path.join(dir, 'research', '外部.md'), '# 在应用外面写的');
    // 等实际事件；FSEvents 在繁忙机器上的投递可能晚于固定的 700ms。
    // 上限短于默认的 30 秒轮询周期，避免把轮询误当成原生监听成功。
    const received = await Promise.race([
      changed,
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 5000); })
    ]);
    assert.ok(received, `应当感知到外部写入，实际收到 ${JSON.stringify(batches)}`);
  } finally {
    clearTimeout(timeout);
    watcher.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
