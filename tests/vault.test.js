const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const paths = require('../src/vault/paths');
const note = require('../src/vault/note');
const { parseWikilinks, buildResolver, renderWikilinks } = require('../src/vault/wikilink');

async function makeVault() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ws-vault-'));
}

test('isSafeRelativePath 挡住目录穿越与绝对路径', () => {
  for (const unsafe of [
    '../secrets.md',
    'diary/../../etc/passwd',
    '/etc/passwd',
    '\\windows\\system32',
    'C:\\Users\\me\\notes.md',
    './diary.md',
    'diary//note.md',
    'questions/a?b.md',
    'notes/a:b.md',
    'notes/trailing. ',
    'notes/CON.md',
    'a\0b.md',
    ''
  ]) {
    assert.equal(paths.isSafeRelativePath(unsafe), false, `应拒绝 ${JSON.stringify(unsafe)}`);
  }

  for (const safe of ['diary/2026-08-06.md', 'a.md', 'reading/book/ch03.md']) {
    assert.equal(paths.isSafeRelativePath(safe), true, `应接受 ${safe}`);
  }
});

test('toAbsolute 对越界路径抛错而不是返回 vault 外的位置', () => {
  assert.throws(() => paths.toAbsolute('/vault', '../escape.md'), /Unsafe vault path/);
  assert.throws(() => paths.toAbsolute('/vault', '/etc/passwd'), /Unsafe vault path/);
  assert.equal(paths.toAbsolute('/vault', 'diary/a.md'), path.resolve('/vault/diary/a.md'));
});

test('相对路径一律用正斜杠，保证 Windows 与 macOS 之间索引可移植', () => {
  assert.equal(paths.toPosix('diary\\2026-08-06.md'), 'diary/2026-08-06.md');
  assert.equal(
    paths.toAbsolute('/vault', 'diary\\2026-08-06.md'),
    path.resolve('/vault/diary/2026-08-06.md')
  );
  assert.equal(paths.stripExtension('reading/book/ch03.md'), 'reading/book/ch03');
  assert.equal(paths.encodePath('research/C# 与 a?b.md'), 'research/C%23%20%E4%B8%8E%20a%3Fb.md');
  assert.equal(paths.sectionOf('diary/2026-08-06.md'), 'diary');
  assert.equal(paths.sectionOf('top.md'), '');
});

test('标题依次取 frontmatter、正文 H1、文件名', () => {
  assert.equal(note.resolveTitle({ title: '显式标题' }, '# 正文标题', 'diary/a.md'), '显式标题');
  assert.equal(note.resolveTitle({}, '# 正文标题\n\n内容', 'diary/a.md'), '正文标题');
  assert.equal(note.resolveTitle({}, '没有标题', 'diary/2026-08-06.md'), '2026-08-06');
});

// 日记标题天然是日期，而 YAML 会把不带引号的 2026-08-06 解析成 Date 对象。
// 不处理的话页面上显示的是「Tue Aug 05 2025 17:00:00 GMT-0700」这种东西。
test('frontmatter 里的日期型标题还原成原本写下的字面量', () => {
  const parsed = note.parseNote('diary/2026-08-06.md', '---\ntitle: 2026-08-06\n---\n正文');
  assert.ok(parsed.data.title instanceof Date, 'YAML 确实把它解析成了 Date');
  assert.equal(parsed.title, '2026-08-06', '但标题必须还原成原来那串日期');
});

test('日期字面量的还原不受本机时区影响', () => {
  // YAML 的纯日期按 UTC 午夜解析。用本地时区取值的话，负偏移时区（比如这台
  // 机器所在的 UTC-7）会把它渲染成前一天。
  assert.equal(note.stringifyFrontmatterValue(new Date('2026-08-06T00:00:00.000Z')), '2026-08-06');
  assert.equal(note.stringifyFrontmatterValue(new Date('2025-01-01T00:00:00.000Z')), '2025-01-01');
  assert.equal(note.stringifyFrontmatterValue('普通字符串'), '普通字符串');
  assert.equal(note.stringifyFrontmatterValue(undefined), '');
  assert.equal(note.stringifyFrontmatterValue(new Date('invalid')), '');
});

