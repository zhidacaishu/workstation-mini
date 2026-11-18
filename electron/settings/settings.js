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
const conflictPanel = document.getElementById('conflict-panel');
const conflictList = document.getElementById('conflict-list');
const conflictProgress = document.getElementById('conflict-progress');
const resolveButton = document.getElementById('resolve-conflicts');
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
// 冲突文件和已经做的选择。状态每变一次就重新问一遍主进程，选过的按路径留着。
let conflictFiles = [];
let conflictChoices = new Map();
let conflictSignature = '';
let conflictToken = 0;

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
  const readOnly = Boolean((externalData?.settings || baselineSettings).readOnly);
  abortGitButton.disabled = locked || readOnly || syncStatus.phase === 'running';
  if (resolveButton) resolveButton.disabled = locked || readOnly || syncStatus.phase === 'running' || !conflictsReady();
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
    syncStatusTitle.textContent = recovery.unmergedCount > 0 && recovery.abortable
      ? `同步遇到冲突，等你处理（Git ${labels[recovery.kind] || '操作'}）`
      : `Git ${labels[recovery.kind] || '操作'} 需要恢复`;
    syncStatusDetail.textContent = recovery.abortable
      ? `有 ${recovery.unmergedCount} 个文件两边都改过，同步已暂停。浏览和复习可以继续。可以在下面逐个选保留哪一边；也可以中止，回到同步前的状态（这期间保存的笔记修改会从正文撤掉并存进「历史与草稿」）。`
      : `有 ${recovery.unmergedCount} 个未合并文件，同步已暂停。这种状态应用里无法中止，请用 Git 工具处理后重启应用。`;
    abortGitButton.hidden = !recovery.abortable;
  } else if (syncStatus.phase === 'disabled') {
    syncStatusTitle.textContent = '自动同步已关闭';
    syncStatusDetail.textContent = '本地编辑和索引不受影响。';
    abortGitButton.hidden = true;
  } else if (syncStatus.phase === 'running') {
    syncStatusTitle.textContent = 'Git 同步正在进行';
    syncStatusDetail.textContent = syncStatus.operation === 'abort' ? '正在中止当前 Git 操作…' : syncStatus.operation === 'resolve' ? '正在按选择解决冲突…' : '请稍候，本地内容仍可继续使用。';
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
  refreshConflicts();
  updateActions();
}

function pendingConflicts() {
  return conflictFiles.filter(file => !file.auto && !conflictChoices.has(file.path));
}

function conflictsReady() {
  return conflictFiles.length > 0 && pendingConflicts().length === 0;
}

function hideConflicts() {
  conflictToken += 1;
  conflictFiles = [];
  conflictChoices = new Map();
  conflictSignature = '';
  if (conflictPanel) conflictPanel.hidden = true;
}

