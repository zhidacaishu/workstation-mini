const api = window.workstationRecovery;
const body = document.body;
const form = document.getElementById('recovery-form');
const firstRun = document.getElementById('first-run');
const sourcePanel = document.getElementById('source-panel');
const destinationPanel = document.getElementById('destination-panel');
const statusPanel = document.getElementById('status-panel');
const phaseLabel = document.getElementById('phase-label');
const title = document.getElementById('title');
const outcome = document.getElementById('outcome');
const remoteInput = document.getElementById('remote');
const remoteResult = document.getElementById('remote-result');
const localSourcePath = document.getElementById('local-source-path');
const destinationParent = document.getElementById('destination-parent');
const directoryName = document.getElementById('directory-name');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');
const currentPath = document.getElementById('current-path');
const progress = document.getElementById('progress');
const progressBar = progress.querySelector('span');
const startButton = document.getElementById('start');
const cancelButton = document.getElementById('cancel');
const retryButton = document.getElementById('retry');
const activateButton = document.getElementById('activate');
const discardButton = document.getElementById('discard-staging');
const openCurrentVaultButton = document.getElementById('open-current-vault');
const dismissResidueButton = document.getElementById('dismiss-residue');
const actionNote = document.getElementById('action-note');

let state = { phase: 'idle', mode: 'restore' };
let localSourceSelected = false;
let destinationSelected = false;
let inspectedRemote = '';
let operationPending = false;

const PHASE_COPY = {
  idle: ['准备恢复', '把资料带回新工作区', '选择来源和一个全新的目标目录。'],
  'inspecting-source': ['检查来源', '确认远端可以读取', '系统 Git 正在验证远端和默认分支。'],
  'preparing-staging': ['建立暂存区', '准备应用拥有的恢复目录', '最终目标在此阶段仍不会出现。'],
  cloning: ['复制文本', '从 Git 远端完整克隆', '这一步只读取远端，不提交也不推送。'],
  copying: ['复制文本', '复制本地备份', '来源目录保持原样。'],
  'validating-git': ['检查 Git', '确认克隆结果可安全使用', '正在检查分支、上游、远端和工作区状态。'],
  'validating-vault': ['检查结构', '确认资料库结构', '正在验证 Markdown 与资料库目录。'],
  'building-index': ['重建索引', '从 Markdown 建立新索引', '坏文件会单独报告，不会抹掉已成功的结果。'],
  'ready-to-activate': ['等待切换', '恢复结果已经可以检查', '确认报告后再切换到新资料库。'],
  activating: ['正在切换', '短暂切换到新资料库', '此阶段不能取消，请不要关闭应用。'],
  completed: ['恢复完成', '新资料库已经打开', '自动 Git 同步仍关闭，请检查设置后再手工开启。'],
  cancelling: ['正在取消', '清理应用暂存区', '来源和最终目标不会被删除。'],
  cancelled: ['已取消', '恢复没有生效', '可以重新选择来源和目标。'],
  residue: ['发现残留', '上次恢复未完整结束', '不会自动续跑；可检查后安全清理应用拥有的暂存区。'],
  failed: ['需要处理', '恢复没有完成', '请按下方建议修复后重试。']
};

// 首次启动还没有资料库，谈不上「恢复」：这时显示欢迎页（body[data-view="welcome"]），
// 不出现恢复阶段栏；选了「从备份恢复」之后才换成恢复界面。
const WELCOME_COPY = ['首次启动', '欢迎使用科研工作台', '还没有打开资料库'];

function isWelcome() {
  return state.mode === 'first-run' && ['idle', 'cancelled', 'failed'].includes(state.phase || 'idle');
}

const STAGE_PHASES = {
  source: ['idle', 'inspecting-source', 'cloning', 'copying', 'validating-git', 'validating-vault'],
  destination: ['preparing-staging'],
  index: ['building-index'],
  activate: ['ready-to-activate', 'activating', 'completed', 'failed', 'residue']
};

function sourceKind() {
  return form.elements.sourceKind.value;
}

function setPending(value) {
  operationPending = value;
  form.toggleAttribute('aria-busy', value);
  renderControls();
}

function renderStages(phase) {
  const items = [...document.querySelectorAll('#stages li')];
  const order = Object.keys(STAGE_PHASES);
  let currentIndex = order.findIndex(stage => STAGE_PHASES[stage].includes(phase));
  if (currentIndex < 0) currentIndex = 0;
  for (const item of items) {
    const index = order.indexOf(item.dataset.stage);
    item.classList.toggle('is-active', index === currentIndex);
    item.classList.toggle('is-complete', index < currentIndex || phase === 'completed');
    if (index === currentIndex) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
}

function renderList(id, entries, total, formatter) {
  const block = document.getElementById(id);
  const list = block.querySelector('ul');
  const totalLine = block.querySelector('.report-total');
  list.textContent = '';
  for (const entry of entries || []) {
    const item = document.createElement('li');
    item.textContent = formatter(entry);
    list.appendChild(item);
  }
  const count = Number(total || entries?.length || 0);
  block.hidden = count === 0;
  totalLine.textContent = count > (entries?.length || 0)
    ? `共 ${count} 项；这里只显示前 ${entries.length} 项。`
    : `共 ${count} 项。`;
}

function renderWarnings(warnings = []) {
  const block = document.getElementById('warnings');
  const list = block.querySelector('ul');
  list.textContent = '';
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = warning.message || warning.code;
    list.appendChild(item);
  }
  block.hidden = warnings.length === 0;
}

