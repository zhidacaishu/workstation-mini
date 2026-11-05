const path = require('node:path');
const katex = require('katex');

const { toLocalDate } = require('./templates');
const { addDays } = require('./dates');
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
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
const PREVIEW_MATH = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;

/**
 * 搜索结果摘要：去掉 Markdown 记号、行内公式排成 KaTeX、块公式省略，并把查询词标出来。
 * 重复的一级标题由 buildSnippet 在原文还保留行边界时移除。
 */
function excerptHtml(value, query = '') {
  const formulas = [];
  let raw = String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  // 摘要窗口可能从公式中间截断：开头多出来的半个公式（落单的 $ 或 $$）连同它前面的 TeX 一起去掉，
  // 结尾同理，否则后面的 $ 会全部错位配对。
  const unpaired = text => ((text.match(/\$\$/g) || []).length % 2) + ((text.replace(/\$\$/g, '').match(/\$/g) || []).length % 2);
  if (raw.startsWith('…') && unpaired(raw)) raw = '…' + raw.slice(raw.search(/\$(?!\$)|\$\$/) + (raw.includes('$$') && raw.indexOf('$$') === raw.indexOf('$') ? 2 : 1));
  if (raw.endsWith('…') && unpaired(raw)) raw = raw.slice(0, raw.lastIndexOf('$')).replace(/\$$/, '') + '…';
  let text = raw
    .replace(/\$\$[^$]*\$\$/g, ' … ')
    .replace(PREVIEW_MATH, (match, block, inline) => `\u0000${formulas.push(block ?? inline) - 1}\u0000`)
    .replace(/\$/g, '');
  text = plainSnippet(text);
  const needle = String(query || '').trim();
  const pattern = needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  function highlightText(value) {
    if (!pattern) return escapeHtml(value);
    let html = '';
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      html += escapeHtml(value.slice(offset, match.index)) + `<mark>${escapeHtml(match[0])}</mark>`;
      offset = match.index + match[0].length;
    }
    return html + escapeHtml(value.slice(offset));
  }
  // 先按公式占位符分段，再只对普通文本高亮；避免数字查询改坏占位符或 HTML 实体。
  return text.split(/\u0000(\d+)\u0000/g).map((part, index) => index % 2 === 0
    ? highlightText(part)
    : formulas[part] === undefined ? '' : katex.renderToString(formulas[part], {
      output: 'html', throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 20
    })).join('');
}

/**
 * 卡片列表里的一行预览：文字去掉 Markdown 记号，公式用 KaTeX 排出来，
 * 研究笔记里的卡大多带公式，只显示 TeX 源码很难一眼认出是哪张。
 * 先把公式换成占位符再处理文字，免得 `$\hat y - y$` 里的减号被当成列表符号吃掉。
 */
function cardPreview(value, limit = 240) {
  const formulas = [];
  // 占位符用 \u0000 包住编号；原文里自带的 \u0000 先去掉，免得被当成占位符。
  const text = String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, limit)
    .replace(PREVIEW_MATH, (match, block, inline) => `\u0000${formulas.push(block ?? inline) - 1}\u0000`);
  return escapeHtml(plainSnippet(text)).replace(/\u0000(\d+)\u0000/g, (match, index) => formulas[index] === undefined ? '' : katex.renderToString(formulas[index], {
    output: 'html', throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 20
  }));
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
 * 逾期数每次现查；到期卡数缓存 30 秒，任何写操作（非 GET 请求）都会让它失效，
 * 所以评分或改卡之后，下一页的角标就是准的。
 */
function createNavCounts({ config, db, now = () => new Date(), review: shared = null }) {
  let review = shared;
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
    const today = toLocalDate(now());
    const value = { overdue: 0, review: 0 };
    // 逾期数每次现查：一条 SQL，很便宜；缓存的话，外部编辑、首次建索引和 Git 拉取
    // 之后角标会和今日页的数字对不上，最长 30 秒。
    try {
      value.overdue = (db?.listTasks?.() || []).filter(task => task.due && task.due < today).length;
    } catch {}
    if (!cache || Date.now() - cache.at >= TTL_MS) {
      let due = 0;
      try {
        // 只数到期卡：新卡每天都有，算进角标会让它永远亮着、失去提醒作用。
        const queue = await reviewService()?.queue({});
        due = queue?.due?.length || 0;
      } catch {}
      cache = { at: Date.now(), review: due };
    }
    value.review = cache.review;
    return value;
  }

  function invalidate() {
    cache = null;
  }

  return { get, invalidate };
}

// 侧栏图标的路径。导航本身、首次启动导览和上手指南共用同一套，
// 说明里画出来的图标和侧栏上看到的一模一样。
const NAV_ICONS = {
  today: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  notes: '<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
  projects: '<path d="M9 3h6M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3"/><path d="M8 15h8"/>',
  plan: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2"/>',
  review: '<rect x="5" y="7" width="15" height="14" rx="2"/><path d="M3 16V4a1 1 0 0 1 1-1h12M10 14l2 2 4-4"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  health: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  guide: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 16v1"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
};

module.exports = {
  NAV_ICONS,
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
  excerptHtml,
  cardPreview,
  dayDiff,
  addDays,
  SECTION_NAMES,
  PROJECT_STATUS,
  CARD_TYPES
};