function refreshConflicts() {
  if (!conflictPanel || typeof api.listGitConflicts !== 'function') return;
  if (!syncStatus.recovery) { hideConflicts(); return; }
  // 正在处理时列表先留着不动，结束后状态会再变一次。
  if (syncStatus.phase === 'running') return;
  const token = ++conflictToken;
  api.listGitConflicts().then(result => {
    if (token !== conflictToken) return;
    if (!result || !result.resolvable) { hideConflicts(); updateActions(); return; }
    showConflicts(result.files);
  }).catch(() => {
    if (token === conflictToken) { hideConflicts(); updateActions(); }
  });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function conflictOption(file, index, value, label) {
  const wrapper = element('label', 'conflict-option');
  const input = element('input');
  input.type = 'radio';
  input.name = `conflict-${index}`;
  input.value = value;
  input.checked = conflictChoices.get(file.path) === value;
  input.addEventListener('change', () => {
    if (!input.checked) return;
    conflictChoices.set(file.path, value);
    updateConflictProgress();
    updateActions();
  });
  wrapper.append(input, element('span', '', label));
  return wrapper;
}

function conflictDiff(diff) {
  const details = element('details', 'conflict-diff');
  details.append(element('summary', '', `看两边差在哪里（本机比远端多 ${diff.added} 行、少 ${diff.removed} 行）`));
  const box = element('div', 'conflict-diff-body');
  for (const hunk of diff.hunks) {
    if (hunk.type === 'skip') { box.append(element('p', 'diff-skip', `两边一样的 ${hunk.count} 行`)); continue; }
    for (const row of hunk.rows) {
      const line = element('div', `diff-row is-${row.type}`);
      line.append(element('span', 'diff-sign', row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''), element('span', 'diff-text', row.text));
      box.append(line);
    }
  }
  if (diff.truncated) box.append(element('p', 'diff-skip', '后面还有，只显示了前一部分'));
  details.append(box, element('p', 'conflict-legend', '－ 只有远端有的行　＋ 只有本机有的行'));
  return details;
}

function showConflicts(files) {
  const signature = JSON.stringify(files.map(file => [file.path, file.remote, file.local, file.current, file.auto, file.diff?.added, file.diff?.removed]));
  conflictFiles = files;
  const known = new Set(files.map(file => file.path));
  for (const path of [...conflictChoices.keys()]) if (!known.has(path)) conflictChoices.delete(path);
  for (const file of files) if (conflictChoices.get(file.path) === 'current' && !file.current) conflictChoices.delete(file.path);
  conflictPanel.hidden = false;
  if (signature !== conflictSignature) {
    conflictSignature = signature;
    conflictList.replaceChildren(...files.map((file, index) => {
      const item = element('li', 'conflict-file');
      item.append(element('code', 'conflict-path', file.path));
      if (file.auto) {
        item.append(element('p', 'conflict-auto', '复习记录两边都保留，不用选。'));
        return item;
      }
      const options = element('div', 'conflict-options');
      options.setAttribute('role', 'radiogroup');
      options.setAttribute('aria-label', `${file.path} 保留哪一边`);
      options.append(
        conflictOption(file, index, 'remote', file.remote ? '用远端的' : '跟远端一样删掉'),
        conflictOption(file, index, 'local', file.local ? '用本机的' : '跟本机一样删掉')
      );
      if (file.current) options.append(conflictOption(file, index, 'current', '用现在文件里的内容（已经手工改好）'));
      item.append(options);
      if (file.diff) item.append(conflictDiff(file.diff));
      return item;
    }));
  }
  updateConflictProgress();
  updateActions();
}

function updateConflictProgress() {
  if (!conflictProgress) return;
  const left = pendingConflicts().length;
  conflictProgress.textContent = left ? `还有 ${left} 个文件没选` : '';
}

function chooseAllConflicts(side) {
  for (const file of conflictFiles) if (!file.auto) conflictChoices.set(file.path, side);
  for (const input of conflictList.querySelectorAll('input[type="radio"]')) input.checked = input.value === side;
  updateConflictProgress();
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
      // 撞上冲突时 Git 的原话是一大段英文提示；上面的状态栏和冲突列表已经说清楚该做什么。
      const detail = result.blocked === 'recovery-required' ? 'Git 需要先恢复，未执行同步。'
        : result.recovery ? `同步停在了冲突上：有 ${result.recovery.unmergedCount} 个文件两边都改过，请在上面选保留哪一边。`
        : `同步失败：${result.error || '未知错误'}`;
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
    else {
      const preserved = Array.isArray(result.preserved) ? result.preserved : [];
      const notes = preserved.filter(item => item.kind === 'history').length;
      const reviews = preserved.filter(item => item.kind === 'review').reduce((sum, item) => sum + (item.count || 0), 0);
      const kept = [
        notes ? `${notes} 个文件的未提交修改已存进「历史与草稿」` : '',
        reviews ? `${reviews} 条复习记录已补回` : ''
      ].filter(Boolean).join('，');
      settleOperation(`Git 操作已中止${kept ? `；${kept}` : ''}。请检查资料库后手动同步。`);
    }
  } catch (error) {
    failOperation(error);
  }
});

document.getElementById('conflict-all-remote')?.addEventListener('click', () => chooseAllConflicts('remote'));
document.getElementById('conflict-all-local')?.addEventListener('click', () => chooseAllConflicts('local'));
resolveButton?.addEventListener('click', async () => {
  if (activeOperation || !conflictsReady()) return;
  const choices = Object.fromEntries(conflictChoices);
  beginOperation('resolve', '正在按选择解决冲突…');
  try {
    const result = await api.resolveGitConflicts(choices);
    if (result.ok === false) throw new Error(result.error || '冲突没有解决。');
    const kept = Array.isArray(result.preserved) ? result.preserved.length : 0;
    const tail = kept ? `没采用的 ${kept} 个文件版本已存进「历史与草稿」。` : '';
    settleOperation(result.more
      ? `这一处已经解决；后面的本机提交还有冲突，请继续选。${tail}`
      : `冲突已解决，正在把结果同步上去。${tail}`);
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
