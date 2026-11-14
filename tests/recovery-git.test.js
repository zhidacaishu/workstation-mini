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
    if (joined.includes('remote get-url origin')) return { stdout: `${VALID[0]}\n` };
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

test('父仓库中的普通子目录不被视为独立仓库', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-git-parent-'));
  try {
    await run('git', ['init', root]);
    const candidate = path.join(root, 'candidate');
    await fs.mkdir(candidate);
    const git = createGitRecovery();
    await assert.rejects(() => git.inspectLocalRepository(candidate), error => (
      error instanceof RecoveryGitError && error.code === 'external-git-directory'
    ));
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
