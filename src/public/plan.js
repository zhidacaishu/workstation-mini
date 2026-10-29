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
    const baseline = date.value;
    dates.set(form, baseline);
    date.addEventListener('input', () => {
      form.classList.toggle('is-edited', date.value !== baseline);
    });
    form.querySelector('[data-task-toggle]').addEventListener('change', () => form.requestSubmit());
  }
})();
