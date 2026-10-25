const fsp = require('node:fs/promises');
const path = require('node:path');

const { loadAllCards, listCardFiles } = require('./cards');
const { createReviewStore, replay, newCardState, State } = require('./review');

// 一次学习会话里最多引入多少张新卡。没有上限的话，新建一批卡片的当天
// 会被几百张新卡淹没，接下来几天的复习量也跟着爆掉。
const DEFAULT_NEW_LIMIT = 20;

function createReviewService({ vaultDir, device, now = () => new Date() }) {
  const store = createReviewStore({ vaultDir, device, now });

  // 卡片文件的解析结果缓存。个人卡库就几千张，全量解析是毫秒级，
  // 但每次请求都重读磁盘没必要 —— 用目录里最新的 mtime 做失效判断。
  let cache = { signature: '', cards: [] };
  let failures = [];

  async function cardsSignature() {
    const parts = [];
    for (const file of await listCardFiles(vaultDir)) {
      const stat = await fsp.lstat(path.join(vaultDir, ...file.split('/')));
      parts.push(`${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`);
    }
    return JSON.stringify(parts);
  }

  async function allCards() {
    const signature = await cardsSignature();
    if (signature !== cache.signature || failures.length) {
      failures = [];
      cache = { signature, cards: await loadAllCards(vaultDir, { onError: failure => failures.push(failure) }) };
    }
    return cache.cards;
  }

  function migrateEvents(events, cards) {
    const aliases = new Map();
    for (const card of cards) {
      const list = aliases.get(card.legacyId) || [];
      list.push(card.id);
      aliases.set(card.legacyId, list);
    }
    return events.flatMap(event => {
      if (event.identityVersion === 2) return [event];
      const targets = aliases.get(event.cardId);
      // Ambiguous old records remain on disk, but cannot be assigned to either card.
      if (targets?.length > 1) return [];
      return [{ ...event, cardId: targets?.[0] || event.cardId }];
    });
  }

  /** 卡片本体 + 重放算出的状态。没复习过的卡是「新卡」，立刻可学。 */
  async function withStates() {
    const cards = await allCards();
    const states = replay(migrateEvents(await store.readEvents(), cards), cards.map(card => card.id));
    const current = now();
    return cards.map(card => ({
      ...card,
      state: states.get(card.id) || newCardState(current)
    }));
  }

  /**
   * 今天该复习的队列。
   *
   * 到期的排前面（越早到期越靠前），新卡排后面并限量。先还债再学新的，
   * 否则积压会越滚越大。
   */
  async function queue({ deck = '', newLimit = DEFAULT_NEW_LIMIT } = {}) {
    const nowIso = now().toISOString();
    const all = await withStates();
    const scoped = deck ? all.filter(card => card.deck === deck) : all;

    const due = scoped
      .filter(card => card.state.state !== State.New && card.state.due <= nowIso)
      .sort((a, b) => (a.state.due < b.state.due ? -1 : a.state.due > b.state.due ? 1 : a.id.localeCompare(b.id)));

    const fresh = scoped
      .filter(card => card.state.state === State.New)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, Math.max(0, newLimit));

    return { due, fresh, cards: [...due, ...fresh] };
  }

  async function stats() {
    const nowIso = now().toISOString();
    const all = await withStates();
    const byDeck = new Map();

    for (const card of all) {
      const entry = byDeck.get(card.deck) || { deck: card.deck, total: 0, due: 0, fresh: 0, learned: 0 };
      entry.total += 1;
      if (card.state.state === State.New) entry.fresh += 1;
      else {
        entry.learned += 1;
        if (card.state.due <= nowIso) entry.due += 1;
      }
      byDeck.set(card.deck, entry);
    }

    const decks = [...byDeck.values()].sort((a, b) => b.due - a.due || a.deck.localeCompare(b.deck));
    const due = decks.reduce((sum, deck) => sum + deck.due, 0);
    const fresh = decks.reduce((sum, deck) => sum + deck.fresh, 0);
    return {
      decks,
      failures,
      ambiguousHistory: all.some(card => all.some(other => other !== card && other.legacyId === card.legacyId)),
      total: all.length,
      due,
      fresh,
      sessionCount: due + Math.min(fresh, DEFAULT_NEW_LIMIT)
    };
  }

  async function answer(cardId, rating, elapsedMs, eventId = '') {
    return store.record(cardId, rating, elapsedMs, eventId, {
      validate: async () => {
        if (!(await allCards()).some(card => card.id === cardId)) {
          const error = new Error('卡片不存在或已被删除。');
          error.status = 404;
          throw error;
        }
      }
    });
  }

  return { allCards, withStates, queue, stats, answer, store };
}

module.exports = { createReviewService, DEFAULT_NEW_LIMIT };
