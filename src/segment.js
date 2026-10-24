// 中文分词。
//
// SQLite FTS5 自带的分词器处理不了中文：`unicode61` 和 `porter` 把一整串汉字
// 当成一个 token，搜「教材」匹配不到「教材第45页」；`trigram` 只索引三字序列，
// 两字词（教材、计量、日记、论文）一律搜不到，而两字词恰是中文最常见的词长。
//
// 解决办法是在喂给 FTS5 之前先分词，并且**索引和查询用同一个分词器**，这样
// 两边切出来的 token 边界一致。Intl.Segmenter 是 ECMA-402 内置能力，不需要任何
// 原生依赖，Windows 和 macOS 上行为一致。
//
// 它不完美：「计量经济学」会被切成「计量 / 经济 / 学的」，所以查询「经济学」
// 命中不了。这类分词边界不一致的情况由 search.js 的 LIKE 兜底负责。

const WORD_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

const LEXICAL_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '把', '被',
  '这', '那', '有', '没', '不', '很', '一个', '我们', '可以', '因为', '所以', '但是',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'for', 'on', 'with',
  'that', 'this', 'it', 'as', 'we', 'be', 'by', 'from', 'at', 'can', 'not'
]);

const QUESTION_STOPWORDS = new Set([
  ...LEXICAL_STOPWORDS,
  '什么', '为何', '为什么', '如何', '怎么', '怎样', '哪个', '哪些', '哪里', '是否', '吗', '呢', '请问',
  'what', 'why', 'how', 'which', 'where', 'whether', 'who', 'when', 'do', 'does', 'did'
]);

// 拉丁字母与数字统一转小写，让 FTS5 的匹配不受大小写影响；中日韩文字不受影响。
function normalizeToken(token) {
  return token.toLowerCase();
}

/**
 * 把一段文本切成 token 数组。标点、空白和其它非词素片段会被丢掉。
 */
function tokenize(text) {
  const source = String(text ?? '');
  if (!source) return [];

  const tokens = [];
  for (const part of WORD_SEGMENTER.segment(source)) {
    if (!part.isWordLike) continue;
    const token = normalizeToken(part.segment);
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * 把文本切成以空格分隔的 token 串，这是实际写进 FTS5 的形式。
 */
function tokenizeToText(text) {
  return tokenize(text).join(' ');
}

/**
 * 把用户输入的查询转成 FTS5 的 MATCH 表达式。
 *
 * 每个 token 都用双引号包起来当短语处理，避免 FTS5 把 `AND`、`OR`、`NOT`、`*`、
 * `(` 这些字符当成查询语法——用户搜「C++」或「A AND B」时不该报语法错。
 * 多个 token 之间是 AND：搜「平台定价」要求两个词都出现。
 *
 * 返回空串表示查询里没有任何可检索的 token，调用方应据此跳过 FTS5。
 */
function quoteMatchToken(token) {
  return `"${token.replaceAll('"', '""')}"`;
}

function toMatchExpression(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return '';
  return tokens.map(quoteMatchToken).join(' AND ');
}

function toBroadMatchExpression(query) {
  const tokens = [...new Set(tokenize(query).filter(token => !QUESTION_STOPWORDS.has(token)))];
  if (tokens.length === 0) return '';
  return tokens.map(quoteMatchToken).join(' OR ');
}

module.exports = {
  LEXICAL_STOPWORDS,
  tokenize,
  tokenizeToText,
  toMatchExpression,
  toBroadMatchExpression
};
