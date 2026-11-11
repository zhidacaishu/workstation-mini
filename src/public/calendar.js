(() => {
  const form = document.querySelector('[data-calendar-form]');
  if (!form) return;
  const text = form.elements.text;
  const hash = form.elements.expectedHash;
  const status = form.querySelector('[data-calendar-status]');
  const save = form.querySelector('button[type="submit"]');
  const day = document.querySelector('[data-calendar-day="' + form.elements.date.value + '"]');
  const preview = day.querySelector('[data-calendar-preview]');
  const noteLink = document.querySelector('[data-calendar-note-link]');
  const originalLabel = day.getAttribute('aria-label').replace('，有备注', '');
  let baseline = text.value;
  let saving = false;
  window.workstationCalendar = { hasUnsavedChanges: () => saving || text.value !== baseline };

  text.addEventListener('input', () => {
    status.textContent = text.value === baseline ? '' : '有未保存的更改';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
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
      preview.textContent = submitted.trim();
      day.setAttribute('aria-label', originalLabel + (submitted.trim() ? '，有备注' : ''));
      noteLink.hidden = !result.hash;
      status.textContent = text.value !== baseline ? '已保存；还有未保存的更改' : result.hash ? '已保存' : '已清空';
    } catch (error) {
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
