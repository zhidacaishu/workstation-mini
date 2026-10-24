const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const PLAIN_FIELDS = [
  'vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes',
  'zoteroApi', 'zoteroDataDir', 'journalTrackerUrl', 'journalTrackerEmail',
  'checkDraftPath', 'pythonPath', 'whisperPath', 'whisperModel', 'blogRepo',
  'launchAtLogin', 'blobServerUrl', 'updatesEnabled',
  'remindersEnabled', 'reminderLeadMinutes'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeData(overrides = {}) {
  const settings = {
    vaultDir: 'C:/vault',
    device: 'laptop',
    readOnly: false,
    syncEnabled: true,
    syncIntervalMinutes: 15,
    zoteroApi: 'http://127.0.0.1:23119/api',
    zoteroDataDir: 'C:/Zotero',
    journalTrackerUrl: '',
    journalTrackerEmail: '',
    checkDraftPath: '',
    pythonPath: 'python',
    whisperPath: '',
    whisperModel: '',
    blogRepo: '',
    launchAtLogin: false,
    updatesEnabled: true,
    remindersEnabled: false,
    reminderLeadMinutes: 10,
    secrets: {
      anthropicApiKey: true,
      journalTrackerPassword: false,
      blobServerToken: false,
      mineruApiToken: false
    },
    ...overrides
  };
  if (overrides.secrets) settings.secrets = overrides.secrets;
  return {
    revision: Number(overrides.revision || 0),
    settings,
    runtimeRunning: true,
    syncStatus: settings.syncEnabled
      ? { phase: 'idle', operation: '', recovery: null, lastResult: null }
      : { phase: 'disabled', operation: '', recovery: null, lastResult: null },
    updateStatus: { phase: 'idle', version: '', reason: '', enabled: true, text: '尚未检查更新' },
    capabilities: { launchAtLogin: true, autoUpdate: true }
  };
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

function createElement({ id = '', name = '', type = 'button', value = '', checked = false } = {}) {
  const listeners = new Map();
  return {
    id,
    name,
    type,
    value,
    checked,
    disabled: false,
    hidden: false,
    textContent: '',
    dataset: {},
    attributes: {},
    classList: fakeClassList(),
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async dispatch(event, detail = {}) {
      const payload = { preventDefault() {}, ...detail };
      await Promise.all((listeners.get(event) || []).map(handler => handler(payload)));
      return payload;
    },
    setAttribute(attribute, attributeValue) { this.attributes[attribute] = attributeValue; },
    removeAttribute(attribute) { delete this.attributes[attribute]; }
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
}

async function loadSettings(initial = makeData()) {
  const fields = new Map();
  for (const name of PLAIN_FIELDS) {
    const checkbox = ['readOnly', 'syncEnabled', 'launchAtLogin', 'updatesEnabled', 'remindersEnabled'].includes(name);
    const number = ['syncIntervalMinutes', 'reminderLeadMinutes'].includes(name);
    fields.set(name, createElement({ name, type: checkbox ? 'checkbox' : number ? 'number' : 'text' }));
  }
  fields.set('anthropicApiKey', createElement({ name: 'anthropicApiKey', type: 'password' }));
  fields.set('clearAnthropicApiKey', createElement({ name: 'clearAnthropicApiKey', type: 'checkbox' }));
  fields.set('journalTrackerPassword', createElement({ name: 'journalTrackerPassword', type: 'password' }));
  fields.set('clearJournalTrackerPassword', createElement({ name: 'clearJournalTrackerPassword', type: 'checkbox' }));
  fields.set('blobServerToken', createElement({ name: 'blobServerToken', type: 'password' }));
  fields.set('clearBlobServerToken', createElement({ name: 'clearBlobServerToken', type: 'checkbox' }));
  fields.set('mineruApiToken', createElement({ name: 'mineruApiToken', type: 'password' }));
  fields.set('clearMineruApiToken', createElement({ name: 'clearMineruApiToken', type: 'checkbox' }));

  const form = createElement({ id: 'settings-form' });
  form.elements = { namedItem: name => fields.get(name) || null };
  const message = createElement({ id: 'message' });
  const save = createElement({ id: 'save' });
  save.disabled = true;
  const reload = createElement({ id: 'reload-settings' });
  reload.hidden = true;
  const runtime = createElement({ id: 'runtime-status' });
  const state = createElement({ id: 'settings-state' });
  const sync = createElement({ id: 'sync-now' });
  const syncStatus = createElement({ id: 'sync-status' });
  const syncStatusTitle = createElement({ id: 'sync-status-title' });
  const syncStatusDetail = createElement({ id: 'sync-status-detail' });
  const abortGit = createElement({ id: 'abort-git-operation' });
  abortGit.hidden = true;
  const openVault = createElement({ id: 'open-vault' });
  const openConfig = createElement({ id: 'open-config' });
  const openRecovery = createElement({ id: 'open-recovery' });
  const repairBlobs = createElement({ id: 'repair-blobs' });
  const anthropicStatus = createElement({ id: 'anthropic-status' });
  const journalStatus = createElement({ id: 'journal-password-status' });
  const blobTokenStatus = createElement({ id: 'blob-token-status' });
  const mineruTokenStatus = createElement({ id: 'mineru-token-status' });
  const updateStatusLine = createElement({ id: 'update-status' });
  const launchCapability = createElement();
  launchCapability.dataset.capability = 'launchAtLogin';
  launchCapability.querySelectorAll = () => [fields.get('launchAtLogin')];
  const updateCapability = createElement();
  updateCapability.dataset.capability = 'autoUpdate';
  updateCapability.querySelectorAll = () => [fields.get('updatesEnabled')];
  const capabilityElements = [launchCapability, updateCapability];
  const controls = [...fields.values(), save, reload, sync, abortGit, openVault, openConfig, openRecovery, repairBlobs];
  form.querySelectorAll = selector => selector === 'input, button' ? controls : [];

  const byId = new Map([
    ['settings-form', form], ['message', message], ['save', save],
    ['reload-settings', reload], ['runtime-status', runtime], ['settings-state', state],
    ['sync-now', sync], ['sync-status', syncStatus], ['sync-status-title', syncStatusTitle],
    ['sync-status-detail', syncStatusDetail], ['abort-git-operation', abortGit],
    ['open-vault', openVault], ['open-config', openConfig],
    ['open-recovery', openRecovery], ['repair-blobs', repairBlobs],
    ['anthropic-status', anthropicStatus], ['journal-password-status', journalStatus],
    ['blob-token-status', blobTokenStatus], ['mineru-token-status', mineruTokenStatus],
    ['update-status', updateStatusLine]
  ]);
  const body = { dataset: {} };
  const document = {
    body,
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll(selector) { return selector === '[data-capability]' ? capabilityElements : []; },
    querySelector() { return null; }
  };

  let current = clone(initial);
  let changed;
  let syncStatusChanged;
  let updateStatusChanged;
  let saveImpl = async update => {
    current = makeData({ ...update.settings, secrets: current.settings.secrets });
    return clone(current);
  };
  let getCalls = 0;
  const savedUpdates = [];
  const recoveryModes = [];
  const api = {
    async get() { getCalls += 1; return clone(current); },
    async save(update) {
      savedUpdates.push(clone(update));
      const result = await saveImpl(update);
      current = clone(result);
      return result;
    },
    async chooseDirectory() { return ''; },
    async chooseFile() { return ''; },
    async syncNow() { return { ok: true }; },
    async abortGitOperation() { return { ok: true, aborted: 'rebase' }; },
    async openVault() {},
    async openConfigDirectory() {},
    async openRecovery(mode) { recoveryModes.push(mode); },
    onChanged(callback) { changed = callback; return () => {}; },
    onSyncStatusChanged(callback) { syncStatusChanged = callback; return () => {}; },
    onUpdateStatusChanged(callback) { updateStatusChanged = callback; return () => {}; }
  };

  const windowListeners = new Map();
  const window = {
    workstationSettings: api,
    location: { hash: '' },
    confirm: () => true,
    addEventListener(event, handler) {
      if (!windowListeners.has(event)) windowListeners.set(event, []);
      windowListeners.get(event).push(handler);
    }
  };

  const script = await fs.readFile(path.join(__dirname, '..', 'electron', 'settings', 'settings.js'), 'utf8');
  vm.runInNewContext(script, {
    window, document, JSON, Number, String, Boolean, Object, Map,
    setTimeout, clearTimeout
  });
  await flush();
  await flush();

  return {
    fields, form, message, save, reload, runtime, state, sync, syncStatus,
    syncStatusTitle, syncStatusDetail, abortGit, openVault, openConfig, openRecovery, repairBlobs,
    updateStatusLine, launchCapability, updateCapability, body, savedUpdates, recoveryModes,
    setSave(implementation) { saveImpl = implementation; },
    setCurrent(data) { current = clone(data); },
    async change() { await changed(); await flush(); },
    async changeSyncStatus(status) { syncStatusChanged(status); await flush(); },
    async changeUpdateStatus(status) { updateStatusChanged(status); await flush(); },
    getCalls: () => getCalls,
    beforeUnload() {
      const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
      for (const handler of windowListeners.get('beforeunload') || []) handler(event);
      return event;
    }
  };
}

test('macOS capabilities 隐藏不支持项并保留对应设置原值', async () => {
  const initial = makeData({ launchAtLogin: true, updatesEnabled: true });
  initial.capabilities = { launchAtLogin: false, autoUpdate: false };
  const ui = await loadSettings(initial);

  assert.equal(ui.launchCapability.hidden, true);
  assert.equal(ui.updateCapability.hidden, true);
  assert.equal(ui.launchCapability.attributes['aria-hidden'], 'true');
  assert.equal(ui.fields.get('launchAtLogin').disabled, true);
  assert.equal(ui.fields.get('updatesEnabled').disabled, true);
  assert.equal(ui.updateStatusLine.textContent, '');

  ui.fields.get('device').value = 'mac';
  await ui.form.dispatch('input');
  ui.setSave(async update => {
    assert.equal(update.settings.launchAtLogin, true);
    assert.equal(update.settings.updatesEnabled, true);
    const result = makeData({ ...update.settings, secrets: initial.settings.secrets });
    result.capabilities = initial.capabilities;
    return result;
  });
  await ui.form.dispatch('submit');

  assert.equal(ui.savedUpdates[0].settings.launchAtLogin, true);
  assert.equal(ui.savedUpdates[0].settings.updatesEnabled, true);
  assert.equal(ui.launchCapability.hidden, true);
});

test('更新状态实时显示，文案取自主进程而不是在页面里再拼一遍', async () => {
  const ui = await loadSettings();
  assert.equal(ui.updateStatusLine.textContent, '尚未检查更新');

  await ui.changeUpdateStatus({
    phase: 'downloaded', version: '0.2.0', reason: '', enabled: true,
    text: '更新 0.2.0 已就绪，退出时安装'
  });
  assert.match(ui.updateStatusLine.textContent, /0\.2\.0/);
  assert.equal(ui.updateStatusLine.dataset.phase, 'downloaded');

  // 没配存储服务时也要说清楚原因，而不是留一行空白让人以为坏了。
  await ui.changeUpdateStatus({
    phase: 'disabled', version: '', reason: '未配置大文件存储服务地址，无法检查更新。',
    enabled: false, text: '未启用自动更新：未配置大文件存储服务地址，无法检查更新。'
  });
  assert.match(ui.updateStatusLine.textContent, /存储服务/);
  assert.equal(ui.updateStatusLine.dataset.phase, 'disabled');
});

test('同步恢复状态独立展示，并阻止手工同步', async () => {
  const ui = await loadSettings();
  await ui.changeSyncStatus({
    phase: 'recovery-required',
    operation: '',
    recovery: { kind: 'rebase', abortable: true, unmergedCount: 2 },
    lastResult: null
  });

  assert.equal(ui.syncStatus.dataset.phase, 'recovery-required');
  assert.match(ui.syncStatusTitle.textContent, /rebase/);
  assert.match(ui.syncStatusDetail.textContent, /2 个未合并文件/);
  assert.equal(ui.abortGit.hidden, false);
  assert.equal(ui.sync.disabled, true);
  assert.equal(ui.body.dataset.settingsState, 'clean');
});

test('取消启用同步后保留 dirty 表单，不伪装成已保存', async () => {
  const ui = await loadSettings(makeData({ syncEnabled: false }));
  ui.fields.get('syncEnabled').checked = true;
  await ui.form.dispatch('change');
  ui.setSave(async () => ({ cancelled: true }));

  await ui.form.dispatch('submit');

  assert.equal(ui.body.dataset.settingsState, 'dirty');
  assert.equal(ui.fields.get('syncEnabled').checked, true);
  assert.match(ui.message.textContent, /尚未保存/);
  assert.equal(ui.save.disabled, false);
});

test('恢复入口只打开独立窗口，不改变未保存设置状态', async () => {
  const ui = await loadSettings();
  ui.fields.get('device').value = 'local-draft';
  await ui.form.dispatch('input');

  await ui.openRecovery.dispatch('click');
  await ui.repairBlobs.dispatch('click');

  assert.deepEqual(ui.recoveryModes, ['restore', 'repair-blobs']);
  assert.equal(ui.body.dataset.settingsState, 'dirty');
  assert.equal(ui.fields.get('device').value, 'local-draft');
});

test('设置页从 clean 进入 dirty，保存失败保留普通字段和秘密输入', async () => {
  const ui = await loadSettings();
  assert.equal(ui.body.dataset.settingsState, 'clean');
  assert.equal(ui.state.textContent, '已同步');
  assert.equal(ui.runtime.textContent, '工作台运行中');
  assert.equal(ui.save.disabled, true);

  ui.fields.get('device').value = 'desk';
  ui.fields.get('anthropicApiKey').value = 'secret-value';
  await ui.form.dispatch('input');

  assert.equal(ui.body.dataset.settingsState, 'dirty');
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.beforeUnload().prevented, true);

  ui.setSave(async () => { throw new Error('无法写入设置'); });
  await ui.form.dispatch('submit');

  assert.equal(ui.body.dataset.settingsState, 'error');
  assert.equal(ui.message.textContent, '无法写入设置');
  assert.equal(ui.message.classList.contains('is-error'), true);
  assert.equal(ui.fields.get('device').value, 'desk');
  assert.equal(ui.fields.get('anthropicApiKey').value, 'secret-value');
  assert.equal(ui.save.disabled, false);
  assert.deepEqual(ui.savedUpdates[0].secrets.anthropicApiKey, { action: 'set', value: 'secret-value' });
});

test('保存期间锁定竞争操作，成功后清空秘密并吸收自身变更通知', async () => {
  const ui = await loadSettings();
  let resolveSave;
  ui.setSave(update => new Promise(resolve => {
    resolveSave = () => resolve(makeData({
      ...update.settings,
      secrets: { anthropicApiKey: true, journalTrackerPassword: false }
    }));
  }));

  ui.fields.get('device').value = 'desktop';
  ui.fields.get('anthropicApiKey').value = 'new-key';
  await ui.form.dispatch('input');
  const saving = ui.form.dispatch('submit');
  await flush();

  assert.equal(ui.body.dataset.settingsState, 'busy');
  assert.equal(ui.state.textContent, '保存中');
  assert.equal(ui.fields.get('device').disabled, true);
  assert.equal(ui.sync.disabled, true);
  assert.equal(ui.beforeUnload().prevented, true);

  const notification = ui.change();
  resolveSave();
  await saving;
  await notification;
  await flush();

  assert.equal(ui.body.dataset.settingsState, 'clean');
  assert.equal(ui.message.textContent, '设置已保存。');
  assert.equal(ui.fields.get('device').value, 'desktop');
  assert.equal(ui.fields.get('anthropicApiKey').value, '');
  assert.equal(ui.fields.get('device').disabled, false);
  assert.equal(ui.save.disabled, true);
  assert.ok(ui.getCalls() >= 2);
});

test('外部变化在 clean 时自动刷新，在 dirty 时保留本地值并合并未编辑字段', async () => {
  const ui = await loadSettings(makeData({ revision: 3 }));

  ui.setCurrent(makeData({ revision: 4, device: 'external-clean', zoteroApi: 'http://external/one' }));
  await ui.change();
  assert.equal(ui.fields.get('device').value, 'external-clean');
  assert.equal(ui.fields.get('zoteroApi').value, 'http://external/one');
  assert.equal(ui.body.dataset.settingsState, 'clean');

  ui.fields.get('device').value = 'local-draft';
  await ui.form.dispatch('input');
  ui.setCurrent(makeData({ revision: 5, device: 'external-two', zoteroApi: 'http://external/two' }));
  await ui.change();

  assert.equal(ui.body.dataset.settingsState, 'conflict');
  assert.equal(ui.fields.get('device').value, 'local-draft');
  assert.equal(ui.fields.get('zoteroApi').value, 'http://external/one');
  assert.equal(ui.reload.hidden, false);
  assert.match(ui.message.textContent, /没有被覆盖/);

  ui.setSave(async update => makeData({
    revision: 6,
    ...update.settings,
    secrets: { anthropicApiKey: true, journalTrackerPassword: false }
  }));
  await ui.form.dispatch('submit');

  assert.equal(ui.savedUpdates.at(-1).expectedRevision, 5);
  assert.equal(ui.savedUpdates.at(-1).settings.device, 'local-draft');
  assert.equal(ui.savedUpdates.at(-1).settings.zoteroApi, 'http://external/two');
  assert.equal(ui.body.dataset.settingsState, 'clean');
});

test('revision 冲突保留本地输入并等待显式合并', async () => {
  const ui = await loadSettings(makeData({ revision: 7 }));
  ui.fields.get('device').value = 'local-draft';
  await ui.form.dispatch('input');
  ui.setSave(async update => {
    assert.equal(update.expectedRevision, 7);
    return { conflict: true, latest: makeData({ revision: 8, device: 'external' }) };
  });

  await ui.form.dispatch('submit');

  assert.equal(ui.body.dataset.settingsState, 'conflict');
  assert.equal(ui.fields.get('device').value, 'local-draft');
  assert.match(ui.message.textContent, /没有被覆盖/);
  assert.equal(ui.save.disabled, false);
});
