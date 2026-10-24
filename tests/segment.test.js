const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  LEXICAL_STOPWORDS,
  tokenize,
  tokenizeToText,
  toMatchExpression,
  toBroadMatchExpression
} = require('../src/segment');

test('tokenize 切开中文词并丢掉标点', () => {
  const tokens = tokenize('第三章 计量经济学的工具变量方法，教材第45页。');
  assert.ok(tokens.includes('教材'), '应切出「教材」');
  assert.ok(tokens.includes('计量'), '应切出「计量」');
  assert.ok(!tokens.includes('，'), '标点不应成为 token');
  assert.ok(!tokens.includes('。'), '标点不应成为 token');
});

test('tokenize 把拉丁字母转小写，方便大小写无关匹配', () => {
  assert.deepEqual(tokenize('Heterogeneity TREATMENT effect'), ['heterogeneity', 'treatment', 'effect']);
});

test('tokenize 对空输入返回空数组', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize('，。！'), []);
});

test('toMatchExpression 把 FTS5 语法字符当普通文本处理', () => {
  // 未加引号时这些会被 FTS5 解析成查询语法并抛错，而不是当成搜索词。
  for (const query of ['A AND B', 'NOT', 'OR', 'foo*', '(bar)']) {
    const expression = toMatchExpression(query);
    const db = new Database(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(body, tokenize="unicode61")');
    assert.doesNotThrow(
      () => db.prepare('SELECT count(*) FROM t WHERE body MATCH ?').get(expression),
      `查询 ${query} 不应触发 FTS5 语法错误`
    );
    db.close();
  }
});

test('带引号的查询能正常匹配到原文', () => {
  // 分词器把引号当标点丢掉，所以 token 里不会残留引号；toMatchExpression 里的
  // 转义是防御性的。这里断言的是真正重要的行为：用户输入带引号也能搜到东西。
  const db = new Database(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(body, tokenize="unicode61")');
  db.prepare('INSERT INTO t VALUES (?)').run(tokenizeToText('he said hi to everyone'));

  const expression = toMatchExpression('said "hi"');
  assert.equal(expression, '"said" AND "hi"');
  assert.equal(db.prepare('SELECT count(*) AS c FROM t WHERE body MATCH ?').get(expression).c, 1);
  db.close();
});

test('查询里没有可检索 token 时返回空串', () => {
  assert.equal(toMatchExpression('   '), '');
  assert.equal(toMatchExpression('，。'), '');
});

test('broad FTS 查询过滤停用词、窄疑问词并按首次出现去重', () => {
  assert.equal(
    toBroadMatchExpression('请问工具变量如何处理工具变量的内生性'),
    '"工具" OR "变量" OR "处理" OR "内" OR "生" OR "性"'
  );
  assert.equal(toBroadMatchExpression('方法和模型有什么效应'), '"方法" OR "模型" OR "效应"');
  assert.equal(toBroadMatchExpression('为什么 是否 what how 的'), '');
  assert.ok(LEXICAL_STOPWORDS.has('的'));
});

test('broad FTS 查询也把语法字符当普通文本处理', () => {
  const db = new Database(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(body, tokenize="unicode61")');
  for (const query of ['A AND B', 'NOT', 'OR', 'foo*', '(bar)', 'said "hi"']) {
    const expression = toBroadMatchExpression(query);
    assert.doesNotThrow(
      () => expression && db.prepare('SELECT count(*) FROM t WHERE body MATCH ?').get(expression),
      `查询 ${query} 不应触发 FTS5 语法错误`
    );
  }
  db.close();
});

// 这是整个中文检索方案的回归基线。方案定稿前在 SQLite 3.45.1 上实测过一次，
// better-sqlite3 13 自带 3.53.4 上复测结果一致。改动分词逻辑时这个测试必须仍然通过。
test('中文检索基线：索引与查询共用分词器后 FTS5 的命中情况', () => {
  const db = new Database(':memory:');
  db.exec('CREATE VIRTUAL TABLE notes USING fts5(body, tokenize="unicode61")');

  const document = '第三章 计量经济学的工具变量方法，教材第45页。今天读了平台定价的文献。';
  db.prepare('INSERT INTO notes VALUES (?)').run(tokenizeToText(document));

  const matches = query => {
    const expression = toMatchExpression(query);
    if (!expression) return false;
    return db.prepare('SELECT count(*) AS c FROM notes WHERE body MATCH ?').get(expression).c > 0;
  };

  // FTS5 能命中的
  for (const query of ['教材', '计量', '工具变量', '平台定价', '定价']) {
    assert.equal(matches(query), true, `FTS5 应命中「${query}」`);
  }

  // 分词边界不一致：文档被切成「计量 / 经济 / 学的」，所以「经济学」切出的
  // 「经济 / 学」里的「学」对不上「学的」。这类必须由 LIKE 兜底，见 search.js。
  assert.equal(matches('经济学'), false, '「经济学」预期走 LIKE 兜底而非 FTS5');
  assert.ok(document.includes('经济学'), '但原文确实包含「经济学」，所以兜底必须存在');

  db.close();
});
