const { toLocalDate, templateVariables, renderNamedTemplate } = require('./templates');
// 日期算术统一走 dates.js。这里保留 isValidDateString / weekdayOf / shiftDays 的
// 导出名不变，只是转成再导出 —— diaryRoutes 和测试都还在用这几个名字。
const { isValidDateString, weekdayOf, addDays: shiftDays } = require('./dates');

const DIARY_SECTION = 'diary';

// `section = 'diary'` 不等于「这是一篇日记」。
//
// diary/ 底下还躺着别的东西 —— 周回顾就存在 `diary/retro-2026-08-10.md`
// （todayRoutes 建议的就是这个路径）。只按 section 查，回顾笔记会混进日记列表和
// 「历年今日」：dateFromPath 认不出它，日期是空串，yearsAgo 算成 2026，
// 于是首页顶着一条「2026 年前的今天」。所以查询按「diary/ + 四位年 + 月日.md」
// 收窄；LIKE 里的 `_` 是单字符通配，连长度一起卡死。
const DIARY_PATH_LIKE = `${DIARY_SECTION}/____-__-__.md`;

// 打点字段的取值范围。超出范围当作没填，而不是画一根越界的柱子。
const MOOD_MIN = 1;
const MOOD_MAX = 5;

function diaryPath(dateString) {
  return `${DIARY_SECTION}/${dateString}.md`;
}

function dateFromPath(notePath) {
  const match = String(notePath ?? '').match(/^diary\/(\d{4}-\d{2}-\d{2})\.md$/);
  return match ? match[1] : '';
}

/** frontmatter 里的数值字段。空、非数字或越界都返回 null，表示「这天没打点」。 */
function readNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < min || number > max) return null;
  return number;
}

function parseData(dataJson) {
  try {
    return JSON.parse(dataJson || '{}') || {};
  } catch {
    return {};
  }
}

function createDiary({ db, config, now = () => new Date() }) {
  function today() {
    return toLocalDate(now());
  }

  /** 新日记的初始内容，按模板渲染。 */
  function renderNewEntry(dateString) {
    return renderNamedTemplate(config.vaultDir, 'diary', templateVariables(dateString));
  }

  function exists(dateString) {
    return Boolean(db.getNote(diaryPath(dateString)));
  }

  function list(limit = 60) {
    return db.raw.prepare(`
      SELECT path, title_raw AS title, data_json AS dataJson
      FROM notes WHERE section = ? AND path LIKE ? ORDER BY path DESC LIMIT ?
    `).all(DIARY_SECTION, DIARY_PATH_LIKE, limit).filter(row => dateFromPath(row.path)).map(row => {
      const data = parseData(row.dataJson);
      const date = dateFromPath(row.path);
      return {
        path: row.path,
        date,
        weekday: date ? weekdayOf(date) : '',
        title: row.title,
        mood: readNumber(data.mood, { min: MOOD_MIN, max: MOOD_MAX }),
        focusMinutes: readNumber(data.focus_minutes, { min: 0 })
      };
    });
  }

  /**
   * 历年今日：过去每一年的同月同日。
   *
   * 只按「月-日」后缀匹配，因为日记路径就是 diary/YYYY-MM-DD.md，
   * 后缀相同即同月同日。2 月 29 日在平年自然查不到，不用特殊处理。
   */
  function onThisDay(dateString = today()) {
    const suffix = dateString.slice(5);
    return db.raw.prepare(`
      SELECT path, title_raw AS title FROM notes
      WHERE section = ? AND path LIKE ? AND path != ?
      ORDER BY path DESC
    `).all(DIARY_SECTION, `${DIARY_SECTION}/____-${suffix}.md`, diaryPath(dateString))
      .map(row => ({ row, date: dateFromPath(row.path) }))
      // 认不出日期的一律丢掉：算不出 yearsAgo，硬算会得到「2026 年前的今天」。
      .filter(entry => entry.date)
      .map(({ row, date }) => {
        const yearsAgo = Number(dateString.slice(0, 4)) - Number(date.slice(0, 4));
        return {
          path: row.path,
          date,
          title: row.title,
          yearsAgo,
          label: yearsAgo === 1 ? '去年今日' : `${yearsAgo} 年前的今天`
        };
      })
      .filter(entry => entry.yearsAgo > 0);
  }

  /**
   * 近 N 天的打点序列。
   *
   * 每一天都出现在结果里，没写日记或没填字段的那天值为 null —— 图表要如实
   * 显示空缺，而不是把它画成 0，也不是跳过后让两根柱子挨在一起假装连续。
   */
  function trend(days = 30, endDate = today()) {
    const startDate = shiftDays(endDate, -(days - 1));
    const rows = db.raw.prepare(`
      SELECT path, data_json AS dataJson FROM notes
      WHERE section = ? AND path LIKE ? AND path >= ? AND path <= ?
    `).all(DIARY_SECTION, DIARY_PATH_LIKE, diaryPath(startDate), diaryPath(endDate));

    const byDate = new Map();
    for (const row of rows) {
      const date = dateFromPath(row.path);
      if (!date) continue;
      const data = parseData(row.dataJson);
      byDate.set(date, {
        mood: readNumber(data.mood, { min: MOOD_MIN, max: MOOD_MAX }),
        focusMinutes: readNumber(data.focus_minutes, { min: 0 })
      });
    }

    const series = [];
    for (let offset = 0; offset < days; offset += 1) {
      const date = shiftDays(startDate, offset);
      const entry = byDate.get(date) || { mood: null, focusMinutes: null };
      series.push({ date, weekday: weekdayOf(date), hasEntry: byDate.has(date), ...entry });
    }
    return series;
  }

  /** 趋势条上方的汇总数字。没有任何打点时返回 null，页面据此不渲染图表。 */
  function summarize(series) {
    const moods = series.map(d => d.mood).filter(v => v !== null);
    const focus = series.map(d => d.focusMinutes).filter(v => v !== null);
    const average = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

    return {
      entryCount: series.filter(d => d.hasEntry).length,
      moodCount: moods.length,
      focusCount: focus.length,
      moodAverage: average(moods),
      moodMax: moods.length ? Math.max(...moods) : null,
      focusAverage: average(focus),
      focusMax: focus.length ? Math.max(...focus) : null,
      focusTotal: focus.reduce((a, b) => a + b, 0)
    };
  }

  return {
    today, renderNewEntry, exists, list, onThisDay, trend, summarize,
    diaryPath, isValidDateString, weekdayOf, shiftDays
  };
}

module.exports = {
  createDiary,
  diaryPath,
  dateFromPath,
  isValidDateString,
  shiftDays,
  readNumber,
  DIARY_SECTION,
  MOOD_MIN,
  MOOD_MAX
};
