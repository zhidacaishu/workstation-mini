const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const publish = require('../src/publish');
const { parseFrontmatter } = require('../src/vault/note');

test('发表提交只包含当前文章，保留仓库中其它已暂存修改', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blog-commit-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Publish Test');
    git('config', 'user.email', 'publish@example.test');
    git('config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repo, 'unrelated.txt'), 'existing');
    git('add', 'unrelated.txt');
    git('commit', '-qm', 'initial');
    await fs.writeFile(path.join(repo, 'unrelated.txt'), 'staged change');
    git('add', 'unrelated.txt');
    const mdx = publish.toMdx({ title: '文章', raw: '正文' }, { pubDate: '2026-03-17' });
    const result = await publish.publish(repo, { slug: 'article', mdx, commit: true });
    assert.equal(result.committed, true);
    assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'src/content/blog/article.mdx');
    assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.txt');
    assert.equal(git('show', 'HEAD:unrelated.txt'), 'existing');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// ── 发表 ──────────────────────────────────────────────

test('发表转换和校验保留代码里的标题、公式及双链示例', () => {
  const examples = [
    '代码示例：`echo $$ [[target]]`。',
    '代码示例：``echo ` $$ [[target]]``。',
    ['~~~~bash', '# 注释', 'echo $$ [[target]]', '~~~~ text', '# 仍在围栏内', '~~~~'].join('\n'),
    ['````md', '```', '# 注释', '[[target]] $$value$$', '````'].join('\n')
  ];
  for (const example of examples) {
    const mdx = publish.toMdx({ title: '代码', raw: '# 正文标题\n\n' + example }, {
      pubDate: '2026-03-17', description: '代码示例'
    });
    assert.equal(parseFrontmatter(mdx).content.trim(), '## 正文标题\n\n' + example);
    assert.deepEqual(publish.validate(mdx), { ok: true, problems: [] });
  }
});

test('发表保留双链显示文字中的行内代码，并处理缩进标题', () => {
  const mdx = publish.toMdx({ title: '笔记', raw: '  # 标题 `code`\n\n[[target|使用 `code`]] 与 [[target|`a]b`]]' }, {
    pubDate: '2026-03-17'
  });
  assert.equal(parseFrontmatter(mdx).content.trim(), '## 标题 `code`\n\n使用 `code` 与 `a]b`');
  assert.deepEqual(publish.validate(mdx), { ok: true, problems: [] });
});

test('自动摘要跳过不同长度的围栏代码，选取正文', () => {
  assert.equal(publish.firstSentence('~~~~bash\necho secret\n~~~~\n正文。'), '正文。');
  assert.equal(publish.firstSentence('````md\n```\n示例\n````\n正文。'), '正文。');
});

test('双链显示文字中的公式在展开后仍转换，行内代码保持原样', () => {
  const mdx = publish.toMdx({
    title: '公式', raw: '[[target|公式 $$x$$ 与 `$$code$$`]]'
  }, { pubDate: '2026-03-17' });
  assert.equal(parseFrontmatter(mdx).content.trim(), '公式 \n$$\nx\n$$\n 与 `$$code$$`');
  assert.deepEqual(publish.validate(mdx), { ok: true, problems: [] });
});

test('并发发表同名文章只允许一次成功，并保留赢家的完整内容', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blog-race-'));
  try {
    const drafts = ['first', 'second'].map(title => publish.toMdx({ title, raw: title }, {
      pubDate: '2026-03-17'
    }));
    const results = await Promise.all(drafts.map(mdx => publish.publish(repo, { slug: 'same', mdx })));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.match(results.find(result => !result.ok).problems[0], /已存在/);
    assert.equal(await fs.readFile(path.join(repo, 'src/content/blog/same.mdx'), 'utf8'),
      drafts[results.findIndex(result => result.ok)]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('转 MDX 时遵守 myblog 的三条硬约束', () => {
  const note = {
    title: '工具变量笔记',
    raw: [
      '---', 'title: 工具变量笔记', 'tags: ["计量 经济学", "IV Methods"]', '---', '',
      '# 工具变量', '',
      '正文里提到 [[reading/econ/ch03|第三章]] 和 [[另一篇]]。', '',
      '行内公式 $$y = X\\beta + u$$ 结束。'
    ].join('\n')
  };
  const mdx = publish.toMdx(note, { pubDate: '2026-03-17', category: 'notes' });

  assert.ok(!/^#\s+/m.test(mdx.split('---').slice(2).join('---')), '正文里不能有 H1');
  assert.match(mdx, /## 工具变量/, 'H1 应降级成 H2');
  assert.match(mdx, /tags: \["计量-经济学", "iv-methods"\]/, '标签要小写 kebab-case');
  assert.match(mdx, /第三章 和 另一篇/, '双链应剥成纯文字');
  assert.ok(!mdx.includes('[['), '不能残留双链');

  // $$ 必须**还在**，而且独占一行。
  //
  // 先断存在再断位置：以前替换串写成 '$1\n$$'，而 `$$` 在替换串里是「一个字面 $」
  // 的转义，公式分隔符被悄悄改成了单个 $ —— 那时候下面的循环一条都匹配不到，
  // 于是这条测试什么也没验证，坏 MDX 一路通过。
  const fenceLines = mdx.split('\n').filter(line => line.trim().includes('$$'));
  assert.equal(fenceLines.length, 2, '一对 $$ 必须原样保留');
  assert.ok(!/(^|[^$])\$([^$]|$)/.test(mdx.replace(/\$\$/g, '')), '不能留下落单的 $');
  for (const line of fenceLines) {
    const t = line.trim();
    assert.ok(t === '$$' || /^\$\$[^$]*\$\$$/.test(t), `公式分隔符没独占行：${t}`);
  }
});

test('代码块里的 # 注释既不被降级，也不会被校验器误判成 H1', () => {
  const note = {
    title: '构建笔记',
    raw: [
      '---', 'title: 构建笔记', '---', '',
      '# 真正的标题', '',
      '```bash',
      '# 这是 shell 注释，不是标题',
      '~~~',
      '# 仍然在代码块里',
      '```', ''
    ].join('\n')
  };
  const mdx = publish.toMdx(note, { pubDate: '2026-03-17', description: '构建', category: 'notes' });

  assert.match(mdx, /## 真正的标题/, '正文的 H1 要降级');
  assert.ok(mdx.includes('# 这是 shell 注释，不是标题'), '代码块里的 # 必须原样保留');
  assert.ok(mdx.includes('# 仍然在代码块里'), '围栏内嵌 ~~~ 不该把围栏状态翻反');
  // 校验器要和 toMdx 看同一份东西，否则 /publish/write 会拿 400 拒掉一篇好稿子。
  assert.deepEqual(publish.validate(mdx), { ok: true, problems: [] });
});

test('校验器拦下不合格的 MDX，不让它进博客仓库', () => {
  assert.equal(publish.validate('---\ntitle: "x"\ndescription: "d"\npubDate: "2026-01-01"\ncategory: "c"\n---\n\n## 好的\n').ok, true);

  const missing = publish.validate('---\ntitle: "x"\n---\n\n正文\n');
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some(p => p.includes('description')));

  const h1 = publish.validate('---\ntitle: "x"\ndescription: "d"\npubDate: "2026-01-01"\ncategory: "c"\n---\n\n# 还有 H1\n');
  assert.ok(h1.problems.some(p => p.includes('H1')));

  const link = publish.validate('---\ntitle: "x"\ndescription: "d"\npubDate: "2026-01-01"\ncategory: "c"\n---\n\n还有 [[双链]]\n');
  assert.ok(link.problems.some(p => p.includes('双链')));
});

// 发表是对外动作 —— 程序替你 push 到公开博客，出问题的代价太大。
test('发表默认只写文件，不提交也不推送', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blog-'));
  try {
    const mdx = '---\ntitle: "x"\ndescription: "d"\npubDate: "2026-01-01"\ncategory: "c"\n---\n\n## 正文\n';
    const result = await publish.publish(repo, { slug: 'my-post', mdx });

    assert.equal(result.ok, true);
    assert.equal(result.committed, false);
    assert.match(result.note, /未提交/);
    assert.ok(fsSync.existsSync(path.join(repo, 'src/content/blog/my-post.mdx')));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('已存在的文章不覆盖', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-blog2-'));
  try {
    const mdx = '---\ntitle: "x"\ndescription: "d"\npubDate: "2026-01-01"\ncategory: "c"\n---\n\n## 正文\n';
    await publish.publish(repo, { slug: 'dup', mdx });
    const second = await publish.publish(repo, { slug: 'dup', mdx: `${mdx}\n新内容` });

    assert.equal(second.ok, false);
    assert.ok(second.problems[0].includes('已存在'));
    assert.ok(!fsSync.readFileSync(path.join(repo, 'src/content/blog/dup.mdx'), 'utf8').includes('新内容'));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
