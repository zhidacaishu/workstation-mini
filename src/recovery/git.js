const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const SAFE_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0'
});

class RecoveryGitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function externalGitDirectoryError() {
  return new RecoveryGitError('external-git-directory', '本地备份的 Git 数据不在资料库内部，未继续恢复。');
}

function safeSshPath(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  const segments = decoded.split('/').filter(Boolean);
  return segments.length > 0 && segments.every(segment => (
    segment !== '.'
    && segment !== '..'
    && !segment.startsWith('-')
    && /^[A-Za-z0-9._~+@=-]+$/.test(segment)
  ));
}

function safeSshUser(value) {
  if (!value) return true;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(decoded);
}

function validateRemote(value) {
  const remote = String(value || '').trim();
  if (!remote || remote.startsWith('-') || /[\0\r\n]/.test(remote)) {
    throw new RecoveryGitError('invalid-remote', 'Git 远端地址不合法。');
  }
  if (/^(?:ext::|file:)/i.test(remote)
    || /^[a-zA-Z]:[\\/]/.test(remote)
    || remote.startsWith('\\\\')
    || remote.startsWith('/')
    || remote.startsWith('./')
    || remote.startsWith('../')
    || remote.startsWith('~')) {
    throw new RecoveryGitError('invalid-remote', '恢复只接受 HTTPS 或 SSH Git 远端。');
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)
    && !/^https:\/\//i.test(remote)
    && !/^ssh:\/\//i.test(remote)) {
    throw new RecoveryGitError('invalid-remote', '恢复只接受 HTTPS 或 SSH Git 远端。');
  }

  if (/^https:\/\//i.test(remote) || /^ssh:\/\//i.test(remote)) {
    let parsed;
    try {
      parsed = new URL(remote);
    } catch {
      throw new RecoveryGitError('invalid-remote', 'Git 远端地址不合法。');
    }
    const ssh = parsed.protocol === 'ssh:';
    if (!['https:', 'ssh:'].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.hostname.startsWith('-')
      || parsed.password
      || parsed.search
      || parsed.hash
      || (!ssh && parsed.username)
      || (ssh && !safeSshUser(parsed.username))
      || !parsed.pathname || parsed.pathname === '/'
      || (ssh && !safeSshPath(parsed.pathname))) {
      throw new RecoveryGitError('invalid-remote', 'Git 远端地址不能包含凭据、查询参数或危险参数。');
    }
    return remote;
  }

  const scp = remote.match(/^([^@:]+@)?([^:]+):(.+)$/);
  if (scp) {
    const user = scp[1] ? scp[1].slice(0, -1) : '';
    const host = scp[2];
    const validHost = /^\[[0-9A-Fa-f:]+\]$/.test(host)
      || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
    if (safeSshUser(user) && validHost && safeSshPath(scp[3])) return remote;
  }

  throw new RecoveryGitError('invalid-remote', '恢复只接受 HTTPS、ssh:// 或受限 SCP 风格 Git 远端。');
}

function redactRemote(value) {
  const remote = validateRemote(value);
  if (/^https:\/\//i.test(remote) || /^ssh:\/\//i.test(remote)) {
    const parsed = new URL(remote);
    return `${parsed.protocol}//${parsed.host}/…/${path.posix.basename(parsed.pathname)}`;
  }
  const [host, ...rest] = remote.split(':');
  return `${host}:…/${path.posix.basename(rest.join(':'))}`;
}

function classifyGitError(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new RecoveryGitError('cancelled', 'Git 操作已取消。');
  }
  if (error?.killed || error?.code === 'ETIMEDOUT') {
    return new RecoveryGitError('timeout', 'Git 操作超时。');
  }
  const output = `${error?.stderr || ''}\n${error?.stdout || ''}`;
  if (/authentication failed|permission denied|could not read Username|publickey/i.test(output)) {
    return new RecoveryGitError('authentication-failed', '无法使用系统 Git 凭据访问远端。');
  }
  if (/not found|does not exist|repository .* not found/i.test(output)) {
    return new RecoveryGitError('remote-not-found', 'Git 远端不存在或当前身份无权访问。');
  }
  return new RecoveryGitError('git-failed', '系统 Git 操作失败。');
}

