const test = require('node:test');
const assert = require('node:assert/strict');

const { renderCalendar, foldLine, escapeText, uidFor } = require('../src/ics');

const STAMP = new Date('2026-08-10T09:30:00.000Z');

function render(entries, options = {}) {
  return renderCalendar(entries, { dtstamp: STAMP, ...options });
}

/** 把折行还原回逻辑行：续行以一个空格开头。 */
function unfold(text) {
  return text.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
}

test('骨架完整，用 CRLF，末尾有换行', () => {
  const text = render([]);
  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  assert.ok(text.includes('VERSION:2.0\r\n'));
  assert.ok(text.includes('CALSCALE:GREGORIAN\r\n'));
  assert.equal(text.includes('\n\n'), false);
  // 不能出现裸 LF：每个 \n 前面都必须是 \r。
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') assert.equal(text[index - 1], '\r', `位置 ${index} 是裸 LF`);
  }
});

test('全天事件用 VALUE=DATE，DTEND 是次日（开区间）', () => {
  const lines = unfold(render([{ date: '2026-08-10', summary: '投稿截止' }]));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20260810'));
  assert.ok(lines.includes('DTEND;VALUE=DATE:20260811'));
  assert.ok(lines.includes('SUMMARY:投稿截止'));
  assert.equal(lines.some(line => line.startsWith('DTSTART:')), false, '全天事件不该有定时的 DTSTART');
});

test('定时事件用浮动本地时间，不带 Z 也不带 TZID', () => {
  const lines = unfold(render([
    { date: '2026-08-10', from: '09:00', to: '11:00', summary: '写引言' }
  ]));
  assert.ok(lines.includes('DTSTART:20260810T090000'));
  assert.ok(lines.includes('DTEND:20260810T110000'));
  assert.equal(lines.some(line => /^DTSTART.*Z$/.test(line)), false, '不能是 UTC');
  assert.equal(lines.some(line => line.includes('TZID')), false, '不能带 TZID');
});

test('单位数小时补零', () => {
  const lines = unfold(render([{ date: '2026-08-10', from: '9:00', to: '9:30', summary: '组会' }]));
  assert.ok(lines.includes('DTSTART:20260810T090000'));
  assert.ok(lines.includes('DTEND:20260810T093000'));
});

test('跨零点的时间块，DTEND 落到次日', () => {
  const lines = unfold(render([
    { date: '2026-08-10', from: '23:00', to: '01:00', summary: '跑实验' }
  ]));
  assert.ok(lines.includes('DTSTART:20260810T230000'));
  assert.ok(lines.includes('DTEND:20260811T010000'), '否则结束早于开始，客户端会当成错误数据');
});

test('DTSTAMP 是 UTC，格式合法', () => {
  const lines = unfold(render([{ date: '2026-08-10', summary: 'x' }]));
  assert.ok(lines.includes('DTSTAMP:20260810T093000Z'));
});

test('TEXT 转义：反斜杠、分号、逗号、换行', () => {
  assert.equal(escapeText('a\\b'), 'a\\\\b');
  assert.equal(escapeText('a;b'), 'a\\;b');
  assert.equal(escapeText('a,b'), 'a\\,b');
  assert.equal(escapeText('a\nb'), 'a\\nb');
  assert.equal(escapeText('a\r\nb'), 'a\\nb');
  // 反斜杠必须最先处理，否则 ; 转义补出来的反斜杠会被再转一次。
  assert.equal(escapeText('a\\;b'), 'a\\\\\\;b');
  // 冒号在 TEXT 值里不需要转义。
  assert.equal(escapeText('9:00 开会'), '9:00 开会');
});

test('转义后的内容出现在 SUMMARY 里', () => {
  const lines = unfold(render([{ date: '2026-08-10', summary: '实验 A, B; 见 note\\draft' }]));
  assert.ok(lines.includes('SUMMARY:实验 A\\, B\\; 见 note\\\\draft'));
});

test('折行按字节算，中文不会被劈成半个字', () => {
  const long = '截止'.repeat(60);
  const folded = foldLine(`SUMMARY:${long}`);
  const physical = folded.split('\r\n');
  assert.ok(physical.length > 1, '这么长必须折');
  for (const line of physical) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `一行 ${Buffer.byteLength(line, 'utf8')} 字节，超了`);
  }
  for (const line of physical.slice(1)) {
    assert.ok(line.startsWith(' '), '续行必须以空格开头');
  }
  // 还原后必须和原文完全一致 —— 说明没有字符被劈开或丢掉。
  assert.equal(physical.map((line, index) => (index ? line.slice(1) : line)).join(''), `SUMMARY:${long}`);
});

