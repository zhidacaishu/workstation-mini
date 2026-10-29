const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

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

function createSync({
  vaultDir,
  logger = console,
  timeoutMs = 60_000,
  enabled = true,
  reviewSyncEnabled = false,
  beforeReviewPush = async () => {},
  // 会改工作区文件的本地 Git 操作（变基、冲突处理）在这里面跑，期间暂停笔记写入。
  pauseWrites = operation => operation()
}) {
  const cancellation = new AbortController();
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
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function git(args, options = {}) {
    // 后台同步没有终端可以回答提示：账号密码提示会一直挂到超时。HTTP 连接卡住
    // （代理坏了、网络时断时续）时用低速限制尽早放弃，而不是每条命令都等满 60 秒。
    return run('git', [
      '-C', vaultDir,
      '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20',
      ...args
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
      signal: cancellation.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env || {}) }
    });
  }

  async function isRepo(options) {
    try {
      const { stdout } = await git(['rev-parse', '--is-inside-work-tree'], options);
      return stdout.trim() === 'true';
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
    const { stdout } = await git(['status', '--porcelain'], options);
    return stdout.trim().length > 0;
  }

  async function hasUpstream(options) {
    try {
      await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], options);
      return true;
    } catch {
      return false;
    }
  }

  async function gitPath(name, options) {
    const { stdout } = await git(['rev-parse', '--git-path', name], options);
    const value = stdout.trim();
    return path.isAbsolute(value) ? value : path.resolve(vaultDir, value);
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
    for (const [candidate, marker] of markers) {
      if (await pathExists(await gitPath(marker, options))) {
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
    const gitignorePath = path.join(vaultDir, '.gitignore');
    try {
      let existing = '';
      try {
        existing = await fs.readFile(gitignorePath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.writeFile(gitignorePath, renderGitignore(BASE_IGNORE_RULES), 'utf8');
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
      await fs.writeFile(gitignorePath, next, 'utf8');

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
    const attributesPath = path.join(vaultDir, '.gitattributes');
    try {
      let existing;
      try {
        existing = await fs.readFile(attributesPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.writeFile(attributesPath, VAULT_GITATTRIBUTES, 'utf8');
        return finish({ ok: true, created: true });
      }
      const present = new Set(existing.split(/\r?\n/).map(line => line.trim().replace(/\s+/g, ' ')));
      const missing = ATTRIBUTE_RULES.filter(rule => !present.has(rule));
      if (missing.length === 0) return finish({ ok: true, unchanged: true });
      const newline = existing.includes('\r\n') ? '\r\n' : '\n';
      const lead = existing && !existing.endsWith('\n') ? newline : '';
      await fs.writeFile(attributesPath, `${existing}${lead}${missing.join(newline)}${newline}`, 'utf8');
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
    if (!(await hasUpstream(options))) return finish({ ok: true, skipped: '尚未建立上游分支' });

    try {
      if (await hasChanges(options)) {
        // 单独的拉取（启动时那一次）不替用户提交：跳过，下一轮完整同步时一起处理。
        if (!message) return finish({ ok: true, skipped: '本机有未提交的修改，下一轮同步时先提交再拉取' });
        await git(['add', '-A'], options);
        const recovery = await detectRecovery(options);
        if (recovery) return blocked(recovery);
        await git(['commit', '-m', message], options);
      }
      // 拉取拆成两步：联网的 fetch 不挡笔记保存；改工作区的变基期间暂停写入。
      await git(['fetch', '--quiet'], options);
      await pauseWrites(() => git(['rebase', '--no-autostash', '@{u}'], options));
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

  async function resolveReviewTarget(upstream, options) {
    let branch;
    try {
      branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], options)).stdout.trim();
    } catch {
      throw new Error('当前处于 detached HEAD，无法安全建立复习同步上游。');
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
        pullArgs: ['rebase', '--autostash', trackingRef],
        setUpstream: false
      };
    }

    const remote = await defaultRemote(options);
    await git(['remote', 'get-url', remote], options);
    const destination = `refs/heads/${branch}`;
    const trackingRef = `refs/remotes/${remote}/${branch}`;
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
      pullArgs: exists ? ['rebase', '--autostash', trackingRef] : null,
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
    return entries
      .filter(entry => entry.isFile() && pattern.test(entry.name))
      .map(entry => `reviews/${entry.name}`)
      .sort();
  }

  async function syncReviewLogsOnce(device, message, options) {
    if (!reviewSyncEnabled) return finish(reviewResult({ skipped: '复习同步未启用' }));
    if (!(await isRepo(options))) return finish(reviewResult({ skipped: 'vault 不是 git 仓库' }));
    const denied = await beginMutation('review-sync', options);
    if (denied) return finish(reviewResult(denied));

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
      const target = remote ? await resolveReviewTarget(upstream, options) : null;
      if (target) {
        const range = await reviewRange(target, options);
        if (range.violations.length > 0) {
          return finish(reviewResult({ ok: false, blocked: blockedByOutgoing(range) }));
        }
      }

      const before = await headSha(options);
      if (target?.pullArgs) await pauseWrites(() => git(target.pullArgs, options));
      const after = await headSha(options);
      const changed = before !== after;
      const recovery = await detectRecovery(options);
      if (recovery) return finish(reviewResult({ ok: false, changed, blocked: 'recovery-required', recovery }));

      const unsafeAfterPull = await assertSafeStaging();
      if (unsafeAfterPull) return finish({ ...unsafeAfterPull, changed });

      const reviewPaths = await currentDeviceReviewPaths(device);
      if (reviewPaths.length > 0) await git(['add', '--', ...reviewPaths], options);
      const selectedChanged = reviewPaths.length > 0 && (await git([
        'diff', '--cached', '--quiet', '--', ...reviewPaths
      ], options).then(() => false, error => {
        if (error.code === 1) return true;
        throw error;
      }));

      let committed = false;
      if (selectedChanged) {
        await git(['commit', '--only', '-m', message, '--', ...reviewPaths], options);
        committed = true;
      }

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
        const fastForward = await git([
          'merge-base', '--is-ancestor', validated.base, validated.tip
        ], options).then(() => true, error => {
          if (error.code === 1) return false;
          throw error;
        });
        if (!fastForward) {
          return finish(reviewResult({
            ok: false,
            committed,
            changed,
            blocked: 'remote-history-diverged'
          }));
        }
      }

      await beforeReviewPush({
        base: validated.base,
        tip: validated.tip,
        remote: target.remote,
        destination: target.destination
      });
      await git([
        'push',
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
      logger.warn(`[sync] 复习记录同步失败：${errorMessage}`);
      return finish(reviewResult({ ok: false, error: errorMessage, ...(recovery ? { recovery } : {}) }));
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
      const changed = await hasChanges(options);
      if (changed) {
        await git(['add', '-A'], options);
        const recovery = await detectRecovery(options);
        if (recovery) return blocked(recovery);
        await git(['commit', '-m', message], options);
      }

      if (!(await hasRemote(options))) return finish({ ok: true, committed: changed, pushed: false });
      if (!(await hasHead(options))) return finish({ ok: true, committed: false, pushed: false });

      // 没有上游时才需要挑远端；有上游就交给 git 自己按 tracking 配置走。
      // 这里过去写死 origin，和 defaultRemote 的判断对不上 —— 同一个 vault 上
      // 复习记录能推出去、常规提交却报「'origin' does not appear to be a git
      // repository」，而用户并没有配错任何东西。
      const push = (await hasUpstream(options))
        ? ['push']
        : ['push', '-u', await defaultRemote(options), 'HEAD'];
      await git(push, options);
      return finish({ ok: true, committed: changed, pushed: true });
    } catch (error) {
      const message = String(error.stderr || error.message).trim();
      const recovery = await detectRecovery(options);
      logger.warn(`[sync] 提交或推送失败：${message}`);
      return finish({ ok: false, error: message, ...(recovery ? { recovery } : {}) });
    }
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
    try {
      await pauseWrites(() => git(commands[recovery.kind], options));
      const remaining = await detectRecovery(options);
      if (remaining) return blocked(remaining);
      return finish({ ok: true, aborted: recovery.kind });
    } catch (error) {
      const message = String(error.stderr || error.message).trim();
      const remaining = await detectRecovery(options) || recovery;
      logger.warn(`[sync] 中止 ${recovery.kind} 失败：${message}`);
      return finish({ ok: false, error: message, recovery: remaining });
    }
  }

  function abortOperation(options) {
    return enqueue(() => abortOperationOnce(options));
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
    ensureGitignore,
    ensureGitattributes,
    idle,
    cancel: () => cancellation.abort(),
    isRepo,
    hasRemote,
    hasChanges,
    hasUpstream,
    detectRecovery
  };
}

module.exports = { createSync, VAULT_GITIGNORE, VAULT_GITATTRIBUTES, renderGitignore, removeLegacyMediaIgnores };
