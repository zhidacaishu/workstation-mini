const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { normalizeDeviceName } = require('../config');
const { openDatabase } = require('../db');
const { isSafeRelativePath } = require('../vault/paths');
const { createIndexer } = require('../vault/indexer');
const { createGitRecovery } = require('./git');
const { createOwnedStaging } = require('./journal');
const { renameExclusive } = require('./rename-exclusive');

const EXCLUDED_ROOT_FILES = new Set([
  'workstation.db',
  'workstation.db-wal',
  'workstation.db-shm',
  'workstation.db-corrupt'
]);
const PUBLIC_LIMIT = 50;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return {
    sessionId: '',
    mode: 'restore',
    source: null,
    destination: null,
    phase: 'idle',
    outcome: null,
    progress: { current: 0, total: 0, unit: 'files', currentPath: '' },
    warnings: [],
    indexFailures: [],
    indexFailureTotal: 0,
    indexFailuresTruncated: false,
    residue: null,
    canCancel: false,
    canRetry: false,
    canActivate: false,
    error: null
  };
}

function validDirectoryName(value) {
  const name = String(value || '').trim();
  if (name.length > 120 || !isSafeRelativePath(name) || name !== path.basename(name)) {
    throw new Error('新资料库目录名不合法。');
  }
  return name;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 是不是同一个目录。只比 dev + ino 不够：删掉再新建一个目录，ext4 等文件系统会把
 * 刚释放的 inode 号直接给新目录用。能拿到创建时间的平台上再比一次创建时间。
 */
function sameIdentity(left, right) {
  const born = value => Number(value?.birthtimeMs) || 0;
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.dev !== 0 || left.ino !== 0)
    && (!born(left) || !born(right) || born(left) === born(right)));
}

async function validateVaultRoot(vaultDir, { scanSymlinks = false } = {}) {
  const root = await fsp.lstat(vaultDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('所选来源不是普通资料库目录。');
  const notes = await fsp.lstat(path.join(vaultDir, 'notes'));
  if (!notes.isDirectory() || notes.isSymbolicLink()) throw new Error('资料库缺少普通 notes 目录。');
  if (scanSymlinks) {
    const stack = [vaultDir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        const relative = path.relative(vaultDir, path.join(current, entry.name));
        if (entry.isSymbolicLink()) throw new Error(`资料库包含符号链接：${relative}`);
        if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      }
    }
  }
  const gitPath = path.join(vaultDir, '.git');
  try {
    const gitEntry = await fsp.lstat(gitPath);
    if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
      throw new Error('资料库的 .git 不是普通目录。');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

async function copyVault(source, target, { signal, onProgress } = {}) {
  let copied = 0;
  async function walk(from, to, relative = '') {
    signal?.throwIfAborted();
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`备份包含符号链接，未复制：${nextRelative}`);
      if (!relative && EXCLUDED_ROOT_FILES.has(entry.name)) continue;
      if (/\.tmp-/.test(entry.name)) continue;
      const sourcePath = path.join(from, entry.name);
      const targetPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await walk(sourcePath, targetPath, nextRelative);
      } else if (entry.isFile()) {
        await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        copied += 1;
        onProgress?.({ current: copied, total: 0, unit: 'files', currentPath: nextRelative });
      }
    }
  }
  await walk(source, target);
  return { copied };
}

