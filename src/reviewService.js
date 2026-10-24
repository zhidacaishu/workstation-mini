const fsp = require('node:fs/promises');
const path = require('node:path');

const { loadAllCards, listCardFiles } = require('./cards');
const { createReviewStore, replay, newCardState, State } = require('./review');
const { toLocalDate } = require('./templates');
const { addDays } = require('./dates');

// 一次学习会话里最多引入多少张新卡。没有上限的话，新建一批卡片的当天
// 会被几百张新卡淹没，接下来几天的复习量也跟着爆掉。
const DEFAULT_NEW_LIMIT = 20;

// 负荷预测默认看多远。两个月足够覆盖一次投稿周期，再远的排期还会被之后的
// 复习结果改写，算出来也只是好看。
const FORECAST_DAYS = 60;

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

  /**
   * 未来每天要复习多少张。
   *
   * FSRS 早就给每张卡算好了 due 时刻，但 queue() 只回答「此刻到期」——
   * 于是全 app 唯一会自动产生未来工作量的东西完全不可见，你要到当天打开
   * /review 才知道今天有两百张等着。这个函数把同一批状态按天摊开。
   *
   * 逾期的卡堆到 today 那一格，不留在过去：积压散在上个月的日历格子里等于看不见，
   * 而积压恰恰是最该被看见的东西。today 不在窗口内时只计数不落格。
   */
  async function forecast({
    from = toLocalDate(now()),
    days = FORECAST_DAYS,
    today = toLocalDate(now())
  } = {}) {
    const span = Math.max(1, Math.floor(days));
    const to = addDays(from, span - 1);

    // 先把每一天都摆进去，没有卡的那天是 0 而不是缺一格。
    const counts = new Map();
    for (let offset = 0; offset < span; offset += 1) counts.set(addDays(from, offset), 0);

    let backlog = 0;
    let fresh = 0;

    for (const card of await withStates()) {
      // 新卡没有排期，不属于未来的任何一天，单独报一个数。
      if (card.state.state === State.New) {
        fresh += 1;
        continue;
      }

      // state.due 是 UTC 瞬时（review.js 存的是 toISOString()）。要落到「哪一天」
      // 必须过一次本地时区：东八区晚上到期的卡，直接 slice(0, 10) 会算到前一天去。
      // 凡是拿这类时间戳分桶的地方都要走 toLocalDate —— aggregate.js 的
      // inLocalRange 是同一条规则的另一处落地，改一处时记得看看另一处。
      const due = toLocalDate(new Date(card.state.due));
      const bucket = due < today ? today : due;
      if (due < today) backlog += 1;
      // has() 同时挡掉窗口之前和窗口之后的两种情况。
      if (counts.has(bucket)) counts.set(bucket, counts.get(bucket) + 1);
    }

    const series = [...counts].map(([date, count]) => ({ date, count }));
    return {
      from,
      to,
      days: series,
      backlog,
      fresh,
      scheduled: series.reduce((sum, day) => sum + day.count, 0),
      peak: series.reduce((max, day) => Math.max(max, day.count), 0)
    };
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
    return {
      decks,
      failures,
      ambiguousHistory: all.some(card => all.some(other => other !== card && other.legacyId === card.legacyId)),
      total: all.length,
      due: decks.reduce((sum, d) => sum + d.due, 0),
      fresh: decks.reduce((sum, d) => sum + d.fresh, 0)
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

  return { allCards, withStates, queue, forecast, stats, answer, store };
}

module.exports = { createReviewService, DEFAULT_NEW_LIMIT, FORECAST_DAYS };
