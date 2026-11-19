(() => {
  const workspace = document.querySelector('.plan-calendar-layout');
  if (!workspace) return;
  const plan = window.workstationPlan;
  const noteForm = () => workspace.querySelector('[data-calendar-form]');
  const noteDirty = () => {
    const text = noteForm()?.elements.text;
    return Boolean(text && text.value !== text.defaultValue);
  };
  let saving = false;
  let editVersion = 0;
  let pending;
  const navigation = window.navigation;
  let renderedEntry = navigation?.currentEntry;
  const currentDateUrl = () => document.querySelector('.plan-view-switch [aria-current="page"]').href;

  async function readCalendar(url, signal) {
    const response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('月历读取失败');
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const parts = {};
    for (const [name, selector] of Object.entries({
      header: '.plan-header', calendar: '.plan-calendar', detail: '.plan-day-detail',
      tasks: '[aria-labelledby="plan-day-tasks-title"]', badge: '[data-nav="plan"]'
    })) {
      parts[name] = page.querySelector(selector);
      if (!parts[name]) throw new Error('月历内容不完整');
    }
    parts.date = parts.calendar.querySelector('[data-calendar-day][aria-current="date"]')?.dataset.calendarDay;
    if (!parts.date || !parts.calendar.querySelector('.calgrid')) throw new Error('月历内容不完整');
    return parts;
  }

  function render(parts, { keepNote = false } = {}) {
    const calendar = workspace.querySelector('.plan-calendar');
    const active = document.activeElement;
    const monthButtons = [...document.querySelectorAll('.plan-month-nav a')];
    const monthButtonIndex = monthButtons.indexOf(active);
    const wasInDay = workspace.contains(active);
    const sameMonth = parts.calendar.dataset.month === calendar.dataset.month;
    const newDay = parts.date;
    // 通常同月只有两个格子的选中态变化。保留网格、滚动位置和键盘焦点。
    for (const cell of calendar.querySelectorAll('[aria-current="date"], [data-calendar-day="' + newDay + '"]')) {
      const selected = cell.dataset.calendarDay === newDay;
      cell.classList.toggle('is-selected', selected);
      if (selected) cell.setAttribute('aria-current', 'date');
      else cell.removeAttribute('aria-current');
    }
    if (!calendar.isEqualNode(parts.calendar)) {
      const top = calendar.querySelector('.calgrid').scrollTop;
      calendar.replaceWith(parts.calendar);
      if (sameMonth) parts.calendar.querySelector('.calgrid').scrollTop = top;
    }
    const header = document.querySelector('.plan-header');
    if (!header.isEqualNode(parts.header)) header.replaceWith(parts.header);
    const badge = document.querySelector('[data-nav="plan"]');
    if (!badge.isEqualNode(parts.badge)) badge.replaceChildren(...parts.badge.childNodes);
    if (keepNote) workspace.querySelector('[aria-labelledby="plan-day-tasks-title"]').replaceWith(parts.tasks);
    else workspace.querySelector('.plan-day-detail').replaceWith(parts.detail);
    plan.refreshTasks();
    if (!active.isConnected) {
      const target = monthButtonIndex >= 0 ? document.querySelectorAll('.plan-month-nav a')[monthButtonIndex]
        : wasInDay ? workspace.querySelector('[aria-current="date"]') : null;
      target?.focus({ preventScroll: true });
      if (!sameMonth && target?.matches('[data-calendar-day]')) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant', container: 'nearest' });
      }
    }
  }

  function returnToRenderedEntry() {
    if (navigation.currentEntry.key !== renderedEntry.key) {
      navigation.traverseTo(renderedEntry.key).finished.catch(() => {});
    }
  }

  async function selectDate(url, traversing) {
    pending?.abort();
    const request = new AbortController();
    pending = request;
    if (traversing && url.split('#')[0] === renderedEntry.url.split('#')[0]) {
      renderedEntry = navigation.currentEntry;
      return;
    }
    if (!traversing && url === currentDateUrl()) {
      returnToRenderedEntry();
      return;
    }
    const revision = editVersion;
    try {
      if (saving || plan.hasPendingUpdate()) throw new Error('正在保存，请稍后切换日期。');
      const parts = await readCalendar(url, request.signal);
      if (request.signal.aborted) return;
      // “今天”和月份链接由服务端按本机日期解析，同一天的不同地址也不应丢弃输入。
      if (parts.date === workspace.querySelector('[aria-current="date"]').dataset.calendarDay
        && parts.calendar.dataset.month === workspace.querySelector('.plan-calendar').dataset.month) {
        if (traversing) renderedEntry = navigation.currentEntry;
        else returnToRenderedEntry();
        return;
      }
      if (editVersion !== revision || saving || plan.hasPendingUpdate()) throw new Error('当天内容有新修改，已保留在当前日期。');
      if (noteDirty() || plan.hasUnsavedChanges()) {
        const leave = await window.workstationDialog.confirm('放弃未保存的修改？', '切换日期将放弃当天未保存的备注或待办改期。', '切换日期');
        if (request.signal.aborted) return;
        if (!leave) { returnToRenderedEntry(); return; }
      }
      render(parts);
      if (!traversing && url !== location.href) history.pushState(null, '', url);
      renderedEntry = navigation.currentEntry;
      window.workstationNavigation?.remember();
    } catch (error) {
      if (request.signal.aborted) return;
      returnToRenderedEntry();
      window.workstationUI.notify(error.message, { type: 'error' });
    }
  }

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('[data-calendar-day], .plan-month-nav a, .plan-view-switch [aria-current="page"]');
    if (!link || !renderedEntry) return;
    event.preventDefault();
    selectDate(link.href, false);
  });
  window.addEventListener('popstate', () => {
    if (renderedEntry) selectDate(location.href, true);
  });
  window.addEventListener('pagehide', () => pending?.abort());

  workspace.addEventListener('input', event => {
    editVersion++;
    if (event.target.matches('#calendar-note')) {
      noteForm().querySelector('[data-calendar-status]').textContent = noteDirty() ? '有未保存的更改' : '';
    }
  });
  workspace.addEventListener('submit', () => { editVersion++; }, true);
  window.workstationCalendar = {
    hasUnsavedChanges: () => saving || noteDirty(),
    refreshAfterTask: async () => render(await readCalendar(currentDateUrl()))
  };

  workspace.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-calendar-form]')) return;
    event.preventDefault();
    if (saving || plan.hasPendingUpdate()) return;
    const status = form.querySelector('[data-calendar-status]');
    if (plan.hasUnsavedChanges()) {
      status.textContent = '请先还原待办的日期，再保存备注。';
      return;
    }
    const taskSection = workspace.querySelector('[aria-labelledby="plan-day-tasks-title"]');
    const text = form.elements.text;
    const submitted = text.value;
    const save = form.querySelector('button[type="submit"]');
    taskSection.inert = true;
    saving = true;
    save.disabled = true;
    status.textContent = '正在保存…';
    try {
      const result = await window.workstationUI.requestJson(form.action, {
        method: 'POST', body: new URLSearchParams(new FormData(form))
      });
      form.elements.expectedHash.value = result.hash;
      text.defaultValue = submitted;
      workspace.querySelector('[data-calendar-note-link]').hidden = !result.hash;
      try {
        render(await readCalendar(currentDateUrl()), { keepNote: true });
      } catch {
        status.textContent = '备注已保存，事项未能刷新。请重新打开月历。';
        return;
      }
      status.textContent = noteDirty() ? '已保存；还有未保存的更改' : result.hash ? '已保存' : '已清空';
    } catch (error) {
      status.textContent = '保存失败：' + error.message;
    } finally {
      taskSection.inert = false;
      saving = false;
      save.disabled = false;
    }
  });
  window.addEventListener('beforeunload', event => {
    if (!saving && !noteDirty()) return;
    if (window.workstationDialog?.mayLeave(event)) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
