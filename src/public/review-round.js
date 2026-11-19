// 当前窗口保存最近一轮的位置和评分摘要。卡片内容始终从资料库重新读取。
(() => {
  const key = 'review-round-v1';

  function read() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (typeof saved?.token !== 'string' || typeof saved.deck !== 'string' || !Number.isInteger(saved.steps)
        || !Array.isArray(saved.reviewed) || !Array.isArray(saved.relearned) || !Array.isArray(saved.remaining)) return null;
      return saved;
    } catch { return null; }
  }

  function write(snapshot) {
    try {
      if (snapshot) sessionStorage.setItem(key, JSON.stringify(snapshot));
      else sessionStorage.removeItem(key);
    } catch { /* 当前轮仍可在内存中继续。 */ }
  }

  function url(deck, token) {
    const params = new URLSearchParams();
    if (deck) params.set('deck', deck);
    params.set('round', token);
    return '/review?' + params.toString();
  }

  async function load(snapshot, preview = false) {
    const ids = new Set(snapshot.remaining.map(item => item.id));
    if (snapshot.undo) ids.add(snapshot.undo.id);
    return window.workstationUI.requestJson('/api/review-round', {
      method: 'POST', json: { deck: snapshot.deck, ids: [...ids], preview }
    });
  }

  const api = { read, write, url, load };
  window.workstationRound = api;

  async function showResume() {
    const link = document.querySelector('[data-resume-any], [data-resume-deck]');
    if (!link) return;
    link.hidden = true;
    const saved = read();
    if (!saved?.remaining.length || (link.hasAttribute('data-resume-deck') && saved.deck !== link.dataset.resumeDeck)) return;
    try {
      const { cards } = await load(saved, true);
      const counts = new Map(cards.map(card => [card.id, card.reviewCount]));
      if (!saved.remaining.some(item => counts.get(item.id) === item.reviewCount)) return;
      link.href = url(saved.deck, saved.token);
      link.hidden = false;
    } catch { /* 保留服务端的复习入口。 */ }
  }
  window.addEventListener('pageshow', showResume);
})();
