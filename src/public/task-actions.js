(() => {
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
    const fields = [...form.elements];
    const data = Object.fromEntries(new FormData(form));
    data.done = form.querySelector('[name="done"]').checked;
    data.line = Number(data.line);
    form.dataset.busy = '1';
    form.setAttribute('aria-busy', 'true');
    fields.forEach(field => { field.disabled = true; });
    try {
      await window.workstationUI.requestJson(form.action, { method: 'POST', json: data });
      // Reload all derived counts, date ordering and other tasks in the same note.
      window.location.reload();
    } catch (error) {
      const toggle = form.querySelector('[data-task-toggle]');
      if (toggle) toggle.checked = toggle.defaultChecked;
      window.workstationUI.notify(error.message, { type: 'error' });
      fields.forEach(field => { field.disabled = false; });
      form.dataset.busy = '0';
      form.removeAttribute('aria-busy');
    }
  });
})();
