const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { isUtf8 } = require('node:buffer');
const path = require('node:path');
const { promisify } = require('node:util');
const { compareText } = require('./lineDiff');
const { randomUUID } = require('node:crypto');
const { ensureSafeFilePath } = require('./vault/paths');
const { replaceFile } = require('./vault/atomic');
const { saveConflictCopy } = require('./vault/history');

const { isRegularFile } = require('./review');

const run = promisify(execFile);

// 基础规则：任何 vault 都该有的。
//
// 这里是**单一来源** —— 新建 .gitignore 和给已有 .gitignore 打补丁都从它生成，
// 以前两处各写一份，结果是已存在 .gitignore 的 vault 永远补不上 .DS_Store 和
// Thumbs.db，两条路径给出的结果不一样。
const BASE_IGNORE_RULES = [
  { probe: '.workstation-local/', text: '# 本机笔记版本和草稿，不参与同步\n.workstation-local/\n' },
  {
    probe: 'workstation.db',
    text: '# 派生索引：删掉后能从 Markdown 全量重建，绝不提交。\n# 新版本把索引放在应用数据目录；这几条挡住旧版本留在资料库里的文件。\nworkstation.db\n'
  },
  { probe: 'workstation.db-shm', text: 'workstation.db-shm\n' },
  { probe: 'workstation.db-wal', text: 'workstation.db-wal\n' },
  { probe: 'workstation.db-corrupt', text: '# 运行中发现索引库损坏时留下的标记，下次启动据此重建\nworkstation.db-corrupt\n' },
  { probe: '*.tmp-*', text: '# 原子写入中断后可能残留的临时文件\n*.tmp-*\n' },
  { probe: '.DS_Store', text: '# 双系统开发，两边的文件管理器都会往目录里塞东西\n.DS_Store\n' },
  { probe: 'Thumbs.db', text: 'Thumbs.db\n' }
];

// 旧版本在配了大文件存储服务时，会把 attachments/ 和 audio/ 写进 .gitignore（带标记的
// 一段，或者更早的不带标记的三行）。Mini 没有那项服务，这些素材必须由 Git 同步，
// 否则笔记里引用的图片在另一台设备上就丢了。所以只保留「摘掉」这一半：
// 认出应用自己写的那段就删掉，用户自己写的同名规则不动。
const MEDIA_BLOCK_BEGIN = '# >>> workstation managed media ignores >>>';
const MEDIA_BLOCK_END = '# <<< workstation managed media ignores <<<';
const LEGACY_MEDIA_RULES = ['attachments/', 'audio/'];

function renderGitignore(rules) {
  return `${rules.map(rule => rule.text).join('\n')}`;
}

function legacyMediaLines() {
  return [
    '# 二进制资源由大文件存储服务托管，不进 Git（Git 存不动，也合并不了）。',
    'attachments/',
    '',
    'audio/'
  ];
}

function findSequence(lines, sequence) {
  const matches = [];
  for (let index = 0; index <= lines.length - sequence.length; index += 1) {
    if (sequence.every((line, offset) => lines[index + offset] === line)) matches.push(index);
  }
  return matches;
}

/** 返回去掉旧媒体规则后的内容；没有可去掉的返回 null。标记残缺时拒绝修改。 */
function removeLegacyMediaIgnores(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const starts = lines.flatMap((line, index) => line === MEDIA_BLOCK_BEGIN ? [index] : []);
  const ends = lines.flatMap((line, index) => line === MEDIA_BLOCK_END ? [index] : []);
  if (starts.length !== ends.length || starts.length > 1 || (starts.length === 1 && starts[0] >= ends[0])) {
    throw new Error('应用管理的媒体忽略规则标记不完整，未修改 .gitignore。');
  }
  if (starts.length === 1) {
    lines.splice(starts[0], ends[0] - starts[0] + 1);
    return lines.join(newline);
  }
  const legacyMatches = findSequence(lines, legacyMediaLines());
  if (legacyMatches.length > 1) {
    throw new Error('检测到多份旧版媒体忽略规则，未修改 .gitignore。');
  }
  if (legacyMatches.length === 1) {
    lines.splice(legacyMatches[0], legacyMediaLines().length);
    return lines.join(newline);
  }
  return null;
}

const VAULT_GITIGNORE = renderGitignore(BASE_IGNORE_RULES);

// 换行统一用 LF。Git for Windows 默认 core.autocrlf=true，检出时把文本转成 CRLF：
// 卡组、待办、复习日志在两台设备上会是两种换行，diff 满屏 ^M，旧版本的解析器
// 还会一张卡都认不出来。写进 .gitattributes 以后，不管各台机器怎么配，检出的都是 LF。
const ATTRIBUTE_RULES = [
  '*.md text eol=lf',
  '*.jsonl text eol=lf',
  '.gitignore text eol=lf',
  '.gitattributes text eol=lf'
];
const VAULT_GITATTRIBUTES = `# 应用管理：文本统一用 LF 换行，Windows 和 macOS 检出的内容一致。\n${ATTRIBUTE_RULES.join('\n')}\n`;

const NETWORK_COMMANDS = new Set(['fetch', 'push', 'ls-remote']);
// 中止前保全的单个文件大小上限：笔记和复习日志远小于这个数。
const PRESERVE_MAX_BYTES = 16 * 1024 * 1024;
// 冲突列表里给人看的两边差异：只比文本，文件太大或差得太多就不比。
const CONFLICT_DIFF_MAX_BYTES = 512 * 1024;
const CONFLICT_DIFF_MAX_ROWS = 300;
// 「Unable to create '…/index.lock': File exists.」：另一个 Git 正在运行，或者上次被中途杀掉。
function lockFileError(error) {
  const match = /Unable to create '([^'\n]+\.lock)': File exists/.exec(String(error?.stderr || ''));
  return match ? path.normalize(match[1]) : '';
}
const CONFLICT_TEXT_FILE = /\.(md|markdown|txt|jsonl|json|ya?ml|csv|tex|bib)$/i;
// 远端要登录、要输口令或确认主机指纹时 Git/SSH 的报错。后台同步不弹窗（见 git()），
// 只能请用户在终端里登录一次，之后凭据管理器或 ssh-agent 会记住。
const AUTH_REQUIRED = /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification failed|Too many authentication failures|interactivity|GCM_INTERACTIVE/i;
const AUTH_HINT = '远端需要登录或确认主机，后台同步不会弹出登录窗口。请在终端里进入资料库目录运行一次 git fetch，按提示完成登录或确认后再同步。';

