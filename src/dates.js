/**
 * 本地日期字符串的算术。
 *
 * 全项目的日期都是裸的 `YYYY-MM-DD` 本地日期串，没有时区概念 —— 这对一个
 * 单人单机的工作台是对的取舍，但前提是所有解析都走同一条路。这个模块就是那条路。
 *
 * 两条铁律，违反任何一条都会在东八区偏一天：
 *   1. 取「今天是哪天」用 templates.js 的 toLocalDate，不是 toISOString().slice(0,10)
 *   2. 把日期串变回 Date 用下面的 parseDate，不是 new Date('2026-08-06')
 *      —— 后者按 UTC 午夜解析。
 *
 * addDays / daysBetween 原先在 aggregate.js 和 diary.js 各有一份（diary 叫
 * shiftDays），逐字节相同。月视图还要月初月末和跨月，就趁这次收拢到一处。
 */
const { toLocalDate, WEEKDAYS } = require('./templates');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

/**
 * 月视图固定 6 行 × 7 列。
 *
 * 当月最少只占 4 行（平年二月且 1 号是周一），行数随月份变的话，翻月时整页高度
 * 会跳动 —— 而翻月正是这个页面最高频的操作。宁可多铺几天上月/下月的格子。
 */
const GRID_WEEKS = 6;

/** 周一为一周之首；WEEKDAYS 是周日开头的，这里转一次序。 */
const WEEKDAYS_MONDAY_FIRST = [...WEEKDAYS.slice(1), WEEKDAYS[0]];

const CLOCK_PATTERN = /^(\d{1,2}):([0-5]\d)$/;

/**
 * 一天之内的时刻，统一成 HH:MM。
 *
 * 时间块在 frontmatter 里是人手写的，`9:00` 和 `09:00` 都会出现。补零不是审美问题：
 * 这两个值到处都在被**字符串比较** —— 排序、判断时间块跨不跨零点。而
 * `'10:00' > '9:00'` 是假的（比的是 '1' 和 '9'），于是 `9:00-10:00` 会被判成
 * 跨了零点，导出的 .ics 里变成一个 25 小时的事件。补齐之后字典序才等于时间序。
 *
 * 认不出来的返回空串，让调用方按「没填时间」处理，不要拿一个半成品往下传。
 */
function padTime(value) {
  const match = CLOCK_PATTERN.exec(String(value ?? '').trim());
  if (!match) return '';
  const hour = Number(match[1]);
  if (hour > 23) return '';
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

/** HH:MM → 从零点起的分钟数，认不出返回 null。比较时刻先落到数字上最稳。 */
function minutesOfClock(value) {
  const padded = padTime(value);
  if (!padded) return null;
  return Number(padded.slice(0, 2)) * 60 + Number(padded.slice(3, 5));
}

/** YYYY-MM-DD → 本地午夜的 Date。见文件头第 2 条铁律。 */
function parseDate(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** 格式对还不够：2026-02-31 也是合法格式。往返构造一次才能挡掉不存在的日期。 */
function isValidDateString(value) {
  const text = String(value ?? '');
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isValidMonthString(value) {
  const text = String(value ?? '');
  if (!MONTH_PATTERN.test(text)) return false;
  const month = Number(text.slice(5, 7));
  return month >= 1 && month <= 12;
}

function addDays(dateString, days) {
  const date = parseDate(dateString);
  date.setDate(date.getDate() + days);
  return toLocalDate(date);
}

function daysBetween(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / 86_400_000);
}

function weekdayOf(dateString) {
  return WEEKDAYS[parseDate(dateString).getDay()];
}

function monthOf(dateString) {
  return String(dateString).slice(0, 7);
}

function startOfMonth(month) {
  return `${month}-01`;
}

/** 「下个月 0 号」就是这个月最后一天，闰年不用特判。 */
function endOfMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return toLocalDate(new Date(year, monthNumber, 0));
}

function addMonths(month, count) {
  const [year, monthNumber] = month.split('-').map(Number);
  // 月份给成 12 或 -1，Date 自己会滚到下一年/上一年。
  const date = new Date(year, monthNumber - 1 + count, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 网格覆盖的日期范围。首日往前退到那周的周一。 */
function monthGridRange(month) {
  const first = startOfMonth(month);
  const offset = (parseDate(first).getDay() + 6) % 7; // 周一为 0
  const from = addDays(first, -offset);
  return { from, to: addDays(from, GRID_WEEKS * 7 - 1), weeks: GRID_WEEKS };
}

/** 展开成 6×7 的日期串二维数组，往格子里塞什么是调用方的事。 */
function monthGridDates(month) {
  const { from } = monthGridRange(month);
  const weeks = [];
  for (let week = 0; week < GRID_WEEKS; week += 1) {
    const row = [];
    for (let day = 0; day < 7; day += 1) row.push(addDays(from, week * 7 + day));
    weeks.push(row);
  }
  return weeks;
}

module.exports = {
  padTime,
  minutesOfClock,
  parseDate,
  isValidDateString,
  isValidMonthString,
  addDays,
  daysBetween,
  weekdayOf,
  monthOf,
  startOfMonth,
  endOfMonth,
  addMonths,
  monthGridRange,
  monthGridDates,
  GRID_WEEKS,
  WEEKDAYS_MONDAY_FIRST
};
