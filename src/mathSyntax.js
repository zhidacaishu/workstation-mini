const MarkdownIt = require('markdown-it');
const { tex } = require('@mdit/plugin-tex');

function installMathSyntax(md, render = () => '') {
  md.use(tex, { delimiters: 'dollars', mathFence: false, render });
  const inlineRule = md.inline.ruler.__rules__.find(rule => rule.name === 'math_inline_dollar').fn;
  // Inline formulas stay on one source line; multiline TeX belongs in a $$ block.
  md.inline.ruler.at('math_inline_dollar', (state, silent) => {
    const end = state.posMax;
    const newline = state.src.indexOf('\n', state.pos);
    if (newline >= 0) state.posMax = Math.min(end, newline);
    try { return inlineRule(state, silent); }
    finally { state.posMax = end; }
  });
  const rule = md.block.ruler.__rules__.find(rule => rule.name === 'math_block_dollar').fn;
  // An unfinished delimiter must not consume the remainder of the note.
  md.block.ruler.at('math_block_dollar', (state, start, end, silent) => {
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]).trimEnd();
    if (!first.startsWith('$$')) return false;
    let closed = first.length >= 4 && first.endsWith('$$');
    for (let line = start + 1; !closed && line < end; line += 1) {
      if (state.tShift[line] < state.blkIndent && state.bMarks[line] < state.eMarks[line]) break;
      closed = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd().endsWith('$$');
    }
    return closed && rule(state, start, end, silent);
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  return md;
}
const scanner = installMathSyntax(new MarkdownIt({ html: false }));
// Input already has code masked. Preserve offsets/newlines for source replacements.
function maskMath(source) {
  const text = String(source ?? '');
  const starts = [0];
  for (const match of text.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  const ranges = scanner.parse(text, {}).filter(token => token.type === 'math_block')
    .map(token => [starts[token.map[0]], starts[token.map[1]] ?? text.length]);
  const blank = (value, spans) => {
    const chars = value.split('');
    for (const [start, end] of spans) for (let i = start; i < end; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    return chars.join('');
  };
  const blocksMasked = blank(text, ranges);
  const rule = scanner.inline.ruler.__rules__.find(rule => rule.name === 'math_inline_dollar').fn;
  const state = new scanner.inline.State(blocksMasked.replace(/\r/g, '\n'), scanner, {}, []);
  const inlineRanges = [];
  while (state.pos < state.posMax) {
    const start = state.pos;
    if (blocksMasked[start] !== '$') { state.pos += 1; continue; }
    let slashes = 0;
    for (let i = start - 1; i >= 0 && blocksMasked.charCodeAt(i) === 92; i -= 1) slashes += 1;
    const count = state.tokens.length;
    if (blocksMasked[start] === '$' && slashes % 2 === 0 && rule(state, false)) {
      if (state.tokens.length > count && state.tokens.at(-1).type === 'math_inline') inlineRanges.push([start, state.pos]);
    } else state.pos += 1;
  }
  return blank(blocksMasked, inlineRanges);
}
module.exports = { installMathSyntax, maskMath };
