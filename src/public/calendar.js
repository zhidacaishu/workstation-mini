(() => {
  const form = document.querySelector('[data-calendar-form]');
  if (!form) return;
  const text = form.elements.text;
  const hash = form.elements.expectedHash;
  const status = form.querySelector('[data-calendar-status]');
  const save = form.querySelector('button[type="submit"]');
  const taskSection = document.querySelector('[aria-labelledby="plan-day-tasks-title"]');
  const plan = window.workstationPlan;
  // 重新读取服务端排好的日期、行号和版本。保留编辑框，等待期间仍可继续写备注。
  async function refreshCalendar() {
    const query = new URLSearchParams({ view: 'calendar', month: form.elements.month.value, date: form.elements.date.value });
    const response = await fetch('/plan?' + query, { cache: 'no-store' });
    if (!response.ok) throw new Error('月历读取失败');
    const fresh = new DOMParser().parseFromString(await response.text(), 'text/html');
    const selectors = ['.plan-calendar', '[aria-labelledby="plan-day-tasks-title"]', '[data-nav="plan"]'];
    const replacements = selectors.map(selector => [document.querySelector(selector), fresh.querySelector(selector)]);
    if (replacements.some(([current, next]) => !current || !next)) throw new Error('月历内容不完整');
    for (const [current, next] of replacements) current.replaceChildren(...next.childNodes);
    plan.refreshTasks();
  }
  let baseline = text.value;
  let saving = false;
  window.workstationCalendar = { hasUnsavedChanges: () => saving || text.value !== baseline };

  text.addEventListener('input', () => {
    status.textContent = text.value === baseline ? '' : '有未保存的更改';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || plan.hasPendingUpdate()) return;
    if (plan.hasUnsavedChanges()) {
      status.textContent = '请先还原待办的日期，再保存备注。';
      return;
    }
    const wasInert = taskSection.inert;
    taskSection.inert = true;
    saving = true;
    save.disabled = true;
    status.textContent = '正在保存…';
    const submitted = text.value;
    try {
      const result = await window.workstationUI.requestJson(form.action, {
        method: 'POST', body: new URLSearchParams(new FormData(form))
      });
      hash.value = result.hash;
      baseline = submitted;
      document.querySelector('[data-calendar-note-link]').hidden = !result.hash;
      try {
        await refreshCalendar();
      } catch {
        status.textContent = '备注已保存，事项未能刷新。请重新打开月历。';
        return;
      }
      taskSection.inert = false;
      status.textContent = text.value !== baseline ? '已保存；还有未保存的更改' : result.hash ? '已保存' : '已清空';
    } catch (error) {
      taskSection.inert = wasInert;
      status.textContent = '保存失败：' + error.message;
    } finally {
      saving = false;
      save.disabled = false;
    }
  });
  window.addEventListener('beforeunload', event => {
    if (!saving && text.value === baseline) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
