const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fsrs, createEmptyCard, generatorParameters, Rating, State } = require('ts-fsrs');

const { appendLinesSync } = require('./vault/atomic');

const REVIEWS_DIR = 'reviews';
const VALID_RATINGS = new Set([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);

const RATING_LABELS = [
  { rating: Rating.Again, key: '1', label: '忘了', hint: '完全想不起来' },
  { rating: Rating.Hard, key: '2', label: '勉强', hint: '想起来了但很吃力' },
  { rating: Rating.Good, key: '3', label: '记得', hint: '正常回忆出来' },
  { rating: Rating.Easy, key: '4', label: '太简单', hint: '毫不费力' }
];

// enable_fuzz 会给间隔加一点随机扰动。这里必须关掉：
// 卡片状态是由事件日志重放算出来的，两台设备重放同一批事件必须得到同一个结果。
// 有扰动就不成立了。ts-fsrs 当前默认就是 false，但这条性质太关键，
// 不能依赖库的默认值 —— 哪天上游改了默认值，同步会静默错乱。
const FSRS_PARAMETERS = generatorParameters({ enable_fuzz: false });

/** 事件日志文件名：按「年月 + 设备」分文件，不同设备写不同文件，git 合并永不冲突。 */
function reviewLogName(dateString, device) {
  return `${dateString.slice(0, 7)}-${device}.jsonl`;
}

function isValidEvent(event) {
  return Boolean(event)
    && typeof event.card_id === 'string' && event.card_id.length > 0
    && typeof event.ts === 'string' && !Number.isNaN(Date.parse(event.ts))
    && VALID_RATINGS.has(Number(event.rating))
    && (event.event_id === undefined
      || (typeof event.event_id === 'string' && event.event_id.length > 0 && event.event_id.length <= 128));
}

/**
 * 读取全部复习事件。
 *
 * 坏行直接跳过而不是抛错：日志是追加式的，一次崩溃可能留下半行 JSON，
 * 不该让整个复习功能瘫掉。文件名会随事件带出来，用于排序去歧义。
 */
async function readEvents(vaultDir) {
  const dir = path.join(vaultDir, REVIEWS_DIR);
  let files;
  try {
    files = (await fsp.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const events = [];
  for (const file of files) {
    const raw = await fsp.readFile(path.join(dir, file), 'utf8');
    raw.split('\n').forEach((line, index) => {
      const text = line.trim();
      if (!text) return;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!isValidEvent(parsed)) return;
      events.push({
        eventId: parsed.event_id || '',
        cardId: parsed.card_id,
        identityVersion: parsed.card_id_version || 1,
        ts: parsed.ts,
        rating: Number(parsed.rating),
        elapsedMs: Number(parsed.elapsed_ms) || 0,
        source: file,
        line: index
      });
    });
  }
  return events;
}

/**
 * 事件排序必须是全序且跨机器一致。
 *
 * 时间戳相同并非不可能（两台设备离线复习同一张卡）。只按 ts 排，
 * 两边的顺序取决于文件读取顺序，重放结果会分叉。加上文件名和行号做
 * 兜底比较键，任何机器上的排序结果都一样。
 */
function compareEvents(left, right) {
  if (left.ts !== right.ts) return left.ts < right.ts ? -1 : 1;
  if (left.source !== right.source) return left.source < right.source ? -1 : 1;
  return left.line - right.line;
}

/**
 * 重放事件算出每张卡的 FSRS 状态。
 *
 * 卡片状态不落盘为真相 —— 真相是事件日志。FSRS 本身是顺序状态机，
 * 把事件按时间排好一条条喂给 next() 就是正确答案。这也是多台设备能够
 * 独立复习的前提：各自追加，pull 之后重放即可合并。
 */
function replay(events, cardIds) {
  const scheduler = fsrs(FSRS_PARAMETERS);
  const known = cardIds ? new Set(cardIds) : null;
  const byCard = new Map();
  const seenEventIds = new Set();

  for (const event of [...events].sort(compareEvents)) {
    if (event.eventId) {
      if (seenEventIds.has(event.eventId)) continue;
      seenEventIds.add(event.eventId);
    }
    // 卡片被删掉后，它的历史事件留在日志里（追加式日志不改历史），
    // 重放时跳过即可。
    if (known && !known.has(event.cardId)) continue;
    const at = new Date(event.ts);
    const previous = byCard.get(event.cardId);
    const card = previous ? previous.card : createEmptyCard(at);
    const next = scheduler.next(card, at, event.rating);
    byCard.set(event.cardId, { card: next.card, reviewCount: (previous?.reviewCount || 0) + 1 });
  }

  const states = new Map();
  for (const [id, entry] of byCard) {
    states.set(id, {
      due: entry.card.due.toISOString(),
      stability: entry.card.stability,
      difficulty: entry.card.difficulty,
      reps: entry.card.reps,
      lapses: entry.card.lapses,
      state: entry.card.state,
      lastReview: entry.card.last_review ? entry.card.last_review.toISOString() : null,
      reviewCount: entry.reviewCount
    });
  }
  return states;
}

/** 没复习过的新卡：立刻到期，state 为 New。 */
function newCardState(now) {
  const card = createEmptyCard(now);
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: 0,
    lapses: 0,
    state: State.New,
    lastReview: null,
    reviewCount: 0
  };
}

function createReviewStore({ vaultDir, device, now = () => new Date() }) {
  let recordQueue = Promise.resolve();

  function conflict(message) {
    const error = new Error(message);
    error.status = 409;
    return error;
  }

  function record(cardId, rating, elapsedMs = 0, eventId = '', { validate = async () => {} } = {}) {
    const normalized = {
      eventId: String(eventId || '').trim(),
      cardId: String(cardId),
      rating: Number(rating),
      elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0))
    };
    const operation = recordQueue.then(async () => {
      if (!VALID_RATINGS.has(normalized.rating)) {
        throw new Error(`Unknown rating: ${rating}`);
      }
      if (normalized.eventId.length > 128) {
        const error = new Error('Event ID is too long.');
        error.status = 400;
        throw error;
      }

      if (normalized.eventId) {
        const existing = (await readEvents(vaultDir)).find(event => event.eventId === normalized.eventId);
        if (existing) {
          if (existing.cardId !== normalized.cardId
            || existing.rating !== normalized.rating
            || existing.elapsedMs !== normalized.elapsedMs) {
            throw conflict('同一事件 ID 对应了不同评分。');
          }
          return {
            eventId: existing.eventId,
            cardId: existing.cardId,
            ts: existing.ts,
            rating: existing.rating,
            duplicate: true
          };
        }
      }

      await validate();
      const at = now();
      const iso = at.toISOString();
      const dir = path.join(vaultDir, REVIEWS_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const event = {
        ...(normalized.eventId ? { event_id: normalized.eventId } : {}),
        card_id: normalized.cardId,
        card_id_version: 2,
        ts: iso,
        rating: normalized.rating,
        elapsed_ms: normalized.elapsedMs
      };
      const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
      appendLinesSync(path.join(dir, reviewLogName(local, device)), [JSON.stringify(event)]);
      return {
        eventId: normalized.eventId,
        cardId: normalized.cardId,
        ts: iso,
        rating: normalized.rating,
        duplicate: false
      };
    });
    recordQueue = operation.catch(() => {});
    return operation;
  }

  async function states(cardIds) {
    return replay(await readEvents(vaultDir), cardIds);
  }

  return { record, states, readEvents: () => readEvents(vaultDir) };
}

module.exports = {
  REVIEWS_DIR,
  RATING_LABELS,
  FSRS_PARAMETERS,
  Rating,
  State,
  reviewLogName,
  isValidEvent,
  compareEvents,
  readEvents,
  replay,
  newCardState,
  createReviewStore
};
