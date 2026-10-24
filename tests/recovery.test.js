const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRecoveryJournal } = require('../src/recovery/journal');
const { isHelperAvailable } = require('../src/recovery/rename-exclusive');
const {
  createRecoveryService,
  copyVault,
  validDirectoryName
} = require('../src/recovery/service');

async function setup(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-recovery-'));
  const source = path.join(root, 'backup');
  const destinationParent = path.join(root, 'destinations');
  const journal = createRecoveryJournal({ journalPath: path.join(root, 'user-data', 'recovery.json') });
  await fs.mkdir(path.join(source, 'notes'), { recursive: true });
  await fs.mkdir(destinationParent);
  await fs.writeFile(path.join(source, 'notes', 'one.md'), '# One\n');
  const calls = { git: [], blob: [] };
  const git = options.git || {
    async inspectRemote(remote) { calls.git.push(['inspect', remote]); return { display: 'https://example.com/…/vault.git' }; },
    async cloneRemote(remote, candidate) {
      calls.git.push(['clone', remote]);
      await fs.mkdir(path.join(candidate, 'notes'), { recursive: true });
      await fs.writeFile(path.join(candidate, 'notes', 'git.md'), '# Git\n');
    },
    async inspectLocalRepository(candidate) { calls.git.push(['local', candidate]); return { isRepo: false }; }
  };
  const blobRestore = options.blobRestore || {
    async run({ vaultDir }) { calls.blob.push(['run', vaultDir]); return { failed: [], integrityUnavailable: false }; },
    async retry({ vaultDir }) { calls.blob.push(['retry', vaultDir]); return { failed: [], integrityUnavailable: false }; }
  };
  const openDb = options.openDb || (() => ({ close() {} }));
  const createIndex = options.createIndex || (() => ({
    async scan() {},
    getStatus() { return { phase: 'ready', failures: [], failureTotal: 0 }; }
  }));
  const service = createRecoveryService({ journal, git, blobRestore, openDb, createIndex, ...options.serviceOptions });
  return {
    root, source, destinationParent, journal, service, calls,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

async function prepareLocal(ctx, options = {}) {
  ctx.service.selectLocalSource(ctx.source);
  ctx.service.selectDestinationParent(ctx.destinationParent);
  return ctx.service.start({
    sourceKind: 'local',
    directoryName: options.directoryName || 'restored',
    restoreBlobs: Boolean(options.restoreBlobs),
    device: options.device || 'device-a'
  });
}

test('目录 basename 严格拒绝穿越、保留名和超长输入', () => {
  assert.equal(validDirectoryName('restored-vault'), 'restored-vault');
  for (const value of ['', '.', '..', '../vault', 'a/b', 'CON', 'trailing.', 'x'.repeat(121)]) {
    assert.throws(() => validDirectoryName(value), /不合法/, value);
  }
});

test('本地恢复复制来源但不修改来源，并排除 DB 与临时文件', async () => {
  const ctx = await setup();
  try {
    await fs.writeFile(path.join(ctx.source, 'workstation.db'), 'derived');
    await fs.writeFile(path.join(ctx.source, 'workstation.db-wal'), 'wal');
    await fs.writeFile(path.join(ctx.source, 'orphan.tmp-1-abc'), 'temp');
    const before = crypto.createHash('sha256').update(await fs.readFile(path.join(ctx.source, 'notes', 'one.md'))).digest('hex');

    const ready = await prepareLocal(ctx);
    assert.equal(ready.phase, 'ready-to-activate');
    const candidate = path.join(ctx.destinationParent, `.workstation-recovery-${ready.sessionId}`, 'candidate');
    assert.equal(await fs.readFile(path.join(candidate, 'notes', 'one.md'), 'utf8'), '# One\n');
    await assert.rejects(() => fs.access(path.join(candidate, 'workstation.db-wal')));
    await assert.rejects(() => fs.access(path.join(candidate, 'orphan.tmp-1-abc')));
    const after = crypto.createHash('sha256').update(await fs.readFile(path.join(ctx.source, 'notes', 'one.md'))).digest('hex');
    assert.equal(after, before);
  } finally {
    await ctx.cleanup();
  }
});

test('恢复只检查仍在使用的复习日志设备名，旧错题日志按普通文件保留', async () => {
  for (const directory of ['mistakes/exercise', 'reviews']) {
    const ctx = await setup();
    try {
      const logDir = path.join(ctx.source, directory);
      await fs.mkdir(logDir, { recursive: true });
      const logName = '2026-10-device-a.jsonl';
      const content = '{"id":"legacy"}\n';
      await fs.writeFile(path.join(logDir, logName), content);
      const ready = await prepareLocal(ctx);
      assert.equal(ready.warnings.some(warning => warning.code === 'device-name-collision'), directory === 'reviews');
      const candidate = path.join(ctx.destinationParent, `.workstation-recovery-${ready.sessionId}`, 'candidate');
      assert.equal(await fs.readFile(path.join(candidate, directory, logName), 'utf8'), content);
    } finally {
      await ctx.cleanup();
    }
  }
});

test('本地来源含 symlink 时失败且不会跟随复制', async t => {
  const ctx = await setup();
  try {
    const outside = path.join(ctx.root, 'outside.txt');
    await fs.writeFile(outside, 'secret');
    try {
      await fs.symlink(outside, path.join(ctx.source, 'notes', 'link.md'));
    } catch (error) {
      t.skip(`本机不允许创建符号链接：${error.code}`);
      return;
    }
    await assert.rejects(() => prepareLocal(ctx), /符号链接/);
    assert.equal(ctx.service.getState().phase, 'failed');
    assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
  } finally {
    await ctx.cleanup();
  }
});

test('Git candidate 的 managed Blob symlink 在下载前被拒绝', async t => {
  let blobCalled = false;
  let outside;
  const ctx = await setup({
    git: {
      async inspectRemote(remote) {
        return { display: remote };
      },
      async cloneRemote(remote, candidate) {
        await fs.mkdir(path.join(candidate, 'notes'), { recursive: true });
        await fs.writeFile(path.join(candidate, 'notes', 'git.md'), '# Git\n');
        outside = path.join(path.dirname(path.dirname(candidate)), 'outside-blobs');
        await fs.mkdir(outside);
        await fs.symlink(
          outside,
          path.join(candidate, 'attachments'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }
    },
    blobRestore: {
      async run() {
        blobCalled = true;
        return { failed: [], integrityUnavailable: false };
      }
    }
  });
  try {
    try {
      await ctx.service.inspectRemote('https://example.com/team/vault.git');
      ctx.service.selectDestinationParent(ctx.destinationParent);
      await assert.rejects(() => ctx.service.start({
        sourceKind: 'git',
        directoryName: 'restored',
        restoreBlobs: true
      }), /符号链接/);
    } catch (error) {
      if (error.code === 'EPERM') {
        t.skip('本机不允许创建目录链接。');
        return;
      }
      throw error;
    }
    assert.equal(blobCalled, false);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(ctx.service.getState().phase, 'failed');
  } finally {
    await ctx.cleanup();
  }
});

test('degraded 索引可 partial 激活，fatal 索引阻止激活', async () => {
  const partial = await setup({
    createIndex: () => ({
      async scan() {},
      getStatus() {
        return { phase: 'degraded', failureTotal: 1, failures: [{ path: 'bad.md', code: 'invalid-note', reason: '坏笔记' }] };
      }
    })
  });
  try {
    const ready = await prepareLocal(partial);
    assert.equal(ready.outcome, 'partial');
    assert.equal(ready.canActivate, true);
    assert.equal(ready.indexFailureTotal, 1);
  } finally {
    await partial.cleanup();
  }

  const fatal = await setup({
    createIndex: () => ({
      async scan() {},
      getStatus() { return { phase: 'error', fatal: { code: 'database-error' } }; }
    })
  });
  try {
    await assert.rejects(() => prepareLocal(fatal), /索引/);
    assert.equal(fatal.service.getState().canActivate, false);
  } finally {
    await fatal.cleanup();
  }
});

test('激活 rename 与 runtime 成功确认分两阶段', async t => {
  // 走的是服务默认的 renameIntoPlace，也就是真实的 renameExclusive。
  if (!isHelperAvailable()) {
    t.skip('本机没有编译出恢复 helper，跳过真实激活。');
    return;
  }
  const ctx = await setup();
  try {
    await prepareLocal(ctx);
    const activated = await ctx.service.activate();
    assert.equal(ctx.service.getState().phase, 'activating');
    assert.equal(await fs.readFile(path.join(activated.destinationPath, 'notes', 'one.md'), 'utf8'), '# One\n');
    assert.ok(await ctx.journal.read(), 'runtime 切换前 journal 必须保留');

    await ctx.service.completeActivation();
    assert.equal(ctx.service.getState().phase, 'completed');
    assert.equal(await ctx.journal.read(), null);
    assert.equal(await fs.readFile(path.join(activated.destinationPath, 'notes', 'one.md'), 'utf8'), '# One\n');
  } finally {
    await ctx.cleanup();
  }
});

test('激活前 owner 被篡改时 fail-closed 且不调用 rename', async () => {
  let renameCalled = false;
  const ctx = await setup({
    serviceOptions: {
      async renameIntoPlace() {
        renameCalled = true;
      }
    }
  });
  try {
    const ready = await prepareLocal(ctx);
    const staging = path.join(ctx.destinationParent, `.workstation-recovery-${ready.sessionId}`);
    await fs.writeFile(path.join(staging, 'owner.json'), JSON.stringify({
      version: 1,
      sessionId: crypto.randomUUID(),
      destinationPath: path.join(ctx.destinationParent, 'restored')
    }));
    await assert.rejects(() => ctx.service.activate(), error => (
      error.code === 'activation-validation-failed'
    ));
    assert.equal(renameCalled, false);
    assert.equal(ctx.service.getState().phase, 'failed');
    assert.equal(ctx.service.getState().canActivate, false);
    assert.equal(ctx.service.getState().error.code, 'activation-validation-failed');
    assert.ok(await fs.lstat(staging));
    await assert.rejects(() => fs.access(path.join(ctx.destinationParent, 'restored')));
  } finally {
    await ctx.cleanup();
  }
});

test('激活前 candidate 被替换为另一普通 vault 时拒绝发布', async () => {
  let renameCalled = false;
  const ctx = await setup({
    serviceOptions: {
      async renameIntoPlace() {
        renameCalled = true;
      }
    }
  });
  try {
    const ready = await prepareLocal(ctx);
    const staging = path.join(ctx.destinationParent, `.workstation-recovery-${ready.sessionId}`);
    const candidate = path.join(staging, 'candidate');
    await fs.rm(candidate, { recursive: true });
    await fs.mkdir(path.join(candidate, 'notes'), { recursive: true });
    await fs.writeFile(path.join(candidate, 'notes', 'replacement.md'), '# Replacement\n');
    await assert.rejects(() => ctx.service.activate(), error => (
      error.code === 'activation-validation-failed'
    ));
    assert.equal(renameCalled, false);
    assert.equal(ctx.service.getState().phase, 'failed');
    assert.equal(ctx.service.getState().canActivate, false);
    assert.equal(await fs.readFile(path.join(candidate, 'notes', 'replacement.md'), 'utf8'), '# Replacement\n');
    await assert.rejects(() => fs.access(path.join(ctx.destinationParent, 'restored')));
  } finally {
    await ctx.cleanup();
  }
});

test('激活竞争者先占目标时不覆盖且 candidate 保持可用', async () => {
  const ctx = await setup({
    serviceOptions: {
      async renameIntoPlace(source, destination) {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'owner.txt'), 'competitor');
        throw Object.assign(new Error('occupied'), { code: 'destination-exists' });
      }
    }
  });
  try {
    const ready = await prepareLocal(ctx);
    const candidate = path.join(
      ctx.destinationParent,
      `.workstation-recovery-${ready.sessionId}`,
      'candidate'
    );
    await assert.rejects(() => ctx.service.activate(), error => error.code === 'destination-exists');
    const destination = path.join(ctx.destinationParent, 'restored');
    assert.equal(await fs.readFile(path.join(destination, 'owner.txt'), 'utf8'), 'competitor');
    assert.equal(await fs.readFile(path.join(candidate, 'notes', 'one.md'), 'utf8'), '# One\n');
    assert.equal(ctx.service.getState().phase, 'ready-to-activate');
    assert.equal(ctx.service.getState().error.code, 'destination-exists');
    assert.equal(ctx.service.getState().canActivate, true);
    const residue = await ctx.journal.inspect();
    assert.equal(residue.owned, true);
    assert.equal(residue.candidateExists, true);
    const discarded = await ctx.journal.discardOwnedStaging();
    assert.equal(discarded.removed, true);
    assert.equal(await fs.readFile(path.join(destination, 'owner.txt'), 'utf8'), 'competitor');
  } finally {
    await ctx.cleanup();
  }
});

test('runtime 成功后即使 cleanup 失败也保持 completed', async t => {
  // 走的是服务默认的 renameIntoPlace，也就是真实的 renameExclusive。
  if (!isHelperAvailable()) {
    t.skip('本机没有编译出恢复 helper，跳过真实激活。');
    return;
  }
  const ctx = await setup();
  try {
    await prepareLocal(ctx);
    await ctx.service.activate();
    const originalClear = ctx.journal.clear;
    ctx.journal.clear = async () => { throw new Error('locked'); };
    const result = await ctx.service.completeActivation();
    assert.equal(result.ok, true);
    assert.equal(result.cleanupPending, true);
    assert.equal(ctx.service.getState().phase, 'completed');
    assert.equal(ctx.service.getState().warnings.at(-1).code, 'cleanup-pending');
    ctx.journal.clear = originalClear;
  } finally {
    await ctx.cleanup();
  }
});

test('runtime 激活失败时最终目录和 renamed journal 保留', async t => {
  // 走的是服务默认的 renameIntoPlace，也就是真实的 renameExclusive。
  if (!isHelperAvailable()) {
    t.skip('本机没有编译出恢复 helper，跳过真实激活。');
    return;
  }
  const ctx = await setup();
  try {
    await prepareLocal(ctx);
    const { destinationPath } = await ctx.service.activate();
    await ctx.service.failActivation();
    const state = ctx.service.getState();
    assert.equal(state.phase, 'failed');
    assert.equal(state.error.code, 'activation-failed');
    assert.match(state.error.remediation, /新目录已保留/);
    assert.equal((await ctx.journal.read()).phase, 'renamed');
    assert.equal(await fs.readFile(path.join(destinationPath, 'notes', 'one.md'), 'utf8'), '# One\n');
    const discarded = await ctx.service.discardOwnedStaging();
    assert.equal(discarded.destinationPreserved, true);
    assert.equal(await fs.readFile(path.join(destinationPath, 'notes', 'one.md'), 'utf8'), '# One\n');
  } finally {
    await ctx.cleanup();
  }
});

test('取消运行中的恢复会等待停止并安全清理 owned staging', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = await setup({
    git: {
      async inspectLocalRepository() { await gate; return { isRepo: false }; }
    }
  });
  try {
    const running = prepareLocal(ctx);
    running.catch(() => {});
    while (ctx.service.getState().phase !== 'copying') await new Promise(resolve => setImmediate(resolve));
    release();
    const cancelled = await ctx.service.cancel();
    assert.equal(cancelled.cancelled, true);
    await running.catch(() => {});
    assert.equal(ctx.service.getState().phase, 'cancelled');
    assert.equal(await ctx.journal.read(), null);
  } finally {
    release();
    await ctx.cleanup();
  }
});

test('失败恢复可安全丢弃旧 staging 后从头重试', async () => {
  let attempts = 0;
  const ctx = await setup({
    git: {
      async inspectLocalRepository() {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('temporary'), { code: 'git-failed' });
        return { isRepo: false };
      }
    }
  });
  try {
    await assert.rejects(() => prepareLocal(ctx));
    assert.equal(ctx.service.getState().canRetry, true);
    const ready = await ctx.service.retryStage();
    assert.equal(ready.phase, 'ready-to-activate');
    assert.equal(attempts, 2);
    const wrappers = (await fs.readdir(ctx.destinationParent)).filter(name => name.startsWith('.workstation-recovery-'));
    assert.equal(wrappers.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('repair-blobs 固定当前 vault 且永不创建 staging 或激活', async () => {
  const ctx = await setup();
  try {
    const repair = createRecoveryService({
      journal: ctx.journal,
      mode: 'repair-blobs',
      currentVaultDir: ctx.source,
      blobRestore: {
        async run({ vaultDir }) {
          assert.equal(vaultDir, ctx.source);
          return { failed: [{ path: 'audio/x.m4a', retryable: true }], integrityUnavailable: false };
        },
        async retry({ vaultDir }) {
          assert.equal(vaultDir, ctx.source);
          return { failed: [], integrityUnavailable: false };
        }
      }
    });
    const partial = await repair.repairCurrentBlobs();
    assert.equal(partial.phase, 'completed');
    assert.equal(partial.outcome, 'partial');
    assert.equal(partial.canActivate, false);
    await assert.rejects(() => repair.activate());
    const complete = await repair.retryStage();
    assert.equal(complete.outcome, 'complete');
    assert.deepEqual((await fs.readdir(ctx.destinationParent)), []);
  } finally {
    await ctx.cleanup();
  }
});

test('repair-blobs 在 managed Blob symlink 存在时不进入 Blob facade', async t => {
  let blobCalled = false;
  const ctx = await setup();
  try {
    const outside = path.join(ctx.root, 'outside-current-blobs');
    await fs.mkdir(outside);
    try {
      await fs.symlink(
        outside,
        path.join(ctx.source, 'attachments'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      t.skip(`本机不允许创建目录链接：${error.code}`);
      return;
    }
    const repair = createRecoveryService({
      journal: ctx.journal,
      mode: 'repair-blobs',
      currentVaultDir: ctx.source,
      blobRestore: {
        async run() {
          blobCalled = true;
          return { failed: [], integrityUnavailable: false };
        }
      }
    });

    await assert.rejects(() => repair.repairCurrentBlobs(), /符号链接/);
    assert.equal(blobCalled, false);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await ctx.cleanup();
  }
});

test('loadResidue 只公开 destination，reset 不清路径且有 journal 时拒绝', async () => {
  const ctx = await setup();
  try {
    await prepareLocal(ctx);
    const stateBefore = ctx.service.getState();
    const restarted = createRecoveryService({ journal: ctx.journal });
    const residue = await restarted.loadResidue();
    assert.equal(residue.phase, 'residue');
    assert.equal(residue.destination.display, path.join(ctx.destinationParent, 'restored'));
    assert.ok(!JSON.stringify(residue).includes(`.workstation-recovery-${stateBefore.sessionId}`));
    assert.throws(() => restarted.reset(), /不能重置/);
    await restarted.discardOwnedStaging();
    assert.equal(restarted.getState().phase, 'idle');
  } finally {
    await ctx.cleanup();
  }
});

test('idle 等待全部并发异步入口，快速失败不会覆盖长操作', async () => {
  let finishInspect;
  const ctx = await setup({
    git: {
      inspectRemote() {
        return new Promise(resolve => { finishInspect = () => resolve({ display: 'safe' }); });
      }
    }
  });
  try {
    const inspecting = ctx.service.inspectRemote('https://example.com/team/vault.git');
    assert.throws(() => ctx.service.activate(), /已有恢复操作/);
    let idleDone = false;
    const idle = ctx.service.idle().then(() => { idleDone = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(idleDone, false);
    finishInspect();
    await inspecting;
    await idle;
    assert.equal(idleDone, true);
  } finally {
    await ctx.cleanup();
  }
});

test('copyVault 单独保证 source 字节不变', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-copy-vault-'));
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'a.txt'), 'immutable');
    await copyVault(source, target);
    assert.equal(await fs.readFile(path.join(source, 'a.txt'), 'utf8'), 'immutable');
    assert.equal(await fs.readFile(path.join(target, 'a.txt'), 'utf8'), 'immutable');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
