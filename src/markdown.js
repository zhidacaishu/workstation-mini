const posixPath = require('node:path').posix;
const MarkdownIt = require('markdown-it');

const { maskCode, headingFragment, wikilinkFragment } = require('./vault/wikilink');
const { toPosix, stripExtension, encodePath } = require('./vault/paths');
const { stripMachineDirectives } = require('./annotations');

const WIKILINK_PATTERN = /\[\[([^\]\n|#]+)(?:#([^\]\n|]+))?(?:\|([^\]\n]+))?\]\]/g;

// 笔记在 vault 里位于 notes/ 之下，而二进制资源在 attachments/ 和 audio/。
// 要把笔记里的相对路径解析成 vault 相对路径，就得先补回这一层。
const NOTES_PREFIX = 'notes';
const ATTACHMENTS_PREFIX = 'attachments/';
const AUDIO_PREFIX = 'audio/';
const MEDIA_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|pdf|mp3|m4a|wav|ogg|opus|flac|webm|mp4|mov)$/i;

/**
 * 把笔记里写的资源路径解析成应用内的 URL。
 *
 * 只接管落在 `attachments/` 和 `audio/` 里的东西 —— 这两个目录不进 Git、
 * 由存储服务托管，也只有它们有对应的路由。其它路径原样放过：与其猜一个
 * 可能是错的地址，不如让它保持原样，至少作者一眼能看出是自己写错了。
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

// html: false —— 笔记正文里的原始 HTML 不渲染。
// 现在看是保守，等 P6 把网页剪藏接进来之后，正文里就会有来路不明的内容了。
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false
});

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
  tokens[idx].attrSet('src', resolveResourceHref(src, env?.notePath));
  // 懒加载：一篇长笔记里插十几张图时，不该在打开的瞬间全部拉下来。
  tokens[idx].attrSet('loading', 'lazy');
  return defaultImage(tokens, idx, options, env, self);
};

// 行锚必须在预解析 token 流上统一分配。嵌套块（blockquote 里的 paragraph、
// list_item 里的 paragraph）经常共享起始源行；若各 renderer 临时加 id，会生成重复
// DOM id。每一行只让最具体、跨度最小的可见 block claim 一次。
const LINE_BLOCK_TYPES = new Set([
  'paragraph_open', 'heading_open', 'list_item_open', 'blockquote_open', 'table_open', 'fence', 'code_block'
]);
const LINE_BLOCK_PRIORITY = new Map([
  ['heading_open', 0], ['paragraph_open', 1], ['fence', 1], ['code_block', 1],
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
function replaceWikilinks(markdown, resolve, notePath = '') {
  const source = String(markdown ?? '');
  const masked = maskCode(source);
  const replacements = [];

  for (const match of masked.matchAll(WIKILINK_PATTERN)) {
    const literal = match[1].trim();
    const display = escapeMarkdownText((match[3] || '').trim() || literal);

    // `![[图片.png]]` 是嵌入而不是跳转。走原来那条路的话，stripExtension 会把
    // 扩展名吃掉、resolver 又只认 .md，最后渲染成一个「新建 图片 这篇笔记」的
    // 死链 —— 对 Obsidian 用户来说这是最常见的写法，不能这么对待。
    const isEmbed = source[match.index - 1] === '!';
    if (isEmbed && MEDIA_EXTENSION.test(literal)) {
      replacements.push({
        // 连同前面那个 `!` 一起换掉，否则会剩下一个 `!![...]()`。
        start: match.index - 1,
        end: match.index + match[0].length,
        text: `![${display}](${resolveResourceHref(literal, notePath)})`
      });
      continue;
    }

    const target = stripExtension(toPosix(literal));
    if (!target) continue;

    const fragment = wikilinkFragment(match[2]);
    const resolved = resolve(target);
    const href = resolved
      ? `/note/${encodePath(resolved)}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`
      : `/new?path=${encodeURIComponent(target)}`;

    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      text: `[${display}](${href})`
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
function renderMarkdown(body, resolve = () => '', { notePath = '', anchors = true, images = true } = {}) {
  const source = replaceWikilinks(stripMachineDirectives(body), resolve, notePath);
  const env = { notePath, images };
  const tokens = md.parse(source, env);
  if (anchors) assignAnchors(tokens);
  return md.renderer.render(tokens, md.options, env);
}

module.exports = { renderMarkdown, replaceWikilinks, escapeMarkdownText, resolveResourceHref };
