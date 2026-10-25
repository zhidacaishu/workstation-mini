const path = require('node:path');

const { toLocalDate } = require('./templates');
const { createReviewService } = require('./reviewService');

// 界面字体随应用打包，不依赖在线字体服务。中文用思源黑体（Noto Sans SC）的
// 可变字体，按 unicode-range 切成小块，浏览器只取页面实际用到的字。
const FONT_PACKAGES = {
  geist: '@fontsource-variable/geist',
  'geist-mono': '@fontsource-variable/geist-mono',
  'noto-sans-sc': '@fontsource-variable/noto-sans-sc'
};

function fontDirectories() {
  const directories = {};
  for (const [name, pkg] of Object.entries(FONT_PACKAGES)) {
    try {
      directories[name] = path.dirname(require.resolve(`${pkg}/package.json`));
    } catch {
      // 字体缺失只影响观感：样式表里的字体栈会退回系统字体。
    }
  }
  return directories;
}

const SECTION_NAMES = {
  experiments: '研究项目',
  research: '研究笔记',
  calendar: '月历备注',
  learning: '学习笔记',
  reading: '阅读笔记',
  inbox: '收件箱',
  cards: '卡片'
};

const PROJECT_STATUS = {
  planned: '计划中',
  running: '进行中',
  done: '已完成',
  abandoned: '已放弃'
};

const CARD_TYPES = {
  'en-word': '生词',
  'en-phrase': '短语',
  concept: '概念',
  formula: '公式',
  cloze: '挖空'
};

function sectionName(value) {
  return SECTION_NAMES[value] || value || '未分区';
}

/** frontmatter 里的日期可能被 YAML 解析成 Date，也可能是字符串。 */
function toDateString(value) {
  if (!value) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

/** 把 frontmatter 字段值转成一行可读文本：日期、列表、键值对都能显示。 */
function fieldText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return toDateString(value);
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${key} ${fieldText(item)}`).join(' · ');
  }
  return String(value).trim();
}

function dayDiff(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86400000);
}

/** 「10/24」这样的短日期；跨年时带上年份。 */
function shortDate(value, today = toLocalDate()) {
  const date = toDateString(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const label = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return date.slice(0, 4) === String(today).slice(0, 4) ? label : `${date.slice(0, 4)}/${label}`;
}

/** 截止日相对今天：「今天」「明天」「5 天后」「逾期 2 天」。 */
function dueRelative(value, today = toLocalDate()) {
  const diff = dayDiff(today, toDateString(value));
  if (diff === null) return '';
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff > 1) return `${diff} 天后`;
  return `逾期 ${-diff} 天`;
}

/** 修改时间：今天、昨天，其余用短日期。 */
function modifiedLabel(ms, today = toLocalDate()) {
  const time = Number(ms);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = toLocalDate(new Date(time));
  const diff = dayDiff(date, today);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return shortDate(date, today);
}

/**
 * 列表摘要里去掉 Markdown 记号：[[双链]] 只留显示文字，行首的列表、待办、标题、
 * 引用符号不再露出来。只影响展示，不影响检索。
 */
function plainSnippet(value) {
  return String(value || '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/(^|\s)(?:[-*+]\s+)?\[(?: |x|X)\]\s+/g, '$1')
    .replace(/(^|\s)(?:#{1,6}|>|[-*+])\s+/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 本地时间的「2026-10-25 14:20」。 */
function dateTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  const pad = number => String(number).padStart(2, '0');
  return `${toLocalDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 侧栏角标：逾期待办数与待复习卡片数。
 *
 * 每次翻页都重算复习队列太浪费，这里缓存 30 秒；任何写操作（非 GET 请求）
 * 都会让缓存失效，所以完成待办或评分之后，下一页的角标就是准的。
 */
function createNavCounts({ config, db, now = () => new Date() }) {
  let review = null;
  let cache = null;
  const TTL_MS = 30000;

  function reviewService() {
    if (review || !config?.vaultDir) return review;
    try {
      review = createReviewService({ vaultDir: config.vaultDir, device: config.device, now });
    } catch {
      review = null;
    }
    return review;
  }

  async function get() {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
    const today = toLocalDate(now());
    const value = { overdue: 0, review: 0 };
    try {
      value.overdue = (db?.listTasks?.() || []).filter(task => task.due && task.due < today).length;
    } catch {}
    try {
      // 只数到期卡：新卡每天都有，算进角标会让它永远亮着、失去提醒作用。
      const queue = await reviewService()?.queue({});
      value.review = queue?.due?.length || 0;
    } catch {}
    cache = { at: Date.now(), value };
    return value;
  }

  function invalidate() {
    cache = null;
  }

  return { get, invalidate };
}

module.exports = {
  fontDirectories,
  createNavCounts,
  sectionName,
  toDateString,
  fieldText,
  shortDate,
  dueRelative,
  modifiedLabel,
  dateTimeLabel,
  plainSnippet,
  dayDiff,
  SECTION_NAMES,
  PROJECT_STATUS,
  CARD_TYPES
};
