const MarkdownIt = require('markdown-it');
const { installMathSyntax } = require('./mathSyntax');

const md = installMathSyntax(new MarkdownIt({ html: false, linkify: false }));
const inlineRule = name => md.inline.ruler.__rules__.find(rule => rule.name === name).fn;
const backticks = inlineRule('backticks');
const image = inlineRule('image');

// 只记录渲染器真正生成的代码段。链接目的地、标题、转义符和公式由各自的规则消费。
md.inline.ruler.at('backticks', (state, silent) => {
  const start = state.pos;
  const count = state.tokens.length;
  const matched = backticks(state, silent);
  if (!silent && state.tokens.length > count && state.tokens.at(-1).type === 'code_inline') {
    const { base, ranges } = state.env;
    ranges.push([base + start, base + state.pos]);
  }
  return matched;
});

// markdown-it 会把图片说明切成子字符串递归解析，记录其相对本段的起点。
md.inline.ruler.at('image', (state, silent) => {
  if (silent || !state.src.startsWith('![', state.pos)) return image(state, silent);
  const base = state.env.base;
  state.env.base += state.pos + 2;
  try { return image(state, silent); }
  finally { state.env.base = base; }
});

// 引用前缀、列表缩进和表格转义会改变行内文本的偏移，但会保留每个反引号及其次序。
// 以反引号对齐代码段两头，在原文中遮蔽，两头之间可以包含软换行和容器前缀。
function collectInlineRanges(content, source, cursor, env, result) {
  if (!content.includes('`')) return cursor;
  const ranges = [];
  md.inline.parse(content, md, { ...env, base: 0, ranges }, []);
  const offsets = new Map();
  for (const match of content.matchAll(/`/g)) {
    const offset = source.indexOf('`', cursor);
    offsets.set(match.index, offset);
    cursor = offset + 1;
  }
  for (const [start, end] of ranges) result.push([offsets.get(start), offsets.get(end - 1) + 1]);
  return cursor;
}

// 使用渲染器的块边界：标题、相邻列表项和表格单元格各自配对，段内允许软换行。
// 在原文上等长替换，保留 CRLF 和 UTF-16 偏移给双链、挖空和附件定位。
function maskCode(markdown) {
  const text = String(markdown ?? '');
  if (!/`|~~~|\t| {4}/.test(text)) return text;
  const starts = [0];
  for (const match of text.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  const tokens = [];
  const env = {};
  md.block.parse(text.replace(/\r\n?/g, '\n'), md, env, tokens);
  const ranges = [];
  let inlineCursor = 0;
  for (const { type, map, content } of tokens) {
    if (type === 'fence' || type === 'code_block') {
      ranges.push([starts[map[0]], starts[map[1]] ?? text.length]);
    } else if (type === 'tr_open') {
      // 表格仅在行标记上带行号，同一行的单元格按源码顺序消费。
      inlineCursor = starts[map[0]];
    } else if (type === 'inline') {
      if (map) inlineCursor = starts[map[0]];
      inlineCursor = collectInlineRanges(content, text, inlineCursor, env, ranges);
    }
  }
  const parts = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(cursor, start), text.slice(start, end).replace(/[^\r\n]/g, ' '));
    cursor = end;
  }
  return parts.join('') + text.slice(cursor);
}

module.exports = { maskCode };
