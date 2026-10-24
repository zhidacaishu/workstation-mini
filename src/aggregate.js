const { toLocalDate } = require('./templates');
const { addDays } = require('./dates');
const { createReviewService } = require('./reviewService');
const { createItems } = require('./items');
const { sortTasks, summarize } = require('./tasks');

const DEADLINE_HORIZON_DAYS = 21;

function asDateString(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function createAggregator({ config, db, now = () => new Date() }) {
  const review = createReviewService({ vaultDir: config.vaultDir, device: config.device, now });
  const items = createItems({ db, notesDir: config.notesDir });

  function datedEntries(today = toLocalDate(now())) {
    const entries = [];
    for (const item of items.list('experiment')) {
      const date = asDateString(item.data.deadline);
      if (!date) continue;
      entries.push({ date, label: item.title, detail: item.data.dataset ? String(item.data.dataset) : '研究项目', source: '研究项目', path: item.path, overdue: date < today });
    }
    for (const task of db.listTasks()) {
      if (!task.due) continue;
      entries.push({ date: task.due, label: task.title, detail: task.noteTitle, source: '待办', path: task.path, overdue: task.due < today });
    }
    return entries;
  }
  function byDateThenLabel(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label); }
  function deadlines(today = toLocalDate(now()), horizonDays = DEADLINE_HORIZON_DAYS) {
    const horizon = addDays(today, horizonDays);
    return datedEntries(today).filter(entry => entry.overdue || entry.date <= horizon).sort(byDateThenLabel);
  }
  function datedEntriesInRange(from, to, today = toLocalDate(now())) {
    return datedEntries(today).filter(entry => entry.date >= from && entry.date <= to).sort(byDateThenLabel);
  }
  function attention() {
    const projects = items.list('experiment');
    return {
      plannedProjects: projects.filter(item => item.status === 'planned'),
      runningExperiments: projects.filter(item => item.status === 'running')
    };
  }
  async function today() {
    const date = toLocalDate(now());
    const queue = await review.queue({});
    const allTasks = db.listTasks();
    const taskStats = summarize(db.listTasks({ includeDone: true }), date);
    return {
      date,
      weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(now()),
      review: { due: queue.due.length, fresh: queue.fresh.length, total: queue.cards.length },
      tasks: { ...taskStats, top: sortTasks(allTasks, date).slice(0, 8) },
      deadlines: deadlines(date).slice(0, 8),
      attention: attention()
    };
  }
  return { today, deadlines, datedEntries, datedEntriesInRange, attention, addDays, daysBetween: (from, to) => Math.round((new Date(to) - new Date(from)) / 86400000) };
}

module.exports = { createAggregator, asDateString, DEADLINE_HORIZON_DAYS };