function renderControls() {
  const phase = state.phase || 'idle';
  const setup = ['idle', 'cancelled', 'failed'].includes(phase) && !state.residue;
  const remote = remoteInput.value.trim();
  const sourceReady = sourceKind() === 'git' ? Boolean(remote) && remote === inspectedRemote : localSourceSelected;
  const canStart = sourceReady && destinationSelected && directoryName.value.trim();

  startButton.hidden = !setup || isWelcome();
  startButton.disabled = operationPending || !canStart;
  startButton.textContent = '开始复制与索引验证';
  cancelButton.hidden = !state.canCancel;
  cancelButton.disabled = false;
  retryButton.hidden = !state.canRetry;
  retryButton.disabled = operationPending;
  activateButton.hidden = !state.canActivate;
  activateButton.disabled = operationPending;
  discardButton.hidden = phase !== 'residue' || state.residue?.owned !== true;
  discardButton.disabled = operationPending;
  openCurrentVaultButton.hidden = phase !== 'residue' || state.residue?.owned === true || !state.canOpenCurrentVault;
  openCurrentVaultButton.disabled = operationPending;
  if (dismissResidueButton) {
    dismissResidueButton.hidden = phase !== 'residue' || state.residue?.owned === true;
    dismissResidueButton.disabled = operationPending;
  }

  for (const control of form.querySelectorAll('input, button')) {
    if ([cancelButton, retryButton, activateButton, discardButton, openCurrentVaultButton, dismissResidueButton].includes(control)) continue;
    if (!setup || operationPending) control.disabled = true;
  }
  if (setup && !operationPending) {
    for (const control of form.querySelectorAll('input, button')) control.disabled = false;
    startButton.disabled = !canStart;
  }
}

function render(next = {}) {
  const nextMode = next.mode || 'restore';
  const nextPhase = next.phase || 'idle';
  const resetSelections = nextMode !== state.mode
    || nextPhase === 'cancelled'
    || (nextPhase === 'idle' && ['completed', 'residue'].includes(state.phase));
  if (resetSelections) {
    localSourceSelected = false;
    destinationSelected = false;
    localSourcePath.textContent = '尚未选择本地备份目录';
    destinationParent.textContent = '尚未选择新资料库所在位置';
    remoteResult.textContent = '';
    inspectedRemote = '';
  }
  state = { mode: 'restore', phase: 'idle', ...next };
  const phase = state.phase;
  const copy = PHASE_COPY[phase] || PHASE_COPY.failed;
  const welcome = isWelcome();
  body.dataset.phase = phase;
  body.dataset.view = welcome ? 'welcome' : 'recovery';
  document.title = state.mode === 'first-run' ? '开始使用科研工作台' : '恢复科研工作台资料库';
  phaseLabel.textContent = welcome ? WELCOME_COPY[0] : copy[0];
  title.textContent = welcome ? WELCOME_COPY[1] : copy[1];
  statusTitle.textContent = welcome ? WELCOME_COPY[2] : copy[1];
  // 欢迎页上出错时，下面的红框已经写了原因，这里不再重复一遍。
  statusMessage.textContent = welcome
    ? (state.error ? '' : state.reason || '')
    : state.error?.message || state.reason || copy[2];
  renderStages(phase);

  const setup = ['idle', 'cancelled', 'failed'].includes(phase) && !state.residue;
  firstRun.hidden = !welcome;
  // 欢迎页只在出错或被拦下时露出表单，而且只露出说明原因的那一块：
  // 恢复来源和目标目录与「创建」「打开」无关。
  form.hidden = welcome && !state.error && !state.reason;
  sourcePanel.hidden = !setup || welcome;
  destinationPanel.hidden = !setup || welcome;
  statusPanel.hidden = setup && !state.error && !state.reason;

  const unit = state.progress?.unit || '';
  const current = Number(state.progress?.current || 0);
  const total = Number(state.progress?.total || 0);
  const percent = total > 0 ? Math.min(100, Math.round(current / total * 100)) : 0;
  progress.setAttribute('aria-valuenow', String(percent));
  progress.setAttribute('aria-valuetext', total > 0 ? `${current} / ${total} ${unit}` : copy[2]);
  progressBar.style.width = `${percent}%`;
  currentPath.textContent = state.progress?.currentPath || '';
  currentPath.hidden = !currentPath.textContent;

  outcome.hidden = !state.outcome;
  outcome.textContent = state.outcome === 'complete' ? '完整恢复' : state.outcome === 'partial' ? '部分恢复' : '';
  renderWarnings(state.warnings || []);
  renderList('index-failures', state.indexFailures, state.indexFailureTotal, item => `${item.path} — ${item.reason || item.code}`);

  const fatal = document.getElementById('fatal-error');
  fatal.hidden = !state.error;
  if (state.error) {
    fatal.querySelector('strong').textContent = state.error.message || '恢复失败';
    fatal.querySelector('p').textContent = state.error.remediation || '检查来源和目标后重试。';
  }

  if (phase === 'ready-to-activate' && state.outcome === 'partial') {
    actionNote.textContent = '部分 Markdown 未建立索引；请复核报告后再切换。';
  } else if (phase === 'completed') {
    actionNote.textContent = '请复核设备名、Git 远端和本机设置，再手工启用同步。';
  } else if (phase === 'residue' && state.residue?.owned !== true) {
    actionNote.textContent = '此残留不属于当前应用会话，不能自动清理。检查过恢复目录后，可以「忽略这条记录」（不删除任何目录），下次启动就不会再停在这里。';
  } else {
    actionNote.textContent = '来源不会被修改；恢复期间不会写入 Git 远端。';
  }
  renderControls();
}