function safeFailure(error, stage) {
  const code = error?.code || (error?.name === 'AbortError' ? 'cancelled' : `${stage}-failed`);
  const messages = {
    cancelled: '恢复已取消。',
    'authentication-failed': '无法使用系统 Git 凭据访问远端。',
    'remote-not-found': 'Git 远端不存在或当前身份无权访问。',
    'invalid-remote': 'Git 远端地址不合法。',
    'incomplete-repository': '备份的 Git 历史不完整。请从完整的本地备份或远端恢复。',
    'shared-object-store': '备份使用了共享 Git 对象库。请先制作含完整 Git 历史的独立备份。',
    'repository-credentials': '备份含仓库级凭据配置，未继续恢复。',
    'index-failed': '无法从 Markdown 建立索引。',
    'activation-validation-failed': '恢复候选目录在激活前发生变化。',
    'activation-failed': '新资料库未能在当前进程中打开。'
  };
  return {
    stage,
    code,
    message: messages[code] || '恢复操作失败。',
    remediation: code === 'activation-failed'
      ? '新目录已保留；请从首次启动或设置中选择现有资料库后重试。'
      : code === 'activation-validation-failed'
        ? '候选目录不再可信；请保留现状并重新开始恢复。'
        : stage === 'git'
          ? '请先在系统 Git 客户端中确认登录或 SSH agent。'
          : '请检查来源、目标磁盘和错误阶段后重试。',
    retryable: ![
      'repository-credentials',
      'activation-failed',
      'activation-validation-failed'
    ].includes(code),
    partial: false
  };
}

function indexPublic(status) {
  const failures = Array.isArray(status?.failures) ? status.failures : [];
  return {
    failures: failures.slice(0, PUBLIC_LIMIT).map(item => ({
      path: String(item.path || ''),
      code: String(item.code || 'invalid-note'),
      reason: String(item.reason || '笔记无法索引。')
    })),
    total: Number(status?.failureTotal ?? failures.length) || 0
  };
}

