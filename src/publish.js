const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { stringifyFrontmatterValue, parseFrontmatter } = require('./vault/note');
const { maskCode } = require('./vault/wikilink');
const { toLocalDate } = require('./templates');

// myblog 的 blog 集合 schema（src/content.config.ts）里的必填项。
const REQUIRED = ['title', 'description', 'pubDate', 'category'];
const KINDS = ['life', 'ml', 'reading', 'project'];
const STATUSES = ['seed', 'published', 'evergreen', 'archived', 'outdated'];

/** 标签必须是小写 kebab-case —— myblog 的约定。 */
function normalizeTag(tag) {
  return String(tag)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// 在屏蔽后的正文定位，替换时仍从原文取值，避免丢失链接显示文字里的行内代码。
function replaceVisible(body, pattern, replacement) {
  let converted = '';
  let cursor = 0;
  for (const match of maskCode(body).matchAll(pattern)) {
    converted += body.slice(cursor, match.index) + replacement(match);
    cursor = match.index + match[0].length;
  }
  return converted + body.slice(cursor);
}

/**
 * 把工作台的笔记转成 myblog 能吃的 MDX。
 *
 * 三条硬约束来自 myblog 自己：
 *   1. 正文不用 H1 —— 布局会渲染标题，正文再来一个就重复了；降级成 H2。
 *   2. `$$` 公式各自独占一行 —— remark-math 的要求，写在行内会解析失败。
 *   3. tags 小写 kebab-case。
 *
 * 工作台特有的东西（双链、frontmatter 里的状态字段）在这里剥掉：
 * `[[链接]]` 在博客上是死的，指向的笔记根本没发表。
 */
function toMdx(note, { pubDate, category = 'notes', kind = 'reading', description = '', draft = true } = {}) {
  const parsed = parseFrontmatter(note.raw);
  const data = parsed.data || {};
  let body = parsed.content;

  // 先展开双链，再处理标题与公式；显示文字本身也可能含有公式。
  body = replaceVisible(body, /\[\[([^\]\n|#]+)(?:#[^\]\n|]+)?(?:\|([^\]\n]+))?\]\]/dg, match => {
    const [start, end] = match.indices[2] || match.indices[1];
    return body.slice(start, end).trim();
  });
  body = replaceVisible(body, /^( {0,3})#(?=[ \t])|\$\$/gm, match => {
    const start = match.index;
    const end = start + match[0].length;
    if (match[1] !== undefined) {
      return match[0] + '#';
    }
    return (start > 0 && body[start - 1] !== '\n' ? '\n' : '')
      + '$$' + (end < body.length && body[end] !== '\n' ? '\n' : '');
  });

  const title = stringifyFrontmatterValue(data.title).trim() || note.title;
  const tags = (Array.isArray(data.tags) ? data.tags : [])
    .map(normalizeTag)
    .filter(Boolean);

  const front = {
    title,
    description: description || firstSentence(body) || title,
    pubDate,
    category,
    kind: KINDS.includes(kind) ? kind : 'reading',
    tags,
    draft,
    status: STATUSES.includes(data.status) ? data.status : 'published'
  };

  const lines = ['---'];
  for (const [key, value] of Object.entries(front)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(v => JSON.stringify(v)).join(', ')}]`);
    else if (typeof value === 'boolean') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push('---', '');

  return `${lines.join('\n')}${body.trim()}\n`;
}

function firstSentence(body, limit = 150) {
  const text = maskCode(body)
    .replace(/^ {0,3}#.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const sentence = text.split(/(?<=[。.!?！？])\s/)[0] || text;
  return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
}

/**
 * 校验产出的 MDX 是否满足 myblog 的 schema 与约定。
 *
 * 在写文件之前校验：把不合格的 MDX 推进博客仓库，暴露出来的是构建失败，
 * 比在这里报错难查得多。
 */
function validate(mdx) {
  const parsed = parseFrontmatter(mdx);
  const data = parsed.data || {};
  const problems = [];

  // 检查要和 toMdx 看同一份东西：toMdx 跳过代码块才降级 H1，校验也必须跳过，
  // 否则一段带 `# 注释` 的 shell/python 示例会被判成「还有 H1」——而那是校验器
  // 自己看错了，稿子本身没问题。maskCode 用等长空格替换围栏与行内代码，行结构不变。
  const visible = maskCode(parsed.content);

  for (const field of REQUIRED) {
    if (!data[field] && data[field] !== false) problems.push(`缺少必填字段 ${field}`);
  }
  if (/^ {0,3}#[ \t]+/m.test(visible)) problems.push('正文里还有 H1，应降级为 H2');
  if (/\[\[.+?\]\]/.test(visible)) problems.push('正文里还有未处理的双链');
  for (const tag of (Array.isArray(data.tags) ? data.tags : [])) {
    if (tag !== normalizeTag(tag)) problems.push(`标签 ${tag} 不是小写 kebab-case`);
  }
  // $$ 必须独占一行
  for (const line of visible.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.includes('$$') && trimmed !== '$$' && !/^\$\$[^$]*\$\$$/.test(trimmed)) {
      problems.push(`公式分隔符没有独占一行：${trimmed.slice(0, 40)}`);
      break;
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 写进 myblog 仓库。
 *
 * **默认只写文件、不提交更不推送。** 发表是对外动作，应该由人看过之后自己
 * 提交。程序替你 push 到公开博客，出问题的代价太大。
 */
async function publish(blogRepo, { slug, mdx, commit = false, now = () => new Date() }) {
  const validation = validate(mdx);
  if (!validation.ok) return { ok: false, problems: validation.problems };

  const relative = path.join('src', 'content', 'blog', `${slug}.mdx`);
  const absolute = path.join(blogRepo, relative);

  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fsp.writeFile(absolute, mdx, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { ok: false, problems: [relative + ' 已存在，不覆盖'] };
    }
    throw error;
  }

  if (!commit) {
    return { ok: true, path: relative, committed: false, note: '已写入文件，未提交 —— 发表前请自己过一遍再 commit' };
  }

  try {
    await run('git', ['-C', blogRepo, 'add', '--', relative]);
    await run('git', ['-C', blogRepo, 'commit', '--only', '-m', `post: ${slug} (${toLocalDate(now())})`, '--', relative]);
    return { ok: true, path: relative, committed: true, pushed: false, note: '已提交，未推送' };
  } catch (error) {
    return { ok: true, path: relative, committed: false, note: `文件已写入，但提交失败：${String(error.stderr || error.message).trim()}` };
  }
}

function slugify(title, fallback) {
  const slug = String(title || '')
    .trim().toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return slug || fallback || 'post';
}

module.exports = { toMdx, validate, publish, normalizeTag, slugify, firstSentence, REQUIRED, KINDS };
