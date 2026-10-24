const { toLocalDate } = require('./templates');
const {
  addDays, daysBetween, isValidDateString, weekdayOf, parseDate,
  monthOf, addMonths, monthGridRange, monthGridDates, GRID_WEEKS, WEEKDAYS_MONDAY_FIRST,
  padTime, minutesOfClock
} = require('./dates');
const { createAggregator, parsePlan, toPlanEntries } = require('./aggregate');
const { createDiary } = require('./diary');
const { createReviewService } = require('./reviewService');
const { readNote, writeNote, patchFrontmatterField } = require('./vault/note');
const { enqueueNote } = require('./vault/note-queue');

/**
 * 日历（月视图）。
 *
 * aggregate.js 开头写着「今日首页、deadline 时间轴、周回顾、每日简报是同一批
 * 数据的四种呈现」。日历是第五种，也是唯一二维的那种 —— 前四种都是一维列表，
 * 回答不了「哪一周最挤」，而排期时真正要看的就是这个。
 *
 * 所以这里**不引入新的事件实体**。格子里的东西全部来自已有的四个来源：
 *   截止与待办  ← aggregate.datedEntriesInRange（条目 frontmatter 的 deadline + 待办的 @日期）
 *   时间块      ← aggregate.readPlan（当天日记 frontmatter 的 plan）
 *   复习负荷    ← reviewService.forecast（FSRS 算好的 due 按本地日分桶）
 *   写没写日记  ← diary.trend
 *
 * 唯一的写入口是「给某天排一个时间块」，落到那天日记的 frontmatter 里 ——
 * 还是同一个数据源，不是第二份真相。
 */

// 一天最多在格子里显示几条，多的折成「+N」。格子高度有限，塞满了反而看不出哪天挤。
const CELL_ENTRY_LIMIT = 3;

const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

function formatBlock({ from, to, what }) {
  return from ? `${padTime(from)}-${padTime(to)} ${what}` : String(what);
}