function createRecoveryService({
  journal,
  git = createGitRecovery(),
  openDb = openDatabase,
  createIndex = createIndexer,
  renameIntoPlace = renameExclusive,
  now = () => new Date().toISOString()
} = {}) {
  if (!journal) throw new Error('恢复服务缺少 journal。');
  let state = emptyState();
  let session = null;
  const operations = new Set();
  const listeners = new Set();

  function emit(patch) {
    state = { ...state, ...patch };
    const snapshot = getState();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
    return snapshot;
  }

  function getState() {
    return clone(state);
  }

  function onState(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function track(work) {
    const next = Promise.resolve().then(work);
    operations.add(next);
    next.finally(() => operations.delete(next)).catch(() => {});
    return next;
  }

  function selectable() {
    return operations.size === 0
      && ['idle', 'cancelled', 'failed'].includes(state.phase)
      && !session?.stagingRoot;
  }

  function assertNoOperation() {
    if (operations.size) throw new Error('已有恢复操作正在进行。');
  }

  function selectLocalSource(sourcePath) {
    if (!selectable()) throw new Error('当前不能选择恢复来源。');
    session ||= {};
    session.localSource = path.resolve(sourcePath);
    emit({ source: { kind: 'local', display: session.localSource } });
    return getState();
  }

  function selectDestinationParent(parentPath) {
    if (!selectable()) throw new Error('当前不能选择恢复目标。');
    session ||= {};
    session.destinationParent = path.resolve(parentPath);
    return getState();
  }

  async function inspectRemoteInternal(remote, options) {
    if (!['idle', 'failed', 'cancelled'].includes(state.phase)
      || session?.stagingRoot) throw new Error('当前不能检查 Git 远端。');
    emit({ phase: 'inspecting-source', canCancel: true, canRetry: false, error: null });
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    session = { ...(session || {}), remote, controller };
    try {
      const result = await git.inspectRemote(remote, { signal });
      emit({ phase: 'idle', source: { kind: 'git', display: result.display }, canCancel: false });
      return result;
    } catch (error) {
      const cancelled = signal.aborted || error?.code === 'cancelled';
      emit({
        phase: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : safeFailure(error, 'git'),
        canCancel: false,
        canRetry: false
      });
      throw error;
    }
  }

  function inspectRemote(remote, options = {}) {
    assertNoOperation();
    return track(() => inspectRemoteInternal(remote, options));
  }

  async function checkDeviceCollision(vaultDir, device) {
    const suffix = `-${normalizeDeviceName(device)}.jsonl`;
    const stack = [path.join(vaultDir, 'reviews')];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(path.join(current, entry.name));
        else if (entry.isFile() && entry.name.endsWith(suffix)) {
          return [{
            code: 'device-name-collision',
            message: '恢复资料中已有相同设备名的事件日志，请在启用同步前检查。'
          }];
        }
      }
    }
    return [];
  }

  // 只是验证恢复出来的笔记能完整建索引。正式运行时索引放在应用数据目录，
  // 验证完就把这份临时索引删掉，不在资料库里留文件。
  async function buildIndex(candidatePath) {
    const dbPath = path.join(candidatePath, 'workstation.db');
    const removeIndex = () => Promise.all(['', '-wal', '-shm'].map(suffix => fsp.rm(`${dbPath}${suffix}`, { force: true })));
    await removeIndex();
    const db = openDb(dbPath);
    try {
      const indexer = createIndex({ db, vaultDir: path.join(candidatePath, 'notes') });
      await indexer.scan({ force: true, kind: 'initial' });
      return typeof indexer.getStatus === 'function'
        ? indexer.getStatus()
        : { phase: 'ready', failures: [], failureTotal: 0 };
    } finally {
      db.close();
      await removeIndex().catch(() => {});
    }
  }

  function start(options = {}) {
    if (!selectable()) throw new Error('已有恢复操作或残留尚未处理。');
    return track(() => runRestore(options));
  }

  async function runRestore(options) {
    if (Object.hasOwn(options, 'restoreBlobs')) {
      throw new Error('Mini 不支持远端大文件恢复。');
    }
    const sourceKind = options.sourceKind;
    if (!session?.destinationParent) throw new Error('请先选择目标父目录。');
    const destinationParent = session.destinationParent;
    const parentStats = await fsp.stat(destinationParent);
    if (!parentStats.isDirectory()) throw new Error('所选恢复目标不是目录。');
    const directoryName = validDirectoryName(options.directoryName);
    const destinationPath = path.join(destinationParent, directoryName);
    const sourcePath = sourceKind === 'local' ? session.localSource : '';
    if (await exists(destinationPath)) throw new Error('目标资料库目录已经存在。');

    if (sourceKind === 'local') {
      if (!sourcePath) throw new Error('请先选择本地备份。');
      await validateVaultRoot(sourcePath);
      const [sourceReal, parentReal] = await Promise.all([
        fsp.realpath(sourcePath),
        fsp.realpath(destinationParent)
      ]);
      const destinationReal = path.join(parentReal, directoryName);
      if (inside(sourceReal, destinationReal) || inside(destinationReal, sourceReal)) {
        throw new Error('来源和目标目录不能相同或互相嵌套。');
      }
    } else if (sourceKind === 'git') {
      if (!session.remote || state.source?.kind !== 'git') throw new Error('请先检查 Git 远端。');
      if (options.remote && options.remote !== session.remote) throw new Error('Git 远端与已检查的地址不一致。');
    } else {
      throw new Error('未知恢复来源。');
    }

    const selectedSource = clone(state.source);
    const restoreOptions = {
      sourceKind,
      directoryName,
      device: String(options.device || '')
    };
    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    session = { ...session, sessionId, controller, destinationPath, sourceKind, restoreOptions };
    state = { ...emptyState(), sessionId };
    emit({
      source: selectedSource,
      destination: { display: destinationPath, exists: false },
      phase: 'preparing-staging',
      canCancel: true
    });

    let stage = 'staging';
    try {
      const owned = await createOwnedStaging({ destinationParent, destinationPath, sessionId });
      Object.assign(session, owned);
      await journal.write({
        sessionId, mode: 'restore', stagingRoot: owned.stagingRoot,
        destinationPath, phase: 'prepared', createdAt: now()
      });

      if (sourceKind === 'git') {
        stage = 'git';
        emit({ phase: 'cloning' });
        await git.cloneRemote(session.remote, owned.candidatePath, { signal: controller.signal });
      } else {
        stage = 'copy';
        emit({ phase: 'copying' });
        await copyVault(sourcePath, owned.candidatePath, {
          signal: controller.signal,
          onProgress: progress => emit({ progress })
        });
        await git.inspectLocalRepository(owned.candidatePath, { signal: controller.signal });
      }

      await journal.write({
        sessionId, mode: 'restore', stagingRoot: owned.stagingRoot,
        destinationPath, phase: 'candidate-present', createdAt: now()
      });
      stage = 'vault';
      emit({ phase: 'validating-vault' });
      await validateVaultRoot(owned.candidatePath, { scanSymlinks: sourceKind === 'git' });

      stage = 'index';
      emit({ phase: 'building-index' });
      const indexStatus = await buildIndex(owned.candidatePath);
      if (indexStatus.phase === 'error') {
        const error = new Error('无法从 Markdown 建立索引。');
        error.code = 'index-failed';
        throw error;
      }
      const indexed = indexPublic(indexStatus);
      const warnings = await checkDeviceCollision(owned.candidatePath, options.device);
      const [stagingIdentity, candidateIdentity] = await Promise.all([
        fsp.lstat(owned.stagingRoot),
        fsp.lstat(owned.candidatePath)
      ]);
      session.activationIdentity = { stagingIdentity, candidateIdentity };
      emit({
        phase: 'ready-to-activate',
        outcome: indexed.total ? 'partial' : 'complete',
        warnings,
        indexFailures: indexed.failures,
        indexFailureTotal: indexed.total,
        indexFailuresTruncated: indexed.total > PUBLIC_LIMIT,
        canCancel: true,
        canActivate: true
      });
      return getState();
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'cancelled';
      if (session.stagingRoot) {
        await journal.write({
          sessionId, mode: 'restore', stagingRoot: session.stagingRoot,
          destinationPath, phase: 'candidate-present', createdAt: now(),
          lastError: { stage, code: error.code || `${stage}-failed` }
        }).catch(() => {});
      }
      const failure = cancelled ? null : safeFailure(error, stage);
      emit({
        phase: cancelled ? 'cancelled' : 'failed',
        canCancel: false,
        canRetry: Boolean(failure?.retryable),
        canActivate: false,
        error: failure
      });
      throw error;
    }
  }

  async function cancelInternal(pending) {
    if (!session?.controller || !state.canCancel || state.phase === 'activating') return { cancelled: false };
    emit({ phase: 'cancelling', canCancel: false });
    session.controller.abort();
    await pending.catch(() => {});
    if (session.stagingRoot) await journal.discardOwnedStaging();
    const source = state.source;
    const destination = state.destination;
    state = emptyState();
    emit({ phase: 'cancelled', source, destination });
    session = null;
    return { cancelled: true };
  }

  function cancel() {
    const pending = Promise.allSettled([...operations]);
    return track(() => cancelInternal(pending));
  }

  async function retryStageInternal() {
    if (!state.canRetry || state.phase !== 'failed' || !session?.restoreOptions) {
      throw new Error('当前没有可重试的阶段。');
    }
    const options = { ...session.restoreOptions };
    if (session.stagingRoot) await journal.discardOwnedStaging();
    const retained = {
      localSource: session.localSource,
      destinationParent: session.destinationParent,
      remote: session.remote
    };
    const source = clone(state.source);
    session = retained;
    state = { ...emptyState(), source };
    return runRestore(options);
  }

  function retryStage() {
    assertNoOperation();
    return track(retryStageInternal);
  }

  async function verifyActivationCandidate() {
    const candidatePath = path.join(session.stagingRoot, 'candidate');
    if (path.resolve(session.candidatePath) !== candidatePath) {
      throw Object.assign(new Error('恢复候选目录位置不合法。'), {
        code: 'activation-validation-failed'
      });
    }

    const found = await journal.inspect();
    const record = found?.record;
    const matches = Boolean(found?.owned
      && found.candidateExists
      && record.phase === 'candidate-present'
      && record.sessionId === session.sessionId
      && record.stagingRoot === path.resolve(session.stagingRoot)
      && record.destinationPath === path.resolve(session.destinationPath));
    if (!matches) {
      throw Object.assign(new Error('恢复候选目录所有权不匹配。'), {
        code: 'activation-validation-failed'
      });
    }

    const [stagingBefore, candidateBefore] = await Promise.all([
      fsp.lstat(session.stagingRoot),
      fsp.lstat(session.candidatePath)
    ]);
    if (!session.activationIdentity
      || !sameIdentity(session.activationIdentity.stagingIdentity, stagingBefore)
      || !sameIdentity(session.activationIdentity.candidateIdentity, candidateBefore)) {
      throw Object.assign(new Error('恢复候选目录已被替换。'), {
        code: 'activation-validation-failed'
      });
    }
    if (!stagingBefore.isDirectory() || stagingBefore.isSymbolicLink()
      || !candidateBefore.isDirectory() || candidateBefore.isSymbolicLink()) {
      throw Object.assign(new Error('恢复候选目录不是普通目录。'), {
        code: 'activation-validation-failed'
      });
    }

    await validateVaultRoot(session.candidatePath, { scanSymlinks: true });
    const [foundAfter, stagingAfter, candidateAfter] = await Promise.all([
      journal.inspect(),
      fsp.lstat(session.stagingRoot),
      fsp.lstat(session.candidatePath)
    ]);
    const recordAfter = foundAfter?.record;
    if (!foundAfter?.owned || !foundAfter.candidateExists
      || recordAfter.phase !== 'candidate-present'
      || recordAfter.sessionId !== session.sessionId
      || recordAfter.stagingRoot !== path.resolve(session.stagingRoot)
      || recordAfter.destinationPath !== path.resolve(session.destinationPath)
      || !sameIdentity(stagingBefore, stagingAfter)
      || !sameIdentity(candidateBefore, candidateAfter)) {
      throw Object.assign(new Error('恢复候选目录在验证期间发生变化。'), {
        code: 'activation-validation-failed'
      });
    }
  }

  async function activateInternal() {
    if (state.phase !== 'ready-to-activate' || !state.canActivate) {
      throw new Error('恢复结果还不能激活。');
    }
    emit({ phase: 'activating', canCancel: false, canRetry: false, canActivate: false });
    try {
      await verifyActivationCandidate();
      await renameIntoPlace(session.candidatePath, session.destinationPath);
      session.renamed = true;
    } catch (error) {
      const failure = error?.code === 'destination-exists'
        ? {
          stage: 'activation',
          code: 'destination-exists',
          message: '目标资料库目录已经存在。',
          remediation: '请选择另一个新目录名后重新恢复。',
          retryable: false,
          partial: false
        }
        : safeFailure(error, 'activation');
      const destinationExists = error?.code === 'destination-exists';
      emit({
        phase: destinationExists ? 'ready-to-activate' : 'failed',
        error: failure,
        canCancel: destinationExists,
        canRetry: false,
        canActivate: destinationExists
      });
      throw error;
    }

    try {
      await journal.write({
        sessionId: session.sessionId,
        mode: 'restore',
        stagingRoot: session.stagingRoot,
        destinationPath: session.destinationPath,
        phase: 'renamed',
        createdAt: now()
      });
    } catch {
      session.journalWarning = true;
    }
    const warnings = session.journalWarning
      ? [...state.warnings, {
        code: 'journal-update-failed',
        message: '新目录已就位，但恢复记录未能更新；请勿手工删除新目录。'
      }]
      : state.warnings;
    emit({ destination: { display: session.destinationPath, exists: true }, warnings, error: null });
    return { destinationPath: session.destinationPath, outcome: state.outcome, state: getState() };
  }

  function activate() {
    assertNoOperation();
    return track(activateInternal);
  }

  async function completeActivationInternal() {
    if (!session?.renamed || state.phase !== 'activating') return { ok: false };
    let cleanupPending = false;
    try {
      await fsp.rm(session.stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await journal.clear();
    } catch {
      cleanupPending = true;
    }
    const warnings = cleanupPending
      ? [...state.warnings, {
        code: 'cleanup-pending',
        message: '新资料库已经打开，但仍有恢复记录待下次启动安全清理。'
      }]
      : state.warnings;
    emit({
      phase: 'completed',
      warnings,
      residue: cleanupPending ? { cleanupPending: true } : null,
      canCancel: false,
      canRetry: false,
      canActivate: false
    });
    return { ok: true, cleanupPending, state: getState() };
  }

  function completeActivation() {
    assertNoOperation();
    return track(completeActivationInternal);
  }

  function failActivation() {
    assertNoOperation();
    return track(async () => {
      if (!session?.renamed || state.phase !== 'activating') return { ok: false };
      emit({
        phase: 'failed',
        error: safeFailure(Object.assign(new Error(), { code: 'activation-failed' }), 'activation'),
        canCancel: false,
        canRetry: false,
        canActivate: false
      });
      return { ok: true, state: getState() };
    });
  }

  function loadResidue() {
    if (operations.size || !['idle', 'cancelled', 'failed', 'completed'].includes(state.phase)) {
      throw new Error('当前恢复状态不能检查残留。');
    }
    return track(async () => {
      const found = await journal.inspect();
      if (!found) return null;
      session = {
        sessionId: found.record.sessionId,
        stagingRoot: found.record.stagingRoot,
        destinationPath: found.record.destinationPath,
        renamed: found.record.phase === 'renamed'
      };
      state = emptyState();
      emit({
        phase: 'residue',
        destination: { display: found.record.destinationPath, exists: found.destinationExists },
        residue: {
          owned: found.owned || found.staleAfterRename,
          candidateExists: found.candidateExists,
          destinationExists: found.destinationExists,
          staleAfterRename: found.staleAfterRename,
          phase: found.record.phase
        },
        warnings: found.owned || found.staleAfterRename ? [] : [{
          code: 'residue-owner-mismatch',
          message: '恢复残留的所有权标记不匹配，不能自动清理。'
        }]
      });
      return getState();
    });
  }

  function discardOwnedStaging() {
    if (operations.size || !['idle', 'cancelled', 'failed', 'residue'].includes(state.phase)) {
      throw new Error('当前恢复状态不能清理残留。');
    }
    return track(async () => {
      const result = await journal.discardOwnedStaging();
      state = emptyState();
      session = null;
      emit({ phase: 'idle' });
      return result;
    });
  }

  /**
   * 不属于本应用会话的残留（暂存目录被手动删掉、所有权标记对不上）没法自动清理，
   * 以前也没法忽略，于是每次启动都卡在恢复窗口。用户检查过后可以只清掉这条记录：
   * 不碰任何目录。
   */
  function dismissResidue() {
    if (operations.size || state.phase !== 'residue') throw new Error('当前没有可以忽略的恢复残留。');
    return track(async () => {
      await journal.clear();
      state = emptyState();
      session = null;
      emit({ phase: 'idle' });
      return getState();
    });
  }

  function reset() {
    if (operations.size || !['idle', 'cancelled', 'failed', 'completed'].includes(state.phase)) {
      throw new Error('当前恢复状态不能重置。');
    }
    return track(async () => {
      if (await journal.inspect()) throw new Error('仍有恢复残留，请先检查或安全清理。');
      state = emptyState();
      session = null;
      emit({ phase: 'idle' });
      return getState();
    });
  }

  async function idle() {
    while (operations.size) await Promise.allSettled([...operations]);
  }

  return {
    getState,
    onState,
    selectLocalSource,
    selectDestinationParent,
    inspectRemote,
    start,
    cancel,
    retryStage,
    activate,
    completeActivation,
    failActivation,
    loadResidue,
    discardOwnedStaging,
    dismissResidue,
    reset,
    idle
  };
}

module.exports = {
  createRecoveryService,
  copyVault,
  validateVaultRoot,
  validDirectoryName,
  emptyState,
  EXCLUDED_ROOT_FILES
};
