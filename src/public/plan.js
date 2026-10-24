(() => {
  const workspace = document.querySelector('[data-plan-view]');
  if (!workspace) return;
  const url = new URL(window.location.href);
  const key = 'workstation-plan-view';
  try {
    const preferred = localStorage.getItem(key);
    if (url.pathname === '/plan' && !url.search && preferred === 'calendar') {
      url.searchParams.set('view', preferred);
      window.location.replace(url.href);
      return;
    }
    localStorage.setItem(key, workspace.dataset.planView);
  } catch {}

  for (const form of document.querySelectorAll('[data-plan-task]')) {
    form.classList.add('is-enhanced');
    const date = form.querySelector('[name="due"]');
    const baseline = date.value;
    date.addEventListener('input', () => {
      form.classList.toggle('is-edited', date.value !== baseline);
    });
    form.querySelector('[data-task-toggle]').addEventListener('change', () => form.requestSubmit());
  }
})();
