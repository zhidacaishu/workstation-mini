// 笔记正文按这三种换行切行，与 markdown-it 的行号一致。
const LINE_BREAK = /\r\n|\r|\n/;

// - [ ] 待办    /    - [x] 已完成    /    * [X] 也认
const TASK_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

/**
 * 从笔记正文里抽取任务。
 *
 * 任务**不新建存储**：真相永远是 Markdown 里的那一行 `- [ ]`，索引表只是派生。
 * 这样写日记时顺手记的待办会自动进系统，不用两头维护，也不会出现
 * 「笔记里勾掉了但任务列表还亮着」这种两份数据打架的情况。
 *
 * 哪些行算待办由阅读页渲染用的同一遍 Markdown 解析决定（listTaskItems）：
 * 围栏代码块、缩进代码块、$$ 公式块里的 `- [ ]` 都不算，阅读页上能看到的待办
 * 也一定能在计划里找到。
 */
function extractTasks(body, { includeDates = false } = {}) {
  const source = String(body ?? '');
  if (!/\[[ xX]\]/.test(source)) return [];
  // 延迟加载：markdown.js 体积大，而且它也是这个模块的使用方之一。
  const { listTaskItems } = require('./markdown');
  const rawLines = source.split(LINE_BREAK);

  const tasks = [];
  for (const item of listTaskItems(source, { includeDates: true })) {
    const { line } = item;
    const rawLine = rawLines[line - 1] ?? '';
    const match = rawLine.match(TASK_LINE);
    if (!match) continue;
    const text = match[3].trim();
    if (!text) continue;

    const due = item.dates[0];
    const titleLine = due ? rawLine.slice(0, due.index) + rawLine.slice(due.index + 1 + due.date.length) : rawLine;
    tasks.push({
      line,
      done: match[2].toLowerCase() === 'x',
      text,
      // 显示时把 @日期 标记去掉，日期单独成字段。
      title: (titleLine.match(TASK_LINE)?.[3] || text).replace(/\s{2,}/g, ' ').trim() || text,
      due: item.due,
      ...(includeDates ? { dates: item.dates } : {}),
      indent: match[1].length
    });
  }

  return tasks;
}

/**
 * 待办按「逾期 → 今天 → 有期限 → 无期限」排，同组内按截止日期。
 * 没有期限的排最后：有明确期限的东西才是真正压着的。
 */
function sortTasks(tasks, today) {
  const bucket = task => {
    if (!task.due) return 3;
    if (task.due < today) return 0;
    if (task.due === today) return 1;
    return 2;
  };
  return [...tasks].sort((a, b) => {
    const diff = bucket(a) - bucket(b);
    if (diff !== 0) return diff;
    if (a.due !== b.due) return (a.due || '') < (b.due || '') ? -1 : 1;
    return a.path === b.path ? a.line - b.line : String(a.path).localeCompare(String(b.path));
  });
}

function summarize(tasks, today) {
  const open = tasks.filter(task => !task.done);
  return {
    total: tasks.length,
    open: open.length,
    done: tasks.length - open.length,
    overdue: open.filter(task => task.due && task.due < today).length,
    dueToday: open.filter(task => task.due === today).length
  };
}

module.exports = { extractTasks, sortTasks, summarize, LINE_BREAK };
