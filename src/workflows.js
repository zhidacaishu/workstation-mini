// 条目状态机（E6）。
//
// 实验记录、投稿追踪、教材章节，本质都是「带状态流转的条目列表」，
// 所以共用这一套定义和同一个看板组件，而不是各写一遍。
//
// 条目就是普通笔记，状态写在 frontmatter 的 status 里 —— 沿用 P1 为日记打点
// 加的 data_json 列，这里零 schema 改动就能查。
//
// 关于目录：方案草图把 experiments/ 和 submissions/ 放在 notes/ 同级。
// 这里放进 notes/ 下面，因为索引器只扫 notes/ —— 放外面就搜不到、不能双链、
// 没有反链，而「今天跑了 [[experiments/exp-042]]」正是这套东西最该有的用法。

const WORKFLOWS = {
  experiment: {
    key: 'experiment',
    label: '实验记录',
    section: 'experiments',
    noun: '实验',
    initial: 'planned',
    statuses: [
      { key: 'planned', label: '计划中' },
      { key: 'running', label: '进行中' },
      { key: 'done', label: '已完成' },
      { key: 'abandoned', label: '已放弃', muted: true }
    ],
    // 实验记录的意义在于半年后还能查到「当时为什么选这个设定」，
    // 所以这几个字段是模板里就该占好位的。
    fields: ['dataset', 'params', 'seed', 'commit', 'result', 'conclusion', 'next']
  },

  submission: {
    key: 'submission',
    label: '投稿追踪',
    section: 'submissions',
    noun: '稿件',
    initial: 'drafting',
    statuses: [
      { key: 'drafting', label: '写作中' },
      { key: 'submitted', label: '已投出' },
      { key: 'under-review', label: '审稿中' },
      { key: 'major-revision', label: '大修' },
      { key: 'minor-revision', label: '小修' },
      { key: 'accepted', label: '已接收' },
      { key: 'rejected', label: '被拒', muted: true }
    ],
    fields: ['journal', 'deadline', 'submitted_at']
  },

  chapter: {
    key: 'chapter',
    label: '教材进度',
    section: 'reading',
    noun: '章节',
    initial: 'todo',
    statuses: [
      { key: 'todo', label: '未开始' },
      { key: 'reading', label: '在读' },
      { key: 'exercises', label: '做题中' },
      { key: 'stuck', label: '卡住了', warn: true },
      { key: 'done', label: '已打通' }
    ],
    fields: ['book', 'exercises_done', 'exercises_total']
  }
};

const BY_SECTION = new Map(Object.values(WORKFLOWS).map(flow => [flow.section, flow]));

function workflowOf(key) {
  return WORKFLOWS[key] || null;
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
