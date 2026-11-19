const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fsrs, createEmptyCard, generatorParameters, Rating, State } = require('ts-fsrs');

const { appendLinesSync } = require('./vault/atomic');
const { randomUUID } = require('node:crypto');
const { enqueueFile } = require('./vault/note-queue');

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

function isUndoEvent(event) {
  return Boolean(event) && event.type === 'undo'
    && typeof event.event_id === 'string' && event.event_id.length > 0 && event.event_id.length <= 128
    && typeof event.undo_event_id === 'string' && event.undo_event_id.length > 0 && event.undo_event_id.length <= 128
    && typeof event.ts === 'string' && !Number.isNaN(Date.parse(event.ts));
}

function activeEvents(events) {
  const cancelled = new Set(events.filter(event => event.undoOf).map(event => event.undoOf));
  return events.filter(event => !event.undoOf && (!event.eventId || !cancelled.has(event.eventId)));
}

function isValidEvent(event) {
  if (isUndoEvent(event)) return true;
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
function parseEventLines(file, raw) {
  const events = [];
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
      ...(isUndoEvent(parsed) ? { undoOf: parsed.undo_event_id } : {}),
      cardId: parsed.card_id,
      identityVersion: parsed.card_id_version || 1,
      ts: parsed.ts,
      rating: Number(parsed.rating),
      elapsedMs: Number(parsed.elapsed_ms) || 0,
      source: file,
      line: index
    });
  });
  return events;
}

/**
 * 目录项是不是普通文件。Windows 上 readdir 把所有重解析点（包括 OneDrive、Dropbox 的
 * 占位文件）都报成链接，lstat 才分得清：真符号链接仍然不认，占位文件按普通文件处理。
 */
