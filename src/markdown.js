const posixPath = require('node:path').posix;
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js/lib/core');
const katex = require('katex');
const { installMathSyntax, maskMath } = require('./mathSyntax');

const { maskCode, headingFragment, wikilinkFragment } = require('./vault/wikilink');
const { toPosix, stripExtension, encodePath } = require('./vault/paths');
const { stripMachineDirectives } = require('./machineDirectives');
const { toLocalDate } = require('./templates');

const WIKILINK_PATTERN = /\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]+))?\]\]/g;

// 笔记在 vault 里位于 notes/ 之下，而二进制资源在 attachments/ 和 audio/。
// 要把笔记里的相对路径解析成 vault 相对路径，就得先补回这一层。
const NOTES_PREFIX = 'notes';
const ATTACHMENTS_PREFIX = 'attachments/';
const AUDIO_PREFIX = 'audio/';
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
// 音视频不能放进 <img>：嵌入时渲染成链接，点开由内置播放器播放。
const AV_EXTENSION = /\.(mp3|m4a|wav|ogg|opus|flac|webm|mp4|mov)$/i;
const MEDIA_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp3|m4a|wav|ogg|opus|flac|webm|mp4|mov)$/i;

/**
 * 把笔记里写的资源路径解析成应用内的 URL。
 *
 * 只接管落在 `attachments/` 和 `audio/` 里的东西 —— 只有这两个目录有对应的只读路由。
 * 其它路径原样放过：与其猜一个可能是错的地址，不如让它保持原样，至少作者一眼能看出
 * 是自己写错了。
 */
function resolveResourceHref(src, notePath) {
  const raw = String(src || '').trim();
  if (!raw) return raw;
  // 带协议的（http:、https:、data:、mailto:）和已经是应用内绝对路径的都不动。
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('#')) return raw;

  const cleaned = toPosix(raw).replace(/^\.\//, '');

  function hrefFor(vaultPath) {
    if (vaultPath.startsWith(ATTACHMENTS_PREFIX)) return `/${encodePath(vaultPath)}`;
    if (vaultPath.startsWith(AUDIO_PREFIX)) return `/media/${encodePath(vaultPath.slice(AUDIO_PREFIX.length))}`;
    return '';
  }

  // 先按「相对 vault 根」理解。
  //
  // 这条要排在前面，因为它才是实际写出来的形状：应用自己插入的是
  // `attachments/…`，Obsidian 的「基于仓库根的绝对路径」也是这个形状。
  // 而按笔记目录算的话，从 notes/reading/book/ 回到根要写三层 `../`，
  // 没人会手写成那样。
  const asVaultPath = hrefFor(cleaned);
  if (asVaultPath) return asVaultPath;

  // 再按「相对笔记所在目录」理解，覆盖真的写了 `../` 的情况。
  const noteDir = posixPath.dirname(posixPath.join(NOTES_PREFIX, toPosix(notePath || 'x.md')));
  const asNoteRelative = hrefFor(posixPath.normalize(posixPath.join(noteDir, cleaned)));
  if (asNoteRelative) return asNoteRelative;

  // 没有目录分隔符的纯文件名按附件找。Obsidian 里 `![[Pasted image.png]]`
  // 就是这个形状，把它指到 attachments/ 比留一个死链有用。
  if (!cleaned.includes('/') && MEDIA_EXTENSION.test(cleaned)) {
    return `/${ATTACHMENTS_PREFIX}${encodePath(cleaned)}`;
  }

  return raw;
}

// html: false —— 笔记正文里的原始 HTML 不渲染：资料库会经 Git 从别的设备同步过来，
// 正文不该有机会在应用里执行脚本。
// 代码高亮在服务端做完，页面上只是带 class 的 span，不需要再跑脚本。
// 只登记科研笔记里常见的语言；没写语言或写了不认识的语言就不着色，不去猜。
const HIGHLIGHT_LANGUAGES = [
  'python', 'bash', 'shell', 'r', 'latex', 'json', 'yaml', 'ini', 'javascript', 'typescript',
  'c', 'cpp', 'java', 'matlab', 'julia', 'sql', 'rust', 'go', 'xml', 'markdown', 'diff'
];
for (const name of HIGHLIGHT_LANGUAGES) hljs.registerLanguage(name, require(`highlight.js/lib/languages/${name}`));
hljs.registerAliases(['toml'], { languageName: 'ini' });

