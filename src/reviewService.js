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

  // 重放结果只取决于日志和卡片集合：两者都没变就直接复用，翻页不再重放几万条事件。
  let replayed = { generation: -1, cards: null, states: null };

  /** 卡片本体 + 重放算出的状态。没复习过的卡是「新卡」，立刻可学。 */
  async function withStates() {
    const cards = await allCards();
    const log = await store.snapshot();
    if (replayed.generation !== log.generation || replayed.cards !== cards) {
      replayed = {
        generation: log.generation,
        cards,
        states: replay(migrateEvents(log.events, cards), cards.map(card => card.id))
      };
    }
    const { states } = replayed;
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
    // 暂停的卡不进复习队列，复习记录保留，恢复后接着排。
    const scoped = all.filter(card => !card.suspended && (!deck || card.deck === deck));

    const due = scoped
      .filter(card => card.state.state !== State.New && card.state.due <= nowIso)
      .sort((a, b) => (a.state.due < b.state.due ? -1 : a.state.due > b.state.due ? 1 : a.id.localeCompare(b.id)));

    const fresh = scoped
      .filter(card => card.state.state === State.New)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, Math.max(0, newLimit));

    let nextDue = null;
    for (const { state } of scoped) {
      if (state.state !== State.New && state.due > nowIso && (!nextDue || state.due < nextDue)) nextDue = state.due;
    }
    return { due, fresh, cards: [...due, ...fresh], nextDue };
  }

  async function stats() {
    const nowIso = now().toISOString();
    const all = await withStates();
    const byDeck = new Map();

    for (const card of all) {
      const entry = byDeck.get(card.deck) || { deck: card.deck, total: 0, due: 0, fresh: 0, learned: 0, suspended: 0 };
      entry.total += 1;
      if (card.suspended) {
        entry.suspended += 1;
        if (card.state.state !== State.New) entry.learned += 1;
      } else if (card.state.state === State.New) entry.fresh += 1;
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
      // 一趟计数，不两两比较：卡多了以后双重循环要好几百毫秒。
      ambiguousHistory: new Set(all.map(card => card.legacyId)).size !== all.length,
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

  return { allCards, withStates, queue, stats, answer, undo: eventId => store.undo(eventId), store };
}

module.exports = { createReviewService, DEFAULT_NEW_LIMIT };
