const api = window.workstationSettings;
const form = document.getElementById('settings-form');
const message = document.getElementById('message');
const saveButton = document.getElementById('save');
const reloadButton = document.getElementById('reload-settings');
const runtimeStatus = document.getElementById('runtime-status');
const syncButton = document.getElementById('sync-now');
const syncStatusPanel = document.getElementById('sync-status');
const syncStatusTitle = document.getElementById('sync-status-title');
const syncStatusDetail = document.getElementById('sync-status-detail');
const abortGitButton = document.getElementById('abort-git-operation');
const capabilityElements = [...document.querySelectorAll('[data-capability]')];

const PLAIN_FIELDS = [
  'vaultDir', 'device', 'readOnly', 'syncEnabled', 'syncIntervalMinutes',
  'launchAtLogin', 'theme'
];

let phase = 'loading';
let activeOperation = '';
let baseline = '';
let baselineSettings = {};
let externalData = null;
let loaded = false;
let runtimeRunning = false;
let savedVaultDir = '';
let lastServerSignature = '';
let pendingExternalChange = false;
let loadToken = 0;
let revision = 0;
let disabledBeforeBusy = new Map();
let syncStatus = { phase: 'disabled', operation: '', recovery: null, lastResult: null };
let capabilities = { launchAtLogin: true };

function field(name) {
  return form.elements.namedItem(name);
}

function setMessage(text, tone = '') {
  message.textContent = text;
  message.classList.toggle('is-error', tone === 'error');
  message.classList.toggle('is-conflict', tone === 'conflict');
}

function readPlainSettings() {
  const settings = {};
  for (const name of PLAIN_FIELDS) {
    const input = field(name);
    if (!input) continue;
    // theme 是一组单选：namedItem 返回 RadioNodeList，直接读写 value 即可。
    settings[name] = input.type === 'checkbox' ? input.checked : input.value;
  }
  settings.syncIntervalMinutes = Number(settings.syncIntervalMinutes);
  return settings;
}

function snapshot() {
  return JSON.stringify({ settings: readPlainSettings() });
}

function serverSignature(data) {
  const settings = {};
  for (const name of PLAIN_FIELDS) settings[name] = data.settings[name];
  return JSON.stringify({ settings });
}

function isDirty() {
  return loaded && snapshot() !== baseline;
}

function updateActions() {
  const locked = phase === 'loading' || phase === 'busy';
  saveButton.disabled = locked || !isDirty();
  reloadButton.hidden = phase !== 'conflict' || !externalData;
  syncButton.disabled = locked || !runtimeRunning
    || ['disabled', 'running'].includes(syncStatus.phase)
    || Boolean(syncStatus.recovery);
  abortGitButton.disabled = locked || syncStatus.phase === 'running';
  document.getElementById('open-vault').disabled = locked || !savedVaultDir;
  document.getElementById('open-config').disabled = locked;
  document.getElementById('open-recovery').disabled = locked;
}

function renderSyncStatus(status = {}) {
  syncStatus = { phase: 'idle', operation: '', recovery: null, lastResult: null, ...status };
  syncStatusPanel.dataset.phase = syncStatus.phase;
  const recovery = syncStatus.recovery;
  if (recovery) {
    const labels = { rebase: 'rebase', merge: 'merge', 'cherry-pick': 'cherry-pick', revert: 'revert', unmerged: '未合并文件' };
    syncStatusTitle.textContent = `Git ${labels[recovery.kind] || '操作'} 需要恢复`;
    syncStatusDetail.textContent = `有 ${recovery.unmergedCount} 个未合并文件。Git 写操作已暂停，本地编辑、浏览和复习仍可继续。`;
    abortGitButton.hidden = !recovery.abortable;
  } else if (syncStatus.phase === 'disabled') {
    syncStatusTitle.textContent = '自动同步已关闭';
    syncStatusDetail.textContent = '本地编辑和索引不受影响。';
    abortGitButton.hidden = true;
  } else if (syncStatus.phase === 'running') {
    syncStatusTitle.textContent = 'Git 同步正在进行';
    syncStatusDetail.textContent = syncStatus.operation === 'abort' ? '正在中止当前 Git 操作…' : '请稍候，本地内容仍可继续使用。';
    abortGitButton.hidden = true;
  } else if (syncStatus.phase === 'error') {
    syncStatusTitle.textContent = '上次 Git 同步失败';
    syncStatusDetail.textContent = syncStatus.lastResult?.blocked === 'staged-current-review'
      ? '当前设备的复习日志已在 Git 暂存区；请先提交或取消暂存。'
      : syncStatus.lastResult?.error || '可检查网络和远端后重试。';
    abortGitButton.hidden = true;
  } else {
    syncStatusTitle.textContent = 'Git 同步就绪';
    syncStatusDetail.textContent = syncStatus.lastResult?.ok === true ? '上次操作已完成。' : '本地编辑和索引不受影响。';
    abortGitButton.hidden = true;
  }
  updateActions();
}