function highlightCode(source, language) {
  const name = String(language || '').trim().toLowerCase();
  if (!name || !hljs.getLanguage(name)) return '';
  try {
    return hljs.highlight(source, { language: name, ignoreIllegals: true }).value;
  } catch {
    return '';
  }
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: highlightCode
});

installMathSyntax(md, (content, displayMode, env) => {
  const source = displayMode ? '$$\n' + content.trim() + '\n$$' : '$' + content + '$';
  let html;
  try {
    html = katex.renderToString(content, {
      displayMode, output: 'htmlAndMathml', trust: false, throwOnError: true,
      strict: 'ignore', maxExpand: 1000, maxSize: 20,
      macros: env.mathMacros || (env.mathMacros = {})
    });
  } catch (error) {
    if (!(error instanceof katex.ParseError)) throw error;
    html = '<code class="math-error" title="公式暂无法渲染，请检查语法">' + md.utils.escapeHtml(source) + '</code>';
  }
  const tag = displayMode ? 'div' : 'span';
  return '<' + tag + ' class="math-source' + (displayMode ? ' math-display' : '') + '" data-math-source="' + md.utils.escapeHtml(source) + '">' + html + '</' + tag + '>';
});
const renderMathBlock = md.renderer.rules.math_block;
md.renderer.rules.math_block = (tokens, index, options, env, self) => {
  const id = tokens[index].attrGet('id');
  return (id ? '<span id="' + md.utils.escapeHtml(id) + '" class="heading-anchor" aria-hidden="true"></span>' : '') + renderMathBlock(tokens, index, options, env, self) + '\n';
};

