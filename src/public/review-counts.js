(() => {
  const nav = document.querySelector('[data-nav="review"]');
  if (!nav) return;
  const today = document.querySelector('.desk-review');
  let pending;
  let timer;

  function display(due, fresh) {
    let badge = nav.querySelector('.nav-badge');
    if (!due) badge?.remove();
    else {
      const label = due + ' 张到期';
      let created = false;
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        nav.append(badge);
        created = true;
      }
      if (badge.title !== label) {
        const changed = !created && Boolean(badge.title);
        badge.title = label;
        badge.removeAttribute('aria-label');
        const comma = document.createElement('span');
        comma.className = 'visually-hidden';
        comma.textContent = '，';
        const suffix = document.createElement('span');
        suffix.className = 'visually-hidden';
        suffix.textContent = ' 张到期';
        badge.replaceChildren(comma, document.createTextNode(due > 99 ? '99+' : String(due)), suffix);
        if (created) window.workstationMotion?.enter?.(badge, { y: 0, scale: 0.84, easing: window.workstationMotion.EASE_SPRING });
        else if (changed) window.workstationMotion?.pulse?.(badge, { scale: 1.08 });
      }
    }
    if (!today) return;
    const totalEl = today.querySelector('strong');
    const nextTotal = String(due + fresh);
    const totalChanged = Boolean(totalEl && totalEl.textContent && totalEl.textContent !== nextTotal);
    if (totalEl) totalEl.textContent = nextTotal;
    today.querySelector('[data-review-due]').textContent = due;
    today.querySelector('[data-review-fresh]').textContent = fresh;
    today.hidden = !due && !fresh;
    if (totalChanged && !today.hidden) window.workstationMotion?.pulse?.(totalEl, { scale: 1.08 });
  }

  async function refresh() {
    clearTimeout(timer);
    pending?.abort();
    if (document.hidden) return;
    const request = new AbortController();
    pending = request;
    let delay = 60000;
    try {
      const response = await fetch('/api/review-counts', { signal: request.signal, cache: 'no-store' });
      if (!response.ok) return;
      const { due, fresh, nextDue } = await response.json();
      if (request.signal.aborted) return;
      display(due, fresh);
      if (nextDue) delay = Math.max(250, Math.min(delay, Date.parse(nextDue) - Date.now()));
    } catch { /* 暂时无法读取时保留上次的数字，稍后重试。 */ }
    finally {
      if (!request.signal.aborted && !document.hidden) timer = setTimeout(refresh, delay);
    }
  }

  window.workstationReviewCounts = { refresh };
  window.addEventListener('pageshow', refresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', () => { clearTimeout(timer); pending?.abort(); });
})();
