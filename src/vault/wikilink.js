const MarkdownIt = require('markdown-it');
const { maskCode } = require('../markdownCode');
const { maskMath } = require('../mathSyntax');
const { toPosix, stripExtension, wikilinkTarget, basename, encodePath } = require('./paths');

// [[目标]] / [[目标|显示文字]] / [[目标#小节]]
const WIKILINK_PATTERN = /\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]+))?\]\]/g;
const LINE_FRAGMENT = /^L[1-9]\d*$/;

/**
 * 标题锚点和行号锚点分开放：L 命名空间继续兼容已有的精确行跳转，
 * H 命名空间则稳定地表示标题。输入必须是用户最终看到的纯文本；NFC 可让
 * 视觉相同但码点组合不同的中文/重音字符落到同一个 fragment。
 */
const fragmentMarkdown = new MarkdownIt({ html: false, linkify: false });

function renderedPlainText(value) {
  const tokens = fragmentMarkdown.parseInline(String(value ?? ''), {});
  return tokens.flatMap(token => token.children || []).filter(token => (
    token.type === 'text' || token.type === 'code_inline' || token.type === 'image'
  )).map(token => token.content).join('');
}

function headingFragment(value) {
  const normalized = renderedPlainText(value).normalize('NFC').trim().toLowerCase();
  const slug = normalized
    .replace(/\s+/gu, '-')
    .replace(/[^\p{Letter}\p{Mark}\p{Number}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `H-${slug || 'section'}`;
}

function wikilinkFragment(heading) {
  const value = String(heading ?? '').normalize('NFC').trim();
  if (!value) return '';
  return LINE_FRAGMENT.test(value) ? value : headingFragment(value);
}

/**
 * 拆出双链的目标和小节。表格里 Obsidian 写成 [[目标\|别名]]：竖线前的反斜杠是转义，
 * 不属于目标（或小节）。阅读页渲染和反链索引共用，两边认的目标一致。
 */
function wikilinkParts(match) {
  const tableEscaped = match[3] !== undefined && /\\$/.test(match[2] ?? match[1]);
  return {
    target: tableEscaped && match[2] === undefined ? match[1].slice(0, -1) : match[1],
    heading: tableEscaped && match[2] !== undefined ? match[2].slice(0, -1) : match[2]
  };
}

/**
 * 从 Markdown 正文里解析出所有 wikilink。
 * 返回 [{ target, heading, display, index }]，target 使用双链写法并归一为正斜杠。
 */
function parseWikilinks(markdown) {
  const masked = maskMath(maskCode(markdown));
  const links = [];

  for (const match of masked.matchAll(WIKILINK_PATTERN)) {
    // `![[图.png]]`、`![[录音.mp3]]` 嵌入的是附件，不是笔记：不算链接，否则每个附件都成了「待建」笔记。
    // `![[笔记]]` 和 `![[笔记.md]]` 仍按普通双链处理，和阅读页的渲染一致。
    const parts = wikilinkParts(match);
    const raw = toPosix(parts.target.trim());
    if (match.index > 0 && masked[match.index - 1] === '!' && /\.[^./]+$/.test(raw) && !/\.md$/i.test(raw)) continue;
    const target = wikilinkTarget(raw);
    if (!target) continue;
    links.push({
      target,
      heading: (parts.heading || '').trim(),
      display: (match[3] || '').trim(),
      index: match.index
    });
  }
  return links;
}

/**
 * 建一个「链接目标 → 笔记路径」的查找表。
 *
 * 同一个目标有两种写法都要能解析到：完整相对路径（`diary/2026-08-06`）和
 * 光写文件名（`2026-08-06`）。文件名有重名时不猜——只保留完整路径那条，
 * 重名的 basename 映射整个丢弃，让它变成未解析链接，而不是随机指向某一篇。
 */
function buildResolver(notePaths, titles = null) {
  const byFullPath = new Map();
  const byBasename = new Map();
  const ambiguousBasenames = new Set();

  for (const notePath of notePaths) {
    const normalized = toPosix(notePath);
    byFullPath.set(stripExtension(normalized), normalized);

    const name = basename(normalized);
    if (byBasename.has(name)) {
      ambiguousBasenames.add(name);
    } else {
      byBasename.set(name, normalized);
    }
  }
  for (const name of ambiguousBasenames) byBasename.delete(name);

  function resolve(target) {
    const normalized = stripExtension(target);
    return byFullPath.get(normalized) || byBasename.get(normalized) || '';
  }
  // 可选：给出「路径 → 标题」时，渲染层可以把没写别名的双链显示成标题。
  resolve.titleOf = notePath => (titles && titles.get(notePath)) || '';
  return resolve;
}

/** 从索引构建带标题的解析器；索引不提供标题时退回只解析路径。 */
function buildIndexResolver(db) {
  if (typeof db.listNoteTitles !== 'function') return buildResolver(db.listPaths());
  const rows = db.listNoteTitles();
  return buildResolver(rows.map(row => row.path), new Map(rows.map(row => [row.path, row.title])));
}

/**
 * 把 wikilink 渲染成 HTML 链接。解析不到的目标渲染成「待建」样式，
 * 而不是死链——它标记的是一篇还没写的笔记，这在双链笔记里是正常状态。
 */
function renderWikilinks(markdown, resolve, escapeHtml) {
  const masked = maskMath(maskCode(markdown));
  const replacements = [];

  for (const match of masked.matchAll(WIKILINK_PATTERN)) {
    // `![[图.png]]`、`![[录音.mp3]]` 嵌入的是附件，不是笔记：不算链接，否则每个附件都成了「待建」笔记。
    // `![[笔记]]` 和 `![[笔记.md]]` 仍按普通双链处理，和阅读页的渲染一致。
    const parts = wikilinkParts(match);
    const raw = toPosix(parts.target.trim());
    if (match.index > 0 && masked[match.index - 1] === '!' && /\.[^./]+$/.test(raw) && !/\.md$/i.test(raw)) continue;
    const target = wikilinkTarget(raw);
    if (!target) continue;
    const display = (match[3] || '').trim() || parts.target.trim();
    const resolved = resolve(target);
    const fragment = wikilinkFragment(parts.heading);
    const anchor = fragment ? `#${encodeURIComponent(fragment)}` : '';
    const html = resolved
      ? `<a class="wikilink" href="/note/${encodePath(resolved)}${anchor}">${escapeHtml(display)}</a>`
      : `<a class="wikilink wikilink-missing" href="/new?path=${encodeURIComponent(target)}">${escapeHtml(display)}</a>`;
    replacements.push({ start: match.index, end: match.index + match[0].length, html });
  }

  if (replacements.length === 0) return String(markdown ?? '');

  let result = '';
  let cursor = 0;
  for (const replacement of replacements) {
    result += String(markdown).slice(cursor, replacement.start) + replacement.html;
    cursor = replacement.end;
  }
  return result + String(markdown).slice(cursor);
}

module.exports = {
  parseWikilinks,
  wikilinkParts,
  buildResolver,
  buildIndexResolver,
  renderWikilinks,
  maskCode,
  headingFragment,
  wikilinkFragment
};
