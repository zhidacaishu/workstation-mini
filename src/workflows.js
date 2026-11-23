// 研究项目条目状态机。
//
// 研究项目是带状态流转的条目列表，复用同一个看板组件。
//
// 条目就是普通笔记，状态写在 frontmatter 的 status 里。
//
// 研究项目放在 notes/experiments/ 下，保持可搜索和可双链。
// 这里放进 notes/ 下面，因为索引器只扫 notes/ —— 放外面就搜不到、不能双链、
// 没有反链，而「今天跑了 [[experiments/exp-042]]」正是这套东西最该有的用法。

const WORKFLOWS = {
  experiment: {
    key: 'experiment',
    label: '研究项目',
    section: 'experiments',
    noun: '项目',
    initial: 'planned',
    statuses: [
      { key: 'planned', label: '计划中' },
      { key: 'running', label: '进行中' },
      { key: 'done', label: '已完成' },
      { key: 'abandoned', label: '已放弃', muted: true }
    ],
    fields: ['dataset', 'params', 'seed', 'commit', 'result', 'conclusion', 'next']
  }
};

const BY_SECTION = new Map(Object.values(WORKFLOWS).map(flow => [flow.section, flow]));

function workflowOf(key) {
  // 只认自己的键：`/board/constructor`、`__proto__` 这类原型链上的名字不能当成工作流。
  return typeof key === 'string' && Object.hasOwn(WORKFLOWS, key) ? WORKFLOWS[key] : null;
}

function workflowForSection(section) {
  return BY_SECTION.get(section) || null;
}

function statusLabel(workflowKey, status) {
  const flow = workflowOf(workflowKey);
  if (!flow) return status || '';
  return flow.statuses.find(s => s.key === status)?.label || status || '';
}

/**
 * 校验状态是否属于这个工作流。
 *
 * 只校验目标状态合法，不限制「从哪能到哪」：科研过程本来就会往回走 ——
 * 已接收的稿子又要改、跑完的实验发现有问题要重来、打通的章节回头发现没懂。
 * 把这些拦掉只会逼人绕过工具。状态列表的顺序只用于看板的左右排布。
 */
function isValidStatus(workflowKey, status) {
  const flow = workflowOf(workflowKey);
  return Boolean(flow) && flow.statuses.some(s => s.key === status);
}

function normalizeStatus(workflowKey, status) {
  const flow = workflowOf(workflowKey);
  if (!flow) return '';
  const value = String(status ?? '').trim();
  return isValidStatus(workflowKey, value) ? value : flow.initial;
}

module.exports = {
  WORKFLOWS,
  workflowOf,
  workflowForSection,
  statusLabel,
  isValidStatus,
  normalizeStatus
};