function applyCapabilities(next = {}) {
  capabilities = {
    launchAtLogin: next.launchAtLogin !== false
  };
  for (const element of capabilityElements) {
    const supported = Boolean(capabilities[element.dataset.capability]);
    element.hidden = !supported;
    element.setAttribute('aria-hidden', String(!supported));
    for (const control of element.querySelectorAll('input, button')) control.disabled = !supported;
  }
}

function setPhase(next) {
  phase = next;
  document.body.dataset.settingsState = next;
  form.dataset.settingsState = next;
  // 编辑状态（待保存、保存中、外部有变化、出错）都写在底部操作栏的提示里，标题旁不再另挂一个状态胶囊。
  updateActions();
}

function lockControls() {
  disabledBeforeBusy = new Map();
  for (const control of form.querySelectorAll('input, button')) {
    disabledBeforeBusy.set(control, control.disabled);
    control.disabled = true;
  }
  form.setAttribute('aria-busy', 'true');
}

function unlockControls() {
  for (const [control, wasDisabled] of disabledBeforeBusy) control.disabled = wasDisabled;
  disabledBeforeBusy.clear();
  form.removeAttribute('aria-busy');
  applyCapabilities(capabilities);
  updateActions();
}

function beginOperation(name, text) {
  activeOperation = name;
  setPhase('busy');
  lockControls();
  setMessage(text);
}

function settleOperation(text = '') {
  activeOperation = '';
  unlockControls();
  if (externalData && isDirty()) {
    setPhase('conflict');
    setMessage('外部设置已变化；本页未保存内容没有被覆盖。', 'conflict');
  } else {
    setPhase(isDirty() ? 'dirty' : 'clean');
    setMessage(text);
  }
  if (pendingExternalChange) {
    pendingExternalChange = false;
    handleExternalChange();
  }
}

function failOperation(error) {
  activeOperation = '';
  unlockControls();
  setPhase('error');
  setMessage(error.message || String(error), 'error');
  if (pendingExternalChange) {
    pendingExternalChange = false;
    handleExternalChange();
  }
}

function fill(data) {
  revision = Number(data.revision || 0);
  applyCapabilities(data.capabilities);
  for (const name of PLAIN_FIELDS) {
    const input = field(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(data.settings[name]);
    else input.value = data.settings[name] ?? '';
  }

  runtimeRunning = Boolean(data.runtimeRunning);
  renderSyncStatus(data.syncStatus);
  savedVaultDir = String(data.settings.vaultDir || '');
  runtimeStatus.textContent = runtimeRunning ? '工作台运行中' : '等待选择资料库';
  // 正常运行时不必说；只有还没选资料库、工作台没跑起来时才挂出来。
  runtimeStatus.hidden = runtimeRunning;
  loaded = true;
  baselineSettings = readPlainSettings();
  baseline = snapshot();
  lastServerSignature = serverSignature(data);
  externalData = null;
}

function collect() {
  const local = readPlainSettings();
  const settings = {};
  for (const name of PLAIN_FIELDS) {
    const localChanged = !Object.is(local[name], baselineSettings[name]);
    settings[name] = externalData && !localChanged
      ? externalData.settings[name]
      : local[name];
  }
  settings.syncIntervalMinutes = Number(settings.syncIntervalMinutes);
  return {
    expectedRevision: Number(externalData?.revision ?? revision),
    settings
  };
}

function updateDirtyState() {
  if (!loaded || phase === 'loading' || phase === 'busy') return;
  if (!isDirty() && externalData) {
    const latest = externalData;
    fill(latest);
    setPhase('clean');
    setMessage('已载入外部设置。');
    return;
  }
  if (externalData && isDirty()) {
    setPhase('conflict');
    setMessage('外部设置已变化；本页未保存内容没有被覆盖。', 'conflict');
  } else if (isDirty()) {
    setPhase('dirty');
    setMessage('有未保存的更改。');
  } else {
    setPhase('clean');
    setMessage('');
  }
}

async function load() {
  const token = ++loadToken;
  activeOperation = 'load';
  setPhase('loading');
  lockControls();
  setMessage('正在读取设置…');
  try {
    const data = await api.get();
    if (token !== loadToken) return;
    fill(data);
    activeOperation = '';
    unlockControls();
    setPhase('clean');
    setMessage('');
    if (pendingExternalChange) {
      pendingExternalChange = false;
      handleExternalChange();
    }
  } catch (error) {
    if (token === loadToken) failOperation(error);
  }
}

async function handleExternalChange() {
  if (activeOperation) {
    pendingExternalChange = true;
    return;
  }

  const token = ++loadToken;
  try {
    const data = await api.get();
    if (token !== loadToken) return;
    if (serverSignature(data) === lastServerSignature) return;
    if (isDirty()) {
      externalData = data;
      setPhase('conflict');
      setMessage('外部设置已变化；本页未保存内容没有被覆盖。', 'conflict');
    } else {
      fill(data);
      setPhase('clean');
      setMessage('设置已从其它位置更新。');
    }
  } catch (error) {
    setPhase('error');
    setMessage(error.message || String(error), 'error');
  }
}

form.addEventListener('input', updateDirtyState);
form.addEventListener('change', updateDirtyState);

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!isDirty() || activeOperation) return;

  const update = collect();
  beginOperation('save', '正在保存设置…');
  try {
    const result = await api.save(update);
    if (result.conflict) {
      activeOperation = '';
      unlockControls();
      externalData = result.latest;
      setPhase('conflict');
      setMessage('设置已在其它位置更新；本页未保存内容没有被覆盖。', 'conflict');
      return;
    }
    if (result.cancelled) {
      settleOperation(result.reason || '设置尚未保存。');
      return;
    }
    fill(result);
    activeOperation = '';
    unlockControls();
    setPhase('clean');
    setMessage('设置已保存。');
    if (pendingExternalChange) {
      pendingExternalChange = false;
      handleExternalChange();
    }
  } catch (error) {
    failOperation(error);
  }
});

