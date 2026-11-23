const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);

const {
  createGitRecovery,
  validateRemote,
  redactRemote,
  RecoveryGitError,
  classifyGitError
} = require('../src/recovery/git');

const VALID = [
  'https://example.com/team/vault.git',
  'ssh://git@example.com/team/vault.git',
  'ssh://git@[2001:db8::1]/team/vault.git',
  'git@example.com:team/vault.git'
];

const INVALID = [
  '', '-uploader', 'ext::sh -c pwn', 'file:///tmp/vault', '/tmp/vault', './vault', '../vault',
  '~/vault', 'C:\\vault', '\\\\server\\share', 'http://example.com/vault',
  'https://user@example.com/vault', 'https://user:secret@example.com/vault',
  'https://example.com/vault?token=secret', 'https://example.com/vault#part',
  'ssh://git@example.com/-oProxyCommand=bad', 'ssh://bad user@example.com/vault',
  'git@-example.com:vault', 'git@example.com:-oProxyCommand=bad',
  'git@example.com:repo;touch-pwned', 'git@example.com:repo name', 'git@example.com:repo*.git',
  'git@example.com:\\repo', 'example.com:', 'bad\nremote'
];

test('只接受无凭据的 HTTPS 与受限 SSH Git 远端', () => {
  for (const remote of VALID) assert.equal(validateRemote(remote), remote);
  for (const remote of INVALID) {
    assert.throws(() => validateRemote(remote), error => error instanceof RecoveryGitError
      && error.code === 'invalid-remote', remote);
  }
});

test('公开远端只保留主机和仓库 basename', () => {
  assert.equal(redactRemote('https://example.com/private/team/vault.git'), 'https://example.com/…/vault.git');
  assert.equal(redactRemote('git@example.com:private/team/vault.git'), 'git@example.com:…/vault.git');
});

