const { toLocalDate } = require('../src/templates');

/**
 * 到点提醒。
 *
 * 这是应用里第一个真正意义上的「定时任务」——之前只有 15 分钟一次的 Git 同步和
 * 6 小时一次的更新检查，那两个都不关心现在几点。所以这里有几个别处没遇到过的问题：
 *
 * **不累加计数器。** 每次 tick 都拿墙上时钟重新算「还有几分钟」，而不是维护一个
 * 倒计时。笔记本合盖再打开，setInterval 的节奏早就乱了，但重新算的结果永远是对的。
 *
 * **跨零点要换一天。** 议程是按日拉的，日期一变就把「已发过」的集合清空，
 * 否则昨天 09:00 的时间块会挡住今天 09:00 的提醒。
 *
 * **不补发陈年旧账。** 只提醒即将开始（lead 分钟内）或刚过去几分钟的事。
 * 少了这条，晚上打开应用会被一整天的时间块轰炸一遍。
 *
 * 整个模块不 require electron：通知怎么发、点了往哪跳都由调用方注入。
 * 这样它能在普通 node 里跑测试，而这类「什么时候该发」的逻辑恰恰最需要测。
 */

const TICK_INTERVAL_MS = 60_000;

// 提前多久提醒时间块。用户可改，这是缺省值。
const DEFAULT_LEAD_MINUTES = 10;
const MIN_LEAD_MINUTES = 1;
const MAX_LEAD_MINUTES = 120;

// 刚过去这么久之内的事还提醒一下（应用刚启动、或机器刚唤醒的场景）。
// 再久就不提了 —— 那不是提醒，是打扰。
const GRACE_MINUTES = 5;

// 当天截止的汇总在早上发一次。太早发人还没坐下，太晚发就失去意义了。
const MORNING_HOUR = 9;

function clampLead(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return DEFAULT_LEAD_MINUTES;
  return Math.min(Math.max(minutes, MIN_LEAD_MINUTES), MAX_LEAD_MINUTES);
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 'HH:MM' → 从零点起的分钟数；解析不了返回 null。 */
function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function createReminders({
  fetchAgenda,
  notify = () => {},
  logger = console,
  now = () => new Date(),
  scheduleInterval = setInterval,
  cancelInterval = clearInterval
} = {}) {
  let enabled = false;
  let leadMinutes = DEFAULT_LEAD_MINUTES;
  let timer = null;

  // 「今天已经发过哪些」。跨日清空。故意只放在内存里：进程重启最多重复一条，
  // 而为它引一个持久化文件要处理损坏、并发和清理，代价大于收益。
  let firedDate = '';
  let fired = new Set();

  function getState() {
    return { enabled, leadMinutes };
  }

  function rollDate(date) {
    if (date === firedDate) return;
    firedDate = date;
    fired = new Set();
  }

  function send(key, options) {
    if (fired.has(key)) return false;
    fired.add(key);
    try {
      notify(options);
    } catch (error) {
      // 通知发不出去（系统关了通知、AUMID 没注册……）不该影响后面的判断，
      // 更不该让 tick 抛出去把定时器带崩。
      logger.warn?.(`[reminder] 发送通知失败：${error.message}`);
    }
    return true;
  }

  /**
   * 跑一轮判断。定时器和「唤醒后补一次」都调它。
   * 返回这一轮发出去的提醒（测试用；正常调用方不关心）。
   */
  async function tick() {
    if (!enabled || typeof fetchAgenda !== 'function') return [];

    let agenda;
    try {
      agenda = await fetchAgenda();
    } catch (error) {
      // 本地服务可能正在重启（改设置会重建 runtime）。记一条就够，下一轮再试。
      logger.warn?.(`[reminder] 拉取议程失败：${error.message}`);
      return [];
    }
    if (!agenda || !agenda.date) return [];

    const current = now();
    // 拉取和处理之间跨了零点，或者服务端和本地对「今天」的判断不一致时，
    // 这一轮的分钟数算出来是错的。宁可跳过一轮。
    if (agenda.date !== toLocalDate(current)) return [];

    rollDate(agenda.date);
    const nowMinutes = minutesOfDay(current);
    const sent = [];

    for (const block of Array.isArray(agenda.plan) ? agenda.plan : []) {
      const start = parseClock(block.from);
      if (start === null) continue; // 没有时间的计划提醒不了

      const until = start - nowMinutes;
      if (until > leadMinutes || until < -GRACE_MINUTES) continue;

      // 结束时间也进 key：同一天同一开始时间同名的两个块（09:00-10:00 和
      // 09:00-11:00）否则会共用一条「已发过」记录，第二个永远提醒不出来。
      const key = `${agenda.date}|plan|${block.from}|${block.to}|${block.what}`;
      const body = until > 0 ? `${until} 分钟后 · ${block.from}–${block.to}` : `${block.from}–${block.to} 已经开始`;
      if (send(key, { title: block.what, body, date: agenda.date })) {
        sent.push(key);
      }
    }

    const entries = Array.isArray(agenda.entries) ? agenda.entries : [];
    if (entries.length && nowMinutes >= MORNING_HOUR * 60) {
      const key = `${agenda.date}|deadlines`;
      const title = entries.length === 1 ? '今天有 1 项截止' : `今天有 ${entries.length} 项截止`;
      const body = entries.map(entry => entry.label).join('、');
      if (send(key, { title, body, date: agenda.date })) sent.push(key);
    }

    return sent;
  }

  function stop() {
    if (timer) cancelInterval(timer);
    timer = null;
  }

  /** 按当前设置重新配置。设置里改了开关或提前量就再调一次。 */
  function configure({ remindersEnabled, reminderLeadMinutes } = {}) {
    stop();
    enabled = Boolean(remindersEnabled);
    leadMinutes = clampLead(reminderLeadMinutes);

    if (!enabled) return getState();

    // 换了资料库/重启了运行时之后，已发集合应该重新开始 —— 但同一天内不该
    // 因为改了个无关设置就把今天发过的再发一遍，所以这里不清空 fired。
    timer = scheduleInterval(() => { tick(); }, TICK_INTERVAL_MS);
    timer?.unref?.();
    return getState();
  }

  return { configure, tick, stop, getState };
}

module.exports = {
  createReminders,
  clampLead,
  parseClock,
  TICK_INTERVAL_MS,
  DEFAULT_LEAD_MINUTES,
  MIN_LEAD_MINUTES,
  MAX_LEAD_MINUTES,
  GRACE_MINUTES,
  MORNING_HOUR
};
