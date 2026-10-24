const { maskCode } = require('./vault/wikilink');

// - [ ] 待办    /    - [x] 已完成    /    * [X] 也认
const TASK_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
// @2026-08-10 表示截止日期
const DUE_TAG = /@(\d{4}-\d{2}-\d{2})\b/;

/**
 * 从笔记正文里抽取任务。
 *
 * 任务**不新建存储**：真相永远是 Markdown 里的那一行 `- [ ]`，索引表只是派生。
 * 这样写日记时顺手记的待办会自动进系统，不用两头维护，也不会出现
 * 「笔记里勾掉了但任务列表还亮着」这种两份数据打架的情况。
 *
 * 代码块里的 `- [ ]` 不算任务 —— 贴一段 Markdown 示例不该凭空生成待办。
 */
function extractTasks(body) {
  const source = String(body ?? '');
  // 用 maskCode 屏蔽围栏与行内代码，但保留行结构，行号才对得上。
  const masked = maskCode(source);
  const maskedLines = masked.split('\n');
  const rawLines = source.split('\n');

  const tasks = [];
  maskedLines.forEach((line, index) => {
    const match = line.match(TASK_LINE);
    if (!match) return;

    // 用原文那一行取内容：masked 版本里代码片段被空格替换过。
    const rawMatch = rawLines[index].match(TASK_LINE);
    const text = (rawMatch ? rawMatch[3] : match[3]).trim();
    if (!text) return;

    const due = line.match(DUE_TAG);
    const titleLine = due ? rawLines[index].slice(0, due.index) + rawLines[index].slice(due.index + due[0].length) : rawLines[index];
    tasks.push({
      line: index + 1,
      done: match[2].toLowerCase() === 'x',
      text,
      // 显示时把 @日期 标记去掉，日期单独成字段。
      title: (titleLine.match(TASK_LINE)?.[3] || text).replace(/\s{2,}/g, ' ').trim() || text,
      due: due ? due[1] : null,
      indent: match[1].length
    });
  });

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

module.exports = { extractTasks, sortTasks, summarize };