test('标签归一为小写去重数组，数组和逗号串都接受', () => {
  assert.deepEqual(note.normalizeTags(['计量', 'Causal', 'causal']), ['计量', 'causal']);
  assert.deepEqual(note.normalizeTags('计量, Causal , causal'), ['计量', 'causal']);
  assert.deepEqual(note.normalizeTags(undefined), []);
});

test('只替换目标 frontmatter 字段，完整保留其它原文', () => {
  const raw = [
    '---',
    '# 顶层注释',
    'title: "2026-08-12"',
    'status: planned # 状态说明',
    'description: |',
    '  第一行',
    '  第二行',
    'meta: &meta {nested: [one, two]}',
    'copy: *meta',
    '---',
    '',
    '# 正文',
    ''
  ].join('\n');
  const expectedPrefix = raw.replace('status: planned # 状态说明', 'status: done # 状态说明');

  assert.equal(note.patchFrontmatterField(raw, 'status', 'done'), expectedPrefix);
  // 列表写成块状，不压成一行 —— 用户在 Obsidian 里看到的 plan 应该还是列表的样子。
  const withPlan = note.patchFrontmatterField(raw, 'plan', ['09:00-10:00 A', 'B: C']);
  assert.match(withPlan, /\nplan:\n {2}- '09:00-10:00 A'\n {2}- 'B: C'\n/);
  assert.equal(
    withPlan.replace(/plan:\n(?: {2}- .*\n)+/, ''),
    raw,
    '插入目标字段之外的每个字节都应保持不变'
  );
  assert.deepEqual(note.parseNote('x.md', withPlan).data.plan, ['09:00-10:00 A', 'B: C']);

  // 空集合和标量本来就是一行，块状风格对它们没有意义。
  assert.match(note.patchFrontmatterField(raw, 'plan', []), /\nplan: \[\]\n/);
});

test('frontmatter 字段补丁保留 CRLF、支持无 frontmatter，并对危险目标失败关闭', () => {
  const crlf = '---\r\ntitle: "日期"\r\nstatus: planned\r\n---\r\n正文\r\n';
  assert.equal(
    note.patchFrontmatterField(crlf, 'status', 'done'),
    '---\r\ntitle: "日期"\r\nstatus: done\r\n---\r\n正文\r\n'
  );
  assert.equal(note.patchFrontmatterField('正文\n', 'status', 'done'), '---\nstatus: done\n---\n正文\n');
  assert.throws(
    () => note.patchFrontmatterField('---\nstatus: &current planned\ncopy: *current\n---\n正文\n', 'status', 'done'),
    error => error.status === 409 && /锚点/.test(error.message)
  );
});