test('Git 调用使用固定参数、shell false 且永不 commit/push', async () => {
  const calls = [];
  const runner = async (program, args, options) => {
    calls.push({ program, args, options });
    if (args.includes('ls-remote')) return { stdout: 'ref: refs/heads/main\tHEAD\nabc\tHEAD\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const git = createGitRecovery({ runner });
  const result = await git.inspectRemote(VALID[0]);

  assert.equal(result.display, 'https://example.com/…/vault.git');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'git');
  assert.deepEqual(calls[0].args, [
    '-c', 'protocol.ext.allow=never',
    'ls-remote', '--symref', '--', VALID[0], 'HEAD'
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!calls.flatMap(call => call.args).some(arg => ['commit', 'push', 'reset'].includes(arg)));
});

test('clone 参数固定且在 clone 后执行只读验证', async () => {
  const calls = [];
  const timeouts = [];
  const runner = async (program, args, options) => {
    calls.push(args);
    timeouts.push(options.timeout);
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref --short HEAD')) return { stdout: 'main\n' };
    if (joined.includes('config --get remote.origin.url')) return { stdout: `${VALID[0]}\n` };
    if (joined.includes('status --porcelain') || joined.includes('ls-files -u')) return { stdout: '' };
    if (joined.includes('rev-parse --git-path')) return { stdout: '/definitely/missing/recovery-marker\n' };
    if (joined.includes('rev-parse --verify HEAD')) return { stdout: 'abc\n' };
    if (joined.includes('@{u}')) return { stdout: 'origin/main\n' };
    return { stdout: '' };
  };
  const git = createGitRecovery({ runner });
  await git.cloneRemote(VALID[0], '/safe/candidate');

  assert.deepEqual(calls[0], [
    '-c', 'protocol.ext.allow=never',
    '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30',
    'clone', '--origin', 'origin', '--', VALID[0], '/safe/candidate'
  ]);
  // 克隆要拉附件：总时长比本地命令宽得多，卡住的连接靠低速限制放弃。
  assert.ok(timeouts[0] >= 30 * 60_000, '克隆不该沿用两分钟的超时');
  assert.equal(timeouts[1], 120_000);
  assert.ok(calls.some(args => args.includes('status')));
  assert.ok(calls.some(args => args.includes('ls-files')));
  assert.ok(!calls.flat().includes('push'));
});

test('真实本地仓库接受直属普通 .git 目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-'));
  try {
    await run('git', ['init', root]);
    const git = createGitRecovery();
    assert.deepEqual(await git.inspectLocalRepository(root), { isRepo: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Windows 路径大小写别名仍识别为同一仓库', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-case-'));
  try {
    await run('git', ['init', root]);
    const alias = path.join(path.dirname(root), path.basename(root).toUpperCase());
    const git = createGitRecovery();
    assert.deepEqual(await git.inspectLocalRepository(alias), { isRepo: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('.git 文件即使指向仓内 Git 数据也拒绝', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-file-'));
  try {
    await run('git', ['init', root]);
    await fs.rename(path.join(root, '.git'), path.join(root, 'git-data'));
    await fs.writeFile(path.join(root, '.git'), 'gitdir: git-data\n');
    const git = createGitRecovery();
    await assert.rejects(() => git.inspectLocalRepository(root), error => (
      error instanceof RecoveryGitError && error.code === 'external-git-directory'
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('.git 目录链接即使指向仓内 Git 数据也拒绝', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-link-'));
  try {
    await run('git', ['init', root]);
    const gitData = path.join(root, 'git-data');
    await fs.rename(path.join(root, '.git'), gitData);
    try {
      await fs.symlink(gitData, path.join(root, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`本机不允许创建目录链接：${error.code}`);
      return;
    }
    const git = createGitRecovery();
    await assert.rejects(() => git.inspectLocalRepository(root), error => (
      error instanceof RecoveryGitError && error.code === 'external-git-directory'
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('父仓库中的普通子目录不被视为独立仓库，按没有 Git 的备份恢复', async () => {
  // 恢复目标放在用 Git 管理的目录里（dotfiles 仓库、项目仓库）很常见：备份里没有 .git
  // 时它就是普通资料库，不能因为 Git 认出了外层仓库而整个恢复失败。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-parent-'));
  try {
    await run('git', ['init', root]);
    const candidate = path.join(root, 'candidate');
    await fs.mkdir(candidate);
    const git = createGitRecovery();
    assert.deepEqual(await git.inspectLocalRepository(candidate), { isRepo: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('无法确认 Git 目录真实路径时关闭失败', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-missing-'));
  let configCalled = false;
  try {
    await fs.mkdir(path.join(root, '.git'));
    const runner = async (program, args) => {
      if (args.includes('--is-inside-work-tree')) return { stdout: 'true\n', stderr: '' };
      if (args.includes('--absolute-git-dir')) return { stdout: `${path.join(root, 'missing-git')}\n`, stderr: '' };
      if (args.includes('config')) configCalled = true;
      return { stdout: '', stderr: '' };
    };
    const git = createGitRecovery({ runner });
    await assert.rejects(() => git.inspectLocalRepository(root), error => (
      error instanceof RecoveryGitError && error.code === 'external-git-directory'
    ));
    assert.equal(configCalled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('真实本地仓库拒绝 repo-local 传输配置', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-'));
  try {
    await run('git', ['init', root]);
    await run('git', ['-C', root, 'config', '--local', 'core.sshCommand', 'ssh -i old-machine-key']);
    const git = createGitRecovery();
    await assert.rejects(() => git.inspectLocalRepository(root), error => (
      error instanceof RecoveryGitError && error.code === 'repository-credentials'
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('真实本地仓库拒绝含凭据或危险协议的 remote', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-'));
  try {
    await run('git', ['init', root]);
    await run('git', ['-C', root, 'remote', 'add', 'origin', 'file:///tmp/private']);
    const git = createGitRecovery();
    await assert.rejects(() => git.inspectLocalRepository(root), error => (
      error instanceof RecoveryGitError && error.code === 'invalid-remote'
    ));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Git stderr 只映射安全类别而不向上透传', () => {
  const secret = 'https://user:password@example.com/private.git';
  const classified = classifyGitError({ stderr: `fatal: Authentication failed for '${secret}'` });
  assert.equal(classified.code, 'authentication-failed');
  assert.ok(!classified.message.includes('password'));
  assert.ok(!classified.message.includes(secret));
});

test('本地恢复拒绝依赖其他 Git 对象库的备份', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-objects-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const backup = path.join(root, 'backup');
  await run('git', ['init', backup]);
  await fs.writeFile(path.join(backup, '.git', 'objects', 'info', 'alternates'), path.join(root, 'original', '.git', 'objects') + '\n');
  await assert.rejects(createGitRecovery().inspectLocalRepository(backup), { code: 'shared-object-store' });
});

test('可以恢复所有对象目录都在备份中的相对引用', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-contained-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run('git', ['init', root]);
  const objects = path.join(root, '.git', 'objects');
  await fs.mkdir(path.join(root, '.git', 'local objects', 'info'), { recursive: true });
  await fs.writeFile(path.join(objects, 'info', 'alternates'), '"../local\\040objects"\n');
  assert.deepEqual(await createGitRecovery().inspectLocalRepository(root), { isRepo: true });
});

test('本地恢复区分无 Git 的资料库、损坏的 .git 和缺失的提交对象', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-incomplete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = createGitRecovery();
  assert.deepEqual(await git.inspectLocalRepository(root), { isRepo: false });
  await fs.mkdir(path.join(root, '.git'));
  await assert.rejects(git.inspectLocalRepository(root), { code: 'incomplete-repository' });
  await run('git', ['init', root]);
  await run('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'one']);
  const { stdout } = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
  const hash = stdout.trim();
  await fs.rm(path.join(root, '.git', 'objects', hash.slice(0, 2), hash.slice(2)));
  await assert.rejects(git.inspectLocalRepository(root), { code: 'incomplete-repository' });
});

test('离线完整性检查识别部分克隆缺失的 blob，并接受已补齐的备份', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-partial-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const backup = path.join(root, 'backup');
  await run('git', ['init', source]);
  await fs.writeFile(path.join(source, 'note.md'), 'test');
  await run('git', ['-C', source, 'add', '.']);
  await run('git', ['-C', source, '-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'one']);
  await run('git', ['-C', source, 'config', 'uploadpack.allowFilter', 'true']);
  const url = require('node:url').pathToFileURL(source).href;
  await run('git', ['clone', '--filter=blob:none', '--no-checkout', url, backup]);
  const git = (...args) => run('git', ['-C', backup, ...args]);
  await git('remote', 'set-url', 'origin', VALID[0]);
  const inspect = () => createGitRecovery().inspectLocalRepository(backup);
  await assert.rejects(inspect, { code: 'incomplete-repository' });
  // 直接从已知原文补入唯一缺失的 blob，不依赖各平台 checkout 是否自动抓取。
  const { stdout: wanted } = await git('rev-parse', 'HEAD:note.md');
  const { stdout: written } = await git('hash-object', '-w', '--no-filters', path.join(source, 'note.md'));
  assert.equal(written.trim(), wanted.trim());
  assert.deepEqual(await inspect(), { isRepo: true });
});

test('盘符开头的 SCP 写法（C:foo）只在 Windows 上当成本地路径', () => {
  for (const remote of ['C:foo', 'c:vault.git', 'D:team/vault.git']) {
    assert.throws(() => validateRemote(remote, { platform: 'win32' }), error => error instanceof RecoveryGitError
      && error.code === 'invalid-remote', remote);
    // macOS、Linux 上这是 ~/.ssh/config 里单字母主机别名的 SSH 远端。
    assert.equal(validateRemote(remote, { platform: 'darwin' }), remote);
    assert.equal(validateRemote(remote, { platform: 'linux' }), remote);
  }
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.throws(() => validateRemote('C:\\vault', { platform }), error => error.code === 'invalid-remote');
  }
});

test('全局 url.insteadOf 改写远端时，克隆验证仍认用户选的地址', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-insteadof-'));
  const saved = process.env.GIT_CONFIG_GLOBAL;
  t.after(async () => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
    await fs.rm(root, { recursive: true, force: true });
  });
  const globalConfig = path.join(root, 'global.gitconfig');
  await fs.writeFile(globalConfig, '[url "git@example.com:"]\n\tinsteadOf = https://example.com/\n[user]\n\tname = t\n\temail = t@example.invalid\n');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  const repo = path.join(root, 'clone');
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await fs.writeFile(path.join(repo, 'a.md'), 'a\n');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', VALID[0]]);
  await run('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await run('git', ['-C', repo, 'branch', '-q', '-u', 'origin/main']);

  const result = await createGitRecovery().validateClonedRepository(repo, { expectedRemote: VALID[0] });
  assert.equal(result.ok, true);
  assert.equal(result.origin, VALID[0]);
});

