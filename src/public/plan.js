(() => {
  const workspace = document.querySelector('[data-plan-view]');
  if (!workspace) return;
  // 上次用的是列表还是月历由服务端用 cookie 记住（见 calendarRoutes）：
  // 内部服务每次启动换端口，localStorage 按端口隔离，重启后就读不到了。

  const tasks = [...document.querySelectorAll('[data-plan-task]')];
  const dates = new Map();
  window.workstationPlan = {
    hasUnsavedChanges: exceptForm => tasks.some(form => form !== exceptForm
      && form.querySelector('[name="due"]').value !== dates.get(form)),
    hasPendingUpdate: () => tasks.some(form => form.dataset.busy === '1'),
    saved(form) {
      if (!dates.has(form)) return;
      dates.set(form, form.querySelector('[name="due"]').value);
      form.classList.remove('is-edited');
      form.dataset.busy = '0';
    }
  };
  window.addEventListener('beforeunload', event => {
    if (!window.workstationPlan.hasUnsavedChanges() && !window.workstationPlan.hasPendingUpdate()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  for (const form of tasks) {
    form.classList.add('is-enhanced');
    const date = form.querySelector('[name="due"]');
    const baseline = date.defaultValue;
    const reschedule = form.querySelector('.plan-task-reschedule');
    const summary = reschedule?.querySelector('summary');
    if (summary) {
      reschedule.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !reschedule.open) return;
        event.preventDefault();
        event.stopPropagation();
        reschedule.open = false;
        summary.focus();
      });
    }
    dates.set(form, baseline);
    const refreshDate = () => {
      form.classList.toggle('is-edited', date.value !== dates.get(form));
      if (summary) summary.textContent = date.value !== dates.get(form) ? '待保存' : '改期';
    };
    date.addEventListener('input', refreshDate);
    date.addEventListener('change', refreshDate);
    // 用户可能在defer脚本就绪前已编辑日期，服务端value属性才是已保存的基线。
    refreshDate();
    form.querySelector('[data-task-toggle]').addEventListener('change', () => form.requestSubmit());
  }
})();
