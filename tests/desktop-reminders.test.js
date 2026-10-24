const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createReminders,
  clampLead,
  parseClock,
  TICK_INTERVAL_MS,
  DEFAULT_LEAD_MINUTES,
  GRACE_MINUTES,
  MORNING_HOUR
} = require('../electron/reminders');

/** 可控的定时器 + 通知收集器。updater 那边也是这个套路。 */
function harness({ agenda, at = new Date(2026, 7, 10, 8, 50), fetchAgenda } = {}) {
  const sent = [];
  const warnings = [];
  let current = at;
  let ticker = null;

  const reminders = createReminders({
    fetchAgenda: fetchAgenda || (async () => (typeof agenda === 'function' ? agenda() : agenda)),
    notify: options => sent.push(options),
    logger: { warn: message => warnings.push(message) },
    now: () => current,
    scheduleInterval: (callback, ms) => {
      ticker = { callback, ms };
      return ticker;
    },
    cancelInterval: () => { ticker = null; }
  });

  return {
    reminders,
    sent,
    warnings,
    titles: () => sent.map(item => item.title),
    setTime(date) { current = date; },
    hasTimer: () => Boolean(ticker),
    tickInterval: () => ticker?.ms,
    runTimer: () => ticker?.callback()
  };
}

const PLAN_AGENDA = {
  date: '2026-08-10',
  weekday: '周一',
  plan: [
    { from: '09:00', to: '11:00', what: '写引言' },
    { from: '14:00', to: '16:00', what: '跑回归' }
  ],
  entries: [],
  reviewDue: 0
};

test('时间块在提前量之内才提醒', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 50) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), ['写引言'], '09:00 的正好在 10 分钟内，14:00 的还早');
  assert.match(ui.sent[0].body, /10 分钟后/);
});

test('还没进入提前量就不提醒', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 40) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), [], '离 09:00 还有 20 分钟');
});

test('同一个时间块只提醒一次', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 51) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  ui.setTime(new Date(2026, 7, 10, 8, 55));
  await ui.reminders.tick();
  ui.setTime(new Date(2026, 7, 10, 8, 59));
  await ui.reminders.tick();

  assert.deepEqual(ui.titles(), ['写引言']);
});

test('刚开始几分钟内还补一条，再久就不打扰了', async () => {
  const justStarted = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 9, GRACE_MINUTES - 1) });
  justStarted.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });
  await justStarted.reminders.tick();
  assert.deepEqual(justStarted.titles(), ['写引言']);
  assert.match(justStarted.sent[0].body, /已经开始/);

  const tooLate = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 9, GRACE_MINUTES + 5) });
  tooLate.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });
  await tooLate.reminders.tick();
  assert.deepEqual(tooLate.titles(), [], '早就过去的事不该补发');
});

test('晚上打开应用不会被一整天的时间块轰炸', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 22, 0) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), []);
});

test('没有开始时间的计划提醒不了，但不影响别的', async () => {
  const ui = harness({
    agenda: {
      date: '2026-08-10',
      plan: [{ from: '', to: '', what: '有空就读文献' }, { from: '09:00', to: '11:00', what: '写引言' }],
      entries: []
    },
    at: new Date(2026, 7, 10, 8, 55)
  });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), ['写引言']);
});

test('当天有截止时早上汇总一条，太早不发', async () => {
  const agenda = {
    date: '2026-08-10',
    plan: [],
    entries: [
      { date: '2026-08-10', label: '交伦理审查材料', source: '待办' },
      { date: '2026-08-10', label: 'AER 投稿', source: '投稿追踪' }
    ]
  };

  const early = harness({ agenda, at: new Date(2026, 7, 10, MORNING_HOUR - 1, 30) });
  early.reminders.configure({ remindersEnabled: true });
  await early.reminders.tick();
  assert.deepEqual(early.titles(), [], '早上 9 点前不发');

  const morning = harness({ agenda, at: new Date(2026, 7, 10, MORNING_HOUR, 0) });
  morning.reminders.configure({ remindersEnabled: true });
  await morning.reminders.tick();
  assert.deepEqual(morning.titles(), ['今天有 2 项截止']);
  assert.equal(morning.sent[0].body, '交伦理审查材料、AER 投稿');

  // 也只发一次。
  morning.setTime(new Date(2026, 7, 10, 11, 0));
  await morning.reminders.tick();
  assert.equal(morning.sent.length, 1);
});

test('当天没有截止就不发汇总', async () => {
  const ui = harness({
    agenda: { date: '2026-08-10', plan: [], entries: [] },
    at: new Date(2026, 7, 10, 10, 0)
  });
  ui.reminders.configure({ remindersEnabled: true });
  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), []);
});