async function isRegularFile(entry, absolute) {
  if (entry.isFile()) return true;
  if (entry.isDirectory()) return false;
  try {
    const stat = await fsp.lstat(absolute);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 复习日志文件。reviews 目录本身或其中的文件是符号链接时一律不认：
 * 否则一个指向资料库外的链接就能让应用去读写别处的文件。
 */
async function listLogFiles(vaultDir) {
  const directory = path.join(vaultDir, REVIEWS_DIR);
  try {
    if (!(await fsp.lstat(directory)).isDirectory()) return [];
    const names = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.jsonl')) continue;
      if (await isRegularFile(entry, path.join(directory, entry.name))) names.push(entry.name);
    }
    return names.sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function assertWritableLog(directory, file) {
  const unsafe = target => {
    try { return fs.lstatSync(target).isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (unsafe(directory) || unsafe(file)) {
    throw Object.assign(new Error('复习日志目录或文件是符号链接，为安全起见不写入。'), { status: 409 });
  }
}

async function readEvents(vaultDir) {
  const events = [];
  for (const file of await listLogFiles(vaultDir)) {
    events.push(...parseEventLines(file, await fsp.readFile(path.join(vaultDir, REVIEWS_DIR, file), 'utf8')));
  }
  return activeEvents(events);
}

/**
 * 复习日志的缓存：按文件记住大小、修改时间和 inode，只重读变了的文件。
 *
 * 日志按「年月 + 设备」分文件、只追加，几年下来会有几万条。以前今日、复习、卡组页
 * 每打开一次就把全部文件读一遍、整体重放一遍，评一张卡还要再读一遍来去重。
 * 现在评一张卡只会让本设备当月那一个文件失效；git 拉下别的设备的记录也只重读那几个文件。
 * generation 在任何文件变化时加一，上层据此决定要不要重放。
 */
function createEventCache(vaultDir) {
  let files = new Map();
  let generation = 0;
  let snapshot = null;

  async function refresh() {
    const directory = path.join(vaultDir, REVIEWS_DIR);
    const names = await listLogFiles(vaultDir);
    let changed = names.length !== files.size;
    const next = new Map();
    for (const name of names) {
      let stats;
      try {
        stats = await fsp.stat(path.join(directory, name));
      } catch (error) {
        if (error.code === 'ENOENT') { changed = true; continue; }
        throw error;
      }
      const key = `${stats.size}:${stats.mtimeMs}:${stats.ino}`;
      const cached = files.get(name);
      if (cached && cached.key === key) {
        next.set(name, cached);
        continue;
      }
      changed = true;
      next.set(name, { key, events: parseEventLines(name, await fsp.readFile(path.join(directory, name), 'utf8')) });
    }
    files = next;
    if (changed || !snapshot) {
      generation += 1;
      const events = [...files.values()].flatMap(entry => entry.events);
      snapshot = { generation, events: activeEvents(events), allEvents: events, byId: null };
    }
    return snapshot;
  }

  /** 事件 ID → 事件，第一次用到时才建。 */
  function byId(current) {
    if (!current.byId) {
      current.byId = new Map();
      for (const event of current.allEvents) {
        if (event.eventId && !current.byId.has(event.eventId)) current.byId.set(event.eventId, event);
      }
    }
    return current.byId;
  }

  return { refresh, byId };
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

  for (const event of activeEvents(events).sort(compareEvents)) {
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
  const cache = createEventCache(vaultDir);

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
        const existing = cache.byId(await cache.refresh()).get(normalized.eventId);
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
      const event = {
        ...(normalized.eventId ? { event_id: normalized.eventId } : {}),
        card_id: normalized.cardId,
        card_id_version: 2,
        ts: iso,
        rating: normalized.rating,
        elapsed_ms: normalized.elapsedMs
      };
      const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
      const logName = reviewLogName(local, device);
      const logFile = path.join(dir, logName);
      // 和笔记一样过写入闸门：Git 变基改工作区的那一小段时间里，评分等变基结束再落盘。
      // 否则这一行要么让变基失败并留下需要中止的现场，要么在中止时被一起丢掉。
      await enqueueFile(vaultDir, `${REVIEWS_DIR}/${logName}`, async () => {
        assertWritableLog(dir, dir);
        fs.mkdirSync(dir, { recursive: true });
        assertWritableLog(dir, logFile);
        appendLinesSync(logFile, [JSON.stringify(event)]);
      });
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

  const isLocalLog = name => /^\d{4}-\d{2}-/.test(name) && name.slice(8) === device + '.jsonl';
  const latestLocal = snapshot => snapshot.events.filter(event => isLocalLog(event.source))
    .sort((left, right) => left.source.localeCompare(right.source) || left.line - right.line).at(-1);

  /** 撤销也是追加事件：Git 合并或中止后仍能知道原评分已经作废。 */
  function undo(eventId) {
    const wanted = String(eventId || '').trim();
    const operation = recordQueue.then(async () => {
      if (!wanted || wanted.length > 128) {
        throw Object.assign(new Error('缺少或无效的事件 ID。'), { status: 400 });
      }
      // 响应丢失后重试同一撤销仍成功，但只能认本设备评分及本设备撤销。
      const alreadyUndone = snapshot => snapshot.allEvents.some(event =>
        event.eventId === wanted && !event.undoOf && isLocalLog(event.source))
        && snapshot.allEvents.some(event => event.undoOf === wanted && isLocalLog(event.source));
      const snapshot = await cache.refresh();
      if (alreadyUndone(snapshot)) return { ok: true, eventId: wanted };
      const latest = latestLocal(snapshot);
      if (!latest || latest.eventId !== wanted) throw conflict('只能撤销最后一次评分。');
      await enqueueFile(vaultDir, REVIEWS_DIR + '/' + latest.source, async () => {
        // 等待 Git 写入闸门时日志可能已被换过，落盘前重新校验。
        const refreshed = await cache.refresh();
        if (alreadyUndone(refreshed)) return;
        const current = latestLocal(refreshed);
        if (!current || current.eventId !== wanted) throw conflict('只能撤销最后一次评分。');
        const dir = path.join(vaultDir, REVIEWS_DIR);
        const logFile = path.join(dir, latest.source);
        assertWritableLog(dir, logFile);
        appendLinesSync(logFile, [JSON.stringify({
          type: 'undo', event_id: randomUUID(), undo_event_id: wanted, ts: now().toISOString()
        })]);
      });
      return { ok: true, eventId: wanted };
    });
    recordQueue = operation.catch(() => {});
    return operation;
  }

  async function states(cardIds) {
    return replay((await cache.refresh()).events, cardIds);
  }

  return {
    record,
    undo,
    states,
    latestLocalEventId: async () => latestLocal(await cache.refresh())?.eventId || null,
    /** 当前全部事件（缓存过的）；generation 变了才说明日志有变化。 */
    snapshot: () => cache.refresh(),
    readEvents: async () => (await cache.refresh()).events
  };
}

module.exports = {
  isRegularFile,
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