function createCalendar({ config, db, indexer, now = () => new Date() }) {
  const aggregate = createAggregator({ config, db, now });
  const diary = createDiary({ db, config, now });
  const review = createReviewService({ vaultDir: config.vaultDir, device: config.device, now });

  const GRID_DAYS = GRID_WEEKS * 7;

  function today() {
    return toLocalDate(now());
  }

  /** 只给有日记的那几天读时间块 —— 没有日记就一定没有 plan，省掉几十次查询。 */
  function plansFor(dates, hasDiary) {
    const plans = new Map();
    for (const date of dates) {
      if (!hasDiary(date)) continue;
      const blocks = aggregate.readPlan(diary.diaryPath(date));
      if (blocks.length) plans.set(date, blocks);
    }
    return plans;
  }

  function groupByDate(entries) {
    const grouped = new Map();
    for (const entry of entries) {
      const list = grouped.get(entry.date);
      if (list) list.push(entry);
      else grouped.set(entry.date, [entry]);
    }
    return grouped;
  }

  /**
   * 一个月的网格。固定 6 行 × 7 列，周一起始（见 dates.js 的说明）。
   */
  async function month(monthString) {
    const current = today();
    const target = monthString || monthOf(current);
    const { from, to } = monthGridRange(target);
    const grid = monthGridDates(target);
    const dates = grid.flat();

    const entriesByDate = groupByDate(aggregate.datedEntriesInRange(from, to, current));

    // 预测窗口和网格完全对齐，包括网格里属于上/下个月的那几天。
    const forecast = await review.forecast({ from, days: GRID_DAYS, today: current });
    const reviewByDate = new Map(forecast.days.map(day => [day.date, day.count]));

    // trend(days, endDate) 从 endDate 往前数 days 天，正好覆盖整个网格。
    const diaryDates = new Set(
      diary.trend(GRID_DAYS, to).filter(day => day.hasEntry).map(day => day.date)
    );
    const plans = plansFor(dates, date => diaryDates.has(date));

    const weeks = grid.map(week => week.map(date => {
      const entries = entriesByDate.get(date) || [];
      const plan = plans.get(date) || [];
      const weekday = parseDate(date).getDay();
      return {
        date,
        dayOfMonth: Number(date.slice(8, 10)),
        inMonth: monthOf(date) === target,
        isToday: date === current,
        isWeekend: weekday === 0 || weekday === 6,
        weekday: weekdayOf(date),
        entries: entries.slice(0, CELL_ENTRY_LIMIT),
        overflow: Math.max(0, entries.length - CELL_ENTRY_LIMIT),
        entryCount: entries.length,
        plan,
        reviewDue: reviewByDate.get(date) || 0,
        hasDiary: diaryDates.has(date)
      };
    }));

    return {
      month: target,
      label: `${target.slice(0, 4)} 年 ${Number(target.slice(5, 7))} 月`,
      prevMonth: addMonths(target, -1),
      nextMonth: addMonths(target, 1),
      thisMonth: monthOf(current),
      today: current,
      from,
      to,
      weekdayHeaders: WEEKDAYS_MONDAY_FIRST,
      weeks,
      // 强度色要有个归一化基准。用整幅网格的最大值，翻月时颜色才有可比性。
      peakReview: forecast.peak,
      backlog: forecast.backlog,
      freshCards: forecast.fresh,
      totals: {
        entries: [...entriesByDate.values()].reduce((sum, list) => sum + list.length, 0),
        plan: [...plans.values()].reduce((sum, list) => sum + list.length, 0),
        reviewDue: forecast.scheduled
      }
    };
  }

  /** 某一天的详情，右侧栏和提醒调度器共用。 */
  async function day(dateString) {
    const current = today();
    const date = dateString || current;
    const entries = aggregate.datedEntriesInRange(date, date, current);
    const forecast = await review.forecast({ from: date, days: 1, today: current });
    const notePath = diary.diaryPath(date);

    let note = null;
    try {
      note = await readNote(config.notesDir, notePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const exists = Boolean(note);

    return {
      date,
      weekday: weekdayOf(date),
      isToday: date === current,
      isPast: date < current,
      daysFromToday: daysBetween(current, date),
      entries,
      plan: note ? parsePlan(note.data.plan) : [],
      reviewDue: forecast.days[0]?.count || 0,
      diary: { exists, path: notePath, hash: note?.hash || '' },
      onThisDay: diary.onThisDay(date)
    };
  }

  /**
   * 给某一天排一个时间块。
   *
   * 写进那天日记 frontmatter 的 plan 列表 —— 和「今天的计划」用的是同一个字段，
   * 首页、简报、日历看到的永远是同一份数据。日记不存在就按模板建一篇，
   * 这和 POST /diary/today 的行为一致。
   */
  async function addPlanBlock(date, { from = '', to = '', what = '', expectedHash = '' } = {}) {
    if (!isValidDateString(date)) throw new Error('日期格式不对，应为 YYYY-MM-DD。');

    const title = String(what).trim();
    if (!title) throw new Error('时间块的内容不能为空。');

    const start = String(from).trim();
    const end = String(to).trim();
    // 两个都空就是不带时间的一条；只填一个是笔误，不猜。
    if (Boolean(start) !== Boolean(end)) throw new Error('开始和结束时间要么都填，要么都不填。');
    if (start && (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end))) {
      throw new Error('时间格式不对，应为 HH:MM。');
    }

    const notePath = diary.diaryPath(date);
    const line = formatBlock({ from: start, to: end, what: title });
    const result = await enqueueNote(config.notesDir, notePath, async () => {
      let note = null;
      try {
        note = await readNote(config.notesDir, notePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (expectedHash && note?.hash !== expectedHash) {
        const error = new Error('这天的日记已被其它编辑修改，请刷新后重试。');
        error.status = 409;
        throw error;
      }

      const writePlan = async (current, options) => {
        const raw = current?.raw || diary.renderNewEntry(date);
        // 手写成标量的 plan 也要接住。以前只认数组，于是
        // `plan: 09:00-10:00 写论文` 会在这里被当成空列表，排新块时整条覆盖掉。
        const blocks = toPlanEntries(current?.data?.plan)
          .map(entry => String(entry ?? '').trim())
          .filter(Boolean);
        if (!blocks.includes(line)) blocks.push(line);
        // 按分钟数排，不按字符串：这些是原始行，里面可能有手写的 `9:00`，
        // 而 '9:00' > '10:00' 会把上午的块排到十点之后。没有时间的沉到末尾。
        blocks.sort((a, b) => {
          const timeA = minutesOfClock(a.match(/^(\d{1,2}:\d{2})/)?.[1]) ?? Infinity;
          const timeB = minutesOfClock(b.match(/^(\d{1,2}:\d{2})/)?.[1]) ?? Infinity;
          return timeA - timeB || a.localeCompare(b);
        });
        return writeNote(config.notesDir, notePath, {
          raw: patchFrontmatterField(raw, 'plan', blocks)
        }, options);
      };

      if (note) return { hash: (await writePlan(note)).hash };

      try {
        return { hash: (await writePlan(null, { exclusive: true })).hash };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      note = await readNote(config.notesDir, notePath);
      return { hash: (await writePlan(note)).hash };
    });
    await indexer.scan({ paths: [notePath] });

    return { date, path: notePath, block: line, hash: result.hash, plan: aggregate.readPlan(notePath) };
  }

  /**
   * 导出成 .ics 用的条目。
   *
   * 只导截止与时间块，不导每日复习量：那会在每一天塞一个「今天 47 张卡」的
   * 全天事件，把系统日历刷成噪音。复习负荷是排期时看的，不是要提醒的东西。
   */
  function icsEntries({ from, to, origin = '' } = {}) {
    const current = today();
    const start = from || addDays(current, -30);
    const end = to || addDays(current, 365);
    const entries = [];

    // key 决定 .ics 的 UID，日历客户端靠它认「是不是同一个事件」。
    // 凡是能区分两个条目的字段都要进来，漏一个就会让两条不同的事件共用一个 UID，
    // 导入时后者把前者顶掉。
    for (const entry of aggregate.datedEntriesInRange(start, end, current)) {
      entries.push({
        key: `deadline|${entry.source}|${entry.path}|${entry.date}|${entry.label}`,
        date: entry.date,
        summary: `${entry.label}（${entry.source}）`,
        description: entry.detail || '',
        categories: entry.source,
        url: origin && entry.path ? `${origin}/note/${entry.path.split('/').map(encodeURIComponent).join('/')}` : ''
      });
    }

    const diaryDates = diary.trend(daysBetween(start, end) + 1, end)
      .filter(day => day.hasEntry)
      .map(day => day.date);
    for (const date of diaryDates) {
      for (const block of aggregate.readPlan(diary.diaryPath(date))) {
        entries.push({
          key: `plan|${date}|${block.from}|${block.to}|${block.what}`,
          date,
          from: block.from,
          to: block.to,
          summary: block.what,
          categories: '时间块'
        });
      }
    }

    return entries.sort((a, b) => (
      a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.from || '').localeCompare(String(b.from || ''))
    ));
  }

  return { month, day, addPlanBlock, icsEntries, today };
}

module.exports = { createCalendar, formatBlock, padTime, CELL_ENTRY_LIMIT, TIME_PATTERN };