test('短行不折', () => {
  assert.equal(foldLine('SUMMARY:短'), 'SUMMARY:短');
  assert.equal(foldLine('SUMMARY:短').includes('\r\n'), false);
});

test('UID 稳定：同样的输入两次导出逐字节相同', () => {
  const entries = [
    { date: '2026-08-10', summary: '投稿截止', key: 'submissions/aer.md|2026-08-10' },
    { date: '2026-08-12', from: '09:00', to: '11:00', summary: '写引言', key: 'diary/2026-08-12.md|09:00' }
  ];
  assert.equal(render(entries), render(entries), '两次输出必须完全一样，否则重新导入会产生重复条目');
});

test('UID 由内容派生，不同条目不同、同内容相同', () => {
  assert.equal(uidFor('a'), uidFor('a'));
  assert.notEqual(uidFor('a'), uidFor('b'));
  assert.match(uidFor('a'), /^[0-9a-f]{32}@workstation\.local$/);
});

test('没给 key 时按日期+时间+标题派生 UID，仍然稳定', () => {
  const entry = { date: '2026-08-10', from: '09:00', to: '10:00', summary: '组会' };
  const first = unfold(render([entry])).find(line => line.startsWith('UID:'));
  const second = unfold(render([{ ...entry }])).find(line => line.startsWith('UID:'));
  assert.equal(first, second);
  assert.match(first, /^UID:[0-9a-f]{32}@workstation\.local$/);
});

test('可选字段只在有值时出现', () => {
  const bare = unfold(render([{ date: '2026-08-10', summary: 'x' }]));
  assert.equal(bare.some(line => line.startsWith('DESCRIPTION:')), false);
  assert.equal(bare.some(line => line.startsWith('LOCATION:')), false);
  assert.equal(bare.some(line => line.startsWith('URL:')), false);

  const full = unfold(render([{
    date: '2026-08-10', summary: 'x', description: '说明', location: '办公室',
    categories: '待办', url: 'http://127.0.0.1/note/a.md'
  }]));
  assert.ok(full.includes('DESCRIPTION:说明'));
  assert.ok(full.includes('LOCATION:办公室'));
  assert.ok(full.includes('CATEGORIES:待办'));
  assert.ok(full.includes('URL:http://127.0.0.1/note/a.md'));
});

test('每个 VEVENT 都成对，且都带 UID 与 DTSTAMP', () => {
  const lines = unfold(render([
    { date: '2026-08-10', summary: 'a' },
    { date: '2026-08-11', from: '09:00', to: '10:00', summary: 'b' },
    { date: '2026-08-12', summary: 'c' }
  ]));
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 3);
  assert.equal(lines.filter(line => line === 'END:VEVENT').length, 3);
  assert.equal(lines.filter(line => line.startsWith('UID:')).length, 3);
  assert.equal(lines.filter(line => line.startsWith('DTSTAMP:')).length, 3);
  // UID 必须互不相同。
  const uids = lines.filter(line => line.startsWith('UID:'));
  assert.equal(new Set(uids).size, 3);
});

test('日历名字被转义，不会破坏文件结构', () => {
  const lines = unfold(render([], { name: '工作台; 全部' }));
  assert.ok(lines.includes('X-WR-CALNAME:工作台\\; 全部'));
});

test('时刻按分钟数比较，手写的单位数小时不会被当成跨零点', () => {
  // `9:00-10:00` 在 frontmatter 里是完全正常的手写法。按字符串比的话
  // '10:00' > '9:00' 为假，这块会被判成跨了零点，导出成一个 25 小时的事件。
  const lines = unfold(render([
    { date: '2026-08-15', from: '9:00', to: '10:00', summary: '写论文' }
  ]));
  assert.ok(lines.includes('DTSTART:20260815T090000'));
  assert.ok(lines.includes('DTEND:20260815T100000'), '结束时间必须还在同一天');
});

test('真正跨零点的时间块仍然滚到次日', () => {
  const lines = unfold(render([
    { date: '2026-08-15', from: '23:00', to: '01:00', summary: '夜间实验' }
  ]));
  assert.ok(lines.includes('DTSTART:20260815T230000'));
  assert.ok(lines.includes('DTEND:20260816T010000'));
});

test('同起始同标题但时长不同的两个块，UID 必须不同', () => {
  // key 里漏掉结束时间的话两者算出同一个 UID，导入日历时后者把前者顶掉。
  assert.notEqual(
    uidFor('plan|2026-08-15|09:00|10:00|写论文'),
    uidFor('plan|2026-08-15|09:00|11:00|写论文')
  );
});
