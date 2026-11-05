const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) values.add(name);
      else values.delete(name);
    },
    contains(name) { return values.has(name); }
  };
}

function createElement({ id = '', value = '', checked = false } = {}) {
  const listeners = new Map();
  return {
    id,
    value,
    checked,
    hidden: false,
    disabled: false,
    textContent: '',
    dataset: {},
    attributes: {},
    children: [],
    classList: fakeClassList(),
    style: {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    async dispatch(type, detail = {}) {
      const event = { preventDefault() {}, target: this, ...detail };
      for (const handler of listeners.get(type) || []) await handler(event);
      return event;
    },
    setAttribute(name, next) { this.attributes[name] = next; },
    removeAttribute(name) { delete this.attributes[name]; },
    toggleAttribute(name, force) {
      if (force) this.attributes[name] = '';
      else delete this.attributes[name];
    },
    appendChild(child) { this.children.push(child); return child; }
  };
}

function reportBlock(id) {
  const block = createElement({ id });
  const list = createElement();
  const total = createElement();
  block.querySelector = selector => selector === 'ul' ? list : selector === '.report-total' ? total : null;
  block.list = list;
  block.total = total;
  return block;
}

function fatalBlock() {
  const block = createElement({ id: 'fatal-error' });
  const strong = createElement();
  const paragraph = createElement();
  block.querySelector = selector => selector === 'strong' ? strong : selector === 'p' ? paragraph : null;
  block.strong = strong;
  block.paragraph = paragraph;
  return block;
}

async function flushUntil(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('界面状态未在预期时间内更新');
}

async function loadRecovery(initialState, overrides = {}) {
  const ids = [
    'recovery-form', 'first-run', 'source-panel', 'destination-panel', 'status-panel',
    'phase-label', 'title', 'outcome', 'remote', 'remote-result', 'local-source-path',
    'destination-parent', 'directory-name', 'status-title', 'status-message',
    'current-path', 'progress', 'start', 'cancel', 'retry', 'activate', 'discard-staging',
    'open-current-vault', 'action-note', 'warnings', 'git-source', 'local-source', 'inspect-remote',
    'choose-local-source', 'choose-destination', 'create-vault', 'open-existing-vault',
    'begin-restore'
  ];
  const elements = new Map(ids.map(id => [id, createElement({ id })]));
  elements.get('directory-name').value = 'workstation-vault-restored';

  const progressBar = createElement();
  const progressElement = elements.get('progress');
  progressElement.attributes = {
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0'
  };
  progressElement.querySelector = selector => selector === 'span' ? progressBar : null;
  const warningsList = createElement();
  elements.get('warnings').querySelector = selector => selector === 'ul' ? warningsList : null;
  elements.get('warnings').list = warningsList;

  const indexFailures = reportBlock('index-failures');
  const fatal = fatalBlock();
  elements.set('index-failures', indexFailures);
  elements.set('fatal-error', fatal);

  const sourceKind = { value: 'git' };
  const form = elements.get('recovery-form');
  form.elements = { sourceKind };
  const controls = [
    elements.get('remote'), elements.get('directory-name'),
    elements.get('inspect-remote'), elements.get('choose-local-source'),
    elements.get('choose-destination'), elements.get('start'), elements.get('cancel'),
    elements.get('retry'), elements.get('activate'), elements.get('discard-staging'),
    elements.get('open-current-vault')
  ];
  form.querySelectorAll = selector => selector === 'input, button' ? controls : [];

  const stages = ['source', 'destination', 'index', 'activate'].map(stage => {
    const item = createElement();
    item.dataset.stage = stage;
    return item;
  });
  const body = { dataset: {} };
  const document = {
    body,
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll(selector) { return selector === '#stages li' ? stages : []; },
    createElement() { return createElement(); }
  };

  let current = initialState;
  let stateChanged = () => {};
  const calls = {
    createVault: 0,
    openExistingVault: 0,
    beginRestore: 0,
    starts: [],
    cancel: 0,
    retry: 0,
    activate: 0,
    discard: 0,
    openCurrentVault: 0
  };
  const api = {
    async getState() { return overrides.getState ? overrides.getState() : current; },
    async chooseLocalSource() {
      return overrides.chooseLocalSource
        ? overrides.chooseLocalSource()
        : { selected: true, display: 'C:/backup', state: current };
    },
    async chooseDestinationParent() {
      return overrides.chooseDestinationParent
        ? overrides.chooseDestinationParent()
        : { selected: true, display: 'D:/vaults', state: current };
    },
    async inspectRemote(remote) {
      return overrides.inspectRemote
        ? overrides.inspectRemote(remote)
        : { message: '远端可以读取。', state: current };
    },
    async beginRestore() {
      calls.beginRestore += 1;
      current = overrides.beginRestore
        ? await overrides.beginRestore()
        : { mode: 'restore', phase: 'idle' };
      return current;
    },
    async start(options) {
      calls.starts.push(JSON.parse(JSON.stringify(options)));
      if (overrides.start) return overrides.start(options);
      return current;
    },
    async cancel() {
      calls.cancel += 1;
      if (overrides.cancel) {
        const result = await overrides.cancel();
        current = result?.state || result || current;
        return result;
      }
      current = { ...current, phase: 'cancelled', canCancel: false };
      return current;
    },
    async retryStage() {
      calls.retry += 1;
      if (overrides.retryStage) return overrides.retryStage();
      return current;
    },
    async activate() {
      calls.activate += 1;
      if (overrides.activate) return overrides.activate();
      return current;
    },
    async discardOwnedStaging() {
      calls.discard += 1;
      if (overrides.discardOwnedStaging) return overrides.discardOwnedStaging();
      return { mode: 'restore', phase: 'idle' };
    },
    async openCurrentVault() {
      calls.openCurrentVault += 1;
      return overrides.openCurrentVault ? overrides.openCurrentVault() : current;
    },
    async createVault() {
      calls.createVault += 1;
      return overrides.createVault ? overrides.createVault() : current;
    },
    async openExistingVault() {
      calls.openExistingVault += 1;
      return overrides.openExistingVault ? overrides.openExistingVault() : current;
    },
    onStateChanged(callback) { stateChanged = callback; return () => {}; }
  };
  const window = { workstationRecovery: api };
  const script = await fs.readFile(path.join(__dirname, '..', 'electron', 'recovery', 'recovery.js'), 'utf8');
  vm.runInNewContext(script, { window, document, Number, String, Boolean, Object, Map, Set });
  await flushUntil(() => body.dataset.phase === initialState.phase);

  return {
    api,
    body,
    form,
    sourceKind,
    elements,
    stages,
    indexFailures,
    fatal,
    calls,
    emit(next) {
      current = next;
      stateChanged(next);
    },
    setCurrent(next) { current = next; }
  };
}

test('首次启动提供三个语义操作，恢复入口调用 beginRestore', async () => {
  const ui = await loadRecovery({ mode: 'first-run', phase: 'idle' }, {
    createVault: () => ({ mode: 'first-run', phase: 'idle' }),
    openExistingVault: () => ({ mode: 'first-run', phase: 'idle' }),
    beginRestore: () => ({ mode: 'restore', phase: 'idle' })
  });
  assert.equal(ui.elements.get('first-run').hidden, false);
  assert.equal(ui.form.hidden, true);
  // 首次启动是欢迎页，不是恢复界面：样式据此藏起恢复阶段栏。
  assert.equal(ui.body.dataset.view, 'welcome');

  await ui.elements.get('create-vault').dispatch('click');
  await ui.elements.get('open-existing-vault').dispatch('click');
  await ui.elements.get('begin-restore').dispatch('click');

  assert.equal(ui.calls.createVault, 1);
  assert.equal(ui.calls.openExistingVault, 1);
  assert.equal(ui.calls.beginRestore, 1);
  assert.equal(ui.elements.get('first-run').hidden, true);
  assert.equal(ui.form.hidden, false);
  assert.equal(ui.body.dataset.phase, 'idle');
  assert.equal(ui.body.dataset.view, 'recovery');
});

test('恢复完成后重新进入设置会清除仅存在 renderer 的目录选择状态', async () => {
  const ui = await loadRecovery({ mode: 'restore', phase: 'idle' });
  ui.sourceKind.value = 'local';
  await ui.elements.get('choose-local-source').dispatch('click');
  await ui.elements.get('choose-destination').dispatch('click');
  assert.equal(ui.elements.get('start').disabled, false);

  ui.emit({ mode: 'restore', phase: 'completed' });
  ui.emit({ mode: 'restore', phase: 'idle' });

  assert.equal(ui.elements.get('local-source-path').textContent, '尚未选择本地备份目录');
  assert.equal(ui.elements.get('destination-parent').textContent, '尚未选择新资料库所在位置');
  assert.equal(ui.elements.get('start').disabled, true);
});

test('Git 地址只有与最近成功检查值一致时才允许开始', async () => {
  const state = { mode: 'restore', phase: 'idle' };
  const ui = await loadRecovery(state, {
    inspectRemote: remote => ({ message: `${remote} 可读取`, state })
  });
  await ui.elements.get('choose-destination').dispatch('click');
  ui.elements.get('remote').value = 'https://example.com/one.git';
  await ui.form.dispatch('input', { target: ui.elements.get('remote') });
  assert.equal(ui.elements.get('start').disabled, true);

  await ui.elements.get('inspect-remote').dispatch('click');
  assert.equal(ui.elements.get('start').disabled, false);

  ui.elements.get('remote').value = 'https://example.com/two.git';
  await ui.form.dispatch('input', { target: ui.elements.get('remote') });
  assert.equal(ui.elements.get('start').disabled, true);
  assert.match(ui.elements.get('remote-result').textContent, /重新检查/);
});

test('恢复界面没有大文件控件且只提交完整恢复 payload', async () => {
  const ui = await loadRecovery({ mode: 'restore', phase: 'idle' });
  ui.sourceKind.value = 'local';
  await ui.elements.get('choose-local-source').dispatch('click');
  await ui.elements.get('choose-destination').dispatch('click');

  await ui.form.dispatch('submit');
  await flushUntil(() => ui.calls.starts.length === 1);

  assert.equal(ui.elements.has('restore-blobs'), false);
  assert.deepEqual(ui.stages.map(stage => stage.dataset.stage), ['source', 'destination', 'index', 'activate']);
  assert.deepEqual(ui.calls.starts[0], {
    sourceKind: 'local',
    directoryName: 'workstation-vault-restored'
  });
  assert.equal(ui.elements.get('source-panel').hidden, false);
  assert.equal(ui.elements.get('destination-panel').hidden, false);
});

test('长操作 pending 时仍可取消，原操作拒绝不覆盖权威 cancelled 状态', async () => {
  const running = deferred();
  const cancelled = { mode: 'restore', phase: 'cancelled', canCancel: false };
  const ui = await loadRecovery({ mode: 'restore', phase: 'idle' }, {
    start: () => running.promise,
    cancel: () => cancelled
  });
  ui.elements.get('remote').value = 'https://example.com/vault.git';
  await ui.elements.get('choose-destination').dispatch('click');
  await ui.form.dispatch('submit');
  await flushUntil(() => ui.form.attributes['aria-busy'] === '');
  ui.emit({ mode: 'restore', phase: 'cloning', canCancel: true });

  assert.equal(ui.elements.get('cancel').hidden, false);
  assert.equal(ui.elements.get('cancel').disabled, false);
  await ui.elements.get('cancel').dispatch('click');

  assert.equal(ui.calls.cancel, 1);
  assert.equal(ui.body.dataset.phase, 'cancelled');
  running.reject(Object.assign(new Error('原 start 请求被取消'), { name: 'AbortError' }));
  await flushUntil(() => !('aria-busy' in ui.form.attributes));

  assert.equal(ui.body.dataset.phase, 'cancelled');
  assert.equal(ui.elements.get('local-source-path').textContent, '尚未选择本地备份目录');
  assert.equal(ui.elements.get('destination-parent').textContent, '尚未选择新资料库所在位置');
  assert.equal(ui.elements.get('title').textContent, '恢复没有生效');
  assert.equal(ui.elements.get('status-message').textContent, '可以重新选择来源和目标。');
  assert.equal(ui.fatal.hidden, true);
});

test('partial 索引报告保持激活操作，不提供大文件重试', async () => {
  const partial = {
    mode: 'restore',
    phase: 'ready-to-activate',
    outcome: 'partial',
    canRetry: false,
    canActivate: true,
    canCancel: true,
    indexFailures: [{ path: 'notes/bad.md', reason: '格式无效' }],
    indexFailureTotal: 1
  };
  const ui = await loadRecovery(partial, {
    activate: () => ({ ...partial, phase: 'activating', canActivate: false, canCancel: false })
  });

  assert.equal(ui.elements.get('phase-label').textContent, '等待切换');
  assert.equal(ui.elements.get('title').textContent, '恢复结果已经可以检查');
  assert.equal(ui.elements.get('status-message').textContent, '确认报告后再切换到新资料库。');
  assert.equal(ui.elements.get('outcome').textContent, '部分恢复');
  assert.match(ui.elements.get('action-note').textContent, /部分 Markdown 未建立索引/);
  assert.equal(ui.indexFailures.hidden, false);
  assert.match(ui.indexFailures.list.children[0].textContent, /notes\/bad\.md.*格式无效/);
  assert.equal(ui.elements.get('retry').hidden, true);
  assert.equal(ui.elements.get('activate').hidden, false);

  await ui.elements.get('activate').dispatch('click');
  assert.equal(ui.calls.activate, 1);
  assert.equal(ui.body.dataset.phase, 'activating');
});

test('residue 文案只开放 owner-verified 残留清理操作', async () => {
  const ui = await loadRecovery({
    mode: 'restore',
    phase: 'residue',
    residue: { owned: true, candidateExists: true, destinationExists: false }
  });

  assert.equal(ui.elements.get('phase-label').textContent, '发现残留');
  assert.equal(ui.elements.get('title').textContent, '上次恢复未完整结束');
  assert.match(ui.elements.get('status-message').textContent, /不会自动续跑/);
  assert.equal(ui.elements.get('discard-staging').hidden, false);
  assert.equal(ui.elements.get('open-current-vault').hidden, true);
  assert.equal(ui.elements.get('start').hidden, true);
  assert.equal(ui.elements.get('retry').hidden, true);
  assert.equal(ui.elements.get('activate').hidden, true);
  assert.equal(ui.elements.get('cancel').hidden, true);

  await ui.elements.get('discard-staging').dispatch('click');

  assert.equal(ui.calls.discard, 1);
  assert.equal(ui.body.dataset.phase, 'idle');
});

test('非 owner 残留不能自动清理但可安全打开当前资料库', async () => {
  const residue = {
    mode: 'restore',
    phase: 'residue',
    residue: { owned: false, candidateExists: true, destinationExists: false },
    canOpenCurrentVault: true
  };
  const ui = await loadRecovery(residue, { openCurrentVault: () => residue });

  assert.equal(ui.elements.get('discard-staging').hidden, true);
  assert.equal(ui.elements.get('open-current-vault').hidden, false);
  assert.match(ui.elements.get('action-note').textContent, /不能自动清理/);

  await ui.elements.get('open-current-vault').dispatch('click');
  assert.equal(ui.calls.openCurrentVault, 1);
});

test('runtime 替换被未保存编辑阻止时显示原因并保留操作界面', async () => {
  const ui = await loadRecovery({ mode: 'restore', phase: 'idle' }, {
    openExistingVault: () => ({
      mode: 'first-run',
      phase: 'idle',
      cancelled: true,
      reason: '主窗口有未保存的编辑或附件任务。'
    })
  });

  ui.emit({ mode: 'first-run', phase: 'idle' });
  await ui.elements.get('open-existing-vault').dispatch('click');

  assert.equal(ui.form.hidden, false);
  assert.equal(ui.elements.get('status-panel').hidden, false);
  assert.match(ui.elements.get('status-message').textContent, /未保存/);
  // 仍在欢迎页：三个起点保留，恢复来源、目标目录和「开始复制」与这里无关。
  assert.equal(ui.elements.get('first-run').hidden, false);
  assert.equal(ui.elements.get('source-panel').hidden, true);
  assert.equal(ui.elements.get('destination-panel').hidden, true);
  assert.equal(ui.elements.get('start').hidden, true);
});

test('fatal 文案取自主进程权威错误并按 retryability 显示操作', async () => {
  const failed = {
    mode: 'restore',
    phase: 'failed',
    canRetry: true,
    canCancel: false,
    error: {
      message: '本地备份包含不允许的符号链接。',
      remediation: '移除符号链接后重新选择来源。'
    }
  };
  let ui;
  ui = await loadRecovery({ mode: 'restore', phase: 'idle' }, {
    start: async () => {
      ui.setCurrent(failed);
      throw new Error('renderer wrapper');
    }
  });
  ui.elements.get('remote').value = 'https://example.com/vault.git';
  await ui.elements.get('choose-destination').dispatch('click');

  await ui.form.dispatch('submit');
  await flushUntil(() => ui.body.dataset.phase === 'failed');

  assert.equal(ui.elements.get('phase-label').textContent, '需要处理');
  assert.equal(ui.elements.get('title').textContent, '恢复没有完成');
  assert.equal(ui.elements.get('status-message').textContent, failed.error.message);
  assert.equal(ui.fatal.hidden, false);
  assert.equal(ui.fatal.strong.textContent, failed.error.message);
  assert.equal(ui.fatal.paragraph.textContent, failed.error.remediation);
  assert.equal(ui.elements.get('retry').hidden, false);
  assert.equal(ui.elements.get('activate').hidden, true);
  assert.equal(ui.elements.get('discard-staging').hidden, true);
});

test('completed 文案和操作可见性要求用户复核后手工启用同步', async () => {
  const ui = await loadRecovery({
    mode: 'restore',
    phase: 'completed',
    outcome: 'complete',
    canRetry: false,
    canActivate: false,
    canCancel: false
  });

  assert.equal(ui.elements.get('phase-label').textContent, '恢复完成');
  assert.equal(ui.elements.get('title').textContent, '新资料库已经打开');
  assert.match(ui.elements.get('status-message').textContent, /自动 Git 同步仍关闭/);
  assert.equal(ui.elements.get('outcome').textContent, '完整恢复');
  assert.match(ui.elements.get('action-note').textContent, /Git 远端和本机设置/);
  assert.equal(ui.elements.get('start').hidden, true);
  assert.equal(ui.elements.get('cancel').hidden, true);
  assert.equal(ui.elements.get('retry').hidden, true);
  assert.equal(ui.elements.get('activate').hidden, true);
  assert.equal(ui.elements.get('discard-staging').hidden, true);
});

test('pending 与进度状态维护 aria-busy 和 progressbar 属性', async () => {
  const running = deferred();
  const ui = await loadRecovery({ mode: 'restore', phase: 'idle' }, {
    start: () => running.promise
  });
  ui.sourceKind.value = 'local';
  await ui.elements.get('choose-local-source').dispatch('click');
  await ui.elements.get('choose-destination').dispatch('click');

  assert.equal(ui.elements.get('progress').attributes['aria-valuemin'], '0');
  assert.equal(ui.elements.get('progress').attributes['aria-valuemax'], '100');
  assert.equal(ui.elements.get('progress').attributes['aria-valuenow'], '0');
  assert.equal(ui.elements.get('progress').attributes['aria-valuetext'], '选择来源和一个全新的目标目录。');

  await ui.form.dispatch('submit');
  await flushUntil(() => ui.form.attributes['aria-busy'] === '');
  assert.equal(ui.elements.get('start').disabled, true);

  ui.emit({
    mode: 'restore',
    phase: 'copying',
    canCancel: true,
    progress: { current: 2, total: 5, unit: '个文件', currentPath: 'attachments/reference.bin' }
  });
  assert.equal(ui.elements.get('progress').attributes['aria-valuenow'], '40');
  assert.equal(ui.elements.get('progress').attributes['aria-valuetext'], '2 / 5 个文件');
  assert.equal(ui.elements.get('current-path').textContent, 'attachments/reference.bin');
  assert.equal(ui.elements.get('current-path').hidden, false);

  running.resolve({ mode: 'restore', phase: 'completed', outcome: 'complete' });
  await flushUntil(() => !('aria-busy' in ui.form.attributes));
  assert.equal(ui.form.attributes['aria-busy'], undefined);
});
