const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { toLocalDate } = require('./templates');
const { addDays, daysBetween, padTime } = require('./dates');
const { createDiary } = require('./diary');
const { createReviewService } = require('./reviewService');
const { createItems } = require('./items');
const { WORKFLOWS } = require('./workflows');
const { sortTasks, summarize } = require('./tasks');
const { readMistakes, clusterByCategory } = require('./mistakes');

const run = promisify(execFile);

// 多久算「临近截止」。太长会把整页塞满，太短起不到提醒作用。
const DEADLINE_HORIZON_DAYS = 21;

/**
 * frontmatter 的 `plan` 归一成时间块列表。
 *
 * 正常是个列表，但手写成 `plan: 09:00-10:00 写论文` 这种标量也得认 —— 以前直接
 * 当空处理，界面上看不到，日历再排一个块时还会把它整条覆盖掉。认不出结构的
 * （比如写成了映射）才返回空，不猜。
 */
function toPlanEntries(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'object') return [];
  return [value];
}

function parsePlan(value) {
  return toPlanEntries(value).map(entry => {
    const text = String(entry ?? '').trim();
    const match = text.match(/^(\d{1,2}:\d{2})\s*[-–—~]\s*(\d{1,2}:\d{2})\s+(.+)$/);
    // 时刻在这里就补零。下游（排序、.ics 判跨零点）拿它做字符串比较，
    // 让字典序等于时间序是这一层的责任，不该每个调用方各自记得。
    const from = match ? padTime(match[1]) : '';
    const to = match ? padTime(match[2]) : '';
    return match && from && to
      ? { from, to, what: match[3].trim() }
      : { from: '', to: '', what: text };
  }).filter(block => block.what);
}

/**
 * 事件时间戳（UTC ISO）落到本地日，再判断在不在闭区间 [from, to] 里。
 *
 * 复习事件和错题记录存的都是 `toISOString()`，是 UTC 瞬时。直接 `slice(0, 10)`
 * 拿到的是 UTC 日：东八区凌晨 0 点到 8 点之间记的复习，会被算进前一天，
 * 于是周/月回顾在区间两端系统性地数错。reviewService.forecast 早就为这条
 * 专门绕过一次（那里的注释点名了这里），这回一起收掉。
 */
function inLocalRange(timestamp, from, to) {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return false;
  const date = toLocalDate(at);
  return date >= from && date <= to;
}

