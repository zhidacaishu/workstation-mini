const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const matter = require('gray-matter');

const yaml = matter.engines.yaml;

const {
  toAbsolute,
  toPosix,
  ensureSafeTargetParent,
  ensureSafeFilePath,
  sectionOf,
  basename
} = require('./paths');
const { replaceFile } = require('./atomic');
const { saveVersion } = require('./history');

const NOTE_EXTENSION = '.md';

/**
 * 解析 frontmatter。全项目只走这一个入口。
 *
 * 关键是那个 `{}`：gray-matter 只在**不传 options** 时才启用它的进程级缓存，
 * 而那个缓存以「整份文件内容」为 key、永不淘汰、也没有任何地方去清。这是个
 * 长驻的桌面应用，索引扫描、每次保存、外部编辑入索引都会解析一遍，于是
 * 「进程活着期间见过的所有不同文件内容」会全部常驻内存，没有上界。
 *
 * 缓存命中时它还返回浅拷贝 —— `data` 是同一个对象引用，谁原地改一下就会
 * 污染之后所有相同内容的解析结果。传个 options 对象两个问题一起没有，
 * 而应用自己已经有 mtime/hash 快路径，本来也不依赖它这层缓存。
 */
function frontmatterLanguage(source) {
  const match = /^\uFEFF?---(?!-)([^\r\n]*)/.exec(source);
  return match ? match[1].trim().toLowerCase() : '';
}

/**
 * 只认 YAML。gray-matter 会按 `---js`、`---json`、`---toml` 这类开头切换解析引擎，
 * 其中 javascript 引擎直接 eval —— 资料库会经 Git、云盘从别处同步进来，一篇
 * `---js` 开头的笔记就能在建索引时以应用的权限运行任意代码。所以带语言名的开头
 * 一律当成格式错误，内置引擎也一并换成直接报错的版本，双保险。
 */
function onlyYaml() {
  const error = new Error('frontmatter 只支持 YAML（第一行只写 ---），不解析 ---js、---json、---toml 等其他格式。');
  error.name = 'FrontmatterError';
  throw error;
}
const BLOCKED_ENGINE = { parse: onlyYaml, stringify: onlyYaml };
const FRONTMATTER_OPTIONS = Object.freeze({
  language: 'yaml',
  engines: { javascript: BLOCKED_ENGINE, js: BLOCKED_ENGINE, json: BLOCKED_ENGINE, coffee: BLOCKED_ENGINE, cson: BLOCKED_ENGINE }
});

function frontmatterError(message) {
  const error = new Error(message);
  error.name = 'FrontmatterError';
  return error;
}

const FRONTMATTER_NODE_LIMIT = 50_000;

/**
 * YAML 锚点能让一个值引用它自己（`refs: &r [*r]`），也能用几行别名摆出指数级的结构。
 * 前者让 JSON.stringify 直接抛错 —— 而那一步在入库时，一篇这样的笔记会让整轮索引失败；
 * 后者会把内存吃光。两种都当成这篇笔记的属性区写坏了，别的笔记照常入库。
 */
function assertPlainTree(root) {
  const ancestors = new Set();
  let visited = 0;
  const walk = value => {
    if (!value || typeof value !== 'object' || value instanceof Date) return;
    if (ancestors.has(value)) throw frontmatterError('frontmatter 里的 YAML 锚点引用了它自己，无法解析。');
    visited += 1;
    if (visited > FRONTMATTER_NODE_LIMIT) throw frontmatterError('frontmatter 的结构过于庞大，无法解析。');
    ancestors.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child);
    ancestors.delete(value);
  };
  walk(root);
}

const FRONTMATTER_CLOSING = /\n---[ \t]*(?=\r?\n|$)/;

function parseFrontmatter(raw) {
  const source = String(raw ?? '');
  const language = frontmatterLanguage(source);
  if (language && language !== 'yaml' && language !== 'yml') onlyYaml();
  const plain = () => ({ data: {}, content: source.replace(/^\uFEFF/, '') });
  // 开头的 `---` 也可能只是一条分隔线。没有结束标记、或者中间那段解析出来不是键值
  // 映射（一句话、一个列表）时，gray-matter 会把它当属性区吃掉，正文在阅读页和搜索里
  // 就不见了，也不报错。这两种情况都按「没有属性区」处理，整篇都是正文。
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(source);
  if (opening && !FRONTMATTER_CLOSING.test(source.slice(opening[0].length - 1))) return plain();
  const parsed = matter(source, { ...FRONTMATTER_OPTIONS });
  const data = parsed.data;
  if (data === null || data === undefined) return parsed;
  if (typeof data !== 'object' || Array.isArray(data) || data instanceof Date) return plain();
  assertPlainTree(data);
  return parsed;
}

