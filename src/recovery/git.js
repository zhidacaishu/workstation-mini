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

// Git 的双引号路径采用 C 转义，八进制表示文件名中的 UTF-8 字节。
function alternatePath(line) {
  if (!line.startsWith('"')) return line;
  if (!/^"(?:[^"\\]|\\(?:[abfnrtv"\\]|[0-3][0-7]{2}))*"$/.test(line)) throw sharedStoreError();
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  const parts = line.slice(1, -1).match(/[^\\]+|\\(?:[0-3][0-7]{2}|.)/g) || [];
  const bytes = parts.map(part => {
    if (!part.startsWith('\\')) return Buffer.from(part);
    return Buffer.from([part.length === 2 ? escapes[part[1]] : parseInt(part.slice(1), 8)]);
  });
  return Buffer.concat(bytes).toString('utf8');
}

// 相对引用的对象目录可以一同复制。绝对路径在候选目录改名后也可能失效。
async function checkLocalObjectStores(candidateDir, gitDir) {
  const root = await fsp.realpath(candidateDir);
  const visited = new Set();
  async function visit(directory) {
    const objects = await fsp.realpath(directory);
    const relative = path.relative(root, objects);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw sharedStoreError();
    if (visited.has(objects)) return;
    visited.add(objects);
    let contents;
    try { contents = await fsp.readFile(path.join(objects, 'info', 'alternates'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of contents.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const alternate = alternatePath(line);
      if (!alternate || path.isAbsolute(alternate)) throw sharedStoreError();
      try { await visit(path.resolve(objects, alternate)); }
      catch (error) { if (error.code === 'ENOENT') throw sharedStoreError(); throw error; }
    }
  }
  await visit(path.join(gitDir, 'objects'));
}

function incompleteRepository() {
  return new RecoveryGitError('incomplete-repository', '备份的 Git 历史不完整。请从完整的本地备份或远端恢复。');
}

function sharedStoreError() {
  return new RecoveryGitError('shared-object-store', '无法确认 Git 对象库能随备份迁移。请先制作含完整 Git 历史的独立备份。');
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

function validateRemote(value, { platform = process.platform } = {}) {
  const remote = String(value || '').trim();
  if (!remote || remote.startsWith('-') || /[\0\r\n]/.test(remote)) {
    throw new RecoveryGitError('invalid-remote', 'Git 远端地址不合法。');
  }
  // 盘符开头：C:\vault 在哪里都是本地路径；C:foo 在 Windows 上也是（Git for Windows
  // 把它当盘符），在 macOS、Linux 上则是 ~/.ssh/config 里单字母主机别名的 SSH 写法。
  if (/^(?:ext::|file:)/i.test(remote)
    || /^[a-zA-Z]:[\\/]/.test(remote)
    || (platform === 'win32' && /^[a-zA-Z]:/.test(remote))
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

// 克隆要把附件和录音一起拉下来，两分钟不够。总时长放宽到一小时，卡住的连接靠
// http.lowSpeedLimit 提前放弃（SSH 远端没有这项保护，一小时是最后的保险）；
// 恢复窗口里随时可以取消。
const CLONE_TIMEOUT_MS = 60 * 60_000;
const CLONE_LOW_SPEED = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];

function createGitRecovery({ runner = exec, timeoutMs = 120_000, cloneTimeoutMs = CLONE_TIMEOUT_MS } = {}) {
  async function run(args, options = {}) {
    try {
      return await runner('git', ['-c', 'protocol.ext.allow=never', ...args], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: options.timeoutMs ?? timeoutMs,
        signal: options.signal,
        cwd: options.cwd,
        env: { ...process.env, ...SAFE_ENV, ...options.env }
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
    await run([...CLONE_LOW_SPEED, 'clone', '--origin', 'origin', '--', remote, candidateDir], { ...options, timeoutMs: cloneTimeoutMs });
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

    // 读配置里的原文：remote get-url 会套用全局 url.<base>.insteadOf，改写后的地址
    // 和用户选的对不上，克隆恢复就永远报 remote-mismatch。
    const origin = (await gitAt(candidateDir, ['config', '--get', 'remote.origin.url'], options)).stdout.trim();
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
    const expectedGitDirectory = path.resolve(candidateDir, '.git');
    let expectedStats;
    try { expectedStats = await fsp.lstat(expectedGitDirectory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // 备份里没有 .git 就是不带 Git 的普通资料库。不能再问 Git：目标放在别的工作树里
    // （dotfiles 仓库、项目仓库）时它会认出外层仓库，恢复就被误判失败。
    if (!expectedStats) return { isRepo: false };
    try {
      const inside = (await gitAt(candidateDir, ['rev-parse', '--is-inside-work-tree'], options)).stdout.trim();
      if (inside !== 'true') {
        if (expectedStats) throw incompleteRepository();
        return { isRepo: false };
      }
    } catch (error) {
      if (error.code === 'git-failed') {
        if (expectedStats) throw incompleteRepository();
        return { isRepo: false };
      }
      throw error;
    }

    if (!expectedStats?.isDirectory() || expectedStats.isSymbolicLink()) {
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

    const common = (await gitAt(candidateDir, ['rev-parse', '--git-common-dir'], options)).stdout.trim();
    if (path.relative(expectedReal, await fsp.realpath(path.resolve(candidateDir, common))) !== '') {
      throw externalGitDirectoryError();
    }
    await checkLocalObjectStores(candidateDir, expectedGitDirectory);
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
    // 部分克隆的 fsck 允许承诺对象缺失。离线遍历所有可达对象，任何缺失都不能算完整恢复。
    const offline = { ...options, env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' } };
    try {
      await gitAt(candidateDir, ['fsck', '--connectivity-only', '--no-dangling'], offline);
      const missing = await gitAt(candidateDir, [
        'rev-list', '--all', '--reflog', '--indexed-objects', '--objects', '--quiet', '--missing=print'
      ], offline);
      if (/^\?/m.test(missing.stdout)) throw incompleteRepository();
    } catch (error) {
      if (error.code === 'git-failed' || error.code === 'remote-not-found') throw incompleteRepository();
      throw error;
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
