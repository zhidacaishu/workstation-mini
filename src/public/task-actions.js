(() => {
  // 今日页的待办只有一个勾选框：勾上即提交，改期留给计划页。
  document.addEventListener('change', event => {
    const toggle = event.target;
    if (!toggle?.matches?.('[data-task-toggle]')) return;
    const form = toggle.form;
    if (form?.matches?.('[data-task-quick]')) form.requestSubmit();
  });

  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-task-form]')) return;
    event.preventDefault();
    if (form.dataset.busy === '1') return;
    if (window.workstationCalendar?.hasUnsavedChanges()) {
      const done = form.querySelector('[name="done"]');
      done.checked = done.defaultChecked;
      window.workstationUI.notify('请先保存当天备注，再更新待办。', { type: 'info' });
      return;
    }
    const plan = window.workstationPlan;
    if (plan?.hasPendingUpdate() || plan?.hasUnsavedChanges(form)) {
      const done = form.querySelector('[name="done"]');
      done.checked = done.defaultChecked;
      window.workstationUI.notify(plan.hasPendingUpdate()
        ? '正在保存其他待办，请稍候再试。'
        : '请先保存或还原其他待办的日期，再更新此待办。', { type: 'info' });
      return;
    }
    // 成功后会刷新整个计划页：等待期间统一锁定会受刷新影响的输入，
    // 避免另一行日期或当天备注在请求途中产生新改动。
    const fields = plan
      ? [...document.querySelectorAll('[data-task-form] input, [data-task-form] button, [data-calendar-form] textarea, [data-calendar-form] button')]
      : [...form.elements];
    const disabledBefore = fields.map(field => field.disabled);
    const data = Object.fromEntries(new FormData(form));
    data.done = form.querySelector('[name="done"]').checked;
    data.line = Number(data.line);
    form.dataset.busy = '1';
    form.setAttribute('aria-busy', 'true');
    fields.forEach(field => { field.disabled = true; });
    try {
      await window.workstationUI.requestJson(form.action, { method: 'POST', json: data });
      // Reload all derived counts, date ordering and other tasks in the same note.
      plan?.saved(form);
      window.location.reload();
    } catch (error) {
      const toggle = form.querySelector('[data-task-toggle]');
      if (toggle) toggle.checked = toggle.defaultChecked;
      window.workstationUI.notify(error.message, { type: 'error' });
      fields.forEach((field, index) => { field.disabled = disabledBefore[index]; });
      form.dataset.busy = '0';
      form.removeAttribute('aria-busy');
    }
  });
})();
