(() => {
  const dialog = document.getElementById('onboarding');
  const templates = [...document.querySelectorAll('template[data-guide-step]')];
  if (!dialog || !templates.length) return;
  const api = window.workstationDesktop;
  const next = dialog.querySelector('[data-guide-next]');
  const prev = dialog.querySelector('[data-guide-prev]');
  const skip = dialog.querySelector('[data-guide-skip]');
  const body = dialog.querySelector('[data-guide-body]');
  const title = dialog.querySelector('#guide-title');
  const error = dialog.querySelector('[data-guide-error]');
  let state = { step: 0, status: 'active' }, context = {}, busy = false, opener;
  let loadFailed = false;
  const loaded = api ? api.getGuide().then(value => { context = value; state = value; }).catch(() => { loadFailed = true; }) : Promise.resolve();
  function message(text) { error.textContent = text; error.hidden = !text; }
  function render() {
    const template = templates[state.step] || templates[0];
    title.textContent = template.dataset.title;
    dialog.querySelector('#guide-description').textContent = template.dataset.description;
    body.replaceChildren(template.content.cloneNode(true));
    dialog.querySelector('[data-guide-progress]').textContent = (state.step + 1) + ' / ' + templates.length;
    dialog.querySelector('[data-guide-meter]').style.width = ((state.step + 1) / templates.length * 100) + '%';
    prev.disabled = state.step === 0;
    next.textContent = state.step === templates.length - 1 ? '完成指引' : '下一步';
    const readOnly = body.querySelector('[data-guide-readonly]');
    if (readOnly) readOnly.hidden = !context.readOnly;
    const commands = body.querySelector('[data-guide-git-commands]');
    // POSIX quoting works in macOS Terminal and Git Bash, including apostrophes.
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    if (commands) commands.textContent = 'cd -- ' + quote((context.vaultDir || '/你的资料库目录').replaceAll('\\', '/'))
      + '\ngit --version\ngit init\ngit config user.name "你的名字"\ngit config user.email "你的邮箱"\ngit status';
    const sync = body.querySelector('[data-guide-sync-state]');
    if (sync) sync.textContent = context.syncEnabled ? '当前设置已启用自动同步；请在设置中查看本次结果。' : '当前自动同步尚未开启，是否开启由你在设置中决定。';
    title.focus();
  }
  async function save(value) {
    if (api) await api.saveGuide(value);
    state = value;
  }
  async function change(value, close = false) {
    if (busy) return;
    busy = true;
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    message('');
    try {
      await save(value);
      if (close) dialog.close();
      else render();
    } catch (e) { message('无法保存指引进度：' + e.message + '。请重试。'); }
    finally {
      busy = false;
      for (const button of dialog.querySelectorAll('button')) button.disabled = false;
      prev.disabled = state.step === 0;
    }
  }
  async function open(restart) {
    await loaded;
    if (dialog.open) return;
    if (document.querySelector('dialog[open]')) return;
    opener = document.activeElement;
    if (restart) state = { step: 0, status: 'active' };
    dialog.showModal();
    render();
    if (restart) await change(state);
  }
  next.addEventListener('click', () => state.step === templates.length - 1
    ? change({ step: state.step, status: 'completed' }, true)
    : change({ step: state.step + 1, status: 'active' }));
  prev.addEventListener('click', () => change({ step: Math.max(0, state.step - 1), status: 'active' }));
  const dismiss = () => change({ step: state.step, status: 'skipped' }, true);
  skip.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { message(''); if (opener?.isConnected) opener.focus(); });
  document.querySelector('[data-guide-open]')?.addEventListener('click', () => open(true));
  window.addEventListener('focus', async () => {
    if (!api || !dialog.open) return;
    try {
      context = await api.getGuide();
      const sync = body.querySelector('[data-guide-sync-state]');
      if (sync) sync.textContent = context.syncEnabled ? '当前设置已启用自动同步；请在设置中查看本次结果。' : '当前自动同步尚未开启，是否开启由你在设置中决定。';
    } catch {}
  });
  async function settings() {
    try {
      if (api) await api.openSettings();
      else message('请从应用菜单或系统托盘打开“设置”。');
    } catch (e) { message(e.message); }
  }
  body.addEventListener('click', event => { if (event.target.closest('[data-guide-settings]')) settings(); });
  const settingsEntry = document.querySelector('[data-desktop-settings]');
  if (api && settingsEntry) { settingsEntry.hidden = false; settingsEntry.addEventListener('click', settings); }
  loaded.then(() => {
    // An automatic tour never interrupts editing or an in-progress review.
    const route = document.body.dataset.pagePath || location.pathname;
    if (api && !loadFailed && state.status === 'active' && !/^\/(edit|new|review)(\/|$)/.test(route)) open(false);
  });
})();