// 给 wikilink 加上样式类：指向已存在笔记的和指向待建笔记的要能看出区别。
const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  if (href.startsWith('/note/')) {
    tokens[idx].attrJoin('class', 'wikilink');
  } else if (href.startsWith('/new?path=')) {
    tokens[idx].attrJoin('class', 'wikilink wikilink-missing');
  } else if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  } else if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('#')) {
    // `[原图](attachments/fig.png)` 这类普通链接也指到附件路由，和图片同一套解析。
    const resolved = resolveResourceHref(href, env?.notePath);
    if ((resolved.startsWith('/attachments/') || resolved.startsWith('/media/')) && MEDIA_EXTENSION.test(href.split(/[?#]/)[0])) {
      tokens[idx].attrSet('href', resolved);
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// 图片的 src 也要走一遍解析，否则笔记里插的图全是死链 ——
// 附件在 vault 里的位置和笔记页的 URL 层级对不上，浏览器按相对路径去取
// 只会打到 /note/... 上，拿回一个 404 页面。
const defaultImage = md.renderer.rules.image
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  if (env?.images === false) return md.utils.escapeHtml(tokens[idx].content || '');
  const src = tokens[idx].attrGet('src');
  const resolved = resolveResourceHref(src, env?.notePath);
  if (AV_EXTENSION.test(String(src || '').split(/[?#]/)[0])) {
    const label = md.utils.escapeHtml(tokens[idx].content || String(src).split('/').pop());
    return `<a class="media-link" href="${md.utils.escapeHtml(resolved)}">${label}</a>`;
  }
  tokens[idx].attrSet('src', resolved);
  // 懒加载：一篇长笔记里插十几张图时，不该在打开的瞬间全部拉下来。
  tokens[idx].attrSet('loading', 'lazy');
  return defaultImage(tokens, idx, options, env, self);
};

// 待办行 `- [ ] 写引言 @2026-10-26` 在阅读页显示成勾选框和日期标签，而不是原始语法。
//
// 「哪几行是待办」只在这里判断一次：索引抽取（tasks.js 的 extractTasks）也是调用
// listTaskItems 跑同一遍解析。以前抽取用另一套正则，缩进代码块、$$ 公式块里的
// `- [ ]` 被收成待办，一个落单的反引号又会把几段之后的待办整片藏掉，两边对不上。
// 列表项第一行本身必须是 `- [ ] 文本` 的写法（TASK_LINE），写回时才找得到那一行。
const TASK_PREFIX = /^\[( |x|X)\]\s+/;
const TASK_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const TASK_DUE = /@(\d{4})-(\d{2})-(\d{2})\b/g;

function plainInlineText(children) {
  return children.filter(child => child.type === 'text' || child.type === 'code_inline')
    .map(child => child.content).join('').replace(TASK_DUE, '').replace(/\s+/g, ' ').trim();
}

/**
 * 待办第一行里、行内代码之外的第一个 @日期。行内代码可以跨行，所以按 token 走，
 * 不能按原文逐行找：`- [ ] 示例 \`@2026-10-05` 换行再闭合时，那个日期在代码里。
 */
function firstLineDue(children) {
  for (const child of children) {
    if (child.type === 'softbreak' || child.type === 'hardbreak') return null;
    if (child.type === 'text') {
      TASK_DUE.lastIndex = 0;
      const due = TASK_DUE.exec(child.content);
      TASK_DUE.lastIndex = 0;
      if (due) return `${due[1]}-${due[2]}-${due[3]}`;
    }
    if (child.type === 'code_inline' && child.content.includes('\n')) return null;
  }
  return null;
}

/** 截止日标签：今年只写月/日，跨年带上年份；没完成且已过期的写明「逾期」。 */
function dueLabel(date, today, done) {
  const [year, month, day] = date.split('-');
  const short = `${Number(month)}/${Number(day)}`;
  const label = year === today.slice(0, 4) ? short : `${year}/${short}`;
  if (done) return { label, tone: '' };
  if (date < today) return { label: `逾期 ${label}`, tone: ' is-overdue' };
  if (date === today) return { label: '今天', tone: ' is-today' };
  return { label, tone: '' };
}

md.core.ruler.push('task_items', state => {
  const tokens = state.tokens;
  const today = state.env.today || toLocalDate(new Date());
  // markdown-it 已把 \r\n 和单独的 \r 都归一成 \n：行号按这个算，抽取和写回也按
  // /\r\n|\r|\n/ 切行，三处才对得上（以前写回只认 \n，点 A 改到 B）。
  let sourceLines = null;
  const lineOf = number => (sourceLines ||= state.src.split('\n'))[number - 1] ?? '';
  for (let index = 2; index < tokens.length; index += 1) {
    const inline = tokens[index];
    if (inline.type !== 'inline' || tokens[index - 1].type !== 'paragraph_open' || tokens[index - 2].type !== 'list_item_open') continue;
    const children = inline.children || [];
    const first = children[0];
    const match = first?.type === 'text' ? first.content.match(TASK_PREFIX) : null;
    if (!match) continue;
    const done = match[1].toLowerCase() === 'x';
    first.content = first.content.slice(match[0].length);
    tokens[index - 2].attrJoin('class', done ? 'task-item is-done' : 'task-item');

    const line = tokens[index - 2].map ? tokens[index - 2].map[0] + 1 : 0;
    const writable = line > 0 && TASK_LINE.test(lineOf(line));
    if (writable && state.env.collectTasks) state.env.collectTasks.push({ line, done, due: firstLineDue(children) });
    const box = new state.Token('html_inline', '', 0);
    if (writable && state.env.taskToggle) {
      const label = md.utils.escapeHtml((done ? '标记为未完成：' : '标记为完成：') + plainInlineText(children));
      box.content = `<input type="checkbox" class="task-box task-toggle${done ? ' is-done' : ''}" data-task-line="${line}"${done ? ' checked' : ''} aria-label="${label}">`;
    } else {
      box.content = `<span class="task-box${done ? ' is-done' : ''}" role="img" aria-label="${done ? '已完成' : '待办'}"></span>`;
    }
    const rebuilt = [box];
    for (const child of children) {
      if (child.type !== 'text' || !TASK_DUE.test(child.content)) {
        rebuilt.push(child);
        continue;
      }
      TASK_DUE.lastIndex = 0;
      let cursor = 0;
      for (const due of child.content.matchAll(TASK_DUE)) {
        if (due.index > cursor) {
          const text = new state.Token('text', '', 0);
          text.content = child.content.slice(cursor, due.index);
          rebuilt.push(text);
        }
        const time = new state.Token('html_inline', '', 0);
        const date = `${due[1]}-${due[2]}-${due[3]}`;
        const { label, tone } = dueLabel(date, today, done);
        time.content = `<time class="task-due${tone}" datetime="${date}">${label}</time>`;
        rebuilt.push(time);
        cursor = due.index + due[0].length;
      }
      if (cursor < child.content.length) {
        const text = new state.Token('text', '', 0);
        text.content = child.content.slice(cursor);
        rebuilt.push(text);
      }
    }
    inline.children = rebuilt;
  }
});

// 行锚必须在预解析 token 流上统一分配。嵌套块（blockquote 里的 paragraph、
// list_item 里的 paragraph）经常共享起始源行；若各 renderer 临时加 id，会生成重复
// DOM id。每一行只让最具体、跨度最小的可见 block claim 一次。
const LINE_BLOCK_TYPES = new Set([
  'paragraph_open', 'heading_open', 'list_item_open', 'blockquote_open', 'table_open', 'fence', 'code_block', 'math_block'
]);
const LINE_BLOCK_PRIORITY = new Map([
  ['heading_open', 0], ['paragraph_open', 1], ['fence', 1], ['code_block', 1], ['math_block', 1],
  ['list_item_open', 2], ['table_open', 3], ['blockquote_open', 4]
]);

function assignAnchors(tokens) {
  const claims = new Map();
  for (const [index, token] of tokens.entries()) {
    if (!LINE_BLOCK_TYPES.has(token.type) || !token.map || token.hidden) continue;
    const line = token.map[0];
    const candidate = {
      index,
      span: Math.max(1, token.map[1] - token.map[0]),
      priority: LINE_BLOCK_PRIORITY.get(token.type) ?? 99
    };
    const current = claims.get(line);
    if (!current || candidate.span < current.span
      || (candidate.span === current.span && candidate.priority < current.priority)) {
      claims.set(line, candidate);
    }
  }
  for (const [line, claim] of claims) tokens[claim.index].attrSet('id', `L${line + 1}`);

  const headings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'heading_open') continue;
    const inline = tokens[index + 1];
    if (!inline || inline.type !== 'inline') continue;
    headings.push({ index, base: headingFragment(inline.content) });
  }

  // 每个显式标题 base 都预留给它第一次出现。否则前面的重复 `Foo` 会抢走
  // 后面显式 `Foo-2` 的 H-foo-2，使 [[#Foo-2]] 错跳到重复的 Foo。
  const reservedBases = new Set(headings.map(heading => heading.base));
  const seenBases = new Set();
  const usedAliases = new Set();
  const nextSuffix = new Map();
  for (const { index, base } of headings) {
    let alias = base;
    if (seenBases.has(base)) {
      let suffix = nextSuffix.get(base) || 2;
      do { alias = `${base}-${suffix++}`; } while (reservedBases.has(alias) || usedAliases.has(alias));
      nextSuffix.set(base, suffix);
    } else {
      seenBases.add(base);
      nextSuffix.set(base, 2);
    }
    usedAliases.add(alias);
    tokens[index].meta = { ...(tokens[index].meta || {}), headingAlias: alias };
  }
}

const defaultHeadingOpen = md.renderer.rules.heading_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const alias = tokens[idx].meta?.headingAlias;
  return `${alias ? `<span id="${md.utils.escapeHtml(alias)}" class="heading-anchor" aria-hidden="true"></span>` : ''}${defaultHeadingOpen(tokens, idx, options, env, self)}`;
};

// 显示文字要放进 Markdown 的链接语法里，所以得转义 Markdown 的特殊字符，
// 否则一个标题里的 `]` 会把链接语法截断。
function escapeMarkdownText(value) {
  return String(value).replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

/**
 * 把 [[wikilink]] 换成标准 Markdown 链接语法，交给 markdown-it 去渲染。
 *
 * 用 maskCode 定位、在原文上按偏移量替换，这样代码块里的 [[ ]] 不会被动到。
 */
function replaceWikilinks(markdown, resolve, notePath = '', { linkMissing = true } = {}) {
  const source = String(markdown ?? '');
  const masked = maskMath(maskCode(source));
  const replacements = [];

  for (const match of masked.matchAll(WIKILINK_PATTERN)) {
    const literal = match[1].trim();
    const display = escapeMarkdownText((match[3] || '').trim() || literal);

    // `![[图片.png]]` 是嵌入而不是跳转。走原来那条路的话，stripExtension 会把
    // 扩展名吃掉、resolver 又只认 .md，最后渲染成一个「新建 图片 这篇笔记」的
    // 死链 —— 对 Obsidian 用户来说这是最常见的写法，不能这么对待。
    const isEmbed = source[match.index - 1] === '!';
    // 嵌入的替换范围连同前面那个 `!` 一起，否则会剩下一个 `!![...]()`，
    // 或者把指向笔记的链接变成一张坏图。
    const start = isEmbed ? match.index - 1 : match.index;
    if (isEmbed && IMAGE_EXTENSION.test(literal)) {
      replacements.push({ start, end: match.index + match[0].length, text: `![${display}](${resolveResourceHref(literal, notePath)})` });
      continue;
    }
    if (isEmbed && AV_EXTENSION.test(literal)) {
      replacements.push({ start, end: match.index + match[0].length, text: `[${display}](${resolveResourceHref(literal, notePath)})` });
      continue;
    }
    if (isEmbed && /\.[a-z0-9]{2,5}$/i.test(literal) && !/\.md$/i.test(literal)) {
      // PDF、压缩包等应用不提供的附件：只显示文件名，不生成坏图或死链。
      replacements.push({ start, end: match.index + match[0].length, text: display });
      continue;
    }

    const target = stripExtension(toPosix(literal));
    if (!target) continue;

    const fragment = wikilinkFragment(match[2]);
    const resolved = resolve(target);
    // 没写别名的 [[路径]] 显示目标笔记的标题而不是文件路径；指向小节时带上小节名。
    const title = resolved && !match[3] && typeof resolve.titleOf === 'function'
      ? String(resolve.titleOf(resolved) || '').trim()
      : '';
    const heading = (match[2] || '').trim();
    const label = title ? escapeMarkdownText(heading ? `${title} › ${heading}` : title) : display;
    const href = resolved
      ? `/note/${encodePath(resolved)}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`
      : `/new?path=${encodeURIComponent(target)}`;
    if (!resolved && !linkMissing) {
      // 只读模式不能新建笔记：待建的双链只显示文字，不给一个点了就 403 的链接。
      replacements.push({ start, end: match.index + match[0].length, text: label });
      continue;
    }

    replacements.push({
      start,
      end: match.index + match[0].length,
      text: `[${label}](${href})`
    });
  }

  if (replacements.length === 0) return source;

  let result = '';
  let cursor = 0;
  for (const replacement of replacements) {
    result += source.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return result + source.slice(cursor);
}

/**
 * notePath 是笔记相对 notes/ 的路径。给了它才能把 `![](../attachments/x.png)`
 * 这类相对写法解析对；不给也能用，只是相对路径没有基准可算。
 */
/**
 * 阅读页的页头已经显示了标题；正文开头那个一模一样的 `# 标题` 再排一遍就重复了。
 * 只去掉「正文第一个块就是 H1、文字与标题完全相同」的情况，带链接或格式的标题照常显示。
 */
function dropLeadingTitle(tokens, title) {
  const wanted = String(title || '').trim();
  const [open, inline, close] = tokens;
  if (!wanted || open?.type !== 'heading_open' || open.tag !== 'h1' || close?.type !== 'heading_close') return;
  if (inline?.children?.some(child => child.type !== 'text') || inline.content.trim() !== wanted) return;
  tokens.splice(0, 3);
}

// 和正文共用解析结果与锚点，避免代码块伪标题、重复标题或被省略的页标题进入目录。
function collectOutline(tokens, outline) {
  const parents = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index], inline = tokens[index + 1];
    if (token.type !== 'heading_open' || inline?.type !== 'inline' || !token.attrGet('id')) continue;
    const text = (inline.children || []).map(child => {
      if (['text', 'code_inline', 'image', 'math_inline'].includes(child.type)) return child.content;
      return ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '';
    }).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const heading = { id: token.attrGet('id'), level: Number(token.tag.slice(1)), text, children: [] };
    while (parents.length && parents.at(-1).level >= heading.level) parents.pop();
    (parents.at(-1)?.children || outline).push(heading);
    parents.push(heading);
  }
}

function renderMarkdown(body, resolve = () => '', { notePath = '', anchors = true, images = true, today = '', taskToggle = false, title = '', readOnly = false, outline = null } = {}) {
  const visible = stripMachineDirectives(body);
  const source = replaceWikilinks(visible, resolve, notePath, { linkMissing: !readOnly });
  // 替换双链和去掉机器指令都不增删行，所以这里的行号与索引里的待办行号一致。
  const env = { notePath, images, today, taskToggle };
  const tokens = md.parse(source, env);
  if (title) dropLeadingTitle(tokens, title);
  if (anchors) assignAnchors(tokens);
  if (outline) collectOutline(tokens, outline);
  return md.renderer.render(tokens, md.options, env);
}

/**
 * 正文里哪几行是待办：和阅读页渲染同一遍解析。返回 [{ line, done }]，line 从 1 开始、
 * 相对正文（不含 frontmatter）。调用方传入的应是去掉机器指令行之后的正文。
 */
function listTaskItems(body) {
  const env = { collectTasks: [], today: '0000-00-00' };
  md.parse(String(body ?? ''), env);
  return env.collectTasks;
}

module.exports = { renderMarkdown, replaceWikilinks, escapeMarkdownText, resolveResourceHref, listTaskItems };
