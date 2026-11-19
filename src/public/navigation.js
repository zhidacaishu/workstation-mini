(() => {
  const sections = {
    notes: ['/search'],
    plan: ['/plan', '/tasks', '/deadlines', '/calendar'],
    review: ['/decks', '/cards', '/review']
  };

  function remember() {
    for (const [section, paths] of Object.entries(sections)) {
      const link = document.querySelector(`[data-nav="${section}"]`);
      if (!link) continue;
      const key = 'navigation:' + section;
      try {
        if (paths.includes(location.pathname)) {
          const url = new URL(location.href);
          url.searchParams.delete('added');
          sessionStorage.setItem(key, url.pathname + url.search);
        }
        const saved = sessionStorage.getItem(key);
        if (!saved) continue;
        const url = new URL(saved, location.origin);
        if (url.origin === location.origin && paths.includes(url.pathname)) link.href = url.pathname + url.search;
      } catch { /* 存储不可用时沿用侧栏默认入口。 */ }
    }
  }

  window.workstationNavigation = { remember };
  remember();
  window.addEventListener('pageshow', remember);
})();