/** frontmatter 里的日期可能被 YAML 解析成 Date，统一还原成 YYYY-MM-DD。 */
function asDateString(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

/**
 * 跨模块聚合层（E8）。
 *
 * 今日首页、deadline 时间轴、周回顾、每日简报 —— 是同一批数据的四种呈现：
 * 实时版、筛选版、汇总版、推送版。所以这里只做一件事：把各模块里带时间戳的
 * 东西抽出来、排好序，谁来渲染是上层的事。
 */
function createAggregator({ config, db, now = () => new Date() }) {
  const diary = createDiary({ db, config, now });
  const review = createReviewService({ vaultDir: config.vaultDir, device: config.device, now });
  const items = createItems({ db, notesDir: config.notesDir });

  /**
   * 所有带日期的条目，不做任何筛选。
   *
   * 博士阶段的 deadline 散在邮件、微信和脑子里，聚合这件事本身就是价值。
   * 「聚合」和「怎么筛」是两件事：deadlines() 要的是向前看 N 天加全部逾期，
   * 日历月视图要的是任意一段区间（包括已经过去的月份）。所以收集这一步独立出来。
   *
   * `overdue` 相对 today 判定，跟筛选口径无关，两个调用方都用得上。
   */
  function datedEntries(today = toLocalDate(now())) {
    const entries = [];

    // 投稿与实验的 deadline 字段
    for (const flow of Object.values(WORKFLOWS)) {
      for (const item of items.list(flow.key)) {
        const date = asDateString(item.data.deadline);
        if (!date) continue;
        entries.push({
          date,
          label: item.title,
          detail: item.data.journal ? String(item.data.journal) : flow.label,
          source: flow.label,
          path: item.path,
          overdue: date < today
        });
      }
    }

    // 带 @日期 的待办
    for (const task of db.listTasks()) {
      if (!task.due) continue;
      entries.push({
        date: task.due,
        label: task.title,
        detail: task.noteTitle,
        source: '待办',
        path: task.path,
        overdue: task.due < today
      });
    }

    return entries;
  }

  function byDateThenLabel(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label);
  }

  /** 把散在各模块的截止日期聚成一条时间轴。 */
  function deadlines(today = toLocalDate(now()), horizonDays = DEADLINE_HORIZON_DAYS) {
    const horizon = addDays(today, horizonDays);
    return datedEntries(today)
      // 逾期的一律保留（不能因为过期就藏起来），未来的只看视野内的。
      .filter(entry => entry.overdue || entry.date <= horizon)
      .sort(byDateThenLabel);
  }

  /** 区间版：闭区间 [from, to]，逾期与否不影响是否入选。日历月视图用这个。 */
  function datedEntriesInRange(from, to, today = toLocalDate(now())) {
    return datedEntries(today)
      .filter(entry => entry.date >= from && entry.date <= to)
      .sort(byDateThenLabel);
  }

  /** 需要注意的条目：卡住的章节、进行中的实验、待回应的审稿意见。 */
  function attention() {
    const chapters = items.list('chapter').filter(item => item.status === 'stuck');
    const running = items.list('experiment').filter(item => item.status === 'running');
    const submissions = items.list('submission').filter(item => item.reviewsOpen > 0);
    return { stuckChapters: chapters, runningExperiments: running, openReviews: submissions };
  }

  /**
   * 用 git 统计一段时间内笔记的净增行数。
   *
   * 刻意叫「新增行数」而不是「字数」：从 git numstat 只能拿到行数，
   * 把它标成字数是在编一个更好听但不准的数字。vault 不是 git 仓库时返回 null，
   * 页面据此不显示这一项，而不是显示 0。
   */
  async function writingVolume(since) {
    try {
      const { stdout } = await run('git', [
        '-C', config.vaultDir, 'log', `--since=${since}`, '--numstat', '--format=', '--', 'notes'
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

      let added = 0;
      let removed = 0;
      for (const line of stdout.split('\n')) {
        const match = line.match(/^(\d+)\t(\d+)\t/);
        if (!match) continue;
        added += Number(match[1]);
        removed += Number(match[2]);
      }
      return { added, removed, net: added - removed };
    } catch {
      return null;
    }
  }

  /** 今天的实时快照，首页和简报共用。 */
  async function today() {
    const date = toLocalDate(now());
    const queue = await review.queue({});
    const allTasks = db.listTasks();
    const taskStats = summarize(db.listTasks({ includeDone: true }), date);
    const series = diary.trend(30, date);
    const pendingAnnotations = db.listPendingAnnotations({ limit: 5 });

    return {
      date,
      weekday: diary.weekdayOf(date),
      diary: {
        writtenToday: diary.exists(date),
        path: diary.diaryPath(date),
        onThisDay: diary.onThisDay(date),
        // 时间块写在当天日记的 frontmatter 的 plan 字段里。
        plan: readPlan(diary.diaryPath(date)),
        entriesLast30: series.filter(day => day.hasEntry).length
      },
      review: { due: queue.due.length, fresh: queue.fresh.length, total: queue.cards.length },
      tasks: {
        ...taskStats,
        top: sortTasks(allTasks, date).slice(0, 8)
      },
      deadlines: deadlines(date).slice(0, 8),
      annotations: {
        pending: db.countPendingAnnotations(),
        top: pendingAnnotations
      },
      attention: attention()
    };
  }

  /** 时间块：写在日记 frontmatter 的 plan 列表里，一行一块。 */
  function readPlan(diaryPath) {
    const note = db.getNote(diaryPath);
    if (!note) return [];
    let data;
    try {
      data = JSON.parse(note.data_json || '{}');
    } catch {
      return [];
    }
    return parsePlan(data.plan);
  }

  /**
   * 一段时间的回顾数据。周回顾和月回顾用的是同一套，只是区间不同。
   *
   * 数据全部从已有模块算出来 —— 你只需要写反思，不用再手动统计一遍。
   */
  async function retrospective({ from, to }) {
    const events = await review.store.readEvents();
    const inRange = events.filter(event => inLocalRange(event.ts, from, to));

    const series = diary.trend(daysBetween(from, to) + 1, to);
    const written = series.filter(day => day.hasEntry);
    const moods = written.map(day => day.mood).filter(value => value !== null);
    const focus = written.map(day => day.focusMinutes).filter(value => value !== null);

    const mistakes = (await readMistakes(config.vaultDir))
      .filter(record => inLocalRange(record.ts, from, to));

    // 长期没动的待办：有截止日期且已逾期的，最该在回顾时被看见。
    const stale = sortTasks(db.listTasks(), to).filter(task => task.due && task.due < to);

    return {
      from,
      to,
      days: daysBetween(from, to) + 1,
      diary: {
        entries: written.length,
        moodAverage: moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null,
        focusMinutes: focus.reduce((a, b) => a + b, 0)
      },
      review: {
        count: inRange.length,
        cards: new Set(inRange.map(event => event.cardId)).size,
        again: inRange.filter(event => event.rating === 1).length
      },
      tasks: { open: db.listTasks().length, stale: stale.slice(0, 10), staleCount: stale.length },
      mistakes: {
        total: mistakes.reduce((sum, record) => sum + (Number(record.count) || 1), 0),
        top: clusterByCategory(mistakes).slice(0, 5)
      },
      writing: await writingVolume(from)
    };
  }

  /** 本周的起止（周一到今天）。 */
  function thisWeek(date = toLocalDate(now())) {
    const [year, month, day] = date.split('-').map(Number);
    const at = new Date(year, month - 1, day);
    const offset = (at.getDay() + 6) % 7; // 周一为 0
    return { from: addDays(date, -offset), to: date };
  }

  function thisMonth(date = toLocalDate(now())) {
    return { from: `${date.slice(0, 7)}-01`, to: date };
  }

  return {
    today, deadlines, datedEntries, datedEntriesInRange, attention, retrospective, writingVolume,
    thisWeek, thisMonth, readPlan, addDays, daysBetween
  };
}

module.exports = { createAggregator, asDateString, parsePlan, toPlanEntries, DEADLINE_HORIZON_DAYS };
