(() => {
  const sidebar = document.querySelector('[data-note-sidebar]');
  if (!sidebar) return;

  const tabs = [...sidebar.querySelectorAll('[data-note-tab]')];
  const panels = [...sidebar.querySelectorAll('[data-note-panel]')];
  function revealCurrent() {
    const panel = sidebar.querySelector('[data-note-panel="outline"]');
    const link = panel.querySelector('[aria-current="location"]');
    if (!link || panel.hidden) return;
    const bounds = panel.getBoundingClientRect(), item = link.getBoundingClientRect();
    if (item.top < bounds.top) panel.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) panel.scrollTop += item.bottom - bounds.bottom;
  }
  function selectTab(tab, focus = false) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.notePanel !== tab.dataset.noteTab;
    if (tab.dataset.noteTab === 'outline') revealCurrent();
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next], true);
    });
  });

  const entries = [...sidebar.querySelectorAll('[data-outline-target]')].map(link => ({
    link, heading: document.getElementById(link.dataset.outlineTarget)
  })).filter(entry => entry.heading);
  if (!entries.length) return;

  let current;
  let navigationTarget;
  function activate(entry) {
    if (!entry || entry === current) return;
    current?.link.removeAttribute('aria-current');
    entry.link.setAttribute('aria-current', 'location');
    current = entry;
    // 只滚动目录面板，避免跟随当前章节时把正文也带走。
    revealCurrent();
  }
  function updateCurrent() {
    // 短尾部不能把所选标题滚到顶端；保留明确选择，直到用户主动滚动正文。
    if (navigationTarget) { activate(navigationTarget); return; }
    let active = entries[0];
    for (const entry of entries) {
      if (entry.heading.getBoundingClientRect().top > 64) break;
      active = entry;
    }
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) active = entries.at(-1);
    activate(active);
  }
  let scheduled = false;
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => { scheduled = false; updateCurrent(); });
  }
  function selectFragment() {
    let target;
    try { target = document.getElementById(decodeURIComponent(window.location.hash.slice(1))); } catch {}
    // 兼容已有双链的 H 标题别名和 L 行号锚点。
    if (target?.classList.contains('heading-anchor')) target = target.nextElementSibling;
    const entry = entries.find(item => item.heading === target);
    navigationTarget = entry;
    if (entry) activate(entry);
    else scheduleUpdate();
  }
  function releaseNavigation(event) {
    if (!sidebar.contains(event.target)) navigationTarget = undefined;
  }
  entries.forEach(entry => entry.link.addEventListener('click', () => {
    navigationTarget = entry;
    activate(entry);
  }));
  // 短目录上的滚轮也会连锁滚动正文；独立目录未触发 window scroll 时不会更新高亮。
  const releaseScrollNavigation = () => { navigationTarget = undefined; };
  window.addEventListener('wheel', releaseScrollNavigation, { passive: true });
  window.addEventListener('touchstart', releaseScrollNavigation, { passive: true });
  window.addEventListener('pointerdown', releaseNavigation, { passive: true });
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('input, textarea, select, button, [contenteditable="true"], [role="tab"]')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) navigationTarget = undefined;
  });
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('hashchange', selectFragment);
  window.addEventListener('load', selectFragment, { once: true });
  selectFragment();
})();
