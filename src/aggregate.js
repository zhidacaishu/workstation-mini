const { toLocalDate } = require('./templates');
const { createReviewService } = require('./reviewService');
const { createItems } = require('./items');
const { sortTasks, summarize } = require('./tasks');
const { toDateString } = require('./viewHelpers');

// 已完成、已放弃的研究项目不再有截止压力：看板和阅读页都按非活跃处理，
// 计划页和月历也不该再把它们的期限标成逾期。
const INACTIVE_PROJECT = new Set(['done', 'abandoned']);

function createAggregator({ config, db, now = () => new Date(), review: shared }) {
  const review = shared || createReviewService({ vaultDir: config.vaultDir, device: config.device, now });
  const items = createItems({ db, notesDir: config.notesDir });

  /**
   * 有日期的事：进行中项目的截止日 + 未完成待办的截止日。
   * 调用方已经查过待办时传进来，同一个请求里不重复读整张表。
   */
  function datedEntries(today = toLocalDate(now()), { tasks = db.listTasks() } = {}) {
    const entries = [];
    for (const item of items.list('experiment')) {
      if (INACTIVE_PROJECT.has(item.status)) continue;
      const date = toDateString(item.data.deadline);
      if (!date) continue;
      entries.push({ date, label: item.title, detail: item.data.dataset ? String(item.data.dataset) : '研究项目', source: '研究项目', path: item.path, overdue: date < today });
    }
    for (const task of tasks) {
      if (!task.due || task.done) continue;
      entries.push({ date: task.due, label: task.title, detail: task.noteTitle, source: '待办', path: task.path, overdue: task.due < today });
    }
    return entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label)));
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
    const everything = db.listTasks({ includeDone: true });
    const allTasks = sortTasks(everything.filter(task => !task.done), date);
    return {
      date,
      weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(now()),
      review: { due: queue.due.length, fresh: queue.fresh.length, total: queue.cards.length },
      // 「今天需要处理」只放逾期和今天到期的；都没有时才给出最近几条有截止日的，
      // 未排期的待办留在计划页，不冒充今天的事。
      tasks: {
        ...summarize(everything, date),
        dueNow: allTasks.filter(task => task.due && task.due <= date),
        upcoming: allTasks.filter(task => task.due && task.due > date).slice(0, 3)
      },
      attention: attention()
    };
  }

  return { review, today, datedEntries, attention };
}

module.exports = { createAggregator };