test('写入再读出，frontmatter 与正文保持一致', async () => {
  const vault = await makeVault();
  try {
    await note.writeNote(vault, 'diary/2026-08-06.md', {
      data: { title: '今天', tags: ['日记', '计量'], mood: 4 },
      body: '# 今天\n\n读了工具变量那一章。\n'
    });

    const loaded = await note.readNote(vault, 'diary/2026-08-06.md');
    assert.equal(loaded.title, '今天');
    assert.deepEqual(loaded.tags, ['日记', '计量']);
    assert.equal(loaded.data.mood, 4);
    assert.equal(loaded.section, 'diary');
    assert.ok(loaded.body.includes('工具变量'));
    assert.equal(loaded.hash.length, 64);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('笔记读写删除拒绝 vault 内的符号链接祖先', async t => {
  const vault = await makeVault();
  const outside = await makeVault();
  const outsideNote = path.join(outside, 'secret.md');
  await fs.writeFile(outsideNote, '外部内容');
  try {
    try {
      await fs.symlink(outside, path.join(vault, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('当前环境不允许创建符号链接');
        return;
      }
      throw error;
    }

    await assert.rejects(note.readNote(vault, 'linked/secret.md'), /符号链接|普通文件/);
    await assert.rejects(note.writeNote(vault, 'linked/secret.md', { body: '覆盖' }), /符号链接/);
    await assert.rejects(note.deleteNote(vault, 'linked/secret.md'), /符号链接|普通文件/);
    assert.equal(await fs.readFile(outsideNote, 'utf8'), '外部内容');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('笔记读写删除拒绝最终文件符号链接', async t => {
  const vault = await makeVault();
  const outside = await makeVault();
  const outsideNote = path.join(outside, 'secret.md');
  await fs.writeFile(outsideNote, '外部内容');
  try {
    try {
      await fs.symlink(outsideNote, path.join(vault, 'linked.md'), 'file');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('当前环境不允许创建符号链接');
        return;
      }
      throw error;
    }

    await assert.rejects(note.readNote(vault, 'linked.md'), /普通文件/);
    await assert.rejects(note.writeNote(vault, 'linked.md', { body: '覆盖' }), /普通文件/);
    await assert.rejects(note.deleteNote(vault, 'linked.md'), /普通文件/);
    assert.equal(await fs.readFile(outsideNote, 'utf8'), '外部内容');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('笔记写入仍可创建普通嵌套目录', async () => {
  const vault = await makeVault();
  try {
    await note.writeNote(vault, 'new/nested/note.md', { body: '内容' });
    assert.equal(await fs.readFile(path.join(vault, 'new', 'nested', 'note.md'), 'utf8'), '内容\n');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('通过 vault 根目录的外层符号链接仍可正常访问笔记', async t => {
  const vault = await makeVault();
  const linkParent = await makeVault();
  const linkedVault = path.join(linkParent, 'vault-link');
  try {
    try {
      await fs.symlink(vault, linkedVault, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('当前环境不允许创建符号链接');
        return;
      }
      throw error;
    }

    await note.writeNote(linkedVault, 'nested/note.md', { body: '内容' });
    assert.equal((await note.readNote(linkedVault, 'nested/note.md')).body, '内容\n');
    await note.deleteNote(linkedVault, 'nested/note.md');
    await assert.rejects(fs.access(path.join(vault, 'nested', 'note.md')));
  } finally {
    await fs.rm(linkParent, { recursive: true, force: true });
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('listNotes 递归列出 .md 并跳过点号目录与 node_modules', async () => {
  const vault = await makeVault();
  try {
    await note.writeNote(vault, 'diary/2026-08-06.md', { body: 'a' });
    await note.writeNote(vault, 'reading/book/ch03.md', { body: 'b' });
    await fs.mkdir(path.join(vault, '.git'), { recursive: true });
    await fs.writeFile(path.join(vault, '.git', 'COMMIT_EDITMSG.md'), 'x');
    await fs.mkdir(path.join(vault, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(vault, 'node_modules', 'readme.md'), 'x');
    await fs.writeFile(path.join(vault, 'notes.txt'), 'x');

    assert.deepEqual(await note.listNotes(vault), ['diary/2026-08-06.md', 'reading/book/ch03.md']);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('写入是原子的，不留下临时文件', async () => {
  const vault = await makeVault();
  try {
    await note.writeNote(vault, 'a.md', { body: '内容' });
    const entries = await fs.readdir(vault);
    assert.deepEqual(entries, ['a.md'], '不应残留 .tmp- 文件');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('Windows 文件锁短暂持续时继续重试替换', async () => {
  const vault = await makeVault();
  const rename = fs.rename;
  let attempts = 0;
  fs.rename = async (...args) => {
    attempts += 1;
    if (attempts <= 4) {
      const error = new Error('文件正被占用');
      error.code = 'EBUSY';
      throw error;
    }
    return rename(...args);
  };

  try {
    await note.writeNote(vault, 'a.md', { body: '内容' });
    assert.equal(attempts, 5);
    assert.equal(await fs.readFile(path.join(vault, 'a.md'), 'utf8'), '内容\n');
  } finally {
    fs.rename = rename;
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('独占写入不会覆盖已经存在的笔记', async () => {
  const vault = await makeVault();
  try {
    await note.writeNote(vault, 'a.md', { body: '原内容' }, { exclusive: true });
    await assert.rejects(
      note.writeNote(vault, 'a.md', { body: '新内容' }, { exclusive: true }),
      error => error.code === 'EEXIST'
    );
    assert.equal(await fs.readFile(path.join(vault, 'a.md'), 'utf8'), '原内容\n');
    assert.deepEqual(await fs.readdir(vault), ['a.md']);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('并发独占写入同一路径只有一个成功且不残留临时文件', async () => {
  const vault = await makeVault();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => (
        note.writeNote(vault, 'a.md', { body: `内容 ${index}` }, { exclusive: true })
      ))
    );
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'EEXIST'));
    assert.match(await fs.readFile(path.join(vault, 'a.md'), 'utf8'), /^内容 \d+\n$/);
    assert.deepEqual(await fs.readdir(vault), ['a.md']);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('解析 wikilink 的各种写法', () => {
  const links = parseWikilinks(`
指向 [[diary/2026-08-06]]，
带显示文字 [[reading/book/ch03|第三章]]，
带小节 [[research/idea#设计]]，
两者都有 [[a/b#节|显示]]。
`);
  assert.equal(links.length, 4);
  assert.equal(links[0].target, 'diary/2026-08-06');
  assert.equal(links[1].display, '第三章');
  assert.equal(links[2].heading, '设计');
  assert.equal(links[3].target, 'a/b');
  assert.equal(links[3].heading, '节');
  assert.equal(links[3].display, '显示');
});

test('代码块与行内代码里的 [[ ]] 不算链接', () => {
  const markdown = [
    '正文里的 [[真链接]]',
    '',
    '```python',
    'x = [[1, 2], [3, 4]]',
    'y = [[假链接]]',
    '```',
    '',
    '行内 `[[也是假的]]` 结束。'
  ].join('\n');

  const targets = parseWikilinks(markdown).map(link => link.target);
  assert.deepEqual(targets, ['真链接']);
});

test('未闭合的围栏代码块要一直屏蔽到文末', () => {
  // 之前用带 m 标志的正则整体匹配时，未闭合围栏的兜底分支会在第一行行尾就收尾，
  // 结果只屏蔽掉代码块第一行，后面的 [[ ]] 全被当成真链接。
  const markdown = [
    '正文 [[真链接]]',
    '',
    '```python',
    'a = [[假1]]',
    'b = [[假2]]',
    'c = [[假3]]'
  ].join('\n');

  assert.deepEqual(parseWikilinks(markdown).map(link => link.target), ['真链接']);
});

test('波浪号围栏与更长的围栏同样生效', () => {
  const tilde = ['[[真]]', '~~~', '[[假]]', '~~~', '[[也真]]'].join('\n');
  assert.deepEqual(parseWikilinks(tilde).map(l => l.target), ['真', '也真']);

  // 四个反引号开启的围栏，内部出现三个反引号不算闭合。
  const longFence = ['````', '```', '[[假]]', '````', '[[真]]'].join('\n');
  assert.deepEqual(parseWikilinks(longFence).map(l => l.target), ['真']);
});

test('wikilink 支持全路径与文件名两种写法，重名时不猜', () => {
  const resolve = buildResolver([
    'diary/2026-08-06.md',
    'reading/econ/ch03.md',
    'reading/stats/ch03.md'
  ]);

  assert.equal(resolve('diary/2026-08-06'), 'diary/2026-08-06.md', '全路径应解析');
  assert.equal(resolve('2026-08-06'), 'diary/2026-08-06.md', '唯一文件名应解析');
  assert.equal(resolve('ch03'), '', 'ch03 有重名，不应随机指向其中一篇');
  assert.equal(resolve('reading/econ/ch03'), 'reading/econ/ch03.md', '但全路径仍然可用');
});

test('渲染链接：解析得到的指向笔记，解析不到的指向新建', () => {
  const resolve = buildResolver(['diary/2026-08-06.md']);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const html = renderWikilinks('看 [[diary/2026-08-06|昨天]] 和 [[还没写的]]', resolve, escapeHtml);
  assert.ok(html.includes('href="/note/diary/2026-08-06.md"'), '已存在的应链到笔记');
  assert.ok(html.includes('昨天</a>'), '应使用显示文字');
  assert.ok(html.includes('wikilink-missing'), '不存在的应标记为待建');
  assert.ok(html.includes('/new?path='), '待建链接应指向新建');
});

test('HTML wikilink 使用 H 标题命名空间并保留 #L 兼容', () => {
  const resolve = buildResolver(['a.md']);
  const escapeHtml = value => value;
  const html = renderWikilinks('[[a#**中文** 标题]] [[a#L9]]', resolve, escapeHtml);
  assert.match(html, /href="\/note\/a\.md#H-%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98"/);
  assert.match(html, /href="\/note\/a\.md#L9"/);
});

test('渲染时转义显示文字里的 HTML', () => {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const html = renderWikilinks('[[a|<img src=x onerror=alert(1)>]]', () => '', escapeHtml);
  assert.ok(!html.includes('<img'), '显示文字里的标签必须被转义');
  assert.ok(html.includes('&lt;img'), '应转义成实体');
});

test('解析 frontmatter 不喂 gray-matter 的全局缓存', () => {
  // gray-matter 只在**不传 options** 时启用缓存，而那个缓存以整份文件内容为 key、
  // 永不淘汰。这是个长驻桌面应用，笔记每改一次就多一条永久驻留的副本，没有上界。
  // 缓存命中时它还返回浅拷贝，data 是同一个对象引用，谁原地改一下就污染全局。
  const matter = require('gray-matter');
  matter.clearCache();

  for (let index = 0; index < 50; index += 1) {
    note.parseFrontmatter(`---\ntitle: t${index}\n---\n正文${index}`);
    note.stringifyFrontmatter(`正文${index}`, { title: `t${index}` });
  }
  assert.equal(Object.keys(matter.cache).length, 0, '一条都不该留下');

  // 行为要和裸调用完全一致，不能为了绕缓存改变解析结果。
  const parsed = note.parseFrontmatter('---\ntitle: 标题\ntags: [a, b]\n---\n\n正文\n');
  assert.equal(parsed.data.title, '标题');
  assert.deepEqual(parsed.data.tags, ['a', 'b']);
  assert.equal(parsed.content, '\n正文\n');

  // 相同内容解析两次，data 必须是各自独立的对象。
  const first = note.parseFrontmatter('---\ntitle: 同一份\n---\n正文');
  first.data.injected = 'oops';
  assert.equal(note.parseFrontmatter('---\ntitle: 同一份\n---\n正文').data.injected, undefined);
});

test('附件嵌入不算双链，笔记嵌入仍算', () => {
  const links = parseWikilinks('![[组会录音.mp3]] ![[图 1.png]] ![[论文.pdf]] ![[另一篇]] ![[第三篇.md]] [[第四篇]]');
  assert.deepEqual(links.map(link => link.target), ['另一篇', '第三篇', '第四篇']);
});

test('标题跳过代码和公式块，仍保留一级标题原文', () => {
  const body = ['~~~sh', '# initialize data', '~~~', '', '$$', '# formula', '$$', '', '# 真正的 **标题** ###'].join('\n');
  assert.equal(note.resolveTitle({}, body, 'notes/a.md'), '真正的 **标题**');
  assert.equal(note.resolveTitle({}, '#\n\n# 正文标题', 'name.md'), '正文标题');
  assert.equal(note.resolveTitle({}, '    # 代码\n\n~~~\n# 仍是代码', 'a.md'), 'a');
});

test('行首的三反引号行内代码不误判成未闭合代码块，后续双链仍可解析；CRLF 代码围栏同样生效', () => {
  const md = '```a`b``` 行内代码\n\n后面的 [[目标笔记]] 应正常识别\n';
  assert.deepEqual(parseWikilinks(md).map(link => link.target), ['目标笔记']);
  const html = renderWikilinks(md, target => target + '.md', value => value);
  assert.match(html, /<a class="wikilink" href="\/note\/%E7%9B%AE%E6%A0%87%E7%AC%94%E8%AE%B0\.md">目标笔记<\/a>/);

  const crlfFence = '```py\r\n\r\nx = [[inside_fence]]\r\n```\r\n\r\n[[outside_fence]]\r\n';
  assert.deepEqual(parseWikilinks(crlfFence).map(link => link.target), ['outside_fence']);
});

test('代码段按完整反引号串配对，保留外部链接的原始偏移', () => {
  const text = '```a ````b` [[代码内]]\r\n仍在代码内``` [[外部]]';
  const links = parseWikilinks(text);
  assert.deepEqual(links.map(link => [link.target, link.index]), [['外部', text.indexOf('[[外部]]')]]);
  const escaped = '\\`[[普通文字]]，`[[代码内]]`';
  assert.deepEqual(parseWikilinks(escaped).map(link => link.target), ['普通文字']);
});

test('反引号不能跨相邻标题、列表项和表格单元格配对', () => {
  for (const text of [
    '# ` 与 ``` 的区别\n参照 [[目标]] 和 `示例`',
    '- ` 与 ``` 的区别\r\n- 参照 [[目标]] 和 `示例`',
    '| A | B |\n|---|---|\n| ` | [[目标]] 和 `示例` |'
  ]) {
    assert.deepEqual(parseWikilinks(text).map(link => [link.target, link.index]), [['目标', text.indexOf('[[目标]]')]]);
  }
});

test('链接标题与公式中的反引号不遮蔽正文，图片说明里的代码按原文位置遮蔽', () => {
  for (const prefix of [
    '[语法](doc "比较 ` 与 ``` 的用法")', '$a` + b```$',
    '> [语法](doc\r\n> "比较 ` 与 ``` 的用法")',
    '- [语法](doc\n  "比较 ` 与 ``` 的用法")'
  ]) {
    const text = prefix + '，参照 [[目标]] 和 `示例`。';
    assert.deepEqual(parseWikilinks(text).map(link => [link.target, link.index]), [['目标', text.indexOf('[[目标]]')]]);
  }
  const text = '[[前]] ![说明 `[[示例]]`](img.png) [[后]]';
  assert.deepEqual(parseWikilinks(text).map(link => link.target), ['前', '后']);
});

test('macOS 上目录名的大小写或 Unicode 写法和磁盘上不同，写入不算离开资料库；真离开了仍然拦下', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const typed = 'café';
  await fs.mkdir(path.join(root, 'diary', typed), { recursive: true });
  const realRoot = await fs.realpath(root);
  const realpath = fs.realpath;
  let redirect = null;
  // 模拟不区分大小写的 APFS：realpath 返回磁盘上的拼写（大写、NFD）。
  t.mock.method(fs, 'realpath', async target => {
    const resolved = await realpath.call(fs, target);
    if (redirect) return redirect(resolved);
    return resolved
      .replace(`${path.sep}diary`, `${path.sep}Diary`)
      .replace(typed, typed.normalize('NFD'));
  });
  const relative = `diary/${typed}/x.md`;

  const absolute = await paths.ensureSafeFilePath(root, relative, { allowMissing: true, platform: 'darwin' });
  assert.equal(absolute, path.join(root, 'diary', typed, 'x.md'));
  await assert.rejects(paths.ensureSafeFilePath(root, relative, { allowMissing: true, platform: 'linux' }), /离开了资料库/);

  redirect = resolved => resolved.startsWith(realRoot) && resolved !== realRoot
    ? path.join(os.tmpdir(), 'elsewhere', path.basename(resolved))
    : resolved;
  await assert.rejects(paths.ensureSafeFilePath(root, relative, { allowMissing: true, platform: 'darwin' }), /离开了资料库/);
});

test('属性区标题是带时区的时间时按原文显示，不换算成 UTC', () => {
  const offset = note.parseNote('a.md', '---\ntitle: 2026-08-06T09:00:00+08:00\n---\n正文\n');
  assert.equal(offset.title, '2026-08-06T09:00:00+08:00');
  const spaced = note.parseNote('b.md', '---\ntags: [x]\ntitle: 2026-08-06 09:30:00 +08:00 # 会议\n---\n正文\n');
  assert.equal(spaced.title, '2026-08-06 09:30:00 +08:00');
  assert.equal(note.parseNote('c.md', '---\ntitle: 2026-08-06\n---\n').title, '2026-08-06');
  // 嵌套在别的键下面的 title 不是笔记标题。
  assert.equal(note.parseNote('d.md', '---\nmeta:\n  title: 2026-01-01T00:00:00+08:00\ntitle: 2026-08-06T09:00:00Z\n---\n').title, '2026-08-06T09:00:00Z');
});