async function chooseDirectory(button) {
  if (activeOperation) return;
  const name = button.dataset.chooseDir;
  beginOperation('choose', '正在选择路径…');
  try {
    const selected = await api.chooseDirectory(name);
    if (selected) field(name).value = selected;
    settleOperation(selected ? '路径已选择，保存后生效。' : '');
  } catch (error) {
    failOperation(error);
  }
}

document.querySelectorAll('[data-choose-dir]').forEach(button => {
  button.addEventListener('click', () => chooseDirectory(button));
});

syncButton.addEventListener('click', async () => {
  if (activeOperation) return;
  beginOperation('sync', '正在同步…');
  try {
    const result = await api.syncNow();
    if (result.ok === false) {
      const detail = result.blocked === 'recovery-required' ? 'Git 需要先恢复，未执行同步。' : `同步失败：${result.error || '未知错误'}`;
      throw new Error(detail);
    }
    settleOperation(result.skipped ? `同步跳过：${result.skipped}` : '同步完成。');
  } catch (error) {
    failOperation(error);
  }
});

abortGitButton.addEventListener('click', async () => {
  if (activeOperation) return;
  beginOperation('abort', '正在中止当前 Git 操作…');
  try {
    const result = await api.abortGitOperation();
    if (result.cancelled) settleOperation('未中止 Git 操作。');
    else if (result.ok === false) throw new Error(result.error || 'Git 操作未能安全中止。');
    else settleOperation('Git 操作已中止；请检查资料库后手动同步。');
  } catch (error) {
    failOperation(error);
  }
});

async function openLocation(name, operation) {
  if (activeOperation) return;
  beginOperation('open', '正在打开…');
  try {
    await operation();
    settleOperation(name);
  } catch (error) {
    failOperation(error);
  }
}

document.getElementById('open-vault').addEventListener('click', () => openLocation('已打开资料库。', api.openVault));
document.getElementById('open-config').addEventListener('click', () => openLocation('已打开配置目录。', api.openConfigDirectory));
document.getElementById('open-recovery').addEventListener('click', () => openLocation('已打开资料库恢复。', () => api.openRecovery('restore')));

reloadButton.addEventListener('click', () => {
  if (!externalData || !window.confirm('载入外部设置会放弃本页未保存的更改。继续？')) return;
  const latest = externalData;
  fill(latest);
  setPhase('clean');
  setMessage('已载入外部设置。');
});

window.addEventListener('beforeunload', event => {
  if (!isDirty() && activeOperation !== 'save') return;
  event.preventDefault();
  event.returnValue = '';
});

const navLinks = [...document.querySelectorAll('[data-settings-nav] a')];
const sections = navLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);

function activateSection(id) {
  for (const link of navLinks) {
    const active = link.getAttribute('href') === `#${id}`;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

let navigatingSection = null;

function activateVisibleSection() {
  if (navigatingSection) return;
  const marker = Math.min(window.innerHeight * .24, 180);
  let visible = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top > marker) break;
    visible = section;
  }
  if (visible) activateSection(visible.id);
}

function activateHashSection() {
  navigatingSection = window.location.hash.slice(1) || sections[0]?.id;
  activateSection(navigatingSection);
}

for (const link of navLinks) {
  link.addEventListener('click', () => {
    navigatingSection = link.hash.slice(1);
    activateSection(navigatingSection);
  });
}
// Keep the chosen section highlighted while smooth anchor scrolling passes other sections.
activateHashSection();
window.addEventListener('hashchange', activateHashSection);
window.addEventListener('scrollend', () => { navigatingSection = null; });
for (const type of ['wheel', 'touchstart']) {
  window.addEventListener(type, () => { navigatingSection = null; }, { passive: true });
}
window.addEventListener('keydown', event => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
    navigatingSection = null;
  }
});
window.addEventListener('scroll', activateVisibleSection, { passive: true });
window.addEventListener('resize', () => { navigatingSection = null; activateVisibleSection(); });

api.onChanged(handleExternalChange);
api.onSyncStatusChanged(renderSyncStatus);
load();
