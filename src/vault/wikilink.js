const MarkdownIt = require('markdown-it');
const { maskMath } = require('../mathSyntax');
const { toPosix, stripExtension, basename, encodePath } = require('./paths');

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

// 代码块与行内代码里的内容不算链接。写笔记时贴一段带 [[ 的代码很常见
// （Python 的嵌套列表 `[[1,2],[3,4]]` 就是），不排除掉会凭空生成一堆死链。
const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`)*\1/g;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

// 围栏代码块按行判定，不用正则整体匹配：Markdown 的围栏规则本身就是逐行的，
// 而带 m 标志的正则里 `$` 会匹配到行尾，未闭合围栏的兜底分支会提前收尾，
// 结果只屏蔽掉代码块的第一行。
function maskFencedCode(markdown) {
  const lines = String(markdown ?? '').split('\n');
  let fence = '';

  return lines.map(line => {
    const blanked = line.replace(/[^\n]/g, ' ');
    if (fence) {
      // 闭合围栏：同种字符，且不短于开启时的长度。
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        fence = '';
      }
      return blanked;
    }
    const opening = line.match(FENCE_OPEN);
    if (opening) {
      fence = opening[1];
      return blanked;
    }
    return line;
  }).join('\n');
}

// 用等长空格替换，保证匹配到的偏移量仍与原文对得上——renderWikilinks 要靠
// 这些偏移量回到原文里做替换。
function maskCode(markdown) {
  return maskFencedCode(markdown).replace(INLINE_CODE, match => match.replace(/[^\n]/g, ' '));
}

/**
 * 从 Markdown 正文里解析出所有 wikilink。
 * 返回 [{ target, heading, display, index }]，target 已去掉扩展名并归一为正斜杠。
 */
function parseWikilinks(markdown) {
  const masked = maskMath(maskCode(markdown));
  const links = [];

  for (const match of masked.matchAll(WIKILINK_PATTERN)) {
    // `![[图.png]]`、`![[录音.mp3]]` 嵌入的是附件，不是笔记：不算链接，否则每个附件都成了「待建」笔记。
    // `![[笔记]]` 和 `![[笔记.md]]` 仍按普通双链处理，和阅读页的渲染一致。
    const raw = toPosix(match[1].trim());
    if (match.index > 0 && masked[match.index - 1] === '!' && /\.[^./]+$/.test(raw) && !/\.md$/i.test(raw)) continue;
    const target = stripExtension(raw);
    if (!target) continue;
    links.push({
      target,
      heading: (match[2] || '').trim(),
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
    const normalized = stripExtension(toPosix(target));
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
    const raw = toPosix(match[1].trim());
    if (match.index > 0 && masked[match.index - 1] === '!' && /\.[^./]+$/.test(raw) && !/\.md$/i.test(raw)) continue;
    const target = stripExtension(raw);
    if (!target) continue;
    const display = (match[3] || '').trim() || match[1].trim();
    const resolved = resolve(target);
    const fragment = wikilinkFragment(match[2]);
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
  buildResolver,
  buildIndexResolver,
  renderWikilinks,
  maskCode,
  headingFragment,
  wikilinkFragment
};
