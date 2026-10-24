const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDate,
  isValidDateString,
  isValidMonthString,
  addDays,
  daysBetween,
  weekdayOf,
  startOfMonth,
  endOfMonth,
  addMonths,
  monthGridRange,
  monthGridDates,
  GRID_WEEKS,
  WEEKDAYS_MONDAY_FIRST
} = require('../src/dates');

test('parseDate 按本地午夜构造，不走 UTC', () => {
  const date = parseDate('2026-08-10');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 10);
  assert.equal(date.getHours(), 0);
});

test('isValidDateString 挡掉格式对但不存在的日期', () => {
  assert.equal(isValidDateString('2026-08-10'), true);
  assert.equal(isValidDateString('2024-02-29'), true, '闰年 2 月 29 日存在');
  assert.equal(isValidDateString('2026-02-29'), false, '平年没有 2 月 29 日');
  assert.equal(isValidDateString('2026-02-31'), false);
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('2026-8-10'), false, '必须补零');
  assert.equal(isValidDateString(''), false);
  assert.equal(isValidDateString(null), false);
});

test('isValidMonthString 只认 YYYY-MM 且月份在 1..12', () => {
  assert.equal(isValidMonthString('2026-08'), true);
  assert.equal(isValidMonthString('2026-12'), true);
  assert.equal(isValidMonthString('2026-00'), false);
  assert.equal(isValidMonthString('2026-13'), false);
  assert.equal(isValidMonthString('2026-08-10'), false);
  assert.equal(isValidMonthString('2026-8'), false);
});

test('addDays 跨月、跨年、跨闰日都对', () => {
  assert.equal(addDays('2026-08-10', 1), '2026-08-11');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29', '闰年');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01', '平年');
  assert.equal(addDays('2026-08-10', 0), '2026-08-10');
});

test('daysBetween 是有向的天数差', () => {
  assert.equal(daysBetween('2026-08-10', '2026-08-10'), 0);
  assert.equal(daysBetween('2026-08-10', '2026-08-17'), 7);
  assert.equal(daysBetween('2026-08-17', '2026-08-10'), -7);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2, '闰年多一天');
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
});

test('weekdayOf 给中文星期', () => {
  assert.equal(weekdayOf('2026-08-10'), '周一');
  assert.equal(weekdayOf('2026-08-16'), '周日');
});

test('月份边界：startOfMonth / endOfMonth / addMonths', () => {
  assert.equal(startOfMonth('2026-08'), '2026-08-01');
  assert.equal(endOfMonth('2026-08'), '2026-08-31');
  assert.equal(endOfMonth('2026-09'), '2026-09-30');
  assert.equal(endOfMonth('2026-02'), '2026-02-28');
  assert.equal(endOfMonth('2024-02'), '2024-02-29', '闰年二月');

  assert.equal(addMonths('2026-08', 1), '2026-09');
  assert.equal(addMonths('2026-12', 1), '2027-01', '跨年往后');
  assert.equal(addMonths('2026-01', -1), '2025-12', '跨年往前');
  assert.equal(addMonths('2026-08', 0), '2026-08');
  assert.equal(addMonths('2026-08', 12), '2027-08');
});

test('月网格从周一起，固定 6 行 42 天', () => {
  // 2026-08-01 是周六，往前退到 2026-07-27（周一）。
  const range = monthGridRange('2026-08');
  assert.equal(range.from, '2026-07-27');
  assert.equal(range.weeks, GRID_WEEKS);
  assert.equal(daysBetween(range.from, range.to) + 1, GRID_WEEKS * 7);
  assert.equal(weekdayOf(range.from), '周一');

  const weeks = monthGridDates('2026-08');
  assert.equal(weeks.length, 6);
  assert.ok(weeks.every(week => week.length === 7));
  assert.equal(weeks[0][0], '2026-07-27');
  assert.equal(weeks[5][6], '2026-09-06');
  // 整月必须完整落在网格内。
  assert.ok(weeks.flat().includes('2026-08-01'));
  assert.ok(weeks.flat().includes('2026-08-31'));
});

test('1 号正好是周一时不多退一周', () => {
  // 2026-06-01 是周一。
  assert.equal(weekdayOf('2026-06-01'), '周一');
  assert.equal(monthGridRange('2026-06').from, '2026-06-01');
});

test('固定 6 行：即使当月只需要 4 行也铺满 42 天', () => {
  // 2027-02-01 是周一，平年二月 28 天，正好 4 行就装得下。
  assert.equal(weekdayOf('2027-02-01'), '周一');
  const weeks = monthGridDates('2027-02');
  assert.equal(weeks.length, 6, '行数不随月份变，翻月时页面高度才不跳');
  assert.equal(weeks.flat().length, 42);
});

test('周一开头的星期表头', () => {
  assert.deepEqual(WEEKDAYS_MONDAY_FIRST, ['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
});