function createSync({
  vaultDir,
  logger = console,
  timeoutMs = 60_000,
  // fetch、push、ls-remote 的总时长上限；平时靠 http.lowSpeedLimit 提前放弃。
  networkTimeoutMs = 30 * 60_000,
  enabled = true,
  reviewSyncEnabled = false,
  beforeReviewPush = async () => {},
  // 会改工作区文件的本地 Git 操作（变基、冲突处理）在这里面跑，期间暂停笔记写入。
  pauseWrites = operation => operation(),
  // 中止 Git 操作会丢弃工作区里未提交的修改。中止前读到的内容交给这里另存一份
  // （运行时把它写进本机历史）；返回 true 表示已经存好。
  preserveDiscarded = async () => false
}) {
  // 每个排队的操作各用一个取消信号。cancel() 取消正在跑的和已经排着队的操作，
  // 之后才排进来的（退出前那次提交）照常执行。以前整个实例共用一个信号、取消后永久
  // 失效，退出前提交的每条 git 命令都会立刻失败，再被 isRepo 当成「不是 git 仓库」
  // 悄悄跳过，最后的编辑没有提交。
  let cancellation = new AbortController();
  let enqueued = 0;
  let cancelledThrough = 0;
  let queue = Promise.resolve();
  let currentStatus = Object.freeze({
    phase: (enabled || reviewSyncEnabled) ? 'idle' : 'disabled',
    operation: '',
    recovery: null,
    lastResult: null
  });
  const listeners = new Set();

  function emitStatus(patch) {
    currentStatus = Object.freeze({ ...currentStatus, ...patch });
    for (const listener of listeners) listener(currentStatus);
    return currentStatus;
  }

  function getStatus() {
    return currentStatus;
  }

  function onStatus(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function enqueue(operation) {
    const ticket = ++enqueued;
    const result = queue.then(() => {
      cancellation = new AbortController();
      if (ticket <= cancelledThrough) cancellation.abort();
      return operation();
    });
    queue = result.catch(() => {});
    return result;
  }

  async function git(args, options = {}) {
    // 后台同步没有终端可以回答提示：账号密码提示会一直挂到超时。HTTP 连接卡住
    // （代理坏了、网络时断时续）时用低速限制尽早放弃。
    //
    // 联网命令不能和本地命令共用 60 秒：附件和录音也走 Git，一次推送超过一分钟很平常，
    // 到点就杀的话每一轮都从头再来，永远推不上去。它们只受低速限制和一个很宽的总上限
    // 约束（SSH 远端没有低速限制，上限是最后的保险）；调用方显式给了 timeout 的
    // （退出前那次提交）仍按调用方的来。
    const network = NETWORK_COMMANDS.has(args[0]);
    const timeout = options.timeout ?? (network ? networkTimeoutMs : timeoutMs);
    const { signal } = cancellation;
    const guards = network ? await sshPromptGuard() : {};
    try {
      return await run('git', [
        '-C', vaultDir,
        '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20',
        ...args
      ], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        ...options,
        timeout,
        signal,
        // GIT_TERMINAL_PROMPT 管不到 SSH（口令、首次连接的主机指纹）和 Git Credential
        // Manager 的登录窗口：后台同步没人回答，要么弹窗打扰，要么一直挂到网络上限。
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...guards, ...(options.env || {}) }
      });
    } catch (error) {
      const lock = lockFileError(error);
      if (lock) {
        error.lockFile = lock;
        error.message = `Git 的锁文件还在：${lock}\n可能是上次 Git 被中途结束（例如关机或超时）留下的。请确认没有别的 Git 程序正在操作这个资料库后，手动删除这个文件，再重新同步。`;
        error.stderr = '';
        throw error;
      }
      if (network && AUTH_REQUIRED.test(String(error?.stderr || ''))) {
        error.authRequired = true;
        error.stderr = `${String(error.stderr).trim()}\n${AUTH_HINT}`;
      }
      // execFile 到点杀进程时只给一句「Command failed: git -C …」，看不出是超时。
      if (error && error.killed && !signal.aborted && error.name !== 'AbortError') {
        const seconds = Math.round(timeout / 1000);
        const detail = String(error.stderr || '').trim();
        error.timedOut = true;
        error.message = `Git ${args[0]} 超过 ${seconds} 秒没有完成，已停止；下一轮同步会重试。${detail ? `\n${detail}` : ''}`;
        error.stderr = '';
      }
      throw error;
    }
  }

  // 用户自己没指定 ssh 命令时，让 ssh 遇到需要回答的提示直接失败。按实例只探测一次。
  let sshGuard;
  function sshPromptGuard() {
    sshGuard ??= (async () => {
      if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return {};
      try {
        const { stdout } = await run('git', ['-C', vaultDir, 'config', '--get', 'core.sshCommand'], {
          encoding: 'utf8', windowsHide: true, timeout: timeoutMs
        });
        if (stdout.trim()) return {};
      } catch (error) {
        // 退出码 1 表示没配置；别的失败（读不了配置）按「用户可能配了」处理，不去覆盖。
        if (error?.code !== 1) return {};
      }
      return { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    })();
    return sshGuard;
  }

  async function isRepo(options) {
    try {
      // Git 在普通子目录里也认父仓库；同步只能操作资料库自身的工作树。
      // 不检查 .git 的类型，linked worktree 的 .git 是文件。
      const { stdout } = await git(['rev-parse', '--show-toplevel'], options);
      const [root, vault] = await Promise.all([fs.realpath(stdout.trim()), fs.realpath(vaultDir)]);
      return path.relative(root, vault) === '';
    } catch {
      return false;
    }
  }

  async function hasRemote(options) {
    try {
      const { stdout } = await git(['remote'], options);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async function hasChanges(options) {
    // 显式要未跟踪文件：全局设了 status.showUntrackedFiles=no 时，只有新笔记的改动会被看漏。
    // 子仓库（submodule、嵌套仓库）里没提交的改动在这一层提交不了：算进来的话，
    // add 之后没有可提交的内容，commit 报错，还会一直挡住启动时的拉取。
    const { stdout } = await git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'], options);
    return stdout.trim().length > 0;
  }

  /**
   * 暂存全部改动并提交。暂存后确实有内容才提交：只有子仓库变动等情况下，status
   * 报有改动但 add 之后什么也没暂存，直接 commit 会以「nothing to commit」失败。
   */
  async function commitAll(message, options) {
    await git(['add', '-A'], options);
    const recovery = await detectRecovery(options);
    if (recovery) return { recovery, committed: false };
    if (!(await hasStagedChanges(options))) return { committed: false };
    await git(['commit', '-m', message], options);
    return { committed: true };
  }

  async function currentBranch(options) {
    try {
      return (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], options)).stdout.trim();
    } catch (error) {
      if (error?.code === 1) return '';
      throw error;
    }
  }

  async function hasUpstream(options) {
    try {
      await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], options);
      return true;
    } catch {
      return false;
    }
  }

  /** 一次 rev-parse 解析多个 .git 内部路径：逐个问要多起好几个子进程，启动时尤其明显。 */
  async function gitPaths(names, options) {
    const { stdout } = await git(['rev-parse', ...names.flatMap(name => ['--git-path', name])], options);
    const values = stdout.split(/\r?\n/).filter(Boolean);
    if (values.length !== names.length) throw new Error('无法解析 Git 内部路径。');
    return values.map(value => path.isAbsolute(value) ? value : path.resolve(vaultDir, value));
  }

  async function pathExists(target) {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async function detectRecovery(options) {
    if (!(await isRepo(options))) return null;
    const markers = [
      ['rebase', 'rebase-merge'],
      ['rebase', 'rebase-apply'],
      ['merge', 'MERGE_HEAD'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD']
    ];
    let kind = '';
    const markerPaths = await gitPaths(markers.map(([, marker]) => marker), options);
    for (const [index, [candidate]] of markers.entries()) {
      if (await pathExists(markerPaths[index])) {
        kind = candidate;
        break;
      }
    }

    let unmergedCount = 0;
    try {
      const { stdout } = await git(['ls-files', '-u', '-z'], options);
      const paths = new Set(stdout.split('\0').filter(Boolean).map(line => line.replace(/^\d+ [0-9a-f]+ \d+\t/, '')));
      unmergedCount = paths.size;
    } catch {}

    if (!kind && unmergedCount === 0) return null;
    return Object.freeze({
      kind: kind || 'unmerged',
      abortable: Boolean(kind),
      unmergedCount
    });
  }

  async function probeOnce(options) {
    const recovery = await detectRecovery(options);
    if (recovery) emitStatus({ phase: 'recovery-required', operation: '', recovery });
    else emitStatus({ phase: (enabled || reviewSyncEnabled) ? 'idle' : 'disabled', operation: '', recovery: null });
    return currentStatus;
  }

  function probe(options) {
    return enqueue(() => probeOnce(options));
  }

  function blocked(recovery) {
    const result = { ok: false, blocked: 'recovery-required', recovery };
    emitStatus({ phase: 'recovery-required', operation: '', recovery, lastResult: result });
    return result;
  }

  async function beginMutation(operation, options) {
    const recovery = await detectRecovery(options);
    if (recovery) return blocked(recovery);
    emitStatus({ phase: 'running', operation, recovery: null });
    return null;
  }

  function finish(result) {
    const recovery = result.recovery || null;
    emitStatus({
      phase: recovery
        ? 'recovery-required'
        : (enabled || reviewSyncEnabled) ? (result.ok === false ? 'error' : 'idle') : 'disabled',
      operation: '',
      recovery,
      lastResult: result
    });
    return result;
  }

  async function ensureGitignoreOnce(options) {
    const denied = await beginMutation('gitignore', options);
    if (denied) return denied;
    try {
      const gitignorePath = await ensureSafeFilePath(vaultDir, '.gitignore', { allowMissing: true });
      let existing = '';
      try {
        existing = await fs.readFile(gitignorePath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeVaultText('.gitignore', renderGitignore(BASE_IGNORE_RULES), 0o666);
        return finish({ ok: true, created: true });
      }
      const rules = new Set(existing.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
      const missing = BASE_IGNORE_RULES.filter(patch => !rules.has(patch.probe));
      const mediaUpdated = removeLegacyMediaIgnores(existing);

      if (missing.length === 0 && mediaUpdated === null) return finish({ ok: true, unchanged: true });

      let next = mediaUpdated === null ? existing : mediaUpdated;
      if (missing.length > 0) {
        const newline = next.includes('\r\n') ? '\r\n' : '\n';
        const lead = next && !next.endsWith('\n') ? newline : '';
        const gap = next && next.trim() ? newline : '';
        const rendered = missing.map(patch => patch.text.replaceAll('\n', newline)).join(newline);
        next = `${next}${lead}${gap}${rendered}`;
      }
      await writeVaultText('.gitignore', next, (await fs.lstat(gitignorePath)).mode);

      if (mediaUpdated !== null) {
        return finish({
          ok: true,
          ...(missing.length > 0 ? { appended: true } : {}),
          removed: LEGACY_MEDIA_RULES
        });
      }
      return finish({ ok: true, appended: true });
    } catch (error) {
      const result = { ok: false, error: error.message };
      logger.warn(`[sync] 更新 .gitignore 失败：${error.message}`);
      return finish(result);
    }
  }

  function ensureGitignore(options) {
    return enqueue(() => ensureGitignoreOnce(options));
  }

  /** 和 .gitignore 一样：不存在就建，缺哪条补哪条，用户自己写的规则不动。 */
  async function ensureGitattributesOnce(options) {
    const denied = await beginMutation('gitattributes', options);
    if (denied) return denied;
    try {
      const attributesPath = await ensureSafeFilePath(vaultDir, '.gitattributes', { allowMissing: true });
      let existing;
      try {
        existing = await fs.readFile(attributesPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeVaultText('.gitattributes', VAULT_GITATTRIBUTES, 0o666);
        return finish({ ok: true, created: true });
      }
      const present = new Set(existing.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')));
      const missing = ATTRIBUTE_RULES.filter(rule => !present.has(rule));
      if (missing.length === 0) return finish({ ok: true, unchanged: true });
      const newline = existing.includes('\r\n') ? '\r\n' : '\n';
      const lead = existing && !existing.endsWith('\n') ? newline : '';
      await writeVaultText('.gitattributes', `${existing}${lead}${missing.join(newline)}${newline}`, (await fs.lstat(attributesPath)).mode);
      return finish({ ok: true, appended: true });
    } catch (error) {
      logger.warn(`[sync] 更新 .gitattributes 失败：${error.message}`);
      return finish({ ok: false, error: error.message });
    }
  }

  function ensureGitattributes(options) {
    return enqueue(() => ensureGitattributesOnce(options));
  }

  async function status() {
    const repo = await isRepo();
    if (!repo) return { isRepo: false, hasRemote: false, branch: '', recovery: null };
    let branch = '';
    try {
      branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    } catch {}
    return { isRepo: true, hasRemote: await hasRemote(), branch, recovery: await detectRecovery() };
  }

  // 先提交本机修改再变基；发生冲突时保留 Git 状态，由用户解决或中止。
  async function pullOnce(options, message = '') {
    if (!enabled) return finish({ ok: true, skipped: '同步已关闭' });
    if (!(await isRepo(options))) return finish({ ok: true, skipped: 'vault 不是 git 仓库' });
    const denied = await beginMutation('pull', options);
    if (denied) return denied;
    if (!(await hasRemote(options))) return finish({ ok: true, skipped: '没有配置远端' });
    const upstream = await hasUpstream(options);
    if (!upstream && !message) return finish({ ok: true, skipped: '尚未建立上游分支' });

    try {
      let trackingRef = '@{u}';
      if (!upstream) {
        const target = await resolveSyncTarget(false, options);
        if (!target.trackingRef) return finish({ ok: true, skipped: '远端还没有这个分支' });
        trackingRef = target.trackingRef;
        if (await hasHead(options)) {
          // 首次关联只接续同一个资料库的历史。
          await git(['merge-base', 'HEAD', trackingRef], options).catch(error => {
            if (error.code !== 1) throw error;
            throw new Error('本机与远端分支没有共同历史，请核对资料库和远端后再同步。');
          });
        } else if (await hasChanges(options)) {
          throw new Error('本机尚无提交，远端已有历史。请先妥善保存本机文件，再关联远端分支。');
        } else {
          await pauseWrites(() => git(['merge', '--ff-only', trackingRef], options));
          return finish({ ok: true });
        }
      }
      if (await hasChanges(options)) {
        // 单独的拉取（启动时那一次）不替用户提交：跳过，下一轮完整同步时一起处理。
        if (!message) return finish({ ok: true, skipped: '本机有未提交的修改，下一轮同步时先提交再拉取' });
        const { recovery } = await commitAll(message, options);
        if (recovery) return blocked(recovery);
      }
      // 拉取拆成两步：联网的 fetch 不挡笔记保存；改工作区的变基期间暂停写入。
      if (upstream) await git(['fetch', '--quiet'], options);
      // 远端的提交本机已经都有了（包括在外面手工 merge 过的情形）就不用变基：
      // 变基会把合并提交拆开重放，同一处冲突要再解决一遍。
      if (await isAncestor(trackingRef, 'HEAD', options)) return finish({ ok: true });
      await pauseWrites(() => git(['rebase', '--no-autostash', trackingRef], options));
      return finish({ ok: true });
    } catch (error) {
      const message = String(error.stderr || error.message).trim();
      const recovery = await detectRecovery(options);
      logger.warn(`[sync] 拉取失败，本地继续工作：${message}`);
      return finish({ ok: false, error: message, ...(recovery ? { recovery } : {}) });
    }
  }

  async function hasHead(options) {
    try {
      await git(['rev-parse', '--verify', 'HEAD'], options);
      return true;
    } catch {
      return false;
    }
  }

  async function isAncestor(ancestor, descendant, options) {
    return git(['merge-base', '--is-ancestor', ancestor, descendant], options).then(() => true, error => {
      if (error.code === 1) return false;
      throw error;
    });
  }

  /** 已跟踪文件有没有未提交的修改；未跟踪的新文件不妨碍变基，不算。 */
  async function hasTrackedChanges(options) {
    const { stdout } = await git(['status', '--porcelain', '--untracked-files=no'], options);
    return stdout.trim().length > 0;
  }

  function reviewResult(fields = {}) {
    return { ok: true, committed: false, pushed: false, changed: false, ...fields };
  }

  function splitNul(stdout) {
    return stdout.split('\0').filter(Boolean).map(value => value.replaceAll('\\', '/'));
  }

  function isReviewPath(file) {
    return /^reviews\/[^/]+\.jsonl$/.test(file);
  }

  async function stagedPaths(options) {
    return splitNul((await git(['diff', '--cached', '--name-only', '-z'], options)).stdout);
  }

  async function outgoingCommits(revision, options) {
    return (await git(['rev-list', '--reverse', revision], options)).stdout.split(/\r?\n/).filter(Boolean);
  }

  async function validateOutgoing(revision, options) {
    const commits = await outgoingCommits(revision, options);
    const violations = [];
    for (const sha of commits) {
      const paths = splitNul((await git([
        'diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', '-z', sha
      ], options)).stdout);
      if (paths.some(file => !isReviewPath(file))) violations.push(sha);
    }
    return { commits, violations };
  }

  function currentDeviceReviewPattern(device) {
    const escapedDevice = device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^reviews/\\d{4}-\\d{2}-${escapedDevice}\\.jsonl$`);
  }

  /**
   * 还没有上游分支时，该推向哪个远端。
   *
   * 原来两条推送路径都写死 `origin`。远端叫别的名字（很多人用 `github`、
   * `gitlab`，或者从别处 clone 后改过名）时，`git remote get-url origin` 和
   * `git push -u origin HEAD` 都直接抛错，用户看到的是一段原始 git 报错，
   * 指向一个他并没有配错的地方。
   * 只有一个远端就用它；有多个而其中没有 origin 才是真的没法猜，那时明说。
   *
   * 复习同步和常规提交推送共用这一个判断 —— 两边对「默认远端是谁」的答案
   * 必须一致，否则首次推送会把两类提交送去不同的地方。所以文案保持中性，
   * 别写成只讲复习记录的样子。
   */
  async function defaultRemote(options) {
    const { stdout } = await git(['remote'], options);
    const remotes = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (remotes.length === 0) throw new Error('vault 没有配置 Git 远端，无法推送。');
    if (remotes.includes('origin')) return 'origin';
    if (remotes.length === 1) return remotes[0];
    throw new Error(
      `vault 配置了多个 Git 远端（${remotes.join('、')}）且没有 origin，`
      + '无法确定该推向哪一个，请先为当前分支设置上游。'
    );
  }

  // 空远端的 clone 或尚未 fetch 的分支可能只有配置，还没有本地跟踪引用。
  async function untrackedDestination(branch, options) {
    const remote = await configValue(`branch.${branch}.remote`, options);
    const destination = await configValue(`branch.${branch}.merge`, options);
    if (!destination) {
      const pushRemote = await configuredPushRemote(branch, options);
      return { remote: remote || pushRemote || await defaultRemote(options), destination: `refs/heads/${branch}` };
    }
    if (!remote || !destination.startsWith('refs/heads/')) throw new Error('当前上游分支配置无法安全解析。');
    await git(['remote', 'get-url', remote], options);
    return { remote, destination };
  }

  async function resolveSyncTarget(upstream, options) {
    let branch;
    try {
      branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], options)).stdout.trim();
    } catch {
      throw new Error('当前处于 detached HEAD，无法安全建立同步上游。');
    }

    if (upstream) {
      const remote = (await git(['config', '--get', `branch.${branch}.remote`], options)).stdout.trim();
      const destination = (await git(['config', '--get', `branch.${branch}.merge`], options)).stdout.trim();
      const trackingRef = (await git([
        'rev-parse', '--symbolic-full-name', '@{u}'
      ], options)).stdout.trim();
      if (!remote || !destination.startsWith('refs/heads/') || !trackingRef.startsWith('refs/remotes/')) {
        throw new Error('当前上游分支配置无法安全解析。');
      }
      await git(['remote', 'get-url', remote], options);
      await git(['fetch', '--no-tags', remote, `+${destination}:${trackingRef}`], options);
      return {
        branch,
        remote,
        destination,
        trackingRef,
        pullArgs: ['rebase', '--no-autostash', trackingRef],
        setUpstream: false
      };
    }

    const { remote, destination } = await untrackedDestination(branch, options);
    const trackingRef = `refs/remotes/${remote}/${destination.slice('refs/heads/'.length)}`;
    const exists = (await git([
      'ls-remote', '--heads', remote, destination
    ], options)).stdout.trim().length > 0;
    if (exists) {
      await git(['fetch', '--no-tags', remote, `+${destination}:${trackingRef}`], options);
    }

    return {
      branch,
      remote,
      destination,
      trackingRef: exists ? trackingRef : '',
      pullArgs: exists ? ['rebase', '--no-autostash', trackingRef] : null,
      setUpstream: true
    };
  }

  async function reviewRange(target, options) {
    const tip = await headSha(options);
    if (!tip) return { tip: '', base: '', commits: [], violations: [], bootstrap: false };
    // 远端分支还不存在时没有 base，推送等于用本地完整历史去创建这个分支 ——
    // 所以要检查的确实是整段历史，而不是某个区间。这一点是对的，但它意味着
    // 任何含普通笔记提交的 vault 都会在这里被拦下；调用方要能把这种情况和
    // 「区间里混进了非复习提交」区分开，否则报错会指向一个用户没犯的错。
    const bootstrap = !target.trackingRef;
    const base = bootstrap
      ? ''
      : (await git(['rev-parse', '--verify', target.trackingRef], options)).stdout.trim();
    const { commits, violations } = await validateOutgoing(base ? `${base}..${tip}` : tip, options);
    return { tip, base, commits, violations, bootstrap };
  }

  /** 远端分支缺失导致的拦截和「区间里混进非复习提交」不是同一回事，分开报。 */
  function blockedByOutgoing(range) {
    return range.bootstrap ? 'remote-branch-missing' : 'non-review-commits';
  }

  async function currentDeviceReviewPaths(device) {
    const reviewsDir = path.join(vaultDir, 'reviews');
    let entries;
    try {
      entries = await fs.readdir(reviewsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const escapedDevice = device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^\\d{4}-\\d{2}-${escapedDevice}\\.jsonl$`);
    const files = [];
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      if (await isRegularFile(entry, path.join(reviewsDir, entry.name))) files.push(`reviews/${entry.name}`);
    }
    return files.sort();
  }

  async function syncReviewLogsOnce(device, message, options) {
    if (!reviewSyncEnabled) return finish(reviewResult({ skipped: '复习同步未启用' }));
    if (!(await isRepo(options))) return finish(reviewResult({ skipped: 'vault 不是 git 仓库' }));
    const denied = await beginMutation('review-sync', options);
    if (denied) return finish(reviewResult(denied));

    let committed = false;
    let changed = false;
    let headBefore = '';
    try {
      const currentPattern = currentDeviceReviewPattern(device);

      const assertSafeStaging = async () => {
        const staged = await stagedPaths(options);
        if (staged.some(file => !isReviewPath(file))) {
          return reviewResult({ ok: false, blocked: 'staged-non-review' });
        }
        if (staged.some(file => currentPattern.test(file))) {
          return reviewResult({ ok: false, blocked: 'staged-current-review' });
        }
        return null;
      };

      const unsafeStaging = await assertSafeStaging();
      if (unsafeStaging) return finish(unsafeStaging);

      const remote = await hasRemote(options);
      const upstream = remote && await hasUpstream(options);
      const target = remote ? await resolveSyncTarget(upstream, options) : null;
      if (target) {
        const range = await reviewRange(target, options);
        if (range.violations.length > 0) {
          return finish(reviewResult({ ok: false, blocked: blockedByOutgoing(range) }));
        }
      }

      // 先把这台设备的复习日志提交掉，再决定要不要变基。
      //
      // 以前是带着未提交的修改直接 `rebase --autostash`：远端和本机改了同一篇笔记时，
      // 自动暂存弹回来会把冲突标记写进正文，留下一个只有未合并文件、应用里中止不了的
      // 现场。现在和周期同步一个规矩：不用 autostash；工作区还有别的未提交修改时，
      // 这一次只提交不推送，等下一轮完整同步先提交全部再变基。
      const reviewPaths = await currentDeviceReviewPaths(device);
      if (reviewPaths.length > 0) await git(['add', '--', ...reviewPaths], options);
      const selectedChanged = reviewPaths.length > 0 && (await git([
        'diff', '--cached', '--quiet', '--', ...reviewPaths
      ], options).then(() => false, error => {
        if (error.code === 1) return true;
        throw error;
      }));

      if (selectedChanged) {
        await git(['commit', '--only', '-m', message, '--', ...reviewPaths], options);
        committed = true;
      }

      if (target?.pullArgs && await hasHead(options)
          && !(await isAncestor(target.trackingRef, 'HEAD', options))) {
        if (await hasTrackedChanges(options)) {
          return finish(reviewResult({
            committed,
            deferred: 'local-changes',
            skipped: '本机还有未提交的修改，复习记录已在本机提交，下一轮完整同步时一起推送'
          }));
        }
        headBefore = await headSha(options);
        await pauseWrites(() => git(target.pullArgs, options));
        changed = headBefore !== await headSha(options);
      }
      const recovery = await detectRecovery(options);
      if (recovery) return finish(reviewResult({ ok: false, committed, changed, blocked: 'recovery-required', recovery }));

      const unsafeAfterPull = await assertSafeStaging();
      if (unsafeAfterPull) return finish({ ...unsafeAfterPull, committed, changed });

      if (!target || !(await hasHead(options))) {
        return finish(reviewResult({ committed, changed }));
      }

      const validated = await reviewRange(target, options);
      if (validated.violations.length > 0) {
        return finish(reviewResult({ ok: false, committed, changed, blocked: blockedByOutgoing(validated) }));
      }
      if (validated.commits.length === 0) {
        return finish(reviewResult({ committed, changed, skipped: '没有待推送的复习记录' }));
      }

      if (validated.base) {
        const fastForward = await isAncestor(validated.base, validated.tip, options);
        if (!fastForward) {
          return finish(reviewResult({
            ok: false,
            committed,
            changed,
            blocked: 'remote-history-diverged'
          }));
        }
      }

      // 复习只可推已经核验过的提交。用户指定了推送规则时，还须确认 Git
      // 算出的推送目标与刚核验的上游一致，否则交给完整同步处理。
      if (await hasPushPolicy(target.branch, target.remote, options, target.setUpstream && target.destination === `refs/heads/${target.branch}`)) {
        const localRef = `refs/heads/${target.branch}`;
        const pushRemote = await configuredPushRemote(target.branch, options)
          || await configValue(`branch.${target.branch}.remote`, options) || await defaultRemote(options);
        const blocked = `Git 推送设置未允许复习同步从本机 ${target.branch} 推到 ${target.remote}/${target.destination.slice('refs/heads/'.length)}`;
        if (pushRemote !== target.remote) throw new Error(blocked + '，请核对推送目标。');
        // 让 Git 自己解析 HEAD、通配符及 matching 等规则。预检无写入且不运行 pre-push 钩子。
        // 实际推送仍只发送已核验的 SHA，并用 lease 防止远端在预检后发生变化。
        let preview;
        try { preview = (await git(['push', '--dry-run', '--porcelain', '--no-verify', '--no-follow-tags'], options)).stdout; }
        catch (error) { throw new Error(blocked + '。\n' + String(error.stderr || error.message).trim(), { cause: error }); }
        const sources = [localRef, 'HEAD', validated.tip];
        const allowed = preview.split(/\r?\n/).some(row => {
          const [flag, refspec] = row.split('\t');
          return [' ', '*', '=', '+'].includes(flag) && sources.some(source => refspec === `${source}:${target.destination}`);
        });
        if (!allowed) throw new Error(blocked + '，请核对分支和推送设置。');
      }
      await beforeReviewPush({
        base: validated.base,
        tip: validated.tip,
        remote: target.remote,
        destination: target.destination
      });
      await git([
        'push', '--no-follow-tags',
        `--force-with-lease=${target.destination}:${validated.base}`,
        target.remote,
        `${validated.tip}:${target.destination}`
      ], options);
      if (target.setUpstream) {
        await git(['config', `branch.${target.branch}.remote`, target.remote], options);
        await git(['config', `branch.${target.branch}.merge`, target.destination], options);
      }
      return finish(reviewResult({ committed, pushed: true, changed }));
    } catch (error) {
      const errorMessage = String(error.stderr || error.message).trim();
      const recovery = await detectRecovery(options);
      // 变基停在半路时 HEAD 已经动了，调用方要据此重扫索引。
      if (headBefore) changed = headBefore !== await headSha(options);
      logger.warn(`[sync] 复习记录同步失败：${errorMessage}`);
      return finish(reviewResult({ ok: false, committed, changed, error: errorMessage, ...(recovery ? { recovery } : {}) }));
    }
  }

  function syncReviewLogs(device, message, options) {
    return enqueue(() => syncReviewLogsOnce(device, message, options));
  }

  async function commitAndPushOnce(message, options) {
    if (!enabled) return finish({ ok: true, skipped: '同步已关闭' });
    if (!(await isRepo(options))) return finish({ ok: true, skipped: 'vault 不是 git 仓库' });
    const denied = await beginMutation('commit-push', options);
    if (denied) return denied;

    try {
      // 游离 HEAD 上的提交不属于任何分支，下次切回分支就找不到了。
      const branch = await currentBranch(options);
      if (!branch && await hasHead(options)) {
        return finish({ ok: false, error: '资料库当前处于游离 HEAD（detached HEAD），没有提交。请在资料库目录用 git switch 切回一个分支后再同步。' });
      }
      let committed = false;
      if (await hasChanges(options)) {
        const outcome = await commitAll(message, options);
        if (outcome.recovery) return blocked(outcome.recovery);
        committed = outcome.committed;
      }

      if (!(await hasRemote(options))) return finish({ ok: true, committed, pushed: false });
      if (!(await hasHead(options))) return finish({ ok: true, committed: false, pushed: false });

      const upstream = await hasUpstream(options);
      if (upstream) {
        const remote = await configValue(`branch.${branch}.remote`, options);
        const destination = await configValue(`branch.${branch}.merge`, options);
        const named = destination.startsWith('refs/heads/') && destination !== `refs/heads/${branch}`
          && (await git(['remote'], options)).stdout.split(/\r?\n/).includes(remote);
        if (named && !await hasPushPolicy(branch, remote, options)) {
          await git(['push', remote, `HEAD:${destination}`], options);
        } else {
          try { await git(['push'], options); }
          catch (error) {
            if (!named) throw error;
            throw new Error(`推送失败（本机分支 ${branch}，上游 ${remote}/${destination.slice('refs/heads/'.length)}）。\n${String(error.stderr || error.message).trim()}`, { cause: error });
          }
        }
      } else {
        const { remote, destination } = await untrackedDestination(branch, options);
        if (await hasPushPolicy(branch, remote, options, destination === `refs/heads/${branch}`)) await git(['push'], options);
        else await git(['push', '-u', remote, `HEAD:${destination}`], options);
      }
      return finish({ ok: true, committed, pushed: true });
    } catch (error) {
      const message = String(error.stderr || error.message).trim();
      const recovery = await detectRecovery(options);
      logger.warn(`[sync] 提交或推送失败：${message}`);
      return finish({ ok: false, error: message, ...(recovery ? { recovery } : {}) });
    }
  }

  async function configValue(key, options) {
    try { return (await git(['config', '--get', key], options)).stdout.trim(); }
    catch (error) { if (error.code === 1) return ''; throw error; }
  }

  async function configuredPushRemote(branch, options) {
    return await configValue(`branch.${branch}.pushRemote`, options) || await configValue('remote.pushDefault', options);
  }

  async function hasPushPolicy(branch, remote, options, bootstrapSameName = false) {
    const keys = ['push.default', `remote.${remote}.push`, `branch.${branch}.pushRemote`, 'remote.pushDefault'];
    const values = await Promise.all(keys.map(key => configValue(key, options)));
    const [mode, ...routes] = values;
    // 首次建立同名上游仍支持显式的 simple/current。已有推送目标始终以 Git 配置为准。
    if (bootstrapSameName && ['simple', 'current'].includes(mode.toLowerCase())) return routes.some(Boolean);
    return values.some(Boolean);
  }

  function commitAndPush(message, options) {
    return enqueue(() => commitAndPushOnce(message, options));
  }

  function pull(options) {
    return enqueue(() => pullOnce(options));
  }

  async function headSha(options) {
    try {
      return (await git(['rev-parse', 'HEAD'], options)).stdout.trim();
    } catch {
      return '';
    }
  }

  async function cycleOnce(message, options) {
    if (!enabled) return finish({ ok: true, skipped: '同步已关闭' });
    const before = await headSha(options);
    const pulled = await pullOnce(options, message);
    const after = await headSha(options);
    if (pulled.ok === false) {
      return finish({
        ok: false,
        error: pulled.error || 'Git 拉取失败。',
        pulled,
        pushed: null,
        changed: before !== after,
        ...(pulled.recovery ? { recovery: pulled.recovery } : {})
      });
    }
    const pushed = await commitAndPushOnce(message, options);
    return finish({
      ok: pushed.ok !== false,
      ...(pushed.ok === false ? { error: pushed.error || 'Git 提交或推送失败。' } : {}),
      pulled,
      pushed,
      changed: before !== after,
      ...(pushed.recovery ? { recovery: pushed.recovery } : {})
    });
  }

  function cycle(message, options) {
    return enqueue(() => cycleOnce(message, options));
  }

  /**
   * 工作区里相对暂存区有改动、或处于未合并状态的已跟踪文本文件，连同当前内容。
   * 只管 .md 和 .jsonl：笔记、卡组、复习日志。二进制附件不在应用里编辑。
   */
  async function snapshotWorktreeEdits(options) {
    const { stdout } = await git(['status', '--porcelain=v1', '-z', '--untracked-files=no'], options);
    const fields = stdout.split('\0');
    const files = [];
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields[index];
      if (entry.length < 4) continue;
      const staged = entry[0];
      const worktree = entry[1];
      // 改名和复制后面多带一个原路径字段。
      if (staged === 'R' || staged === 'C') index += 1;
      const unmerged = staged === 'U' || worktree === 'U'
        || (staged === 'A' && worktree === 'A') || (staged === 'D' && worktree === 'D');
      if (!unmerged && staged === ' ' && worktree !== 'M' && worktree !== 'T') continue;
      const file = entry.slice(3);
      if (file.includes('\\')) throw userError('「' + file + '」路径包含反斜杠，无法安全自动处理；请用 Git 工具处理。');
      if (!/\.(md|jsonl)$/i.test(file)) continue;
      let stagedText;
      if (!unmerged && 'AMRCT'.includes(staged)) {
        stagedText = await blobText(':0:' + file, PRESERVE_MAX_BYTES, options);
        if (stagedText === null) throw userError('「' + file + '」的暂存版本超过备份大小上限，未中止 Git 操作。');
      }
      let content;
      try {
        const absolute = await ensureSafeFilePath(vaultDir, file, { allowMissing: true });
        const stat = await fs.lstat(absolute);
        if (!stat.isFile()) throw userError('无法安全备份「' + file + '」，未中止 Git 操作。');
        if (stat.size > PRESERVE_MAX_BYTES) throw userError('「' + file + '」超过备份大小上限，未中止 Git 操作。');
        content = await fs.readFile(absolute, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (stagedText !== undefined && stagedText !== content) {
        files.push({ path: file, content: stagedText, source: 'index' });
      }
      if (content !== undefined) files.push({ path: file, content, source: 'worktree' });
    }
    return files;
  }

  function isJsonLine(line) {
    try {
      const value = JSON.parse(line);
      return Boolean(value) && typeof value === 'object';
    } catch {
      return false;
    }
  }

  async function writeVaultText(file, content, mode = 0o600) {
    const absolute = await ensureSafeFilePath(vaultDir, file, { allowMissing: true, createParents: true });
    // 全部内容先落到独占临时文件；磁盘满或写入中断时保留原日志。
    if (mode > 0o777) await fs.access(absolute, fs.constants.W_OK);
    const temporary = absolute + '.tmp-' + randomUUID();
    try {
      const handle = await fs.open(temporary, 'wx', mode & 0o777);
      try {
        await handle.writeFile(content, 'utf8');
        if (mode > 0o777 && process.platform !== 'win32') await handle.chmod(mode & 0o777);
        await handle.sync();
      } finally { await handle.close(); }
      // 替换前再次校验，现有链接和不安全父路径一律拒绝。
      await ensureSafeFilePath(vaultDir, file, { allowMissing: true });
      await replaceFile(temporary, absolute);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async function restoreDiscardedEdits(snapshot, history) {
    const preserved = [];
    for (const item of snapshot) {
      // 暂存的旧日志单独留在快照中。自动补回复习事件时只采用用户最后看到的日志。
      if (item.source === 'index' && isReviewPath(item.path)) continue;
      try {
        const absolute = await ensureSafeFilePath(vaultDir, item.path, { allowMissing: true });
        let current = '';
        try {
          current = await fs.readFile(absolute, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (current === item.content) continue;
        if (isReviewPath(item.path)) {
          // 复习日志只追加、每台设备一个文件：把中止后少掉的行补回去就是完整的。
          const known = new Set(current.split(/\r?\n/));
          const missing = item.content.split(/\r?\n/).filter(line => line && !known.has(line) && isJsonLine(line));
          if (missing.length === 0) continue;
          const lead = current && !current.endsWith('\n') ? '\n' : '';
          await writeVaultText(item.path, `${current}${lead}${missing.join('\n')}\n`);
          preserved.push({ path: item.path, kind: 'review', count: missing.length });
        } else if (history.delete(item.path)) {
          // 同一文件的暂存和工作区版本可能都已存入历史，界面按文件计数。
          preserved.push({ path: item.path, kind: 'history' });
        }
      } catch (error) {
        throw new Error('中止后恢复「' + item.path + '」失败；内容已保存在本机 Git 中止备份中：' + error.message);
      }
    }
    return preserved;
  }

  async function abortOperationOnce(options) {
    const recovery = await detectRecovery(options);
    if (!recovery) return finish({ ok: true, skipped: '没有需要恢复的 Git 操作' });
    if (!recovery.abortable) return blocked(recovery);
    emitStatus({ phase: 'running', operation: 'abort', recovery });
    const commands = {
      rebase: ['rebase', '--abort'],
      merge: ['merge', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      revert: ['revert', '--abort']
    };
    let aborted = false;
    let backupPath = '';
    try {
      // 中止等于硬重置：冲突期间保存过的笔记、评过的卡，只要还没提交就会被丢掉。
      // 所以先把这些文件读出来，中止后把复习记录补回去、笔记和卡组另存进本机历史。
      // 读、中止、补回都在写入闸门里，期间没有别的写入插进来。
      const preserved = await pauseWrites(async () => {
        const snapshot = await snapshotWorktreeEdits(options);
        // Git 撤掉工作区之前先落盘，备份失败就保留现场。
        // 整份快照也保留复习日志，以便恢复写入失败或进程中断后手工找回。
        if (snapshot.length) {
          const ignore = await ensureSafeFilePath(vaultDir, '.workstation-local/.gitignore', { allowMissing: true, createParents: true });
          try { await fs.writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          backupPath = '.workstation-local/git-abort/' + randomUUID() + '.json';
          const backup = await ensureSafeFilePath(vaultDir, backupPath, { allowMissing: true, createParents: true });
          const handle = await fs.open(backup, 'wx', 0o600);
          try {
            await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), files: snapshot }));
            await handle.sync();
          } finally { await handle.close(); }
        }
        const history = new Set();
        for (const item of snapshot) {
          if (!isReviewPath(item.path) && await preserveDiscarded({ path: item.path, content: item.content })) {
            history.add(item.path);
          }
        }
        await git(commands[recovery.kind], options);
        aborted = true;
        return restoreDiscardedEdits(snapshot, history);
      });
      const remaining = await detectRecovery(options);
      if (remaining) return blocked(remaining);
      return finish({ ok: true, aborted: recovery.kind, preserved });
    } catch (error) {
      const message = String(error.stderr || error.message).trim();
      const remaining = await detectRecovery(options);
      logger.warn('[sync] 中止操作未能完整完成：' + message);
      return finish({ ok: false, error: message, ...(remaining ? { recovery: remaining } : {}),
        ...(aborted ? { aborted: recovery.kind } : {}), ...(backupPath ? { backupPath } : {}) });
    }
  }

  function abortOperation(options) {
    return enqueue(() => abortOperationOnce(options));
  }

  /**
   * 冲突时索引里一个文件有两到三份：1 是共同祖先，2 是「ours」，3 是「theirs」。
   * 变基是把本机提交挪到远端之上重放，所以 ours 是远端、theirs 是本机；合并正好反过来。
   * 应用自己只会变基；合并是在外面用 Git 手工拉取留下的，一样能选。其他状态
   * （cherry-pick、revert、只剩未合并条目）分不清哪边是哪边，不在应用里选。
   */
  function conflictSides(kind) {
    if (kind === 'rebase') return { remote: 2, local: 3 };
    if (kind === 'merge') return { local: 2, remote: 3 };
    return null;
  }

  async function unmergedEntries(options) {
    const { stdout } = await git(['ls-files', '-u', '-z'], options);
    const entries = new Map();
    for (const line of stdout.split('\0')) {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
      if (!match) continue;
      const file = match[4];
      if (file.includes('\\')) throw userError('「' + file + '」路径包含反斜杠，无法安全自动处理；请用 Git 工具处理。');
      if (!entries.has(file)) entries.set(file, { modes: {} });
      entries.get(file)[Number(match[3])] = match[2];
      entries.get(file).modes[Number(match[3])] = match[1];
    }
    return entries;
  }

  // 单独的等号行也是 Markdown 标题。首尾或 diff3 祖先标记的长度由文件属性决定。
  async function conflictMarkerLine(file, text, options) {
    const attribute = await git(['check-attr', '-z', 'conflict-marker-size', '--', file], options);
    const configured = Number.parseInt(attribute.stdout.split('\0')[2], 10);
    const size = configured > 0 ? configured : 7;
    for (const match of text.matchAll(/^(<+|>+|\|+)(?=[ \t]|\r?$)/gm)) {
      if (match[1].length >= size) return text.slice(0, match.index).split(/\r\n?|\n/).length;
    }
    return 0;
  }

  // UTF-8 解码会悄悄替换无效字节，无法从这样的历史记录恢复原件。
  function decodeText(bytes) {
    if (!isUtf8(bytes)) throw userError('文件包含无效的 UTF-8 字节，无法完整保存文本历史。请用 Git 工具处理。');
    return bytes.toString('utf8');
  }

  async function blobText(sha, limit, options) {
    if (!sha) return null;
    const size = Number((await git(['cat-file', '-s', sha], options)).stdout.trim());
    if (!Number.isFinite(size) || size > limit) return null;
    return decodeText((await git(['cat-file', 'blob', sha], { ...options, encoding: 'buffer' })).stdout);
  }

  async function worktreeText(file, limit) {
    try {
      const absolute = await ensureSafeFilePath(vaultDir, file, { allowMissing: true });
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.size > limit) return null;
      return decodeText(await fs.readFile(absolute));
    } catch {
      return null;
    }
  }

  function trimHunks(result) {
    let rows = 0;
    const hunks = [];
    for (const hunk of result.hunks) {
      if (hunk.type === 'skip') { hunks.push(hunk); continue; }
      const room = CONFLICT_DIFF_MAX_ROWS - rows;
      if (room <= 0) break;
      hunks.push(hunk.rows.length > room ? { type: 'lines', rows: hunk.rows.slice(0, room) } : hunk);
      rows += Math.min(hunk.rows.length, room);
    }
    const total = result.hunks.reduce((sum, hunk) => sum + (hunk.type === 'lines' ? hunk.rows.length : 0), 0);
    return { added: result.added, removed: result.removed, hunks, truncated: total > rows };
  }

  /** 现在卡在冲突里的文件，连同两边各自有没有这个文件、差在哪里。只读，不改任何东西。 */
  async function listConflictsOnce(options) {
    const recovery = await detectRecovery(options);
    if (!recovery) return { ok: true, recovery: null, resolvable: false, files: [] };
    const sides = conflictSides(recovery.kind);
    const entries = await unmergedEntries(options);
    const files = [];
    for (const [file, stages] of entries) {
      const item = {
        path: file,
        // 复习日志只追加：两边的记录都要，不用选。
        auto: isReviewPath(file) ? 'union' : '',
        remote: Boolean(sides && stages[sides.remote]),
        local: Boolean(sides && stages[sides.local]),
        current: false,
        diff: null
      };
      if (sides && !item.auto && CONFLICT_TEXT_FILE.test(file)) {
        // 已经在编辑器里手工合并好（文件里没有冲突标记了）的，可以直接保留现在的内容。
        if (item.remote && item.local) {
          const current = await worktreeText(file, PRESERVE_MAX_BYTES);
          item.markerLine = current === null ? 0 : await conflictMarkerLine(file, current, options);
          item.current = current !== null && !item.markerLine;
          try {
            const [remote, local] = await Promise.all([
              blobText(stages[sides.remote], CONFLICT_DIFF_MAX_BYTES, options),
              blobText(stages[sides.local], CONFLICT_DIFF_MAX_BYTES, options)
            ]);
            if (remote !== null && local !== null) {
              const result = compareText(remote, local);
              if (!result.tooLarge) item.diff = trimHunks(result);
            }
          } catch { /* 差异只是帮人判断用的，读不出来不挡选择。 */ }
        }
      }
      files.push(item);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { ok: true, recovery, resolvable: Boolean(sides) && files.length > 0, files };
  }

  function listConflicts(options) {
    return enqueue(() => listConflictsOnce(options));
  }

  function userError(message) {
    return Object.assign(new Error(message), { userFacing: true });
  }

  async function resolveReviewLog(file, stages, options) {
    // 不能把超限/读失败当成空日志，也不能把 Git 中的符号链接当 JSONL 合并。
    if (Object.values(stages.modes).some(mode => mode !== '100644' && mode !== '100755')) {
      throw userError('「' + file + '」包含非普通文件，未合并；请用 Git 工具处理。');
    }
    const absolute = await ensureSafeFilePath(vaultDir, file, { allowMissing: true });
    let current = null;
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PRESERVE_MAX_BYTES) {
        throw userError('「' + file + '」无法完整安全读取，未合并；请用 Git 工具处理。');
      }
      current = await fs.readFile(absolute, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const sources = [];
    for (const stage of [2, 3]) {
      if (!stages[stage]) continue; // 这一边确实删除了文件。
      const content = await blobText(stages[stage], PRESERVE_MAX_BYTES, options);
      if (content === null) throw userError('「' + file + '」超过自动合并大小上限，未合并；请用 Git 工具处理。');
      sources.push(content);
    }
    if (current !== null) sources.push(current);
    const seen = new Set();
    const lines = [];
    for (const source of sources) {
      for (const line of source.split(/\r?\n/)) {
        if (!line || seen.has(line) || !isJsonLine(line)) continue;
        seen.add(line);
        lines.push(line);
      }
    }
    await writeVaultText(file, lines.length ? lines.join('\n') + '\n' : '');
  }

  async function resolveConflictsOnce(choices, options = {}) {
    const recovery = await detectRecovery(options);
    if (!recovery) return finish({ ok: true, skipped: '没有需要处理的冲突' });
    const sides = conflictSides(recovery.kind);
    if (!sides) {
      const result = { ok: false, error: '这种 Git 状态分不清哪边是远端、哪边是本机，不能在应用里选；请用 Git 工具处理，或者中止当前操作。', recovery };
      emitStatus({ phase: 'recovery-required', operation: '', recovery, lastResult: result });
      return result;
    }
    const wanted = choices && typeof choices === 'object' ? choices : {};
    emitStatus({ phase: 'running', operation: 'resolve', recovery });
    // 路径原样交给 Git：文件名里的 * ? [ 不当通配符。
    const literal = { ...options, env: { ...(options.env || {}), GIT_LITERAL_PATHSPECS: '1', GIT_EDITOR: 'true' } };
    let resolved = 0;
    const preserved = [];
    try {
      await pauseWrites(async () => {
        const entries = await unmergedEntries(options);
        for (const file of entries.keys()) {
          if (isReviewPath(file)) continue;
          if (!['remote', 'local', 'current'].includes(wanted[file])) throw userError(`还没有选「${file}」保留哪一边。`);
        }
        for (const [file, stages] of entries) {
          if (isReviewPath(file)) {
            await resolveReviewLog(file, stages, options);
            await git(['add', '--', file], literal);
            resolved += 1;
            continue;
          }
          const choice = wanted[file];
          const current = await worktreeText(file, PRESERVE_MAX_BYTES);
          if (choice === 'current') {
            if (current === null) throw userError(`「${file}」现在不在资料库里，不能按现在的内容保留。`);
            const line = await conflictMarkerLine(file, current, options);
            if (line) throw userError(`「${file}」第 ${line} 行还有冲突标记，请先处理后再继续。`);
          }
          const keep = choice === 'current' ? null : stages[sides[choice]];
          const drop = stages[sides[choice === 'remote' ? 'local' : 'remote']];
          // 没采用的那一边、以及手工改到一半的现有内容，先存进本机历史再覆盖。
          if (/^(?:notes|cards)\//.test(file) && /\.md$/i.test(file)) {
            if (Object.values(stages.modes).some(mode => mode !== '100644' && mode !== '100755')) {
              throw userError('「' + file + '」包含非普通文件，未覆盖；请用 Git 工具处理。');
            }
            if (current === null) {
              try {
                const absolute = await ensureSafeFilePath(vaultDir, file, { allowMissing: true });
                await fs.lstat(absolute);
                throw userError('「' + file + '」无法完整安全备份，未覆盖；请用 Git 工具处理。');
              } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            const requiredBlob = async sha => {
              if (!sha) return null;
              const content = await blobText(sha, PRESERVE_MAX_BYTES, options);
              if (content === null) throw userError('「' + file + '」超过自动备份大小上限，未覆盖；请用 Git 工具处理。');
              return content;
            };
            const kept = choice === 'current' ? current : await requiredBlob(keep);
            const otherVersions = choice === 'current'
              ? [await requiredBlob(stages[2]), await requiredBlob(stages[3])]
              : [await requiredBlob(drop)];
            const snapshots = new Set(otherVersions.filter(content => content !== null && content !== kept));
            // 保留编辑器里看到的完整现场，即使它与所选的一边相同。
            if (choice !== 'current' && current !== null) snapshots.add(current);
            for (const content of snapshots) {
              if (!await preserveDiscarded({ path: file, content, reason: 'conflict' })) {
                throw userError(`「${file}」未能存入本机历史，未覆盖。请用 Git 工具处理。`);
              }
              if (!preserved.some(item => item.path === file)) preserved.push({ path: file, kind: 'history' });
            }
          } else if (choice !== 'current') {
            const backupPath = await saveConflictCopy(vaultDir, file);
            if (backupPath) preserved.push({ path: file, kind: 'file', backupPath });
          }
          if (choice === 'current') {
            await git(['add', '--', file], literal);
            resolved += 1;
            continue;
          }
          if (keep) {
            await git(['checkout', sides[choice] === 2 ? '--ours' : '--theirs', '--', file], literal);
            await git(['add', '--', file], literal);
          } else {
            // 保留的那一边已经删了这个文件。
            await git(['rm', '-f', '-q', '--', file], literal);
          }
          resolved += 1;
        }
        // 冲突期间保存过的别的笔记还没暂存，Git 会因此拒绝继续；它们本来就要进下一次提交。
        await git(['add', '-A'], options);
        if (recovery.kind === 'rebase') {
          try {
            await git(['rebase', '--continue'], literal);
          } catch (error) {
            const after = await detectRecovery(options);
            // 重放下一个本机提交时又遇到冲突：停在那里，由调用方报告「还有」。
            if (!after || after.unmergedCount > 0) return;
            // 全部采用远端后，这一个本机提交就没有内容了；有的 Git 版本要显式跳过。
            if (after.kind !== 'rebase' || await hasStagedChanges(options)) throw error;
            try {
              await git(['rebase', '--skip'], literal);
            } catch (skipError) {
              const later = await detectRecovery(options);
              if (later && later.unmergedCount === 0) throw skipError;
            }
          }
        } else {
          await git(['commit', '--no-edit', '--allow-empty'], literal);
        }
      });
      const remaining = await detectRecovery(options);
      // 本机有好几个提交没推时，重放下一个提交可能又遇到冲突：停在那里，再选一次。
      if (remaining) return finish({ ok: true, resolved, preserved, more: true, recovery: remaining });
      return finish({ ok: true, resolved, preserved, continued: recovery.kind });
    } catch (error) {
      const message = error.userFacing ? error.message : String(error.stderr || error.message).trim();
      const remaining = await detectRecovery(options);
      if (!error.userFacing) logger.warn(`[sync] 解决冲突失败：${message}`);
      return finish({ ok: false, error: message, resolved, preserved, ...(remaining ? { recovery: remaining } : {}) });
    }
  }

  async function hasStagedChanges(options) {
    try {
      await git(['diff', '--cached', '--quiet'], options);
      return false;
    } catch {
      return true;
    }
  }

  function resolveConflicts(choices, options) {
    return enqueue(() => resolveConflictsOnce(choices, options));
  }

  function idle() {
    return queue;
  }

  return {
    status,
    probe,
    getStatus,
    onStatus,
    pull,
    cycle,
    commitAndPush,
    syncReviewLogs,
    abortOperation,
    listConflicts,
    resolveConflicts,
    ensureGitignore,
    ensureGitattributes,
    idle,
    cancel: () => {
      cancelledThrough = enqueued;
      cancellation.abort();
    },
    isRepo,
    hasRemote,
    hasChanges,
    hasUpstream,
    detectRecovery
  };
}

module.exports = { createSync, VAULT_GITIGNORE, VAULT_GITATTRIBUTES, renderGitignore, removeLegacyMediaIgnores };