test('跨零点后重新开始，昨天发过的不挡住今天', async () => {
  let date = '2026-08-10';
  const ui = harness({
    agenda: () => ({ date, plan: [{ from: '09:00', to: '11:00', what: '写引言' }], entries: [] }),
    at: new Date(2026, 7, 10, 8, 55)
  });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  assert.equal(ui.sent.length, 1);

  // 第二天同一个时间、同样的时间块。
  date = '2026-08-11';
  ui.setTime(new Date(2026, 7, 11, 8, 55));
  await ui.reminders.tick();

  assert.equal(ui.sent.length, 2, '换了一天就该重新提醒');
  assert.deepEqual(ui.titles(), ['写引言', '写引言']);
});

test('议程日期和本地今天对不上时跳过这一轮', async () => {
  const ui = harness({
    // 服务端说是 11 号，本地时钟还在 10 号 —— 分钟差算出来会是错的。
    agenda: { date: '2026-08-11', plan: [{ from: '09:00', to: '11:00', what: '写引言' }], entries: [] },
    at: new Date(2026, 7, 10, 8, 55)
  });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), []);
});

test('关掉时不装定时器，也不发通知', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 55) });
  ui.reminders.configure({ remindersEnabled: false });

  assert.equal(ui.hasTimer(), false);
  assert.equal(ui.reminders.getState().enabled, false);
  await ui.reminders.tick();
  assert.deepEqual(ui.titles(), []);
});

test('打开时装一个一分钟的定时器，stop 之后撤掉', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 55) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  assert.equal(ui.hasTimer(), true);
  assert.equal(ui.tickInterval(), TICK_INTERVAL_MS);
  assert.deepEqual(ui.reminders.getState(), { enabled: true, leadMinutes: 10 });

  ui.reminders.stop();
  assert.equal(ui.hasTimer(), false);
});

test('定时器触发时真的会去判断', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 55) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await ui.runTimer();
  assert.deepEqual(ui.titles(), ['写引言']);
});

test('重新配置不会重复装定时器', async () => {
  const ui = harness({ agenda: PLAN_AGENDA });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 20 });

  assert.equal(ui.reminders.getState().leadMinutes, 20);
  assert.equal(ui.hasTimer(), true);
});

test('改设置不会把今天已经发过的再发一遍', async () => {
  const ui = harness({ agenda: PLAN_AGENDA, at: new Date(2026, 7, 10, 8, 55) });
  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });
  await ui.reminders.tick();
  assert.equal(ui.sent.length, 1);

  ui.reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 15 });
  await ui.reminders.tick();
  assert.equal(ui.sent.length, 1, '重配之后同一条不该再来一次');
});

test('拉议程失败只记一条日志，不抛出去', async () => {
  const ui = harness({
    fetchAgenda: async () => { throw new Error('connect ECONNREFUSED'); },
    at: new Date(2026, 7, 10, 8, 55)
  });
  ui.reminders.configure({ remindersEnabled: true });

  await assert.doesNotReject(() => ui.reminders.tick());
  assert.deepEqual(ui.titles(), []);
  assert.equal(ui.warnings.length, 1);
  assert.match(ui.warnings[0], /拉取议程失败/);
});

test('通知本身发失败也不会让这一轮崩掉', async () => {
  const sent = [];
  const warnings = [];
  const reminders = createReminders({
    fetchAgenda: async () => PLAN_AGENDA,
    notify: () => { throw new Error('系统关闭了通知'); },
    logger: { warn: message => warnings.push(message) },
    now: () => new Date(2026, 7, 10, 8, 55),
    scheduleInterval: () => ({}),
    cancelInterval: () => {}
  });
  reminders.configure({ remindersEnabled: true, reminderLeadMinutes: 10 });

  await assert.doesNotReject(() => reminders.tick());
  assert.equal(sent.length, 0);
  assert.match(warnings[0], /发送通知失败/);
});

test('议程是空的或缺字段时安静跳过', async () => {
  for (const agenda of [null, undefined, {}, { date: '' }, { date: '2026-08-10' }]) {
    const ui = harness({ agenda, at: new Date(2026, 7, 10, 10, 0) });
    ui.reminders.configure({ remindersEnabled: true });
    await assert.doesNotReject(() => ui.reminders.tick());
    assert.deepEqual(ui.titles(), []);
  }
});

test('提前量被夹在 1..120 之间', () => {
  assert.equal(clampLead(10), 10);
  assert.equal(clampLead(0), 1);
  assert.equal(clampLead(-5), 1);
  assert.equal(clampLead(999), 120);
  assert.equal(clampLead('30'), 30);
  assert.equal(clampLead('abc'), DEFAULT_LEAD_MINUTES);
  assert.equal(clampLead(undefined), DEFAULT_LEAD_MINUTES);
  assert.equal(clampLead(10.6), 11);
});

test('时刻解析', () => {
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('9:00'), 540);
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('09:60'), null);
  assert.equal(parseClock('9'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(null), null);
});