/** 写回 frontmatter。同样要显式传 options，`matter.stringify` 内部也会走那层缓存。 */
function stringifyFrontmatter(body, data) {
  return matter.stringify(String(body ?? ''), data, { ...FRONTMATTER_OPTIONS });
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function firstHeading(body) {
  const source = String(body ?? '');
  if (!/^ {0,3}#[ \t]+/m.test(source)) return '';
  return require('../markdown').firstMarkdownHeading(source);
}

/**
 * 标签统一成小写字符串数组。
 * frontmatter 里写成 `tags: [a, b]` 或 `tags: a, b` 都接受。
 */
function normalizeTags(value) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  for (const item of raw) {
    const tag = String(item ?? '').trim().toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * YAML 会把不带引号的 `title: 2026-08-06` 解析成 Date 对象，直接 String() 得到
 * 的是「Tue Aug 05 2025 17:00:00 GMT-0700」这种东西。日记标题天然就是日期，
 * 所以这个坑一定会踩到。
 *
 * YAML 的纯日期值按 UTC 午夜解析，因此要用 UTC 取值还原成当初写下的那串字面量；
 * 用本地时区的话，负偏移时区会把它渲染成前一天。
 */
function stringifyFrontmatterValue(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const iso = value.toISOString();
    // 纯日期（UTC 午夜）还原成 YYYY-MM-DD；带时间的保留到分钟。
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  return String(value ?? '');
}

/**
 * 改写并写回 frontmatter 前，先把整棵 data 过一遍。
 *
 * 上面那个坑还有下半段：`matter()` 把 `title: 2026-08-10` 解析成 Date 之后，
 * 原样丢回 `matter.stringify` 会被 js-yaml 写成 `2026-08-10T00:00:00.000Z` ——
 * 只是想改个别字段，却顺手把用户写的日期改了样子。日记恰恰是最容易出现
 * 日期型 frontmatter 的地方，所以任何「读出来、改一个字段、写回去」的路径
 * 都要先过这里。
 *
 * 只动 Date：数字、布尔、null 必须原样保留（mood: 4 变成 "4" 同样是破坏）。
 */
function normalizeFrontmatter(value) {
  if (value instanceof Date) return stringifyFrontmatterValue(value);
  if (Array.isArray(value)) return value.map(normalizeFrontmatter);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = normalizeFrontmatter(item);
    return result;
  }
  return value;
}

function frontmatterConflict(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function parseYamlTree(source) {
  const stack = [];
  let root = null;
  yaml.parse(source, {
    listener(event, state) {
      if (event === 'open') {
        const node = { start: state.position, children: [] };
        if (stack.length > 0) stack[stack.length - 1].children.push(node);
        stack.push(node);
        return;
      }
      const node = stack.pop();
      Object.assign(node, {
        end: state.position,
        kind: state.kind,
        value: state.result,
        anchor: state.anchor
      });
      if (stack.length === 0) root = node;
    }
  });
  return root;
}

function frontmatterBounds(raw) {
  const source = String(raw ?? '');
  const offset = source.startsWith('﻿') ? 1 : 0;
  if (!source.startsWith('---', offset) || source[offset + 3] === '-') return null;
  const openingEnd = source.indexOf('\n', offset);
  if (openingEnd < 0 || source.slice(offset + 3, openingEnd).trim()) {
    throw frontmatterConflict('笔记的 frontmatter 起始标记无法安全修改。');
  }
  const closingMatch = /\n---[ \t]*(?=\r?\n|$)/g;
  closingMatch.lastIndex = openingEnd;
  const closing = closingMatch.exec(source);
  if (!closing) throw frontmatterConflict('笔记的 frontmatter 缺少结束标记。');
  const contentStart = openingEnd + 1;
  const closingStart = closing.index + 1;
  return { offset, contentStart, contentEnd: closingStart, closingStart };
}

function serializeYamlValue(value, { flow = false } = {}) {
  return yaml.stringify(value, {
    ...(flow ? { flowLevel: 0 } : {}),
    noRefs: true,
    noCompatMode: true,
    lineWidth: -1
  }).trimEnd();
}

function indentYamlBlock(text, newline) {
  return text.split('\n').map(line => (line ? `  ${line}` : line)).join(newline);
}

/**
 * 决定这个值写回去时是摊成块状还是挤成一行。
 *
 * 以前一律 flowLevel: 0，于是日记里正常的块状 plan 列表第一次加时间块就会被压成
 * `plan: [09:00-10:00 写论文, 14:00-15:00 …]` 这样一条不换行的长行，而且再也回不去。
 * 这个模块其余地方为保住用户写的字节做了很多功夫（绕开注释、保留引号和 CRLF），
 * 把目标字段重排成没法读的一行是在跟那份努力对着干。
 *
 * 只有真的会跨行时才用块状：标量和空集合本来就是一行，两种风格输出一样。
 */
function encodeFrontmatterValue(value, { allowBlock }) {
  const block = serializeYamlValue(value);
  if (allowBlock && block.includes('\n')) return { encoded: block, block: true };
  return { encoded: serializeYamlValue(value, { flow: true }), block: false };
}

function patchFrontmatterField(raw, key, value) {
  const source = String(raw ?? '');
  const field = String(key ?? '');
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(field)) {
    throw new Error('frontmatter 字段名不合法。');
  }
  const bounds = frontmatterBounds(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';

  const render = (allowBlock, prefix, suffix) => {
    const { encoded, block } = encodeFrontmatterValue(value, { allowBlock });
    const rendered = block
      ? `${field}:${newline}${indentYamlBlock(encoded, newline)}`
      : `${field}: ${encoded}`;
    return `${prefix}${rendered}${suffix}`;
  };

  if (!bounds) {
    return render(true, `---${newline}`, `${newline}---${newline}${source}`);
  }

  const yamlSource = source.slice(bounds.contentStart, bounds.contentEnd);
  let root;
  try {
    root = parseYamlTree(yamlSource);
  } catch (error) {
    throw frontmatterConflict(`frontmatter 无法安全修改：${error.message}`);
  }
  if (root && root.kind !== 'mapping') {
    throw frontmatterConflict('frontmatter 必须是顶层键值映射。');
  }

  const children = root?.children || [];
  const matches = [];
  for (let index = 0; index + 1 < children.length; index += 2) {
    const keyNode = children[index];
    if (keyNode.kind === 'scalar' && keyNode.value === field) {
      matches.push({ keyNode, valueNode: children[index + 1] });
    }
  }
  if (matches.length > 1) throw frontmatterConflict(`frontmatter 的 ${field} 字段重复，无法安全修改。`);

  if (matches.length === 0) {
    const lead = yamlSource && !yamlSource.endsWith('\n') ? newline : '';
    return render(
      true,
      `${source.slice(0, bounds.contentEnd)}${lead}`,
      `${newline}${source.slice(bounds.closingStart)}`
    );
  }

  const { keyNode, valueNode } = matches[0];
  if (keyNode.start !== 0 && yamlSource[keyNode.start - 1] !== '\n') {
    throw frontmatterConflict(`frontmatter 的 ${field} 字段不是普通顶层键，无法安全修改。`);
  }
  if (valueNode.anchor) {
    throw frontmatterConflict(`frontmatter 的 ${field} 字段带有锚点，无法安全修改。`);
  }

  const colon = yamlSource.indexOf(':', keyNode.end);
  if (colon < 0 || colon >= valueNode.start) {
    throw frontmatterConflict(`frontmatter 的 ${field} 字段无法可靠定位。`);
  }
  const start = bounds.contentStart + valueNode.start;
  const end = bounds.contentStart + valueNode.end;
  const originalValue = source.slice(start, end);
  const trailingNewline = originalValue.match(/\r?\n$/)?.[0] || '';
  // 值节点有时把值后面那个空格算进自己的范围（标量），有时不算（flow 集合到 ] 就结束）。
  // 只看 source[end] 会漏掉后一种，于是带行尾注释的 flow 列表会被误判成可以摊开。
  const hasTrailingComment = /^[ \t]*#/.test(source.slice(end));
  const trailingCommentSpace = source[end] === '#'
    ? (originalValue.match(/[ \t]+$/)?.[0] || ' ')
    : '';

  // 值后面跟着行尾注释时只能写成一行：摊成块状会把那条注释挤到列表的第一项上去。
  const { encoded, block } = encodeFrontmatterValue(value, { allowBlock: !hasTrailingComment });
  if (!block) {
    return `${source.slice(0, start)} ${encoded}${trailingNewline || trailingCommentSpace}${source.slice(end)}`;
  }
  // 块状要从 `key:` 后面接管排版，所以替换区间从冒号之后算起，而不是从原值开头。
  const afterColon = bounds.contentStart + colon + 1;
  return `${source.slice(0, afterColon)}${newline}${indentYamlBlock(encoded, newline)}${trailingNewline}${source.slice(end)}`;
}

/**
 * frontmatter 的 title 优先，其次正文第一个 H1，最后退回文件名。
 * 这样刚建的空笔记也总有一个能显示的标题。
 */
/**
 * 标题被 YAML 解析成时间（`title: 2026-08-06T09:00:00+08:00`）时，Date 里已经没有原来的
 * 时区，换算成 UTC 显示会差几个小时。从属性区原文里找回顶层 title 那一行的写法，
 * 确认解析出来是同一个时间点再用。
 */
const TITLE_TIMESTAMP_LINE = /^title[ \t]*:[ \t]*(\d{4}-\d{1,2}-\d{1,2}(?:[Tt \t]+[0-9:.]+(?:[ \t]*(?:[Zz]|[+-]\d{1,2}(?::?\d{2})?))?)?)[ \t]*(?:#.*)?$/m;

function timestampTitleLiteral(value, source) {
  if (!(value instanceof Date) || typeof source !== 'string') return '';
  const literal = TITLE_TIMESTAMP_LINE.exec(source.replace(/\r/g, ''))?.[1];
  if (!literal) return '';
  try {
    const reparsed = yaml.parse(`value: ${literal}`)?.value;
    return reparsed instanceof Date && reparsed.getTime() === value.getTime() ? literal : '';
  } catch {
    return '';
  }
}

function resolveTitle(data, body, relativePath, frontmatterSource) {
  const explicit = (timestampTitleLiteral(data?.title, frontmatterSource) || stringifyFrontmatterValue(data?.title)).trim();
  if (explicit) return explicit;
  const heading = firstHeading(body);
  if (heading) return heading;
  return basename(relativePath);
}

function parseNote(relativePath, raw, stats) {
  const parsed = parseFrontmatter(raw);
  const body = parsed.content;
  const data = parsed.data || {};

  return {
    path: toPosix(relativePath),
    section: sectionOf(relativePath),
    title: resolveTitle(data, body, relativePath, parsed.matter),
    data,
    tags: normalizeTags(data.tags),
    body,
    raw,
    hash: hashContent(raw),
    size: stats ? stats.size : Buffer.byteLength(raw, 'utf8'),
    mtimeMs: stats ? Math.floor(stats.mtimeMs) : 0
  };
}

function sameEntry(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.ino !== 0 && left.ino !== 0n || left.dev !== 0 && left.dev !== 0n)
  );
}

function unsafeFileChanged() {
  const error = new Error('目标文件在访问过程中发生变化。');
  error.code = 'ELOOP';
  return error;
}

async function readNote(vaultDir, relativePath, { tolerateInvalid = false } = {}) {
  const absolute = await ensureSafeFilePath(vaultDir, relativePath);
  const before = await fsp.lstat(absolute, { bigint: true });
  const handle = await fsp.open(absolute, 'r');
  try {
    const [raw, stats, identity] = await Promise.all([
      handle.readFile('utf8'),
      handle.stat(),
      handle.stat({ bigint: true })
    ]);
    await ensureSafeTargetParent(vaultDir, absolute);
    const after = await fsp.lstat(absolute, { bigint: true });
    if (!sameEntry(before, identity) || !sameEntry(identity, after)) throw unsafeFileChanged();
    try {
      return parseNote(relativePath, raw, stats);
    } catch (error) {
      if (!tolerateInvalid) throw error;
      return { path: toPosix(relativePath), raw, hash: hashContent(raw), title: basename(relativePath), parseError: error.message };
    }
  } finally {
    await handle.close();
  }
}

/** 写完先 fsync 再关：只靠 rename 的话，断电后可能留下一个改了名的空文件。 */
async function writeDurably(file, content) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}

// exFAT/FAT32、部分云盘虚拟盘和 SMB 共享不支持硬链接，link 会报这些错。
const NO_HARDLINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EMLINK']);

/**
 * 新建时不能覆盖已有文件。首选硬链接：把写好的临时文件「挂」到目标名上，
 * 目标已存在就失败，而且目标一出现就是完整内容。文件系统不支持硬链接时，
 * 退回 `wx` 直接创建 —— 仍然保证不覆盖别人刚建的同名文件。
 */
async function createExclusive(temporary, absolute, content) {
  try {
    await fsp.link(temporary, absolute);
  } catch (error) {
    if (!NO_HARDLINK.has(error.code)) throw error;
    try {
      await writeDurably(absolute, content);
    } catch (fallbackError) {
      if (fallbackError.code !== 'EEXIST') await fsp.rm(absolute, { force: true }).catch(() => {});
      throw fallbackError;
    }
  }
}

/**
 * 写笔记。先写临时文件再 rename，避免写到一半崩溃留下半截文件——
 * 正文是唯一真相，损坏一次就是真的丢数据。
 */
async function writeNote(vaultDir, relativePath, { data = {}, body = '', raw } = {}, { exclusive = false, versionReason = 'save' } = {}) {
  const absolute = await ensureSafeFilePath(vaultDir, relativePath, {
    allowMissing: true,
    createParents: true
  });

  const hasFrontmatter = Object.keys(data).length > 0;
  const content = raw === undefined
    ? (hasFrontmatter
        ? stringifyFrontmatter(body, data)
        : (body.endsWith('\n') || body === '' ? body : `${body}\n`))
    : String(raw);

  // A failed validation must never replace the original file.
  try { parseNote(relativePath, content); } catch (cause) {
    const error = new Error(`笔记格式不合法：${cause.message}`);
    error.status = 400;
    throw error;
  }
  if (!exclusive) {
    try {
      const previous = await readNote(vaultDir, relativePath, { tolerateInvalid: true });
      if (previous.raw !== content) await saveVersion(vaultDir, relativePath, previous.raw, versionReason);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeDurably(temporary, content);
    await ensureSafeFilePath(vaultDir, relativePath, { allowMissing: true });
    if (exclusive) {
      await createExclusive(temporary, absolute, content);
    } else {
      await replaceFile(temporary, absolute);
    }
    await ensureSafeFilePath(vaultDir, relativePath);

    return parseNote(relativePath, content, await fsp.stat(absolute));
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function deleteNote(vaultDir, relativePath) {
  const previous = await readNote(vaultDir, relativePath, { tolerateInvalid: true });
  await saveVersion(vaultDir, relativePath, previous.raw, 'delete');
  const absolute = await ensureSafeFilePath(vaultDir, relativePath);
  const before = await fsp.lstat(absolute, { bigint: true });
  await ensureSafeTargetParent(vaultDir, absolute);
  const after = await fsp.lstat(absolute, { bigint: true });
  if (!sameEntry(before, after)) throw unsafeFileChanged();
  await fsp.rm(absolute, { force: true });
}

/**
 * 递归列出 vault 里所有 .md 文件的相对路径。
 *
 * 跳过点号开头的目录（.git 首当其冲）和 node_modules；不跟随符号链接，
 * 否则一个指向 vault 外面的链接会把整块磁盘扫进索引。
 *
 * onUnreadable(相对路径, error)：某个子文件夹读不了（权限、I/O 错误、扫描途中被换成
 * 文件）时交给调用方记下，其余照常列出。不传的话仍然抛错，调用方不会误以为那里没有笔记。
 * 根目录本身读不了始终抛错。
 */
const UNREADABLE_DIRECTORY = new Set(['EACCES', 'EPERM', 'ENOTDIR', 'EIO']);

async function listNotes(rootDir, options = {}) {
  const { extension = NOTE_EXTENSION, onUnreadable = null } = options;
  const results = [];

  async function walk(currentDir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (prefix && onUnreadable && UNREADABLE_DIRECTORY.has(error.code)) {
        onUnreadable(prefix, error);
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Windows 上目录项只要带「重解析点」属性就报成链接，OneDrive/Dropbox 的
        // 占位文件也是这样。用 lstat 再问一次：真正的符号链接和目录联接才跳过。
        let stats;
        try {
          stats = await fsp.lstat(path.join(currentDir, entry.name));
        } catch {
          continue;
        }
        if (stats.isSymbolicLink()) continue;
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      }
      if (isDirectory) {
        await walk(path.join(currentDir, entry.name), relative);
      } else if (isFile && entry.name.toLowerCase().endsWith(extension)) {
        results.push(relative);
      }
    }
  }

  await walk(rootDir, '');
  results.sort();
  return results;
}

module.exports = {
  NOTE_EXTENSION,
  parseFrontmatter,
  stringifyFrontmatter,
  hashContent,
  normalizeTags,
  stringifyFrontmatterValue,
  normalizeFrontmatter,
  patchFrontmatterField,
  resolveTitle,
  parseNote,
  readNote,
  writeNote,
  deleteNote,
  listNotes
};
