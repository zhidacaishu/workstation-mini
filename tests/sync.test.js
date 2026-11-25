const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSync } = require('../src/sync');
const { writeNote } = require('../src/vault/note');

const quietLogger = { warn() {}, log() {} };

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sync-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

test('vault 不是 git 仓库时，同步降级为空操作而不是报错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-nogit-'));
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.equal(await sync.isRepo(), false);

    const pulled = await sync.pull();
    assert.equal(pulled.ok, true);
    assert.ok(pulled.skipped, '应报告跳过原因');

    const pushed = await sync.commitAndPush('test');
    assert.equal(pushed.ok, true);
    assert.ok(pushed.skipped);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('资料库必须是工作树根：普通子目录不能同步父仓库', async () => {
  const root = await makeRepo();
  try {
    const vaultDir = path.join(root, 'vault');
    await fs.mkdir(path.join(vaultDir, 'notes'), { recursive: true });
    await fs.writeFile(path.join(vaultDir, 'notes', 'a.md'), '# 笔记\n');
    await fs.writeFile(path.join(root, 'outside.txt'), '资料库之外\n');
    const before = git(root, 'status', '--porcelain', '-uall');
    const sync = createSync({ vaultDir, logger: quietLogger });
    assert.equal(await sync.isRepo(), false);
    assert.equal((await sync.status()).isRepo, false);
    assert.ok((await sync.pull()).skipped);
    assert.ok((await sync.commitAndPush('不能提交父仓库')).skipped);
    const cycle = await sync.cycle('不能同步父仓库');
    assert.ok(cycle.pulled.skipped);
    assert.ok(cycle.pushed.skipped);
    assert.equal(git(root, 'status', '--porcelain', '-uall'), before);
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
    assert.throws(() => git(root, 'rev-parse', '--verify', 'HEAD'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('资料库工作树根检查兼容未提交仓库、linked worktree 和 Windows 路径别名', async () => {
  const root = await makeRepo();
  const worktree = root + '-linked';
  try {
    assert.equal(await createSync({ vaultDir: root }).isRepo(), true, '不要求已有 HEAD');
    if (process.platform === 'win32') {
      assert.equal(await createSync({ vaultDir: root.toUpperCase().replaceAll('\\', '/') }).isRepo(), true);
    }
    await fs.writeFile(path.join(root, 'seed.md'), '# seed\n');
    git(root, 'add', 'seed.md');
    git(root, 'commit', '-qm', 'seed');
    git(root, 'worktree', 'add', '-qb', 'linked', worktree);
    assert.equal(await createSync({ vaultDir: worktree }).isRepo(), true);
    await fs.mkdir(path.join(worktree, 'subdir'));
    assert.equal(await createSync({ vaultDir: path.join(worktree, 'subdir') }).isRepo(), false);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

// 退出路径要用比常规同步短得多的 git 期限，这份选项得一路透传到每次调用，
// 而不是只落在其中一条命令上。
test('提交推送接受自定义 git 期限', async () => {
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    const result = await sync.commitAndPush('限时提交', { timeout: 30_000 });
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.match(git(dir, 'log', '--oneline'), /限时提交/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没配远端时能提交，但不尝试推送', async () => {
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    const result = await sync.commitAndPush('第一次提交');
    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, false, '没有远端就不该推送');

    assert.match(git(dir, 'log', '--oneline'), /第一次提交/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('全局关掉未跟踪文件显示时，只新建了笔记也照样提交', async () => {
  const dir = await makeRepo();
  try {
    await writeNote(dir, 'notes/a.md', { body: '旧笔记' });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    await writeNote(dir, 'notes/new.md', { body: '新笔记' });

    const result = await createSync({ vaultDir: dir, logger: quietLogger }).commitAndPush('新笔记');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.committed, true);
    assert.match(git(dir, 'ls-files'), /notes\/new\.md/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('取消只作用于已经排队的操作：退出前那次提交照常执行', async () => {
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });
    const queued = sync.commitAndPush('排队中的');
    sync.cancel();
    const cancelled = await queued;
    assert.notEqual(cancelled.committed, true, '取消前排着队的操作不该提交');

    const result = await sync.commitAndPush('退出前提交');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.skipped, undefined, '不能被当成「不是 git 仓库」跳过');
    assert.equal(result.committed, true);
    assert.match(git(dir, 'log', '--oneline'), /退出前提交/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('没有改动时不产生空提交', async () => {
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });
    await sync.commitAndPush('第一次');

    const second = await sync.commitAndPush('第二次');
    assert.equal(second.committed, false, '没改动就不该再提交');
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 这是整个同步方案的安全底线：索引库一旦进了版本库，两台机器各改一次就是
// 二进制冲突，而「索引不进版本库」正是用来避开这件事的。
test('自动为 vault 建 .gitignore 并忽略索引库', async () => {
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, created: true });

    // 造一个索引库出来，确认 git 确实看不见它。
    fsSync.writeFileSync(path.join(dir, 'workstation.db'), 'fake');
    fsSync.writeFileSync(path.join(dir, 'workstation.db-wal'), 'fake');
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    // -uall 才会逐个列出未跟踪文件；默认只显示折叠后的目录名。
    const status = git(dir, 'status', '--porcelain', '-uall');
    assert.ok(!status.includes('workstation.db'), `索引库不该出现在 git status 里：\n${status}`);
    assert.ok(status.includes('notes/a.md'), 'Markdown 应正常被跟踪');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('注释和近似文件名不能冒充有效忽略规则', async () => {
  const dir = await makeRepo();
  try {
    fsSync.writeFileSync(path.join(dir, '.gitignore'), '# workstation.db 应该忽略\nmyworkstation.db\n# *.tmp-*\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, appended: true });
    const content = fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.equal(content.match(/^workstation\.db$/gm)?.length, 1);
    assert.equal(content.match(/^workstation\.db-shm$/gm)?.length, 1);
    assert.equal(content.match(/^workstation\.db-wal$/gm)?.length, 1);
    assert.equal(content.match(/^\*\.tmp-\*$/gm)?.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('已有 .gitignore 但没忽略索引库时，补上规则而不是覆盖原文件', async () => {
  const dir = await makeRepo();
  try {
    fsSync.writeFileSync(path.join(dir, '.gitignore'), '# 我自己的规则\n*.tmp\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, appended: true });

    const content = fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(content, /我自己的规则/, '原有规则必须保留');
    assert.match(content, /workstation\.db/);
    assert.match(content, /\*\.tmp-\*/);

    // 再跑一次应识别为已忽略，不重复追加。
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, unchanged: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 第一次启动必然踩到：分支刚建出来，还没有上游。
// 不特判的话 git pull 会以 "no tracking information" 报错，每次首启都吐一段吓人的日志。
test('已有索引忽略规则时只补原子写临时文件规则', async () => {
  const dir = await makeRepo();
  try {
    fsSync.writeFileSync(path.join(dir, '.gitignore'), 'workstation.db\nworkstation.db-shm\nworkstation.db-wal\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, appended: true });

    const content = fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.equal(content.match(/^workstation\.db$/gm)?.length, 1, '不应重复追加已有数据库规则');
    assert.match(content, /\*\.tmp-\*/);
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, unchanged: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 旧版本配过大文件存储服务时会把 attachments/ 和 audio/ 写进 .gitignore。Mini 没有那项
// 服务，留着这些规则就意味着笔记里的图片永远不进 Git、换台设备就丢。
test('旧版本写进 .gitignore 的媒体规则会被摘掉，基础规则一条不少', async () => {
  const dir = await makeRepo();
  try {
    const managed = [
      '# 我的规则', '*.bak', '',
      '# >>> workstation managed media ignores >>>',
      '# 二进制资源由大文件存储服务托管，不进 Git（Git 存不动，也合并不了）。',
      'attachments/', 'audio/',
      '# <<< workstation managed media ignores <<<', ''
    ].join('\n');
    fsSync.writeFileSync(path.join(dir, '.gitignore'), managed);
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, appended: true, removed: ['attachments/', 'audio/'] });
    const content = fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.doesNotMatch(content, /^audio\/$/m, 'audio/ 必须重新纳入 Git');
    assert.doesNotMatch(content, /^attachments\/$/m, 'attachments/ 必须重新纳入 Git');
    assert.doesNotMatch(content, /workstation managed media ignores/);
    assert.match(content, /^\*\.bak$/m);
    assert.match(content, /^workstation\.db$/m);
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, unchanged: true }, '摘干净之后不再反复改写');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('用户自己写的同名规则不动', async () => {
  const dir = await makeRepo();
  try {
    fsSync.writeFileSync(path.join(dir, '.gitignore'), '# 我自己的规则\nscratch/\naudio/\nattachments/\n*.bak\n');
    await createSync({ vaultDir: dir, logger: quietLogger }).ensureGitignore();
    const content = fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(content, /我自己的规则/);
    assert.equal(content.match(/^audio\/$/gm)?.length, 1);
    assert.equal(content.match(/^attachments\/$/gm)?.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('更早版本不带标记的媒体规则只在完整连续时移除', async () => {
  const dir = await makeRepo();
  const legacy = [
    '# 用户规则',
    '*.bak',
    '# 二进制资源由大文件存储服务托管，不进 Git（Git 存不动，也合并不了）。',
    'attachments/',
    '',
    'audio/',
    ''
  ].join('\n');
  try {
    fsSync.writeFileSync(path.join(dir, '.gitignore'), legacy);
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.deepEqual(await sync.ensureGitignore(), { ok: true, appended: true, removed: ['attachments/', 'audio/'] });
    const content = fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(content, /^\*\.bak$/m);
    assert.doesNotMatch(content, /^audio\/$/m);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('媒体标记不完整时失败关闭并保留 CRLF 原文', async () => {
  const dir = await makeRepo();
  const malformed = '# 用户规则\r\n# >>> workstation managed media ignores >>>\r\naudio/\r\n';
  try {
    fsSync.writeFileSync(path.join(dir, '.gitignore'), malformed);
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    const result = await sync.ensureGitignore();
    assert.equal(result.ok, false);
    assert.match(result.error, /标记不完整/);
    assert.equal(fsSync.readFileSync(path.join(dir, '.gitignore'), 'utf8'), malformed);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('还没建立上游分支时，拉取安静跳过而不是报错', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bare2-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    const pulled = await sync.pull();
    assert.equal(pulled.ok, true);
    assert.equal(pulled.skipped, '尚未建立上游分支');
    assert.ok(!pulled.error, '不该产生错误');

    // 推一次之后上游就建好了，此时拉取应真正执行。
    await writeNote(dir, 'notes/a.md', { body: '内容' });
    await sync.commitAndPush('首次');
    assert.equal(await sync.hasUpstream(), true);

    const second = await sync.pull();
    assert.equal(second.ok, true);
    assert.ok(!second.skipped, '有上游后不该再跳过');
  } finally {
    for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true });
  }
});

test('推送失败不抛异常，只返回失败状态', async () => {
  const dir = await makeRepo();
  try {
    // 指向一个不存在的远端，push 必然失败。
    git(dir, 'remote', 'add', 'origin', path.join(dir, 'does-not-exist.git'));

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    const result = await sync.commitAndPush('会推送失败');
    assert.equal(result.ok, false, '应报告失败');
    assert.ok(result.error, '应带上错误信息');

    // 关键：提交本身已经落地了，写笔记这件事没被同步问题连累。
    assert.match(git(dir, 'log', '--oneline'), /会推送失败/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('推送失败后即使工作区干净也会重试旧提交', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-retry-bare-'));
  try {
    git(dir, 'remote', 'add', 'origin', path.join(dir, 'does-not-exist.git'));
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    assert.equal((await sync.commitAndPush('首次')).ok, false);
    assert.equal(git(dir, 'status', '--porcelain').trim(), '', '提交成功后工作区应为空');

    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'set-url', 'origin', bare);
    const retried = await sync.commitAndPush('不会产生新提交');

    assert.equal(retried.ok, true);
    assert.equal(retried.committed, false);
    assert.equal(retried.pushed, true);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.match(execFileSync('git', ['--git-dir', bare, 'log', '--oneline'], { encoding: 'utf8' }), /首次/);
  } finally {
    for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true });
  }
});

test('并发同步调用被串行化，不产生空提交失败', async () => {
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    const results = await Promise.all([
      sync.commitAndPush('并发一'),
      sync.commitAndPush('并发二'),
      sync.commitAndPush('并发三')
    ]);
    assert.ok(results.every(result => result.ok));
    assert.equal(results.filter(result => result.committed).length, 1);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('推送到真实裸仓库并能被另一端拉回来', async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bare-'));
  const deviceA = await makeRepo();
  const deviceB = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-devb-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

    const syncA = createSync({ vaultDir: deviceA, logger: quietLogger });
    git(deviceA, 'remote', 'add', 'origin', bare);
    await writeNote(deviceA, 'notes/diary/2026-08-06.md', { body: '桌面写的' });
    await syncA.ensureGitignore();

    const pushed = await syncA.commitAndPush('来自桌面');
    assert.equal(pushed.pushed, true);

    // 另一台机器克隆下来，应看到同样的 Markdown。
    execFileSync('git', ['clone', '-q', bare, deviceB]);
    const content = await fs.readFile(path.join(deviceB, 'notes/diary/2026-08-06.md'), 'utf8');
    assert.match(content, /桌面写的/);

    // 索引库没有被同步过去 —— 它是派生数据，各端自己重建。
    assert.equal(fsSync.existsSync(path.join(deviceB, 'workstation.db')), false);
  } finally {
    for (const dir of [bare, deviceA, deviceB]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

test('一轮同步先拉后推：远端领先时仍能把本地改动推上去', async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-hub-'));
  const laptop = await makeRepo();
  const server = await makeRepo();
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

    // 笔记本先建立历史并推上去。
    await writeNote(laptop, 'notes/a.md', { body: '# 甲\n\n第一篇。' });
    git(laptop, 'remote', 'add', 'origin', bare);
    git(laptop, 'add', '-A');
    git(laptop, 'commit', '-qm', 'first');
    git(laptop, 'push', '-q', '-u', 'origin', 'main');

    // 另一台长期运行的设备克隆下来。
    await fs.rm(server, { recursive: true, force: true });
    execFileSync('git', ['clone', '-q', bare, server]);
    git(server, 'config', 'user.email', 'server@example.com');
    git(server, 'config', 'user.name', 'server');

    // 笔记本又写了一篇并推上去 —— 现在远端领先于服务器。
    await writeNote(laptop, 'notes/b.md', { body: '# 乙\n\n第二篇。' });
    git(laptop, 'add', '-A');
    git(laptop, 'commit', '-qm', 'second');
    git(laptop, 'push', '-q');

    // 与此同时服务器这边记下了一批复习事件。
    await fs.mkdir(path.join(server, 'reviews'), { recursive: true });
    await fs.writeFile(
      path.join(server, 'reviews', '2026-08-phone.jsonl'),
      '{"card_id":"english/x","ts":"2026-08-07T10:00:00.000Z","rating":3}\n',
      'utf8'
    );

    const sync = createSync({ vaultDir: server, logger: quietLogger });
    const result = await sync.cycle('复习记录自动提交');

    assert.equal(result.ok, true, '先拉后推应当成功');
    assert.equal(result.changed, true, '拉到了新提交，应报告 HEAD 变了');
    assert.equal(result.pushed.pushed, true, '复习记录必须真的推上去');

    // 拉到的笔记在，推上去的复习记录也在 —— 两个方向都通。
    assert.ok(fsSync.existsSync(path.join(server, 'notes', 'b.md')), '应拉到笔记本新写的那篇');
    const hub = execFileSync('git', ['-C', bare, 'log', '--oneline', '-1', '--name-only'], { encoding: 'utf8' });
    assert.match(hub, /reviews\/2026-08-phone\.jsonl/, '裸仓库里应能看到推上去的复习记录');
  } finally {
    for (const dir of [bare, laptop, server]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function conflictFixture() {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-conflict-hub-'));
  const local = await makeRepo();
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-conflict-other-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  await fs.writeFile(path.join(local, 'shared.md'), 'base\n', 'utf8');
  git(local, 'remote', 'add', 'origin', bare);
  git(local, 'add', 'shared.md');
  git(local, 'commit', '-qm', 'base');
  git(local, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', bare, other]);
  git(other, 'config', 'user.email', 'other@example.com');
  git(other, 'config', 'user.name', 'other');
  await fs.writeFile(path.join(other, 'shared.md'), 'remote\n', 'utf8');
  git(other, 'add', 'shared.md');
  git(other, 'commit', '-qm', 'remote');
  git(other, 'push', '-q');
  return { bare, local, other, cleanup: () => Promise.all([bare, local, other].map(target => fs.rm(target, { recursive: true, force: true }))) };
}

test('两台设备冲突时停止同步，不选边、不生成副本、不推送；用户可中止', async () => {
  const fixture = await conflictFixture();
  try {
    await fs.writeFile(path.join(fixture.local, 'shared.md'), 'local\n');
    git(fixture.local, 'commit', '-qam', 'local');
    const sync = createSync({ vaultDir: fixture.local, logger: quietLogger });
    const result = await sync.cycle('自动同步');
    assert.equal(result.ok, false);
    assert.equal(result.pushed, null);
    assert.equal(result.recovery.kind, 'rebase');
    assert.match(await fs.readFile(path.join(fixture.local, 'shared.md'), 'utf8'), /<<<<<<< /);
    assert.equal((await fs.readdir(fixture.local)).some(name => name.includes('冲突副本')), false);
    assert.equal(git(fixture.bare, 'show', 'main:shared.md').trim(), 'remote');
    assert.equal((await sync.cycle('重试')).ok, false);
    assert.equal((await sync.abortOperation()).ok, true);
    assert.equal((await fs.readFile(path.join(fixture.local, 'shared.md'), 'utf8')).trim(), 'local');
  } finally { await fixture.cleanup(); }
});

test('未提交的修改和远端改了同一篇：先提交再变基，停止并保留本机提交', async () => {
  const fixture = await conflictFixture();
  try {
    await fs.writeFile(path.join(fixture.local, 'shared.md'), 'local edit\n', 'utf8');
    const sync = createSync({ vaultDir: fixture.local, logger: quietLogger });
    const pulledAlone = await sync.pull();
    assert.match(pulledAlone.skipped, /未提交的修改/, '单独拉取不替用户提交');
    const result = await sync.cycle('自动同步');
    assert.equal(result.ok, false);
    assert.equal(result.recovery.kind, 'rebase');
    await sync.abortOperation();
    assert.equal((await fs.readFile(path.join(fixture.local, 'shared.md'), 'utf8')).trim(), 'local edit');
  } finally {
    await fixture.cleanup();
  }
});

test('删改冲突同样停下，用户中止后本机提交原样保留', async () => {
  const fixture = await conflictFixture();
  try {
    // 删改冲突：本机删掉、远端改了。这种情况不猜，回到拉取前。
    git(fixture.local, 'rm', '-q', 'shared.md');
    git(fixture.local, 'commit', '-qm', 'delete');
    const sync = createSync({ vaultDir: fixture.local, logger: quietLogger });
    const result = await sync.cycle('自动同步');
    assert.equal(result.ok, false);
    assert.equal((await sync.detectRecovery()).kind, 'rebase');
    await sync.abortOperation();
    assert.equal(await sync.detectRecovery(), null);
    assert.equal(git(fixture.local, 'log', '-1', '--format=%s').trim(), 'delete');
    await assert.rejects(fs.access(path.join(fixture.local, 'shared.md')));
  } finally {
    await fixture.cleanup();
  }
});

test('只有未合并索引时拒绝自动中止，不使用破坏性恢复', async () => {
  const dir = await makeRepo();
  try {
    await fs.writeFile(path.join(dir, 'shared.md'), 'base\n', 'utf8');
    git(dir, 'add', 'shared.md');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'other');
    await fs.writeFile(path.join(dir, 'shared.md'), 'other\n', 'utf8');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(dir, 'shared.md'), 'main\n', 'utf8');
    git(dir, 'commit', '-qam', 'main');
    assert.throws(() => git(dir, 'merge', 'other'));

    const mergeHead = git(dir, 'rev-parse', '--git-path', 'MERGE_HEAD').trim();
    await fs.unlink(path.isAbsolute(mergeHead) ? mergeHead : path.resolve(dir, mergeHead));

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    const status = await sync.probe();
    assert.equal(status.recovery.kind, 'unmerged');
    assert.equal(status.recovery.abortable, false);
    assert.equal(status.recovery.unmergedCount, 1);

    const aborted = await sync.abortOperation();
    assert.equal(aborted.ok, false);
    assert.equal(aborted.blocked, 'recovery-required');
    assert.match(git(dir, 'status', '--porcelain'), /^UU shared\.md$/m);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('复习同步只提交当前设备日志并保留其它工作区状态', async () => {
  const dir = await makeRepo();
  try {
    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-phone.jsonl'), 'phone\n');
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-desktop.jsonl'), 'desktop\n');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'private\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'phone review');
    assert.deepEqual(result, { ok: true, committed: true, pushed: false, changed: false });
    assert.equal(git(dir, 'show', '--format=', '--name-only', 'HEAD').trim(), 'reviews/2026-08-phone.jsonl');
    assert.match(git(dir, 'status', '--porcelain'), /\?\? notes\.txt/);
    assert.match(git(dir, 'status', '--porcelain'), /\?\? reviews\/2026-08-desktop\.jsonl/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('复习同步保留用户暂存的其它设备复习日志', async () => {
  const dir = await makeRepo();
  try {
    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-desktop.jsonl'), 'desktop\n');
    git(dir, 'add', 'reviews/2026-08-desktop.jsonl');
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-phone.jsonl'), 'phone\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'phone review');
    assert.equal(result.committed, true);
    assert.equal(git(dir, 'show', '--format=', '--name-only', 'HEAD').trim(), 'reviews/2026-08-phone.jsonl');
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), 'reviews/2026-08-desktop.jsonl');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('复习同步拒绝已暂存非复习路径且不改变索引', async () => {
  const dir = await makeRepo();
  try {
    await fs.writeFile(path.join(dir, 'note.md'), 'staged\n');
    git(dir, 'add', 'note.md');
    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'blocked');
    assert.equal(result.blocked, 'staged-non-review');
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), 'note.md');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('当前设备日志已暂存时保留用户快照和后续工作区内容', async () => {
  const dir = await makeRepo();
  const reviewPath = 'reviews/2026-08-phone.jsonl';
  try {
    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, reviewPath), 'base\n');
    git(dir, 'add', reviewPath);
    git(dir, 'commit', '-qm', 'base');

    await fs.writeFile(path.join(dir, reviewPath), 'staged\n');
    git(dir, 'add', reviewPath);
    await fs.writeFile(path.join(dir, reviewPath), 'working\n');
    const headBefore = git(dir, 'rev-parse', 'HEAD').trim();

    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'must not consume staged content');

    assert.equal(result.blocked, 'staged-current-review');
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), headBefore);
    assert.equal(git(dir, 'show', `:${reviewPath}`), 'staged\n');
    assert.equal(await fs.readFile(path.join(dir, reviewPath), 'utf8'), 'working\n');
    assert.equal(git(dir, 'status', '--short', reviewPath).trim(), 'MM reviews/2026-08-phone.jsonl');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('未出生分支的当前设备日志已暂存时不尝试从索引移除', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-unborn-'));
  const reviewPath = 'reviews/2026-08-phone.jsonl';
  try {
    git(dir, 'init', '-q', '-b', 'main');
    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, reviewPath), 'staged\n');
    git(dir, 'add', reviewPath);
    await fs.writeFile(path.join(dir, reviewPath), 'working\n');

    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'must remain unborn');

    assert.equal(result.blocked, 'staged-current-review');
    assert.throws(() => git(dir, 'rev-parse', 'HEAD'));
    assert.equal(git(dir, 'show', `:${reviewPath}`), 'staged\n');
    assert.equal(await fs.readFile(path.join(dir, reviewPath), 'utf8'), 'working\n');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('用户自己暂存的非复习文件仍然直接拦下，不替他撤销', async () => {
  const dir = await makeRepo();
  try {
    await fs.writeFile(path.join(dir, 'note.md'), 'seed\n');
    git(dir, 'add', 'note.md');
    git(dir, 'commit', '-qm', 'seed');

    await fs.writeFile(path.join(dir, 'note.md'), '写到一半\n');
    git(dir, 'add', 'note.md');
    const indexBefore = git(dir, 'show', ':note.md');

    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'blocked');

    assert.equal(result.blocked, 'staged-non-review');
    assert.equal(git(dir, 'show', ':note.md'), indexBefore, '用户正在做的事不能被动过');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('无 upstream 时只检查相对已有远端分支新增的复习提交', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-existing-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await fs.writeFile(path.join(dir, 'note.md'), 'shared history\n');
    git(dir, 'add', 'note.md');
    git(dir, 'commit', '-qm', 'normal remote history');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
    assert.throws(() => git(dir, 'rev-parse', '--abbrev-ref', '@{u}'));

    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-phone.jsonl'), 'review\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'review delta');

    assert.equal(result.ok, true);
    assert.equal(result.committed, true);
    assert.equal(result.pushed, true);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/main');
    assert.equal(execFileSync('git', ['--git-dir', bare, 'show', 'HEAD:note.md'], { encoding: 'utf8' }), 'shared history\n');
    assert.equal(execFileSync('git', ['--git-dir', bare, 'show', 'HEAD:reviews/2026-08-phone.jsonl'], { encoding: 'utf8' }), 'review\n');
  } finally { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); }
});

test('远端分支还不存在时单独上报，而不是诬指有非复习提交', async () => {
  // 没有远端分支就没有 base，推送等于用整段本地历史去创建它 —— 含普通笔记提交的
  // vault 必然被拦下。拦是对的，但理由不是「你混进了非复习提交」，而是这个分支还没建。
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-block-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await fs.writeFile(path.join(dir, 'note.md'), 'history\n');
    git(dir, 'add', 'note.md'); git(dir, 'commit', '-qm', 'normal');
    git(dir, 'remote', 'add', 'origin', bare);
    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'blocked');
    assert.equal(result.blocked, 'remote-branch-missing');
    assert.throws(() => execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD']));
  } finally { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); }
});

test('复习同步拒绝包含非复习路径的待推送历史', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-nonreview-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await fs.writeFile(path.join(dir, 'note.md'), 'shared history\n');
    git(dir, 'add', 'note.md'); git(dir, 'commit', '-qm', 'shared');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', 'origin', 'main');
    const remoteBefore = execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // 远端分支已经存在，base 有了；这之后再加一个普通笔记提交才是真正的「非复习提交」。
    await fs.writeFile(path.join(dir, 'note.md'), 'local edit\n');
    git(dir, 'add', 'note.md'); git(dir, 'commit', '-qm', 'normal local');

    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const result = await sync.syncReviewLogs('phone', 'blocked');
    assert.equal(result.blocked, 'non-review-commits');
    assert.equal(
      execFileSync('git', ['--git-dir', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      remoteBefore
    );
  } finally { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); }
});

test('复习同步可推送纯复习历史并串行处理重复调用', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-push-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);
    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-phone.jsonl'), 'one\n');
    const sync = createSync({ vaultDir: dir, logger: quietLogger, enabled: false, reviewSyncEnabled: true });
    const results = await Promise.all([
      sync.syncReviewLogs('phone', 'review one'),
      sync.syncReviewLogs('phone', 'review two')
    ]);
    assert.equal(results.filter(result => result.committed).length, 1);
    assert.equal(results.filter(result => result.pushed).length, 1);
    assert.match(execFileSync('git', ['--git-dir', bare, 'show', 'HEAD:reviews/2026-08-phone.jsonl'], { encoding: 'utf8' }), /one/);
  } finally { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); }
});

test('复习同步只推送最终验证过的 SHA，验证后推进的 HEAD 不会外泄', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-race-'));
  let validatedTip = '';
  let unvalidatedTip = '';
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);
    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-phone.jsonl'), 'review\n');

    const sync = createSync({
      vaultDir: dir,
      logger: quietLogger,
      enabled: false,
      reviewSyncEnabled: true,
      beforeReviewPush: async context => {
        validatedTip = context.tip;
        assert.equal(context.remote, 'origin');
        assert.equal(context.destination, 'refs/heads/main');
        await fs.writeFile(path.join(dir, 'note.md'), 'must stay local\n');
        git(dir, 'add', 'note.md');
        git(dir, 'commit', '-qm', 'external unvalidated commit');
        unvalidatedTip = git(dir, 'rev-parse', 'HEAD').trim();
      }
    });

    const result = await sync.syncReviewLogs('phone', 'validated review');
    assert.equal(result.ok, true);
    assert.equal(result.pushed, true);
    assert.notEqual(unvalidatedTip, validatedTip);
    assert.equal(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), validatedTip);
    assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), unvalidatedTip);
    assert.throws(() => execFileSync('git', ['--git-dir', bare, 'show', 'refs/heads/main:note.md']));
    assert.equal(execFileSync('git', ['--git-dir', bare, 'show', 'refs/heads/main:reviews/2026-08-phone.jsonl'], { encoding: 'utf8' }), 'review\n');
  } finally { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); }
});

test('复习同步在最终验证后遇到远端推进时拒绝覆盖新提交', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-lease-'));
  const competitor = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-review-competitor-'));
  let competingTip = '';
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await fs.writeFile(path.join(dir, 'shared.md'), 'remote base\n');
    git(dir, 'add', 'shared.md');
    git(dir, 'commit', '-qm', 'remote base');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', bare, competitor]);
    git(competitor, 'config', 'user.email', 'competitor@example.com');
    git(competitor, 'config', 'user.name', 'competitor');

    await fs.mkdir(path.join(dir, 'reviews'));
    await fs.writeFile(path.join(dir, 'reviews', '2026-08-phone.jsonl'), 'local review\n');
    const sync = createSync({
      vaultDir: dir,
      logger: quietLogger,
      enabled: false,
      reviewSyncEnabled: true,
      beforeReviewPush: async () => {
        await fs.mkdir(path.join(competitor, 'reviews'));
        await fs.writeFile(path.join(competitor, 'reviews', '2026-08-other.jsonl'), 'competing review\n');
        git(competitor, 'add', 'reviews/2026-08-other.jsonl');
        git(competitor, 'commit', '-qm', 'competing review');
        git(competitor, 'push', '-q', 'origin', 'main');
        competingTip = git(competitor, 'rev-parse', 'HEAD').trim();
      }
    });

    const result = await sync.syncReviewLogs('phone', 'local review');
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.error, /stale info|rejected|fetch first/i);
    assert.equal(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), competingTip);
    assert.equal(execFileSync('git', ['--git-dir', bare, 'show', 'refs/heads/main:reviews/2026-08-other.jsonl'], { encoding: 'utf8' }), 'competing review\n');
    assert.throws(() => execFileSync('git', ['--git-dir', bare, 'show', 'refs/heads/main:reviews/2026-08-phone.jsonl']));
  } finally {
    for (const target of [dir, bare, competitor]) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

test('拉取也走串行队列：不和推送同时操作同一个仓库', async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-hub2-'));
  const dir = await makeRepo();
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    await writeNote(dir, 'notes/a.md', { body: '# 甲\n\n正文。' });
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'first');
    git(dir, 'push', '-q', '-u', 'origin', 'main');

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/b.md', { body: '# 乙\n\n正文。' });

    // 同时发起：串行队列不生效的话，两个 git 进程会撞上 index.lock。
    const results = await Promise.all([
      sync.pull(),
      sync.commitAndPush('并发提交'),
      sync.pull(),
      sync.cycle('并发同步')
    ]);

    for (const result of results) {
      assert.notEqual(result.ok, false, `同步操作不应失败：${JSON.stringify(result)}`);
    }
    assert.doesNotMatch(
      execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }),
      /\S/,
      '跑完之后工作区应当干净'
    );
  } finally {
    for (const target of [bare, dir]) {
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

// 首次推送过去写死 `push -u origin HEAD`。远端叫别的名字（`github`、`gitlab`，
// 或从别处 clone 后改过名）时，git 会报「'origin' does not appear to be a git
// repository」—— 指向一个用户并没有配错的地方。复习同步那条路早就改用
// defaultRemote 挑远端了，常规提交推送却没跟上，于是同一个 vault 上出现
// 「复习记录推得出去、笔记推不出去」这种自相矛盾的状态。
test('首次推送认远端的真实名字，而不是写死 origin', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bare-named-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'github', bare);

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    const pushed = await sync.commitAndPush('首次');
    assert.equal(pushed.ok, true, pushed.error);
    assert.equal(pushed.pushed, true);
    assert.equal(await sync.hasUpstream(), true);
    assert.match(git(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim(), /^github\/main$/);
  } finally {
    for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true });
  }
});

// 有多个远端而其中没有 origin 时是真的没法猜。这时要给出说得清的错误，
// 而不是随便挑一个推出去 —— 推错地方比推不出去糟糕得多。
test('多个远端且没有 origin 时拒绝猜测，报告可读的原因', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bare-ambiguous-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'github', bare);
    git(dir, 'remote', 'add', 'gitlab', bare);

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });

    const pushed = await sync.commitAndPush('首次');
    assert.equal(pushed.ok, false);
    assert.match(pushed.error, /多个 Git 远端/);
    assert.match(pushed.error, /github/);
    // 提交本身要保住：推不出去不该把已经提交好的东西回滚掉。
    assert.equal(git(dir, 'status', '--porcelain').trim(), '');
  } finally {
    for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true });
  }
});

// 只有一个远端且它就叫 origin 是最常见的情况，别在改动里把它弄坏了。
test('远端就叫 origin 时行为不变', async () => {
  const dir = await makeRepo();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bare-origin-'));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    git(dir, 'remote', 'add', 'origin', bare);

    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    await writeNote(dir, 'notes/a.md', { body: '内容' });
    const pushed = await sync.commitAndPush('首次');
    assert.equal(pushed.ok, true, pushed.error);
    assert.match(git(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim(), /^origin\/main$/);
  } finally {
    for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true });
  }
});

test('应用管理 .gitattributes：没有就建，缺规则就补，用户自己的规则不动', async () => {
  const { VAULT_GITATTRIBUTES } = require('../src/sync');
  const dir = await makeRepo();
  try {
    const sync = createSync({ vaultDir: dir, logger: quietLogger });
    assert.equal((await sync.ensureGitattributes()).created, true);
    assert.equal(await fs.readFile(path.join(dir, '.gitattributes'), 'utf8'), VAULT_GITATTRIBUTES);
    assert.equal((await sync.ensureGitattributes()).unchanged, true);
    await fs.writeFile(path.join(dir, '.gitattributes'), '*.png binary\n*.md text eol=lf\n', 'utf8');
    assert.equal((await sync.ensureGitattributes()).appended, true);
    const content = await fs.readFile(path.join(dir, '.gitattributes'), 'utf8');
    assert.match(content, /^\*\.png binary\n\*\.md text eol=lf\n\*\.jsonl text eol=lf\n/);
    assert.equal(content.match(/\*\.md text eol=lf/g).length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('远端不可访问时保留 fetch 错误，绝不报告冲突已解决', async () => {
  const fixture = await conflictFixture();
  try {
    git(fixture.local, 'remote', 'set-url', 'origin', path.join(fixture.local, 'missing-remote'));
    const sync = createSync({ vaultDir: fixture.local, logger: quietLogger });
    const result = await sync.pull();
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(result.conflictCopies, undefined);
    assert.equal(await sync.detectRecovery(), null);
  } finally { await fixture.cleanup(); }
});

test('完整同步在无上游时取回同名远端分支并推送本机修改', async t => {
  const fixture = await conflictFixture();
  t.after(fixture.cleanup);
  git(fixture.local, 'branch', '--unset-upstream');
  await fs.writeFile(path.join(fixture.local, 'mine.md'), '本机笔记');
  const sync = createSync({ vaultDir: fixture.local, logger: quietLogger });
  const result = await sync.cycle('完整同步');
  assert.equal(result.ok, true, result.error);
  assert.equal(git(fixture.local, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/main');
  const pulledText = await fs.readFile(path.join(fixture.local, 'shared.md'), 'utf8');
  assert.equal(pulledText.replaceAll('\r\n', '\n'), 'remote\n');
  assert.equal(git(fixture.bare, 'show', 'main:mine.md'), '本机笔记');
});

test('从空远端克隆后首次完整同步可以创建上游', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-empty-clone-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '--bare', '-b', 'main', 'hub');
  git(root, 'clone', 'hub', 'work');
  const local = path.join(root, 'work');
  git(local, 'config', 'user.name', 'Test');
  git(local, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(local, 'n.md'), '首篇');
  const result = await createSync({ vaultDir: local, logger: quietLogger }).cycle('首次同步');
  assert.equal(result.ok, true, result.error);
  assert.equal(git(path.join(root, 'hub'), 'show', 'main:n.md'), '首篇');
});

test('同步只向普通的规则文件写入，遇到目录时保留原状', async t => {
  const dir = await makeRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sync = createSync({ vaultDir: dir, logger: quietLogger });
  for (const [name, maintain] of [['.gitignore', sync.ensureGitignore], ['.gitattributes', sync.ensureGitattributes]]) {
    await fs.mkdir(path.join(dir, name));
    assert.equal((await maintain()).ok, false);
    assert.equal((await fs.lstat(path.join(dir, name))).isDirectory(), true);
  }
});

test('同步规则文件只接受普通文件，即使指向库内的链接也会被拒绝', async t => {
  const dir = await makeRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = '# custom\n';
  await fs.writeFile(path.join(dir, 'custom-rules'), original);
  const sync = createSync({ vaultDir: dir, logger: quietLogger });
  for (const [name, maintain] of [['.gitignore', sync.ensureGitignore], ['.gitattributes', sync.ensureGitattributes]]) {
    try { await fs.symlink('custom-rules', path.join(dir, name), 'file'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('本机不允许创建文件链接'); return; } throw error; }
    assert.equal((await maintain()).ok, false);
    assert.equal(await fs.readFile(path.join(dir, 'custom-rules'), 'utf8'), original);
  }
});

test('已有规则文件不可写时保留原文', async t => {
  const dir = await makeRepo();
  const file = path.join(dir, '.gitignore');
  t.after(async () => { await fs.chmod(file, 0o600); await fs.rm(dir, { recursive: true, force: true }); });
  await fs.writeFile(file, '# keep\n');
  await fs.chmod(file, 0o444);
  const canWrite = await fs.access(file, fs.constants.W_OK).then(() => true, () => false);
  if (canWrite) return t.skip('本机仍允许当前账号写入只读文件');
  const sync = createSync({ vaultDir: dir, logger: quietLogger });
  assert.equal((await sync.ensureGitignore()).ok, false);
  assert.equal(await fs.readFile(file, 'utf8'), '# keep\n');
});

// ---------- 边界情况：上游改名、子仓库、游离 HEAD、交互提示、残留锁 ----------

async function bareRemote(branch = 'main') {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-bare-edge-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, bare]);
  return bare;
}

test('本地分支跟踪名字不同的上游分支（main → origin/master）时照常推送', async t => {
  const dir = await makeRepo();
  const bare = await bareRemote('master');
  t.after(async () => { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); });
  await writeNote(dir, 'notes/a.md', { body: 'a' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main:master');
  git(dir, 'branch', '-q', '-u', 'origin/master');
  await writeNote(dir, 'notes/b.md', { body: 'b' });

  // 这个场景要求没有显式推送策略，隔离开发机和 CI 的全局配置。
  const env = { GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const result = await createSync({ vaultDir: dir, logger: quietLogger }).cycle('改名上游', { env });
  assert.equal(result.ok, true, result.error);
  assert.match(git(bare, 'log', '--oneline', 'master'), /改名上游/);
  assert.throws(() => git(bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'), '不该在远端另建 main');
});

test('子仓库里有没提交的改动时，同步不报「nothing to commit」，其余改动照常提交和拉取', async t => {
  const dir = await makeRepo();
  const bare = await bareRemote();
  t.after(async () => { for (const target of [dir, bare]) await fs.rm(target, { recursive: true, force: true }); });
  const nested = path.join(dir, 'notes', 'proj', 'code');
  await fs.mkdir(nested, { recursive: true });
  git(nested, 'init', '-q', '-b', 'main');
  git(nested, 'config', 'user.email', 'test@example.com');
  git(nested, 'config', 'user.name', 'test');
  await fs.writeFile(path.join(nested, 'x.py'), '1\n');
  git(nested, 'add', '-A');
  git(nested, 'commit', '-q', '-m', 'sub');
  await writeNote(dir, 'notes/a.md', { body: 'a' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  await fs.writeFile(path.join(nested, 'x.py'), '2\n');
  const sync = createSync({ vaultDir: dir, logger: quietLogger });

  const idle = await sync.cycle('只有子仓库脏');
  assert.equal(idle.ok, true, idle.error);
  const pulled = await sync.pull();
  assert.equal(pulled.ok, true, pulled.error);
  assert.equal(pulled.skipped, undefined, '子仓库的工作区改动不该挡住启动时的拉取');

  await writeNote(dir, 'notes/a.md', { body: 'a 改过' });
  const edited = await sync.cycle('笔记改了');
  assert.equal(edited.ok, true, edited.error);
  assert.match(git(bare, 'log', '--oneline', 'main'), /笔记改了/);
});

test('游离 HEAD 时不往上面提交，明确报错', async t => {
  const dir = await makeRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeNote(dir, 'notes/a.md', { body: 'a' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '--detach');
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  await writeNote(dir, 'notes/b.md', { body: 'b' });

  const result = await createSync({ vaultDir: dir, logger: quietLogger }).commitAndPush('不该提交');
  assert.equal(result.ok, false);
  assert.match(result.error, /游离|detached/i);
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), head);
  assert.match(git(dir, 'status', '--porcelain'), /notes\/b\.md/);
});

test('联网命令不让 SSH 和凭据管理器弹交互提示，但尊重用户自己配置的 ssh 命令', { skip: process.platform === 'win32' }, async t => {
  const dir = await makeRepo();
  const tools = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-fake-ssh-'));
  t.after(async () => { for (const target of [dir, tools]) await fs.rm(target, { recursive: true, force: true }); });
  const log = path.join(tools, 'calls.log');
  const fake = path.join(tools, 'ssh');
  await fs.writeFile(fake, `#!/bin/sh\necho "args=$* gcm=$GCM_INTERACTIVE" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  await writeNote(dir, 'notes/a.md', { body: 'a' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', 'ssh://git@example.invalid/vault.git');
  git(dir, 'config', 'branch.main.remote', 'origin');
  git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.PATH = `${tools}${path.delimiter}${process.env.PATH}`;
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;

  await createSync({ vaultDir: dir, logger: quietLogger }).cycle('ssh');
  const first = await fs.readFile(log, 'utf8');
  assert.match(first, /BatchMode=yes/);
  assert.match(first, /gcm=never/);

  await fs.rm(log, { force: true });
  git(dir, 'config', 'core.sshCommand', `${fake} -o Custom=1`);
  await createSync({ vaultDir: dir, logger: quietLogger }).cycle('ssh');
  const second = await fs.readFile(log, 'utf8');
  assert.match(second, /Custom=1/);
  assert.doesNotMatch(second, /BatchMode/);
});

test('残留的 index.lock 让 Git 失败时，给出锁文件位置和处理办法', async t => {
  const dir = await makeRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeNote(dir, 'notes/a.md', { body: 'a' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  await writeNote(dir, 'notes/b.md', { body: 'b' });
  const lockFile = path.join(dir, '.git', 'index.lock');
  await fs.writeFile(lockFile, '');

  const result = await createSync({ vaultDir: dir, logger: quietLogger }).commitAndPush('有锁');
  assert.equal(result.ok, false);
  const reported = /^Git 的锁文件还在：(.+index\.lock)$/m.exec(result.error);
  assert.ok(reported, result.error);
  // Git 和 Node 可能通过不同的临时目录别名访问同一个锁文件。
  assert.equal(path.relative(await fs.realpath(lockFile), await fs.realpath(reported[1])), '', result.error);
  assert.match(result.error, /没有别的 Git/);
});

test('远端要登录时不弹窗，失败信息告诉用户在终端里登录一次', async () => {
  const http = require('node:http');
  const dir = await makeRepo();
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="vault"' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeNote(dir, 'notes/a.md', { body: '内容' });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/vault.git`);
    // 测试机上可能装了凭据助手，清掉以免它去弹窗或读到别的凭据。
    git(dir, 'config', 'credential.helper', '');
    const result = await createSync({ vaultDir: dir, logger: quietLogger }).cycle('同步');
    assert.equal(result.ok, false);
    assert.match(result.error, /终端里进入资料库目录运行一次 git fetch/);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('用户显式设置 simple 时，完整同步、退出提交和复习同步都尊重异名上游保护', async t => {
  const dir = await makeRepo();
  const remote = await bareRemote('published');
  t.after(async () => { for (const target of [dir, remote]) await fs.rm(target, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dir, 'seed.md'), 'seed');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-qu', 'origin', 'HEAD:refs/heads/published');
  git(dir, 'config', 'push.default', 'simple');
  const before = git(remote, 'rev-parse', 'published');
  const sync = createSync({ vaultDir: dir, logger: quietLogger, reviewSyncEnabled: true });
  await fs.mkdir(path.join(dir, 'reviews'));
  await fs.writeFile(path.join(dir, 'reviews', '2026-11-phone.jsonl'), '{"event_id":"local"}\n');
  const review = await sync.syncReviewLogs('phone', 'review');
  assert.equal(review.committed, true);
  assert.equal(review.ok, false);
  assert.match(review.error, /推送设置/);
  await fs.writeFile(path.join(dir, 'more.md'), 'work');
  for (const result of [await sync.cycle('cycle'), await sync.commitAndPush('exit')]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /本机分支 main，上游 origin\/published/);
  }
  assert.equal(git(remote, 'rev-parse', 'published'), before);
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim(), 'published');

  git(dir, 'config', 'push.default', 'upstream');
  assert.equal((await sync.commitAndPush('allowed')).pushed, true);
  assert.equal(git(remote, 'rev-parse', 'published'), git(dir, 'rev-parse', 'HEAD'));
});

test('无上游的多个远端中，完整同步和退出推送均采用配置的默认推送远端', async t => {
  const dir = await makeRepo();
  const publish = await bareRemote();
  const unused = await bareRemote();
  t.after(async () => { for (const target of [dir, publish, unused]) await fs.rm(target, { recursive: true, force: true }); });
  git(dir, 'remote', 'add', 'publish', publish);
  git(dir, 'remote', 'add', 'unused', unused);
  git(dir, 'config', 'remote.pushDefault', 'publish');
  git(dir, 'config', 'push.default', 'current');
  const sync = createSync({ vaultDir: dir, logger: quietLogger });
  await fs.writeFile(path.join(dir, 'one.txt'), 'one');
  const first = await sync.cycle('首次同步');
  assert.equal(first.ok, true, first.error);
  await fs.writeFile(path.join(dir, 'one.txt'), 'two');
  const next = await sync.commitAndPush('退出');
  assert.equal(next.ok, true, next.error);
  assert.equal(git(publish, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
  assert.equal(git(unused, 'for-each-ref', 'refs/heads'), '');
});

test('复习同步接受 Git 显式配置的 HEAD 推送规则，且只更新已经核验的分支', async t => {
  const dir = await makeRepo();
  const remote = await bareRemote();
  t.after(async () => { for (const target of [dir, remote]) await fs.rm(target, { recursive: true, force: true }); });
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'commit', '--allow-empty', '-qm', 'init');
  // 远端已有相同历史，但本机还没有设置跟踪关系。
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'config', 'remote.origin.push', 'HEAD:refs/heads/main');
  git(dir, 'config', 'push.followTags', 'true');
  git(dir, 'tag', '-a', 'local-only', '-m', '本机标签');
  const sync = createSync({ vaultDir: dir, logger: quietLogger, reviewSyncEnabled: true });
  await fs.mkdir(path.join(dir, 'reviews'));
  await fs.writeFile(path.join(dir, 'reviews', '2026-11-phone.jsonl'), '{"event_id":"local"}\n');
  const result = await sync.syncReviewLogs('phone', 'review');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pushed, true);
  assert.equal(git(remote, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'));
  assert.equal(git(remote, 'tag', '--list'), '');
});