async function run(operation) {
  if (operationPending) return;
  setPending(true);
  try {
    const result = await operation();
    if (result) render(result);
  } catch (error) {
    try {
      const authoritative = await api.getState();
      render(authoritative.error || authoritative.phase === 'cancelled' ? authoritative : {
        ...authoritative,
        error: { message: error.message, remediation: '检查输入后重试。' }
      });
    } catch {
      render({ ...state, error: { message: error.message, remediation: '检查输入后重试。' } });
    }
  } finally {
    setPending(false);
  }
}

function toggleSource() {
  const git = sourceKind() === 'git';
  document.getElementById('git-source').hidden = !git;
  document.getElementById('local-source').hidden = git;
  renderControls();
}

form.addEventListener('change', event => {
  if (event.target.name === 'sourceKind') toggleSource();
  renderControls();
});
form.addEventListener('input', event => {
  if (event.target === remoteInput && remoteInput.value.trim() !== inspectedRemote) {
    remoteResult.textContent = '远端地址已更改，请重新检查。';
  }
  renderControls();
});

document.getElementById('inspect-remote').addEventListener('click', () => run(async () => {
  const remote = remoteInput.value.trim();
  inspectedRemote = '';
  const result = await api.inspectRemote(remote);
  inspectedRemote = remote;
  remoteResult.textContent = result?.message || '远端可以读取。';
  return result?.state || state;
}));

document.getElementById('choose-local-source').addEventListener('click', () => run(async () => {
  const result = await api.chooseLocalSource();
  if (result?.selected) {
    localSourceSelected = true;
    localSourcePath.textContent = result.display;
  }
  return result?.state || state;
}));

document.getElementById('choose-destination').addEventListener('click', () => run(async () => {
  const result = await api.chooseDestinationParent();
  if (result?.selected) {
    destinationSelected = true;
    destinationParent.textContent = result.display;
  }
  return result?.state || state;
}));

form.addEventListener('submit', event => {
  event.preventDefault();
  run(() => api.start({
    sourceKind: sourceKind(),
    remote: sourceKind() === 'git' ? remoteInput.value.trim() : undefined,
    directoryName: directoryName.value.trim()
  }));
});

cancelButton.addEventListener('click', async () => {
  if (!state.canCancel) return;
  cancelButton.disabled = true;
  try {
    const result = await api.cancel();
    if (result) render(result.state || result);
  } catch (error) {
    const authoritative = await api.getState().catch(() => null);
    if (authoritative) render(authoritative);
    else render({ ...state, error: { message: error.message, remediation: '检查恢复状态后重试。' } });
  }
});
retryButton.addEventListener('click', () => run(api.retryStage));
activateButton.addEventListener('click', () => run(api.activate));
discardButton.addEventListener('click', () => run(api.discardOwnedStaging));
openCurrentVaultButton.addEventListener('click', () => run(api.openCurrentVault));
dismissResidueButton?.addEventListener('click', () => {
  if (!window.confirm('只清除这条恢复记录，不会删除任何目录。确认已经检查过恢复目录了吗？')) return;
  run(api.dismissResidue);
});
document.getElementById('create-vault').addEventListener('click', () => run(api.createVault));
document.getElementById('open-existing-vault').addEventListener('click', () => run(api.openExistingVault));
document.getElementById('begin-restore').addEventListener('click', () => run(api.beginRestore));

api.onStateChanged(render);
api.getState().then(render).catch(error => render({ phase: 'failed', error: { message: error.message } }));
