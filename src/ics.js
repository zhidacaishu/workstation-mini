/**
 * iCalendar（RFC 5545）序列化。纯函数，零依赖。
 *
 * **时区取舍：定时事件用「浮动时间」——不带 Z、也不带 TZID。**
 * 浮动时间的语义是「就按看它的那台设备的本地时间算」。这正好是这个应用的
 * 现实：单人、单时区，日程本来就写成「09:00-11:00」而不是某个绝对瞬间。
 * 代价是带着日历飞去另一个时区，时间块会跟着当地时间走 —— 对时间块（今天上午
 * 干什么）来说这是对的，比为了严谨而打包一整段 VTIMEZONE 划算得多。
 * 截止日期是全天事件，本来就没有时区问题。
 *
 * UID 必须稳定且不含随机数：日历客户端靠 UID 认「是不是同一个事件」。
 * 每次导出换一批 UID 的话，重新导入就会得到一堆重复条目而不是更新。
 */
const { createHash } = require('node:crypto');

const { addDays, minutesOfClock } = require('./dates');

// RFC 5545：一行不超过 75 个八位组（不含换行）。注意是**字节**不是字符 ——
// 中文一个字三个字节，按字符折会超长。
const MAX_OCTETS = 75;

const PRODUCT_ID = '-//research workstation//calendar//CN';

/** 续行以一个空格开头，而那个空格也算在 75 里，所以续行内容只剩 74。 */
function foldLine(line) {
  const pieces = [];
  let current = '';
  let bytes = 0;
  let limit = MAX_OCTETS;

  // 按码点迭代（不是按 UTF-16 码元），免得把一个字符劈成两半。
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > limit) {
      pieces.push(current);
      current = '';
      bytes = 0;
      limit = MAX_OCTETS - 1;
    }
    current += char;
    bytes += size;
  }
  pieces.push(current);
  return pieces.join('\r\n ');
}

/** TEXT 值里的转义。反斜杠必须第一个换，否则会把后面补的反斜杠再转一遍。 */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|[\r\n]/g, '\\n');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 2026-08-10 → 20260810 */
function icsDate(dateString) {
  return String(dateString).replace(/-/g, '');
}

/** 2026-08-10 + 9:00 → 20260810T090000（浮动时间，见文件头） */
function icsDateTime(dateString, time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return `${icsDate(dateString)}T${pad2(hour)}${pad2(minute)}00`;
}

/** DTSTAMP 必须是 UTC，它记的是「这份文件什么时候生成的」，不是日程时间。 */
function icsTimestamp(date) {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * 由内容派生 UID。同样的条目永远得到同样的 UID，重新导入才是「更新」而不是「新增」。
 * 用哈希而不是原文：路径和标题里有中文、斜杠和空格，哈希省掉一整类转义问题。
 */
function uidFor(key) {
  return `${createHash('sha1').update(String(key), 'utf8').digest('hex').slice(0, 32)}@workstation.local`;
}

/**
 * 一个条目 → 一段 VEVENT 的行。
 *
 * `from`/`to` 是 HH:MM 就是定时事件，缺省就是全天事件。
 * 全天事件补一个 DTEND（次日，按 RFC 是开区间）—— 少数客户端没有 DTEND
 * 时会把单日事件画歪。
 */
function eventLines(entry, dtstamp) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${entry.uid || uidFor(entry.key ?? `${entry.date}|${entry.from || ''}|${entry.summary}`)}`);
  lines.push(`DTSTAMP:${dtstamp}`);

  if (entry.from) {
    lines.push(`DTSTART:${icsDateTime(entry.date, entry.from)}`);
    // 结束时间不晚于开始时间，说明这一块跨了零点（"23:00-01:00"）。
    //
    // 比分钟数，不比字符串：时刻可能是手写的 `9:00`，而 '10:00' > '9:00' 是假的，
    // 于是一个普通的上午时间块会被判成跨零点，导出成 25 小时的事件。
    const startMinutes = minutesOfClock(entry.from);
    const endMinutes = minutesOfClock(entry.to);
    const crossesMidnight = startMinutes === null || endMinutes === null || endMinutes <= startMinutes;
    const endDate = crossesMidnight ? addDays(entry.date, 1) : entry.date;
    if (entry.to) lines.push(`DTEND:${icsDateTime(endDate, entry.to)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(entry.date)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(entry.endDate || entry.date, 1))}`);
  }

  lines.push(`SUMMARY:${escapeText(entry.summary)}`);
  if (entry.description) lines.push(`DESCRIPTION:${escapeText(entry.description)}`);
  if (entry.location) lines.push(`LOCATION:${escapeText(entry.location)}`);
  if (entry.categories) lines.push(`CATEGORIES:${escapeText(entry.categories)}`);
  if (entry.url) lines.push(`URL:${escapeText(entry.url)}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * 整份日历。
 *
 * dtstamp 由调用方传（默认当前时刻）—— 固定住它，同样的输入就得到逐字节
 * 相同的输出，测试才能断言稳定性。
 */
function renderCalendar(entries = [], { name = '科研工作台', dtstamp = new Date(), prodId = PRODUCT_ID } = {}) {
  const stamp = icsTimestamp(dtstamp);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    // X-WR-CALNAME 不是标准的一部分，但所有主流客户端都用它显示日历名字。
    `X-WR-CALNAME:${escapeText(name)}`
  ];
  for (const entry of entries) lines.push(...eventLines(entry, stamp));
  lines.push('END:VCALENDAR');

  // RFC 5545 要求 CRLF，且最后一行也要有换行。
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { renderCalendar, foldLine, escapeText, uidFor, icsDate, icsDateTime, PRODUCT_ID };
