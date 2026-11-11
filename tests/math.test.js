const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, replaceWikilinks } = require('../src/markdown');
const { parseWikilinks } = require('../src/vault/wikilink');
const { parseCloze, parseCardFile } = require('../src/cards');
const tick = String.fromCharCode(96);

test('公式渲染覆盖中文、分数、矩阵、多行推导和行锚', () => {
  const source = '损失 $\\log x$。\n\n$$\n\\begin{aligned} a &= \\frac{1}{2} \\\\ b &= \\begin{pmatrix}1 & 0 \\\\ 0 & 1\\end{pmatrix} \\end{aligned}\n$$';
  const html = renderMarkdown(source);
  assert.match(html, /katex-mathml/);
  assert.match(html, /math-display/);
  assert.match(html, /id="L3"/);
  assert.doesNotMatch(html, /math-error/);
  assert.equal((html.match(/data-math-source=/g) || []).length, 2);
});

test('代码、转义美元、价格与未闭合定界符保持原文', () => {
  const source = tick + '$x$' + tick + '\n\n' + tick.repeat(3) + 'tex\n$$x$$\n' + tick.repeat(3) + '\n\n价格 $20 和 $30，转义 \\$x\\$。\n\n$$\n未完成\n\n# 后续标题';
  const html = renderMarkdown(source);
  assert.doesNotMatch(html, /class="katex/);
  assert.match(html, /<h1[^>]*>后续标题/);
  assert.match(html, /价格 \$20 和 \$30/);
});

test('公式中的双链不会变成链接或被索引为缺失链接', () => {
  const source = '$[[x]]$ 与 [[real]]\n\n$$\n[[y]]\n$$';
  assert.equal(replaceWikilinks(source, () => ''), '$[[x]]$ 与 [real](/new?path=real)\n\n$$\n[[y]]\n$$');
  assert.deepEqual(parseWikilinks(source).map(x => x.target), ['real']);
  assert.equal(parseWikilinks('\\$[[real]]\\$')[0].target, 'real');
});

test('LaTeX 分组和代码不会变成挖空，整条公式可挖空', () => {
  assert.equal(parseCloze('$x^{{2}}$').hasCloze, false);
  assert.equal(parseCloze(tick + '{{code}}' + tick).hasCloze, false);
  const value = parseCloze('答案 {{ $\\frac{a}{b}$ }}，以及 {{普通}}');
  assert.deepEqual(value.answers, ['$\\frac{a}{b}$', '普通']);
  assert.equal(value.masked, '答案 ＿＿＿＿，以及 ＿＿＿＿');
  assert.equal(value.filled, '答案 $\\frac{a}{b}$，以及 普通');
  const card = parseCardFile('cards/math.md', '## 问题\n{{ $\\frac{a}{b}$ }}')[0];
  assert.match(renderMarkdown(card.answer), /class="katex/);
  assert.doesNotMatch(renderMarkdown(card.question), /frac|data-math-source/);
});

test('错误公式安全回退且宏不会跨文档泄漏', () => {
  const error = renderMarkdown('$\\unknown{<img src=x onerror=alert(1)>}$\n\n后续正文');
  assert.match(error, /math-error/);
  assert.doesNotMatch(error, /<img /);
  assert.match(error, /后续正文/);
  assert.doesNotMatch(renderMarkdown('$\\gdef\\abc{X}$ $\\abc$'), /math-error/);
  assert.match(renderMarkdown('$\\abc$'), /math-error/);
  assert.doesNotMatch(renderMarkdown('$\\href{javascript:alert(1)}{click}$'), /<a /);
  assert.match(renderMarkdown('$\\def\\loop{\\loop}\\loop$'), /math-error/);
});

test('未闭合行内公式不会跨段吞掉挖空或双链', () => {
  const source = '$unfinished\n\n{{答案}} 与 [[real]]\n\nlater$';
  assert.doesNotMatch(renderMarkdown(source), /class="katex/);
  assert.deepEqual(parseCloze(source).answers, ['答案']);
  assert.deepEqual(parseWikilinks(source).map(x => x.target), ['real']);
});

test('正文目录复用渲染锚点，保留标题层级并排除页标题与代码示例', () => {
  const outline = [];
  const source = [
    '# 目录测试', '', '## **研究** `方法` 与 [[source|资料]]', '',
    '#### 深层小节', '', '###### 最深层', '', '### 同级分支', '',
    '## 重复', '', '## 重复', '', '```md', '# 示例不入目录', '```', '',
    '# 独立章节', '', '## $x$ 与 ![图示](image.png)'
  ].join('\n');
  const html = renderMarkdown(source, () => 'source.md', { title: '目录测试', outline });
  assert.deepEqual(outline.map(item => [item.text, item.level]), [['研究 方法 与 资料', 2], ['重复', 2], ['重复', 2], ['独立章节', 1]]);
  assert.deepEqual(outline[0].children.map(item => [item.text, item.level]), [['深层小节', 4], ['同级分支', 3]]);
  assert.equal(outline[0].children[0].children[0].level, 6);
  assert.equal(outline[3].children[0].text, 'x 与 图示');
  const flat = entries => entries.flatMap(item => [item, ...flat(item.children)]);
  const entries = flat(outline);
  assert.equal(new Set(entries.map(item => item.id)).size, entries.length);
  for (const entry of entries) assert.match(html, new RegExp('<h' + entry.level + ' id="' + entry.id + '"'));
  assert.ok(!entries.some(item => /目录测试|示例不入目录/.test(item.text)));
});