function createGitRecovery({ runner = exec, timeoutMs = 120_000 } = {}) {
  async function run(args, options = {}) {
    try {
      return await runner('git', ['-c', 'protocol.ext.allow=never', ...args], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: timeoutMs,
        signal: options.signal,
        cwd: options.cwd,
        env: { ...process.env, ...SAFE_ENV }
      });
    } catch (error) {
      throw classifyGitError(error);
    }
  }

  async function inspectRemote(value, options = {}) {
    const remote = validateRemote(value);
    const { stdout } = await run(['ls-remote', '--symref', '--', remote, 'HEAD'], options);
    if (!String(stdout).trim()) {
      throw new RecoveryGitError('empty-remote', 'Git 远端没有可恢复的默认分支。');
    }
    return { ok: true, remote, display: redactRemote(remote) };
  }

  async function cloneRemote(value, candidateDir, options = {}) {
    const remote = validateRemote(value);
    await run(['clone', '--origin', 'origin', '--', remote, candidateDir], options);
    return validateClonedRepository(candidateDir, { ...options, expectedRemote: remote });
  }

  async function gitAt(candidateDir, args, options) {
    return run(['-C', candidateDir, ...args], options);
  }

  async function gitPath(candidateDir, marker, options) {
    const { stdout } = await gitAt(candidateDir, ['rev-parse', '--git-path', marker], options);
    const found = String(stdout).trim();
    return path.isAbsolute(found) ? found : path.resolve(candidateDir, found);
  }

  async function exists(filePath) {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function validateClonedRepository(candidateDir, options = {}) {
    await gitAt(candidateDir, ['rev-parse', '--verify', 'HEAD'], options);
    const branch = (await gitAt(candidateDir, ['symbolic-ref', '--short', 'HEAD'], options)).stdout.trim();
    if (!branch) throw new RecoveryGitError('detached-head', '恢复出的 Git 仓库没有当前分支。');

    const origin = (await gitAt(candidateDir, ['remote', 'get-url', 'origin'], options)).stdout.trim();
    if (options.expectedRemote && origin !== options.expectedRemote) {
      throw new RecoveryGitError('remote-mismatch', '恢复出的 Git origin 与所选远端不一致。');
    }
    await gitAt(candidateDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], options);

    const dirty = (await gitAt(candidateDir, ['status', '--porcelain'], options)).stdout.trim();
    if (dirty) throw new RecoveryGitError('dirty-repository', '恢复出的 Git 工作区不是干净状态。');
    const unmerged = (await gitAt(candidateDir, ['ls-files', '-u'], options)).stdout.trim();
    if (unmerged) throw new RecoveryGitError('recovery-required', '恢复出的 Git 仓库仍有未合并文件。');

    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      if (await exists(await gitPath(candidateDir, marker, options))) {
        throw new RecoveryGitError('recovery-required', '恢复出的 Git 仓库仍处于未完成操作中。');
      }
    }
    return { ok: true, branch, origin };
  }

  async function inspectLocalRepository(candidateDir, options = {}) {
    try {
      const inside = (await gitAt(candidateDir, ['rev-parse', '--is-inside-work-tree'], options)).stdout.trim();
      if (inside !== 'true') return { isRepo: false };
    } catch (error) {
      if (error.code === 'git-failed') return { isRepo: false };
      throw error;
    }

    const expectedGitDirectory = path.resolve(candidateDir, '.git');
    let expectedStats;
    try {
      expectedStats = await fsp.lstat(expectedGitDirectory);
    } catch {
      throw externalGitDirectoryError();
    }
    if (!expectedStats.isDirectory() || expectedStats.isSymbolicLink()) {
      throw externalGitDirectoryError();
    }

    const gitDirectory = (await gitAt(candidateDir, ['rev-parse', '--absolute-git-dir'], options)).stdout.trim();
    let expectedReal;
    let actualReal;
    try {
      [expectedReal, actualReal] = await Promise.all([
        fsp.realpath(expectedGitDirectory),
        fsp.realpath(gitDirectory)
      ]);
    } catch {
      throw externalGitDirectoryError();
    }
    if (path.relative(expectedReal, actualReal) !== '') {
      throw externalGitDirectoryError();
    }

    const config = await gitAt(candidateDir, [
      'config', '--local', '--list', '--null'
    ], options);
    for (const record of String(config.stdout).split('\0').filter(Boolean)) {
      const separator = record.indexOf('\n');
      const key = separator === -1 ? record : record.slice(0, separator);
      const value = separator === -1 ? '' : record.slice(separator + 1);
      if (/^(?:credential\.|core\.sshcommand$|include(?:if)?\.|url\.)/i.test(key)
        || /^http\..*\.extraheader$/i.test(key)
        || /^remote\..*\.pushurl$/i.test(key)) {
        throw new RecoveryGitError('repository-credentials', '本地备份含有仓库级凭据或传输配置，未继续恢复。');
      }
      if (/^remote\..*\.url$/i.test(key)) validateRemote(value);
    }
    return { isRepo: true };
  }

  return { inspectRemote, cloneRemote, validateClonedRepository, inspectLocalRepository };
}

module.exports = {
  createGitRecovery,
  validateRemote,
  redactRemote,
  RecoveryGitError,
  classifyGitError
};
