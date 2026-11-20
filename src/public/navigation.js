(() => {
  const sections = {
    notes: ['/search'],
    plan: ['/plan', '/tasks', '/deadlines', '/calendar'],
    review: ['/decks', '/cards', '/review']
  };
  const defaults = { notes: '/search', plan: '/plan', review: '/decks' };

  function reviewRoundFinished(url) {
    if (url.pathname !== '/review' || !url.searchParams.has('round')) return false;
    try {
      const saved = window.workstationRound?.read?.() || JSON.parse(sessionStorage.getItem('review-round-v1'));
      return !saved || saved.token !== url.searchParams.get('round')
        || !Array.isArray(saved.remaining) || saved.remaining.length === 0;
    } catch {
      return false;
    }
  }

  function remember() {
    for (const [section, paths] of Object.entries(sections)) {
      const link = document.querySelector(`[data-nav="${section}"]`);
      if (!link) continue;
      const key = 'navigation:' + section;
      try {
        if (paths.includes(location.pathname)) {
          const url = new URL(location.href);
          url.searchParams.delete('added');
          if (section === 'review' && reviewRoundFinished(url)) {
            sessionStorage.removeItem(key);
            link.href = defaults.review;
            continue;
          }
          sessionStorage.setItem(key, url.pathname + url.search);
        }
        const saved = sessionStorage.getItem(key);
        if (!saved) {
          if (section === 'review') link.href = defaults.review;
          continue;
        }
        const url = new URL(saved, location.origin);
        if (url.origin === location.origin && paths.includes(url.pathname)) {
          if (section === 'review' && reviewRoundFinished(url)) {
            sessionStorage.removeItem(key);
            link.href = defaults.review;
          } else {
            link.href = url.pathname + url.search;
          }
        }
      } catch { /* 存储不可用时沿用侧栏默认入口。 */ }
    }
  }

  window.workstationNavigation = { remember };
  remember();
  window.addEventListener('pageshow', remember);
})();
